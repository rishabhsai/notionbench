#!/usr/bin/env node
/**
 * notionbench CLI.
 *
 *   notionbench run --tasks <glob> --configs <a,b> --trials 5 --docs both
 *   notionbench run --resume <runId>
 *   notionbench status <runId>
 *   notionbench configs
 *   notionbench tasks --tasks <glob>
 */

import { parseArgs } from 'node:util';
import path from 'node:path';
import process from 'node:process';
import { prepareWorkspace, type DocsBundle } from '@notionbench/sandbox';
import {
  Checkpoint,
  buildCells,
  cellKey,
  newRunId,
  resume as resumeRun,
  trialDirFor,
  type CellCoords,
  type RunMeta,
} from './checkpoint.js';
import { ConfigError, loadRunConfig, selectConfigs, type AgentConfig } from './config.js';
import { getAdapter, hasAdapter } from './parsers/index.js';
import { Scheduler, runQueue, type CellOutcome, type QueueCell } from './queue.js';
import { compilePatterns } from './rate-limit.js';
import { getCliVersion, runTrial } from './spawn.js';
import { discoverTasks, readPrompt } from './tasks.js';
import { TokenPool } from './token-pool.js';
import { DOCS_CONDITIONS, type DocsCondition, type TaskSpec } from './types.js';

const USAGE = `notionbench — run agent CLIs against the Notion developer-platform benchmark

Usage:
  notionbench run [options]
  notionbench status <runId> [--results <dir>] [--json]
  notionbench configs [--runconfig <path>] [--json]
  notionbench tasks [--tasks <glob>] [--evals <dir>] [--json]

run options:
  --tasks <glob>        Task id glob, repeatable/comma-separated. Default: all.
                        e.g. --tasks 'build-nac-*' --tasks 'resolve-workers-**'
  --configs <list>      Comma-separated config ids. Default: all enabled.
  --trials <n>          Trials per (task, config, docs) cell. Default 5.
  --docs <with|without|both>
                        Docs axis condition(s). Default: both.
  --resume <runId>      Continue an existing run; done cells are skipped.
  --runconfig <path>    runconfig.json. Default: ./runconfig.json if present.
  --results <dir>       Results root. Default: results/
  --evals <dir>         Task root. Default: evals/
  --concurrency <n>     Global in-flight trials (serial per config). Default 2.
  --cooldown-min <n>    Rate-window pause per config, minutes. Default 30.
  --timeout <sec>       Per-trial wall clock; task frontmatter limits.time wins.
  --max-attempts <n>    Attempts per cell before giving up. Default 3.
  --include-disabled    Allow selecting configs marked enabled:false.
  --keep-workspaces     Do not delete trial workspaces (debugging).
  --dry-run             Plan the run and print the grid; launch nothing.
  -h, --help            This message.
`;

type Argv = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;

const OPTIONS = {
  tasks: { type: 'string', multiple: true },
  configs: { type: 'string', multiple: true },
  trials: { type: 'string' },
  docs: { type: 'string' },
  resume: { type: 'string' },
  runconfig: { type: 'string' },
  results: { type: 'string' },
  evals: { type: 'string' },
  concurrency: { type: 'string' },
  'cooldown-min': { type: 'string' },
  timeout: { type: 'string' },
  'max-attempts': { type: 'string' },
  'include-disabled': { type: 'boolean' },
  'keep-workspaces': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed: Argv;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const command = positionals[0];

  if (values.help || !command) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 2;
  }

  try {
    switch (command) {
      case 'run':
        return await cmdRun(values);
      case 'status':
        return await cmdStatus(values, positionals[1]);
      case 'configs':
        return await cmdConfigs(values);
      case 'tasks':
        return await cmdTasks(values);
      default:
        process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`config error: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
    return 1;
  }
}

type Values = Argv['values'];

async function cmdConfigs(values: Values): Promise<number> {
  const rc = await loadRunConfig(await defaultRunconfigPath(values.runconfig));
  if (values.json) {
    process.stdout.write(`${JSON.stringify(rc.configs, null, 2)}\n`);
    return 0;
  }
  for (const c of rc.configs) {
    const flags = [
      c.enabled ? 'enabled' : 'disabled',
      hasAdapter(c.harness) ? 'adapter:ok' : 'adapter:MISSING',
    ].join(' ');
    process.stdout.write(
      `${pad(c.id, 28)} ${pad(c.harness, 13)} ${pad(c.model, 14)} ${pad(c.reasoningEffort ?? '-', 8)} ${flags}\n`,
    );
    if (c.note) process.stdout.write(`${' '.repeat(30)}${c.note}\n`);
  }
  return 0;
}

async function cmdTasks(values: Values): Promise<number> {
  const rc = await loadRunConfig(await defaultRunconfigPath(values.runconfig));
  const evalsRoot = path.resolve(values.evals ?? rc.evalsRoot);
  const tasks = await discoverTasks(evalsRoot, splitList(values.tasks));
  if (values.json) {
    process.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`);
    return 0;
  }
  if (tasks.length === 0) {
    process.stdout.write(`no tasks found under ${evalsRoot}\n`);
    return 0;
  }
  for (const t of tasks) {
    process.stdout.write(
      `${pad(t.id, 44)} ${pad(t.suite ?? '-', 11)} ${pad(t.family ?? '-', 8)} ${pad(t.stage ?? '-', 12)} ${t.runtime ?? '-'}\n`,
    );
  }
  process.stdout.write(`\n${tasks.length} task(s)\n`);
  return 0;
}

