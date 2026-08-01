#!/usr/bin/env node
/**
 * notionbench CLI.
 *
 *   notionbench run --tasks <glob> --configs <a,b> --trials 5 --docs both
 *   notionbench run --dry-run
 *   notionbench run --resume <runId>
 *   notionbench score <runDir>
 *   notionbench status <runId>
 *   notionbench serve <runDir>
 *   notionbench configs
 *   notionbench tasks --tasks <glob>
 */

import { parseArgs } from 'node:util';
import { readFile, readdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { DEFAULT_TEMPLATES_DIR, prepareWorkspace, type DocsBundle } from '@notionbench/sandbox';
import {
  DEFAULT_SCORE_TIMEOUT_MS,
  appendResult,
  buildReport,
  hasScorer,
  readResults,
  renderReport,
} from '@notionbench/scoring';
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
import {
  Scheduler,
  runQueue,
  writeRateWindowState,
  type CellOutcome,
  type QueueCell,
} from './queue.js';
import { DEFAULT_HOST, DEFAULT_PORT, defaultWebRoot, serve } from './serve.js';
import { compilePatterns } from './rate-limit.js';
import { buildPlan, renderPlan } from './plan.js';
import { isScorable, scoreTrial, unscoredRecord } from './score.js';
import { getCliVersion, runTrial } from './spawn.js';
import { discoverTasks, readPrompt } from './tasks.js';
import { TokenPool } from './token-pool.js';
import { DOCS_CONDITIONS, type DocsCondition, type TaskSpec } from './types.js';

const USAGE = `notionbench — run agent CLIs against the Notion developer-platform benchmark

Usage:
  notionbench run [options]
  notionbench score <runDir|runId> [--k <n>] [--results <dir>] [--json]
  notionbench status <runId> [--results <dir>] [--json]
  notionbench serve <runDir|runId> [--port <n>] [--key <token>] [--host <addr>]
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
  --score-timeout <sec> Per-trial verification budget. Default 600.
  --no-score            Record rollouts without running the verifiers.
  --dry-run             Print the execution plan and exit; spawn nothing.
  -h, --help            This message.

score options:
  --k <n>               Trials per task to count. Default: the largest k every
                        task in the run supports.
  --results <dir>       Results root, when a bare runId is given. Default results/
  --json                Emit the report as JSON instead of markdown.

serve options:
  --port <n>            Listen port. Default 8377.
  --host <addr>         Bind address. Default 127.0.0.1 (loopback only).
  --key <token>         Bearer token for /api/status. Default: a fresh random
                        token, printed at startup.
  --web <dir>           Static dashboard directory. Default: the repo's web/.
  --results <dir>       Results root, when a bare runId is given. Default results/

\`run\` does spawn -> score -> checkpoint per trial and appends every scored
rollout to results/<runId>/results.jsonl; \`score\` aggregates that file into
results/<runId>/summary.md and prints it. \`serve\` reads a run directory (while
it is still being written) and hosts the live dashboard + /api/status.
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
  'score-timeout': { type: 'string' },
  'no-score': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  port: { type: 'string' },
  host: { type: 'string' },
  key: { type: 'string' },
  web: { type: 'string' },
  k: { type: 'string' },
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
      case 'score':
        return await cmdScore(values, positionals[1]);
      case 'status':
        return await cmdStatus(values, positionals[1]);
      case 'serve':
        return await cmdServe(values, positionals[1]);
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
  process.stdout.write(`  rate-limited attempts (not charged): ${summary.rateLimitedAttempts}\n`);
  process.stdout.write(
    `  verified ${summary.scored}  solved ${summary.solved}` +
      (summary.unverified > 0 ? `  unverified ${summary.unverified}` : '') +
      '\n\n',
  );
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

/**
 * Host the live dashboard for a run that is (usually) still executing.
 *
 * Read-only by construction: it opens no checkpoint, takes no lock, and re-reads
 * state.json/results.jsonl only when their mtime changes, so pointing it at the
 * directory a run is actively writing is safe.
 */
async function cmdServe(values: Values, target: string | undefined): Promise<number> {
  const runconfigPath = await defaultRunconfigPath(values.runconfig);
  const rc = await loadRunConfig(runconfigPath);
  const resultsRoot = path.resolve(values.results ?? rc.resultsRoot);
  const runDir = await resolveRunDir(target, resultsRoot);
  if (!runDir) {
    process.stderr.write(
      `serve requires a run directory or run id (looked under ${resultsRoot})\n`,
    );
    return 2;
  }
  if (!(await isDir(runDir))) {
    process.stderr.write(`not a run directory: ${runDir}\n`);
    return 2;
  }

  const port = values.port ? intOpt(values.port, 0, '--port') : DEFAULT_PORT;
  const handle = await serve({
    runDir,
    port,
    host: values.host ?? DEFAULT_HOST,
    key: values.key,
    runconfigPath,
    webRoot: values.web,
  });

  process.stdout.write(
    `notionbench serve — ${runDir}\n` +
      `  dashboard  ${handle.url}\n` +
      `  api        http://${handle.host}:${handle.port}/api/status  (Authorization: Bearer ${handle.key})\n` +
      `  static     ${path.resolve(values.web ?? defaultWebRoot())}\n` +
      (values.key ? '' : '  (token generated for this process; pass --key to pin one)\n') +
      `  Ctrl-C to stop\n`,
  );

  await new Promise<void>((resolve) => {
    const stop = () => {
      process.stdout.write('\nstopping\n');
      void handle.close().then(resolve, resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    handle.server.once('close', resolve);
  });
  return 0;
}

/**
 * Aggregate a run's `results.jsonl` into the published table.
 *
 * Reads nothing but results.jsonl — no state.json, no transcripts — so an
 * archived results tree scores identically years later.
 */
async function cmdScore(values: Values, target: string | undefined): Promise<number> {
  const rc = await loadRunConfig(await defaultRunconfigPath(values.runconfig));
  const resultsRoot = path.resolve(values.results ?? rc.resultsRoot);
  const runDir = await resolveRunDir(target, resultsRoot);
  if (!runDir) {
    process.stderr.write(
      `score requires a run directory or run id (looked under ${resultsRoot})\n`,
    );
    return 2;
  }

  let records: Awaited<ReturnType<typeof readResults>>['records'];
  let problems: Awaited<ReturnType<typeof readResults>>['problems'];
  try {
    ({ records, problems } = await readResults(runDir));
  } catch (err) {
    // A run that has not scored anything yet is an operator mistake, not a bug.
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
  for (const p of problems) {
    process.stderr.write(`warning: ${path.join(runDir, 'results.jsonl')}:${p.line}: ${p.reason}\n`);
  }
  if (records.length === 0) {
    process.stderr.write(`no scored trials in ${runDir}\n`);
    return 1;
  }

  const report = buildReport(records, {
    runId: path.basename(await realRunDir(runDir)),
    k: values.k ? intOpt(values.k, 0, '--k') : undefined,
  });

  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  const markdown = renderReport(report);
  const summaryPath = path.join(runDir, 'summary.md');
  await writeFile(summaryPath, markdown, 'utf8');
  process.stdout.write(markdown);
  process.stdout.write(`\nwritten to ${summaryPath}\n`);
  return 0;
}

/** Accept `results/<runId>`, a bare `<runId>`, or `results/latest`. */
async function resolveRunDir(target: string | undefined, resultsRoot: string): Promise<string | undefined> {
  const candidates = target
    ? [path.resolve(target), path.join(resultsRoot, target)]
    : [path.join(resultsRoot, 'latest')];
  for (const candidate of candidates) {
    if (await isDir(candidate)) return candidate;
  }
  // No `latest` link: fall back to the newest run directory (ids sort by time).
  if (!target && (await isDir(resultsRoot))) {
    const entries = (await readdir(resultsRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const newest = entries[entries.length - 1];
    if (newest) return path.join(resultsRoot, newest);
  }
  return undefined;
}

async function realRunDir(runDir: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  try {
    return await realpath(runDir);
  } catch {
    return runDir;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

async function cmdRun(values: Values): Promise<number> {
  const runconfigPath = await defaultRunconfigPath(values.runconfig);
  const rc = await loadRunConfig(runconfigPath);
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
  const scoringEnabled = values['no-score'] !== true;
  const scoreTimeoutMs = values['score-timeout']
    ? intOpt(values['score-timeout'], 0, '--score-timeout') * 1000
    : DEFAULT_SCORE_TIMEOUT_MS;

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
  const tokens = TokenPool.fromEnv();

  // --dry-run answers "what exactly is about to happen" and must therefore
  // change nothing: no `<cli> --version` probes, no run directory, no state.
  if (values['dry-run']) {
    const prompts = new Map<string, string>();
    const verifiers = new Set<string>();
    for (const task of tasks) {
      prompts.set(task.id, await readPrompt(task));
      if (await hasScorer(task.dir)) verifiers.add(task.id);
    }
    const plan = buildPlan({
      tasks,
      configs,
      docsConditions,
      trials,
      concurrency,
      maxAttempts,
      defaultTimeoutSec,
      cooldownMs,
      evalsRoot,
      resultsRoot,
      runconfigPath,
      scoring: { enabled: scoringEnabled, timeoutMs: scoreTimeoutMs },
      prompts,
      verifiers,
      notionTokens: tokens.size,
      templatesDir: DEFAULT_TEMPLATES_DIR,
    });
    if (values.json) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderPlan(plan)}\n`);
    }
    return 0;
  }

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
  await linkLatest(resultsRoot, cp.runId);
  const runDir = path.join(resultsRoot, cp.runId);

  const summary = cp.summary();
  process.stdout.write(
    `${tasks.length} task(s) × ${configs.length} config(s) × ${docsConditions.join('/')} × ${trials} trial(s) ` +
      `= ${summary.total} cell(s); ${summary.done} already done, ${summary.pending} pending\n`,
  );

  const patterns = compilePatterns(rc.rateWindow.patterns);
  const needsLive = tasks.some((t) => t.runtime === 'live');
  if (needsLive && tokens.isEmpty) {
    process.stderr.write(
      'warning: live tasks selected but no NOTION_API_TOKEN / NOTIONBENCH_NOTION_TOKENS in env\n',
    );
  }

  const scheduler = new Scheduler({
    concurrency,
    cooldownMs,
    maxAttempts,
    // Mirror cooldown/blocked next to state.json so `notionbench serve` — a
    // separate process — can report them. Best effort: a failed mirror write
    // must never interrupt a multi-day run.
    onRateWindowChange: (s) => {
      void writeRateWindowState(runDir, s).catch(() => {});
    },
  });
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
        runDir,
        scoringEnabled,
        scoreTimeoutMs,
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
      `scored: ${final.solved}/${final.scored} solved` +
      (final.unverified > 0 ? `  (${final.unverified} unverified)` : '') +
      '\n' +
      `resume with: notionbench run --resume ${cp.runId}\n` +
      `report with: notionbench score ${path.relative(process.cwd(), runDir) || runDir}\n`,
  );
  return final.failed > 0 ? 1 : 0;
}

/**
 * `results/latest` -> the run just started, so the README's
 * `notionbench score results/latest` works without copying a run id around.
 * Best effort: a filesystem without symlinks is not a reason to abort a run.
 */
async function linkLatest(resultsRoot: string, runId: string): Promise<void> {
  const link = path.join(resultsRoot, 'latest');
  try {
    await unlink(link);
  } catch {
    /* nothing to replace */
  }
  try {
    await symlink(runId, link, 'dir');
  } catch {
    /* symlinks unavailable; `notionbench score <runId>` still works */
  }
}

/**
 * One cell, start to finish: **spawn → score → checkpoint**.
 *
 * The order is the contract. The verifier needs the trial workspace, which is
 * deleted in `finally`, so scoring happens before cleanup; and the results row
 * is appended before the cell is marked done, so an interrupted run never
 * leaves a cell claiming a verdict that was never written.
 */
async function executeCell(args: {
  cell: QueueCell;
  cp: Checkpoint;
  config: AgentConfig;
  task: TaskSpec;
  resultsRoot: string;
  /** `results/<runId>` — where results.jsonl is appended. */
  runDir: string;
  scoringEnabled: boolean;
  scoreTimeoutMs: number;
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
    // decides whether that trajectory solved the task.
    if (!args.scoringEnabled || !isScorable(outcome.status)) {
      await appendResult(
        args.runDir,
        unscoredRecord({
          task,
          config,
          outcome,
          runId: cp.runId,
          runDir: args.runDir,
          reason: args.scoringEnabled ? `not scored: status ${outcome.status}` : 'scoring disabled (--no-score)',
        }),
      );
      await cp.markDone(coords, outcome);
      return { kind: 'done' };
    }

    const { score } = await scoreTrial({
      task,
      config,
      outcome,
      workspaceDir: workspace.dir,
      runId: cp.runId,
      runDir: args.runDir,
      timeoutMs: args.scoreTimeoutMs,
      signal: args.signal,
    });

    process.stdout.write(
      `  ${pad(score.ok ? (score.score >= 1 ? 'PASS' : 'FAIL') : 'UNVERIFIED', 13)} ${cellKey(coords)}  ` +
        `score=${score.ok ? score.score : '?'}  ${(score.durationMs / 1000).toFixed(0)}s verify` +
        (score.ok ? '' : `  ${firstLine(score.error ?? '')}`) +
        '\n',
    );

    // Checkpoint last: the results row is already durable, so a crash here costs
    // a re-run of the cell, never a cell that claims a verdict nothing recorded.
    await cp.markDone(coords, outcome, {
      score: score.score,
      scored: score.ok,
      error: score.error,
    });
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