async function cmdStatus(values: Values, runId: string | undefined): Promise<number> {
  if (!runId) {
    process.stderr.write('status requires a runId\n');
    return 2;
  }
  const rc = await loadRunConfig(await defaultRunconfigPath(values.runconfig));
  const resultsRoot = path.resolve(values.results ?? rc.resultsRoot);
  const cp = await Checkpoint.load(runId, resultsRoot);
  const summary = cp.summary();

  if (values.json) {
    process.stdout.write(`${JSON.stringify({ runId, summary, meta: cp.meta }, null, 2)}\n`);
    return 0;
  }

  const pct = summary.total > 0 ? ((summary.done / summary.total) * 100).toFixed(1) : '0.0';
  process.stdout.write(`run ${runId}  (${resultsRoot})\n`);
  process.stdout.write(
    `  ${summary.done}/${summary.total} done (${pct}%)  pending ${summary.pending}  running ${summary.running}  failed ${summary.failed}\n`,
  );
  process.stdout.write(`  rate-limited attempts (not charged): ${summary.rateLimitedAttempts}\n\n`);
  for (const [configId, s] of Object.entries(summary.byConfig).sort()) {
    process.stdout.write(
      `  ${pad(configId, 28)} done ${pad(String(s.done), 5)} pending ${pad(String(s.pending), 5)} running ${pad(String(s.running), 3)} failed ${s.failed}\n`,
    );
  }
  const failed = cp.cells().filter((c) => c.status === 'failed');
  if (failed.length > 0) {
    process.stdout.write(`\n  failed cells:\n`);
    for (const c of failed.slice(0, 20)) {
      process.stdout.write(`    ${cellKey(c)}  ${c.lastTrialStatus ?? '?'}  ${c.lastError ?? ''}\n`);
    }
    if (failed.length > 20) process.stdout.write(`    … and ${failed.length - 20} more\n`);
  }
  return summary.failed > 0 ? 1 : 0;
}

async function cmdRun(values: Values): Promise<number> {
  const rc = await loadRunConfig(await defaultRunconfigPath(values.runconfig));
  const resultsRoot = path.resolve(values.results ?? rc.resultsRoot);
  const evalsRoot = path.resolve(values.evals ?? rc.evalsRoot);
  const trials = intOpt(values.trials, rc.trials, '--trials');
  const concurrency = intOpt(values.concurrency, rc.concurrency, '--concurrency');
  const maxAttempts = intOpt(values['max-attempts'], rc.maxAttempts, '--max-attempts');
  const defaultTimeoutSec = intOpt(values.timeout, rc.timeoutSec, '--timeout');
  const cooldownMs = values['cooldown-min']
    ? intOpt(values['cooldown-min'], 30, '--cooldown-min') * 60_000
    : rc.rateWindow.cooldownMs;
  const docsConditions = parseDocs(values.docs);

  const tasks = await discoverTasks(evalsRoot, splitList(values.tasks));
  if (tasks.length === 0) {
    process.stderr.write(
      `no tasks matched under ${evalsRoot}` +
        (values.tasks ? ` for ${splitList(values.tasks).join(', ')}` : '') +
        '\n',
    );
    return 2;
  }
  const configs = selectConfigs(rc.configs, splitList(values.configs), {
    includeDisabled: values['include-disabled'] === true,
  });
  if (configs.length === 0) {
    process.stderr.write('no configs selected (are they all disabled?)\n');
    return 2;
  }
  for (const c of configs) {
    if (!hasAdapter(c.harness)) {
      throw new ConfigError(
        `config "${c.id}" uses harness "${c.harness}" which has no adapter yet — see the TODO in config.ts`,
      );
    }
  }

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  // Built per config so a config that pins itself to one docs condition (the
  // `docsCondition` field) contributes only that half of the grid.
  const cells = configs.flatMap((c) =>
    buildCells({
      taskIds: tasks.map((t) => t.id),
      configIds: [c.id],
      docsConditions: c.docsCondition ? [c.docsCondition] : docsConditions,
      trials,
    }),
  );

  // Checkpoint: resume or create.
  let cp: Checkpoint;
  if (values.resume) {
    cp = await resumeRun(values.resume, resultsRoot);
    const added = await cp.ensureCells(cells);
    process.stdout.write(`resuming ${cp.runId}: ${added} new cell(s) added\n`);
  } else {
    const runId = newRunId();
    const meta: RunMeta = {
      concurrency,
      trials,
      docsConditions,
      maxAttempts,
      cooldownMs,
      evalsRoot,
      resultsRoot,
      configs: await Promise.all(
        configs.map(async (c) => ({
          id: c.id,
          harness: c.harness,
          model: c.model,
          reasoningEffort: c.reasoningEffort,
          cliVersion: await cliVersionFor(c),
        })),
      ),
      taskIds: tasks.map((t) => t.id),
      provenance: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        startedAt: new Date().toISOString(),
      },
    };
    cp = await Checkpoint.create({ runId, resultsRoot, meta, cells });
    process.stdout.write(`run ${runId}\n`);
  }

  const summary = cp.summary();
  process.stdout.write(
    `${tasks.length} task(s) × ${configs.length} config(s) × ${docsConditions.join('/')} × ${trials} trial(s) ` +
      `= ${summary.total} cell(s); ${summary.done} already done, ${summary.pending} pending\n`,
  );

  if (values['dry-run']) {
    for (const cell of cp.pending().slice(0, 50)) {
      process.stdout.write(`  would run ${cellKey(cell)}\n`);
    }
    if (summary.pending > 50) process.stdout.write(`  … and ${summary.pending - 50} more\n`);
    return 0;
  }

  const patterns = compilePatterns(rc.rateWindow.patterns);
  const tokens = TokenPool.fromEnv();
  const needsLive = tasks.some((t) => t.runtime === 'live');
  if (needsLive && tokens.isEmpty) {
    process.stderr.write(
      'warning: live tasks selected but no NOTION_API_TOKEN / NOTIONBENCH_NOTION_TOKENS in env\n',
    );
  }

  const scheduler = new Scheduler({ concurrency, cooldownMs, maxAttempts });
  scheduler.enqueue(cp.pending().map((c) => ({ ...c, attempts: c.attempts })));

  const configById = new Map(configs.map((c) => [c.id, c]));
  const abort = new AbortController();
  const onSigint = () => {
    process.stderr.write('\ninterrupted — finishing in-flight trials, state is checkpointed\n');
    abort.abort();
  };
  process.once('SIGINT', onSigint);

  await runQueue(scheduler, {
    signal: abort.signal,
    onEvent: (e) => {
      if (e.type === 'config-paused') {
        const mins = Math.round(((e.untilMs ?? 0) - Date.now()) / 60_000);
        process.stdout.write(`  [rate window] pausing ${e.configId} for ~${mins}m\n`);
      } else if (e.type === 'config-resumed') {
        process.stdout.write(`  [rate window] resuming ${e.configId}\n`);
      }
    },
    execute: (cell) =>
      executeCell({
        cell,
        cp,
        config: configById.get(cell.configId)!,
        task: taskById.get(cell.taskId)!,
        resultsRoot,
        defaultTimeoutSec,
        killGraceMs: rc.killGraceMs,
        cooldownMs,
        patterns,
        tokens,
        keepWorkspaces: values['keep-workspaces'] === true,
        signal: abort.signal,
      }),
  });

  process.off('SIGINT', onSigint);
  const final = cp.summary();
  process.stdout.write(
    `\ndone: ${final.done}/${final.total}  failed ${final.failed}  pending ${final.pending}\n` +
      `resume with: notionbench run --resume ${cp.runId}\n`,
  );
  return final.failed > 0 ? 1 : 0;
}

async function executeCell(args: {
  cell: QueueCell;
  cp: Checkpoint;
  config: AgentConfig;
  task: TaskSpec;
  resultsRoot: string;
  defaultTimeoutSec: number;
  killGraceMs: number;
  cooldownMs: number;
  patterns: ReturnType<typeof compilePatterns>;
  tokens: TokenPool;
  keepWorkspaces: boolean;
  signal: AbortSignal;
}): Promise<CellOutcome> {
  const { cell, cp, config, task } = args;
  const coords: CellCoords = {
    taskId: cell.taskId,
    configId: cell.configId,
    docsCondition: cell.docsCondition,
    trial: cell.trial,
  };
  await cp.markRunning(coords);

  const workspace = await prepareWorkspace({
    taskDir: task.dir,
    docsCondition: cell.docsCondition,
    docsBundle: docsBundleFor(task),
    label: `${task.id.replace(/\//g, '-')}-${config.id}-t${cell.trial}`,
    keep: args.keepWorkspaces,
  });
  const lease = task.runtime === 'live' ? await args.tokens.acquire() : undefined;

  try {
    const prompt = await readPrompt(task);
    const timeoutSec = task.limits?.time ?? args.defaultTimeoutSec;
    const outcome = await runTrial({
      config,
      identity: { runId: cp.runId, ...coords },
      prompt,
      workspaceDir: workspace.dir,
      trialDir: path.join(args.resultsRoot, cp.runId, trialDirFor(coords)),
      timeoutMs: timeoutSec * 1000,
      killGraceMs: args.killGraceMs,
      notionHome: workspace.notionHome,
      notionApiToken: lease?.token,
      ratePatterns: args.patterns,
      defaultCooldownMs: args.cooldownMs,
      signal: args.signal,
    });

    process.stdout.write(
      `  ${pad(outcome.status, 13)} ${cellKey(coords)}  ${(outcome.durationMs / 1000).toFixed(0)}s  ` +
        `${outcome.usage?.totalTokens ?? '?'} tok  ${outcome.parsed.toolCalls} calls/${outcome.parsed.toolErrors} err\n`,
    );

    if (outcome.status === 'rate_limited') {
      await cp.markRateLimited(coords, outcome.rateLimit.signals[0]?.excerpt ?? 'usage window exhausted');
      return { kind: 'rate-limited', cooldownMs: outcome.rateLimit.cooldownMs, detail: 'usage window' };
    }
    if (outcome.status === 'spawn_error') {
      await cp.markFailed(coords, outcome.error ?? 'spawn error', outcome.status);
      return { kind: 'failed', detail: outcome.error };
    }

    // A non-zero exit or a timeout is still a *recorded trial*: the agent got its
    // wall clock and produced a trajectory, and the verifier — not the runner —
    // decides whether that trajectory solved the task. Marking it done here means
    // "we have a transcript to score", not "the model passed".
    await cp.markDone(coords, outcome);
    return { kind: 'done' };
  } catch (err) {
    await cp.markFailed(coords, (err as Error).message);
    return { kind: 'failed', detail: (err as Error).message };
  } finally {
    lease?.release();
    await workspace.cleanup();
  }
}

function docsBundleFor(task: TaskSpec): DocsBundle | undefined {
  if (task.family === 'nac') return 'nac';
  if (task.family === 'workers') return 'workers';
  // `<task>/fixture/docs` still applies for everything else.
  return undefined;
}

async function cliVersionFor(config: AgentConfig): Promise<string | undefined> {
  try {
    const adapter = getAdapter(config.harness);
    const inv = adapter.buildInvocation(config, { prompt: '', workspaceDir: process.cwd() });
    return await getCliVersion(inv.command, inv.versionArgs);
  } catch {
    return undefined;
  }
}

function parseDocs(value: string | undefined): DocsCondition[] {
  const v = (value ?? 'both').toLowerCase();
  if (v === 'both') return [...DOCS_CONDITIONS];
  if (v === 'with' || v === 'without') return [v];
  throw new ConfigError(`--docs must be one of with|without|both (got "${value}")`);
}

function splitList(values: string[] | undefined): string[] {
  if (!values) return [];
  return values
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function intOpt(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${flag} must be a positive number`);
  return Math.floor(n);
}

async function defaultRunconfigPath(explicit: string | undefined): Promise<string | undefined> {
  if (explicit) return explicit;
  const candidate = path.resolve('runconfig.json');
  const { access } = await import('node:fs/promises');
  try {
    await access(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

// Only run when invoked as a program, not when imported by tests.
const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('cli.js') || process.argv[1].endsWith('cli.ts'));
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
