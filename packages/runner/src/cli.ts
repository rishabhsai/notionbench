#!/usr/bin/env node
/**
 * notionbench CLI.
 *
 *   notionbench run --tasks <glob> --configs <a,b> --trials 5 --docs both
 *   notionbench run --dry-run
 *   notionbench run --resume <runId>
 *   notionbench run --resume <runId> --redo <taskId>
 *   notionbench score <runDir>
 *   notionbench status <runId>
 *   notionbench serve <runDir>
 *   notionbench doctor <runDir>
 *   notionbench configs
 *   notionbench tasks --tasks <glob>
 */

import { parseArgs } from 'node:util';
import { readFile, readdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { snapshotWorkspace } from './artifacts.js';
import process from 'node:process';
import { DEFAULT_TEMPLATES_DIR, prepareWorkspace, type DocsBundle } from '@notionbench/sandbox';
import {
  DEFAULT_SCORE_TIMEOUT_MS,
  appendResult,
  buildReport,
  hasScorer,
  readResults,
  renderReport,
  supersedeResults,
} from '@notionbench/scoring';
import {
  Checkpoint,
  buildCells,
  cellKey,
  claimRunId,
  trialDirFor,
  type CellCoords,
  type RunMeta,
  type RunStateFile,
} from './checkpoint.js';
import { ConfigError, loadRunConfig, selectConfigs, type AgentConfig } from './config.js';
import {
  AckError,
  ackFlag,
  buildAcknowledgments,
  mergeAcknowledgments,
  newAcknowledgments,
  parseAckFlags,
  renderAcknowledgments,
  requireAckReason,
  type Acknowledgment,
} from './ack.js';
import {
  RUN_SPEC_FILENAME,
  createRunSpec,
  describeGrid,
  detectDrift,
  diffGrid,
  driftLines,
  expandSpec,
  gridCells as expandGrid,
  isSeriousDrift,
  readRunSpec,
  reconstructSpec,
  recordAcks,
  recordDrift,
  recordRedo,
  renderRefusal,
  specAcknowledgments,
  specCells,
  writeRunSpec,
  type ConfigDrift,
  type GridDiff,
  type RequestedAxes,
  type RunSpecExecution,
  type RunSpecFile,
  type SpecConfig,
} from './run-spec.js';
import { DEFAULT_ORDER, LEGACY_ORDER, cellRanker, parseOrder, type OrderPolicy } from './order.js';
import { buildDoctorReport, renderDoctorReport } from './doctor.js';
import {
  WATCHDOG_EXIT_CODE,
  Watchdog,
  freeDiskBytes,
  renderAlertBanner,
  writeAlertFile,
  type WatchdogAlert,
  type WatchdogObservation,
} from './watchdog.js';
import {
  LiveFixtures,
  appendRunLog,
  inspectLiveTasks,
  liveRequirementProblems,
  renderLiveProblems,
  resolveLiveSettings,
  type ProvisionedFixture,
} from './live.js';
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
import { buildPlan, renderPlan, type ResumePlan } from './plan.js';
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
  notionbench doctor <runDir|runId> [--results <dir>] [--json]
  notionbench configs [--runconfig <path>] [--json]
  notionbench tasks [--tasks <glob>] [--evals <dir>] [--json]

run options:
  --tasks <glob>        Task id glob, repeatable/comma-separated. Default: all.
                        e.g. --tasks 'build-nac-*' --tasks 'resolve-workers-**'
  --configs <list>      Comma-separated config ids. Default: all enabled.
  --trials <n>          Trials per (task, config, docs) cell. Default 5.
  --docs <with|without|both>
                        Docs axis condition(s). Default: both.
  --resume <runId>      Continue an existing run, replaying the grid recorded in
                        results/<runId>/run-spec.json exactly: the same tasks,
                        configs (with the harness/model/effort/pricing resolved
                        at launch), docs conditions and trials. Done cells are
                        skipped. runconfig.json and the flag defaults above are
                        NOT consulted for the grid — only to report drift.
  --expand              With --resume: allow this invocation to ADD cells to the
                        run, and record the expansion in the spec. Without it, a
                        resume that would grow the grid is refused, naming what
                        differs.
  --redo <taskId>       With --resume: FIX-AND-RE-RUN ONE TASK. Invalidates every
                        recorded cell of <taskId> — resets them to pending and
                        retires their rows from results.jsonl into
                        results.superseded.jsonl — then runs only those cells.
                        Repeatable/comma-separated. This is the command to use
                        after the watchdog (or \`notionbench doctor\`) says a task
                        was broken: fix evals/<taskId>, then

                            notionbench run --resume <runId> --redo <taskId>

                        Nothing is deleted and no other task is touched. Add
                        --dry-run to see exactly what would be invalidated.
  --order <policy>      Cell execution order. One of:
                          trial-major,task-major  (default) trial 1 of every
                            (task, config) first; within a trial, every config
                            runs task 1 before any runs task 2. The first pass
                            covers all tasks, so a broken task shows up as
                            several configs failing it identically within
                            minutes instead of days.
                          config-major  each config walks its own task list —
                            what the runner did implicitly before; kept for
                            comparison.
                        Recorded in run-spec.json and replayed on --resume.
  --no-watchdog         Disable the in-process watchdog (see below).
  --watchdog-warn-only  Watchdog alerts are recorded and printed, but never stop
                        the run.
  --ack <task[:text]>   ACKNOWLEDGE ONE KNOWN-LEGITIMATE FAILURE SIGNATURE.
                        Repeatable/comma-separated. Requires --ack-reason.
                        The watchdog still detects it, still writes it to
                        ALERT.json and still shows it in \`doctor\` and the
                        dashboard — at level "acknowledged", with your reason —
                        but it no longer halts the run. Everything else stays
                        protected, unlike --no-watchdog/--watchdog-warn-only.

                            --ack resolve-instructions-001-workflow-canary:invalidtoolinputerror \\
                              --ack-reason "reviewed: the prompt asks for zeros on an unknown
                                category; these configs pinned the tool schema to an enum. Real miss."

                        With :text, only a shared diagnostic CONTAINING that
                        text is acknowledged, so a different failure mode on the
                        same task still halts — always prefer this form. Bare
                        --ack <taskId> acknowledges the cross-config-identical-
                        failure and total-task-failure signals for that whole
                        task. Matching is against the NORMALIZED diagnostic
                        (lower-cased, ids/paths/numbers replaced).
                        Verifier crashes and fixture-provisioning failures can
                        NEVER be acknowledged — they are the measurement
                        apparatus failing, not the agent — and --ack refuses to
                        name them. Acknowledgments are recorded in
                        run-spec.json and replayed automatically on --resume.
  --ack-reason "<text>" Why the acknowledged failure is a real agent failure.
                        Mandatory with --ack; stored in run-spec.json and
                        ALERT.json so a published run shows every suppression
                        and its justification.
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
  --no-teardown         Keep provisioned live fixtures instead of archiving them
                        after scoring (debugging). Every kept root is logged as
                        an ORPHAN in results/<runId>/run.log.
  --dry-run             Print the execution plan and exit; spawn nothing.
  -h, --help            This message.

live tasks (runtime: live with a fixture/spec.json) additionally need:
  NOTION_API_TOKEN      integration token (NOTIONBENCH_NOTION_TOKENS=a,b for a pool)
  NOTION_PARENT_PAGE_ID page shared with the integration; every per-trial fixture
                        root is created under it and archived after scoring
                        (or runconfig.json's "notion": {"parentPageId": "…"})
  NOTION_API_BASE       optional API root override (or "notion": {"apiBase": …})

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

doctor options:
  --json                Emit the report as JSON instead of text.
  --results <dir>       Results root, when a bare runId is given. Default results/

the watchdog (deterministic, no model; thresholds under "watchdog" in runconfig)
  Evaluated after every scored cell. It halts the run when a task looks INVALID
  rather than hard:
    - ≥3 configs (or ≥60% of those that attempted) fail the same task in the same
      trial and their diagnostics share a normalized substring — the signature of
      a verifier bug, not of three independent models;
    - any verifier crash / malformed verdict (one is enough — never an agent
      failure);
    - 2 fixture provisioning failures on the same live task.
  It WARNS (does not halt) when every config scores 0 on a task with no shared
  diagnostic — that is what a very hard task and a broken one both look like.
  On halt: scheduling stops, in-flight cells finish and are scored, ALERT.json
  and a run.log banner are written, and the process exits ${WATCHDOG_EXIT_CODE}.
  Then: fix the task and \`notionbench run --resume <runId> --redo <taskId>\`.
  If instead you reviewed the failure and it is REAL — the task is fine and the
  agents genuinely failed it the same way — re-run with
  \`--ack <taskId>:<substring> --ack-reason "<why>"\`: that one signature is
  recorded as acknowledged and stops halting, every other task stays protected,
  and \`doctor\` lists the acknowledgment and its reason so nothing hides.

\`run\` does spawn -> score -> checkpoint per trial and appends every scored
rollout to results/<runId>/results.jsonl; \`score\` aggregates that file into
results/<runId>/summary.md and prints it. \`serve\` reads a run directory (while
it is still being written) and hosts the live dashboard + /api/status.
\`doctor\` is the read-only post-hoc audit of a finished or halted run: per-task
failure patterns, which tasks' failures share diagnostics, verifier crashes, and
a plain-English "these tasks look invalid, investigate before publishing".
`;

type Argv = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;

const OPTIONS = {
  tasks: { type: 'string', multiple: true },
  configs: { type: 'string', multiple: true },
  trials: { type: 'string' },
  docs: { type: 'string' },
  resume: { type: 'string' },
  expand: { type: 'boolean' },
  redo: { type: 'string', multiple: true },
  order: { type: 'string' },
  'no-watchdog': { type: 'boolean' },
  'watchdog-warn-only': { type: 'boolean' },
  ack: { type: 'string', multiple: true },
  'ack-reason': { type: 'string' },
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
  'no-teardown': { type: 'boolean' },
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
        return await cmdRun(values, argv);
      case 'score':
        return await cmdScore(values, positionals[1]);
      case 'status':
        return await cmdStatus(values, positionals[1]);
      case 'serve':
        return await cmdServe(values, positionals[1]);
      case 'doctor':
        return await cmdDoctor(values, positionals[1]);
      case 'configs':
        return await cmdConfigs(values);
      case 'tasks':
        return await cmdTasks(values);
      default:
        process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof AckError) {
      // A refused or malformed --ack is an operator mistake, and the message is
      // the whole product: it says what cannot be acknowledged and why.
      process.stderr.write(`--ack refused: ${err.message}\n`);
      return 2;
    }
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
 * `notionbench doctor <runDir>` — audit a finished or halted run before writing
 * it up.
 *
 * Read-only in the same sense `serve` is: it opens no checkpoint, takes no lock,
 * writes nothing, and is safe to point at a directory a run is still writing.
 *
 * Exit code carries the verdict, so it is usable as a publish gate in CI:
 *   0  no task shows an unreviewed cross-config failure signature — including
 *      the `acknowledged` verdict, where every such signature was reviewed by a
 *      human and recorded with its reason (the report says so loudly, and the
 *      gate lets it through: that is the whole point of an acknowledgment)
 *   1  at least one task is SUSPECT (all configs scored 0, different reasons)
 *   3  at least one task looks INVALID (shared diagnostic, or a verifier crash)
 */
async function cmdDoctor(values: Values, target: string | undefined): Promise<number> {
  const rc = await loadRunConfig(await defaultRunconfigPath(values.runconfig));
  const resultsRoot = path.resolve(values.results ?? rc.resultsRoot);
  const runDir = await resolveRunDir(target, resultsRoot);
  if (!runDir) {
    process.stderr.write(
      `doctor requires a run directory or run id (looked under ${resultsRoot})\n`,
    );
    return 2;
  }
  if (!(await isDir(runDir))) {
    process.stderr.write(`not a run directory: ${runDir}\n`);
    return 2;
  }

  const report = await buildDoctorReport(runDir, { settings: rc.watchdog });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderDoctorReport(report)}\n`);
  }
  if (report.verdict.level === 'invalid') return WATCHDOG_EXIT_CODE;
  return report.verdict.level === 'suspect' ? 1 : 0;
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

async function cmdRun(values: Values, argv: string[]): Promise<number> {
  const runconfigPath = await defaultRunconfigPath(values.runconfig);
  const rc = await loadRunConfig(runconfigPath);
  const resultsRoot = path.resolve(values.results ?? rc.resultsRoot);
  const dryRun = values['dry-run'] === true;

  if (values.expand === true && !values.resume) {
    throw new ConfigError('--expand only applies with --resume (it extends an existing run)');
  }
  if (splitList(values.redo).length > 0 && !values.resume) {
    throw new ConfigError(
      '--redo only applies with --resume: it invalidates and re-runs a task\'s cells inside an ' +
        'existing run. Use `notionbench run --resume <runId> --redo <taskId>`.',
    );
  }

  // --ack is parsed before anything is read or written, so a refusal (an
  // apparatus fault named, a missing reason) costs nothing and is the first
  // thing the operator sees. `parseAckFlags` is where "verifier crashes are
  // never acknowledgeable" is *explained*; `matchAck` is where it is enforced.
  const ackSpecs = parseAckFlags(values.ack);
  const ackReason = requireAckReason(ackSpecs, values['ack-reason']);

  // The grid a run measures is decided ONCE, at creation, and recorded in
  // results/<runId>/run-spec.json. A resume replays that; it never rebuilds the
  // grid from today's runconfig.json or from the defaults of the flags that were
  // omitted this time. (Run 20260801-085000: a bare --resume of a 35-cell run
  // re-expanded it to 3,120 cells and started executing. See run-spec.ts.)
  const replay = values.resume
    ? await resolveReplay({ runId: values.resume, resultsRoot, rc, runconfigPath, argv, values })
    : undefined;
  if (typeof replay === 'number') return replay;
  if (replay && !dryRun) printReplay(replay);

  const evalsRoot = path.resolve(values.evals ?? replay?.spec.execution.evalsRoot ?? rc.evalsRoot);
  const trials = replay ? replay.spec.grid.trials : intOpt(values.trials, rc.trials, '--trials');
  const concurrency = intOpt(
    values.concurrency,
    replay?.spec.execution.concurrency ?? rc.concurrency,
    '--concurrency',
  );
  const maxAttempts = intOpt(
    values['max-attempts'],
    replay?.spec.execution.maxAttempts ?? rc.maxAttempts,
    '--max-attempts',
  );
  const defaultTimeoutSec = intOpt(
    values.timeout,
    replay?.spec.execution.defaultTimeoutSec ?? rc.timeoutSec,
    '--timeout',
  );
  const killGraceMs = replay?.spec.execution.killGraceMs ?? rc.killGraceMs;
  const cooldownMs = values['cooldown-min']
    ? intOpt(values['cooldown-min'], 30, '--cooldown-min') * 60_000
    : (replay?.spec.execution.cooldownMs ?? rc.rateWindow.cooldownMs);
  const docsConditions = replay ? replay.spec.grid.docsConditions : parseDocs(values.docs);
  const scoringEnabled =
    values['no-score'] === true ? false : (replay?.spec.execution.scoring.enabled ?? true);
  const scoreTimeoutMs = values['score-timeout']
    ? intOpt(values['score-timeout'], 0, '--score-timeout') * 1000
    : (replay?.spec.execution.scoring.timeoutMs ?? DEFAULT_SCORE_TIMEOUT_MS);

  // Ordering, like every other execution knob: a flag typed on THIS command line
  // wins; otherwise the recorded policy is replayed; otherwise the default. A
  // resumed run that predates the policy is replayed as `config-major` — the
  // order it actually executed in — not as today's default, because a resume
  // replays the run, it does not redesign it.
  const order: OrderPolicy = values.order
    ? parseOrder(values.order)
    : (replay?.spec.execution.order ?? (replay ? LEGACY_ORDER : DEFAULT_ORDER));

  const watchdogSettings = {
    ...rc.watchdog,
    enabled: values['no-watchdog'] === true ? false : rc.watchdog.enabled,
    warnOnly: values['watchdog-warn-only'] === true ? true : rc.watchdog.warnOnly,
  };

  const taskPatterns = replay ? replay.taskIds : splitList(values.tasks);
  const tasks = await discoverTasks(evalsRoot, taskPatterns);
  if (tasks.length === 0) {
    process.stderr.write(
      `no tasks matched under ${evalsRoot}` +
        (taskPatterns.length > 0 ? ` for ${taskPatterns.join(', ')}` : '') +
        '\n',
    );
    return 2;
  }
  if (replay) {
    const found = new Set(tasks.map((t) => t.id));
    const missing = replay.taskIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      process.stderr.write(
        `run ${replay.spec.runId} recorded ${missing.length} task(s) that no longer exist under ` +
          `${evalsRoot}: ${missing.join(', ')}\n` +
          'Refusing to resume a grid it cannot reproduce. Restore the task directories, or point ' +
          '--evals at the tree the run was launched against.\n',
      );
      return 2;
    }
  }

  // Acknowledgments in force for this invocation: whatever the run already
  // recorded (replayed automatically — an unattended overnight resume must not
  // re-halt on a signature that was reviewed at 2am) plus anything typed now.
  //
  // A typo'd task id is refused rather than silently acknowledging nothing: the
  // failure mode of a suppression that does not apply is a grid that halts at
  // 4am for a reason its operator believes they already handled.
  const knownTaskIds = new Set(replay ? replay.taskIds : tasks.map((t) => t.id));
  for (const spec of ackSpecs) {
    if (knownTaskIds.has(spec.taskId)) continue;
    throw new AckError(
      `--ack ${ackFlag(spec)}: "${spec.taskId}" is not a task in this ${replay ? 'run' : 'grid'}. ` +
        `Selected: ${[...knownTaskIds].sort().slice(0, 8).join(', ')}` +
        (knownTaskIds.size > 8 ? ` … +${knownTaskIds.size - 8} more` : ''),
    );
  }
  const typedAcks = buildAcknowledgments(ackSpecs, { reason: ackReason, argv });
  const recordedAcks = replay ? specAcknowledgments(replay.spec) : [];
  const acknowledgments = mergeAcknowledgments(recordedAcks, typedAcks);
  const addedAcks = newAcknowledgments(recordedAcks, typedAcks);
  // Adding an ack on a resume is a decision about the run, so it appends to the
  // spec's history exactly as --expand and --redo do.
  if (replay && addedAcks.length > 0 && !dryRun) {
    replay.spec = recordAcks(replay.spec, { acknowledgments: addedAcks, argv });
    replay.dirty = true;
  }

  // A resume executes the config definitions recorded at launch. Anything the
  // config file says today is drift, reported below, never applied.
  const configs = replay
    ? replay.configs
    : selectConfigs(rc.configs, splitList(values.configs), {
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

  // Live tasks mutate a real Notion workspace, so everything about that half of
  // the run is settled here — before a run directory exists — and either printed
  // (--dry-run) or enforced (a real run refuses to start half-configured).
  const liveInfo = await inspectLiveTasks(tasks);
  const liveSettings = resolveLiveSettings({ notion: rc.notion });
  const liveProblems = liveRequirementProblems(liveInfo, liveSettings);
  const teardown = values['no-teardown'] !== true;
  const provisionedIds = new Set(liveInfo.provisioned.map((t) => t.id));
  const livePlan =
    liveInfo.live.length > 0
      ? {
          tasks: liveInfo.live.map((t) => t.id),
          provisioned: liveInfo.provisioned.map((t) => t.id),
          fixturesPerRun: replay
            ? replay.gridCells.filter((c) => provisionedIds.has(c.taskId)).length
            : liveInfo.provisioned.length *
              configs.reduce(
                (acc, c) => acc + (c.docsCondition ? 1 : docsConditions.length) * trials,
                0,
              ),
          parentPageId: liveSettings.parentPageId,
          parentPageIdSource: liveSettings.parentPageIdSource,
          apiBase: liveSettings.apiBase,
          apiBaseSource: liveSettings.apiBaseSource,
          tokenPresent: Boolean(liveSettings.token),
          tokenSource: liveSettings.tokenSource,
          teardown,
          problems: liveProblems,
        }
      : undefined;

  // --dry-run answers "what exactly is about to happen" and must therefore
  // change nothing: no `<cli> --version` probes, no run directory, no state.
  // With --resume it additionally must not touch the run it is describing — the
  // checkpoint is opened read-only and no interrupted cell is reset.
  if (dryRun) {
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
      live: livePlan,
      cells: replay?.gridCells,
      resume: replay ? resumePlanFor(replay) : undefined,
      order,
      watchdog: watchdogSettings,
      acknowledgments,
    });
    if (values.json) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderPlan(plan)}\n`);
    }
    return 0;
  }

  // Fail fast, before a run directory exists. Discovering halfway through a
  // multi-day grid that every live cell cannot provision is the expensive way to
  // learn this, and provisioning without a parent page is worse than failing:
  // it would create pages the API cannot archive.
  if (liveProblems.length > 0) {
    process.stderr.write(renderLiveProblems(liveProblems));
    return 2;
  }

  // Built per config so a config that pins itself to one docs condition (the
  // `docsCondition` field) contributes only that half of the grid.
  const cells = replay
    ? replay.gridCells
    : configs.flatMap((c) =>
        buildCells({
          taskIds: tasks.map((t) => t.id),
          configIds: [c.id],
          docsConditions: c.docsCondition ? [c.docsCondition] : docsConditions,
          trials,
        }),
      );

  const execution: RunSpecExecution = {
    concurrency,
    maxAttempts,
    cooldownMs,
    defaultTimeoutSec,
    killGraceMs,
    evalsRoot,
    resultsRoot,
    scoring: { enabled: scoringEnabled, timeoutMs: scoreTimeoutMs },
    order,
  };

  // Checkpoint: resume or create.
  let cp: Checkpoint;
  /** Cells this pass may execute. On a resume, filters narrow it; nothing widens it. */
  let passKeys: Set<string>;
  if (replay) {
    cp = await Checkpoint.load(replay.spec.runId, resultsRoot);
    await cp.resetRunning();
    await applyReplay(cp, replay, resultsRoot, argv);
    passKeys = new Set(replay.passCells.map(cellKey));
  } else {
    const runId = await claimRunId(resultsRoot);
    const specConfigs: SpecConfig[] = await Promise.all(
      configs.map(async (c) => ({ ...c, cliVersion: await cliVersionFor(c) })),
    );
    const meta: RunMeta = {
      concurrency,
      trials,
      docsConditions,
      maxAttempts,
      cooldownMs,
      evalsRoot,
      resultsRoot,
      configs: specConfigs.map((c) => ({
        id: c.id,
        harness: c.harness,
        model: c.model,
        reasoningEffort: c.reasoningEffort,
        cliVersion: c.cliVersion,
      })),
      taskIds: tasks.map((t) => t.id),
      provenance: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        startedAt: new Date().toISOString(),
      },
    };
    cp = await Checkpoint.create({ runId, resultsRoot, meta, cells });
    // Written before the first trial: a run that dies in its first minute is
    // still resumable as the grid it was launched with.
    await writeRunSpec(
      resultsRoot,
      createRunSpec({
        runId,
        grid: {
          taskIds: tasks.map((t) => t.id),
          configIds: configs.map((c) => c.id),
          docsConditions,
          trials,
        },
        configs: specConfigs,
        execution,
        runconfigPath,
        argv,
        acknowledgments,
      }),
    );
    passKeys = new Set(cells.map(cellKey));
    process.stdout.write(`run ${runId}\n`);
  }
  await linkLatest(resultsRoot, cp.runId);
  const runDir = path.join(resultsRoot, cp.runId);

  const summary = tallyCells(cp, cells);
  process.stdout.write(
    `${tasks.length} task(s) × ${configs.length} config(s) × ${docsConditions.join('/')} × ${trials} trial(s) ` +
      `= ${summary.total} cell(s); ${summary.done} already done, ${summary.pending} pending\n` +
      `order: ${order}${watchdogSettings.enabled ? '' : '  ·  watchdog DISABLED'}` +
      `${watchdogSettings.enabled && watchdogSettings.warnOnly ? '  ·  watchdog warn-only' : ''}` +
      `${acknowledgments.length > 0 ? `  ·  ${acknowledgments.length} acknowledgment(s)` : ''}\n`,
  );
  // Printed on every pass, including the resumes that never typed the flag: an
  // inherited suppression the operator has forgotten about is the only way this
  // feature can hurt, so it is stated every single time the run starts.
  if (acknowledgments.length > 0) {
    process.stdout.write(`${renderAcknowledgments(acknowledgments).join('\n')}\n`);
  }

  const patterns = compilePatterns(rc.rateWindow.patterns);

  // One instance for the whole grid; it no-ops for offline tasks, and the live
  // library under evals/_lib/live/ is only imported the first time a fixture is
  // actually provisioned — an offline run never touches it.
  const live =
    liveInfo.provisioned.length > 0
      ? new LiveFixtures({
          settings: liveSettings,
          provisionedIds: liveInfo.provisionedIds,
          runDir,
          evalsRoot,
          noTeardown: !teardown,
          onNotice: (l) => process.stderr.write(`  ${l}\n`),
        })
      : undefined;
  if (live) {
    process.stdout.write(
      `live: ${liveInfo.provisioned.length} task(s) provision a fixture under page ` +
        `${liveSettings.parentPageId} at ${liveSettings.apiBase}` +
        (teardown ? '\n' : ' — teardown DISABLED (--no-teardown)\n'),
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
    // The execution order (order.ts). The scheduler keeps its pending queue
    // sorted by this, which is what makes a task-block a soft barrier: a cooling
    // config is skipped and everyone else walks on, while its cell keeps the
    // rank of the block it belongs to and is the first thing it picks up when
    // the window reopens.
    rank: cellRanker(order, {
      taskIds: tasks.map((t) => t.id),
      configIds: configs.map((c) => c.id),
      docsConditions,
      trials,
    }),
  });
  // Only cells this pass is allowed to touch. On a fresh run that is the whole
  // grid; on a resume it is the recorded grid (narrowed by any filters the
  // operator typed), never whatever else happens to be sitting in state.json.
  scheduler.enqueue(
    cp
      .pending()
      .filter((c) => passKeys.has(cellKey(c)))
      .map((c) => ({ ...c, attempts: c.attempts })),
  );

  // The deterministic run watchdog (watchdog.ts). It sees every scored cell and
  // decides whether a task looks INVALID (halt) or merely hard (keep going).
  const watchdog = new Watchdog({
    settings: watchdogSettings,
    runId: cp.runId,
    configIds: configs.map((c) => c.id),
    acknowledgments,
  });

  const configById = new Map(configs.map((c) => [c.id, c]));
  // TWO controllers, deliberately.
  //
  //  `abort`  is Ctrl-C: it stops the queue AND is handed to the child
  //           processes, so an interrupted trial dies instead of running out its
  //           15-minute clock while the operator waits.
  //  `halt`   is the watchdog: it stops the queue ONLY. In-flight cells keep
  //           their signal, run to completion and are scored normally — killing
  //           a trial mid-flight would waste the one genuinely expensive thing
  //           and leave a workspace unverified, and the whole point of halting
  //           is to stop spending, not to destroy what has already been spent.
  const abort = new AbortController();
  const halt = new AbortController();
  const stopScheduling = (): void => {
    if (!halt.signal.aborted) halt.abort();
  };
  abort.signal.addEventListener('abort', stopScheduling, { once: true });

  const raise = (alerts: WatchdogAlert[]): void => {
    for (const alert of alerts) {
      process.stderr.write(
        `\n  [watchdog ${alert.level}] ${alert.kind}${alert.taskId ? ` ${alert.taskId}` : ''}: ${alert.evidence}\n` +
          (alert.acknowledgment
            ? `  [watchdog] acknowledged (--ack ${ackFlag(alert.acknowledgment)}) — ` +
              `${alert.acknowledgment.reason}\n  [watchdog] recorded as a failure; the run continues\n`
            : ''),
      );
    }
    if (watchdog.halted && !halt.signal.aborted) {
      process.stderr.write(
        '\n  [watchdog] HALTING — no further cells will be scheduled; in-flight trials will ' +
          'finish and be scored.\n',
      );
      stopScheduling();
    }
  };

  const onSigint = () => {
    process.stderr.write('\ninterrupted — finishing in-flight trials, state is checkpointed\n');
    abort.abort();
  };
  process.once('SIGINT', onSigint);

  // The infrastructure sweep: stalls, disk and "every config is down" are by
  // construction invisible from a cell completion, so they are checked on a
  // timer. Unref'd — it must never be the thing keeping the process alive.
  const infraTimer = watchdogSettings.enabled
    ? setInterval(() => {
        void (async () => {
          const stats = scheduler.stats(Date.now());
          const rw = scheduler.rateWindowState();
          raise(
            watchdog.checkInfrastructure({
              now: Date.now(),
              pendingCells: stats.pending,
              inFlightCells: stats.running,
              cooldownConfigIds: rw.cooldowns.map((c) => c.configId),
              blockedConfigIds: rw.blocked,
              freeDiskBytes: await freeDiskBytes(resultsRoot),
            }),
          );
        })().catch(() => {});
      }, 60_000)
    : undefined;
  infraTimer?.unref?.();

  await runQueue(scheduler, {
    signal: halt.signal,
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
        killGraceMs,
        cooldownMs,
        patterns,
        tokens,
        live,
        keepWorkspaces: values['keep-workspaces'] === true,
        signal: abort.signal,
        onObserve: (obs) => raise(watchdog.observe(obs)),
      }),
  });

  process.off('SIGINT', onSigint);
  if (infraTimer) clearInterval(infraTimer);

  // Written after the queue has drained, so ALERT.json describes a settled run:
  // every in-flight cell has finished and been scored by this point. Written for
  // acknowledgments too, even when nothing ever matched them — a run whose
  // watchdog was partly disarmed must say so in its own results tree.
  if (watchdog.alerts.length > 0 || acknowledgments.length > 0) {
    const file = watchdog.snapshot();
    const banner = renderAlertBanner(file, runDir);
    await writeAlertFile(runDir, file);
    await appendRunLog(runDir, `\n${banner}`);
    process.stderr.write(`\n${banner}\n`);
  }

  const final = cp.summary();
  const orphans = live?.orphanSummary();
  if (orphans) process.stdout.write(`\nwarning: ${orphans}\n`);
  process.stdout.write(
    `\ndone: ${final.done}/${final.total}  failed ${final.failed}  pending ${final.pending}\n` +
      `scored: ${final.solved}/${final.scored} solved` +
      (final.unverified > 0 ? `  (${final.unverified} unverified)` : '') +
      '\n' +
      `resume with: notionbench run --resume ${cp.runId}\n` +
      `report with: notionbench score ${path.relative(process.cwd(), runDir) || runDir}\n` +
      `audit with:  notionbench doctor ${path.relative(process.cwd(), runDir) || runDir}\n`,
  );

  const halting = watchdog.haltingAlert;
  if (halting) {
    process.stderr.write(
      `\nHALTED by the watchdog: ${halting.evidence}\n` +
        (halting.taskId
          ? `Fix evals/${halting.taskId}, then re-run only that task's cells:\n` +
            `  notionbench run --resume ${cp.runId} --redo ${halting.taskId}\n`
          : `Then resume with: notionbench run --resume ${cp.runId}\n`) +
        `Evidence and every other alert: ${path.join(runDir, 'ALERT.json')}\n`,
    );
    return WATCHDOG_EXIT_CODE;
  }
  return final.failed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// --resume: replaying a run's own recorded grid
// ---------------------------------------------------------------------------

/** Everything `--resume` decided, resolved before anything is written. */
interface Replay {
  spec: RunSpecFile;
  /** Where the grid came from, in the operator's words. */
  specSource: string;
  notes: string[];
  drift: ConfigDrift[];
  diff: GridDiff;
  expanded: boolean;
  /** Every cell of the recorded (possibly just-expanded) grid. */
  gridCells: CellCoords[];
  /** The subset this invocation may execute — filters narrow it, nothing widens it. */
  passCells: CellCoords[];
  /** `--redo`: tasks whose recorded cells are invalidated and re-queued. */
  redoTaskIds: string[];
  /** The cells `--redo` would invalidate, and how many already carry a verdict. */
  redoCells: CellCoords[];
  redoDone: number;
  redoRows: number;
  /** state.json cells outside the recorded grid; repaired away on a real resume. */
  strayKeys: string[];
  strayStarted: number;
  /** The config definitions recorded at launch — what actually gets executed. */
  configs: AgentConfig[];
  taskIds: string[];
  /** state.json as loaded, so tallies are taken before any mutation. */
  state: RunStateFile;
  /** The spec on disk is out of date (reconstructed, expanded, or new drift). */
  dirty: boolean;
}

/**
 * Work out what `--resume <runId>` is going to replay.
 *
 * Reads nothing but the run's own files plus runconfig.json (for drift only) and
 * writes nothing at all, so `--dry-run --resume` can use it unchanged.
 * Returns an exit code instead of a Replay when the invocation is refused.
 */
async function resolveReplay(args: {
  runId: string;
  resultsRoot: string;
  rc: Awaited<ReturnType<typeof loadRunConfig>>;
  runconfigPath?: string;
  argv: string[];
  values: Values;
}): Promise<Replay | number> {
  const { runId, resultsRoot, rc, runconfigPath, argv, values } = args;
  const cp = await Checkpoint.load(runId, resultsRoot);
  const state = cp.snapshot();
  const notes: string[] = [];
  let dirty = false;

  let spec = await readRunSpec(resultsRoot, runId);
  let specSource: string;
  if (spec) {
    specSource = `${RUN_SPEC_FILENAME} (recorded at launch)`;
  } else {
    // Back-compat: this run predates run-spec.json. Its grid is reconstructed
    // from its own recorded history — never from the current config file, which
    // is exactly the substitution that corrupted run 20260801-085000.
    const rebuilt = reconstructSpec({
      state,
      execution: {
        concurrency: state.meta?.concurrency ?? rc.concurrency,
        maxAttempts: state.meta?.maxAttempts ?? rc.maxAttempts,
        cooldownMs: state.meta?.cooldownMs ?? rc.rateWindow.cooldownMs,
        defaultTimeoutSec: rc.timeoutSec,
        killGraceMs: rc.killGraceMs,
        evalsRoot: state.meta?.evalsRoot ?? path.resolve(rc.evalsRoot),
        resultsRoot: state.meta?.resultsRoot ?? resultsRoot,
        scoring: { enabled: true, timeoutMs: DEFAULT_SCORE_TIMEOUT_MS },
        order: LEGACY_ORDER,
      },
      runconfigPath,
      argv,
    });
    spec = rebuilt.spec;
    notes.push(...rebuilt.notes);
    notes.push(
      'that run did not record its per-trial timeout, kill grace or scoring budget; this resume ' +
        'uses the current defaults for those three',
    );
    specSource = `state.json (no ${RUN_SPEC_FILENAME} — grid reconstructed from the run's own history)`;
    dirty = true;
  }

  if (spec.execution.order === undefined) {
    notes.push(
      `that run recorded no ordering policy, so it executed ${LEGACY_ORDER}; this resume replays ` +
        `${LEGACY_ORDER} rather than today's ${DEFAULT_ORDER} default (pass --order to change it ` +
        'deliberately — the two halves of a grid running in different orders is exactly what ' +
        `${RUN_SPEC_FILENAME} exists to make visible)`,
    );
  }

  spec = { ...spec, configs: hydrateConfigs(spec, rc.configs, notes) };
  const invocationProblems = spec.configs
    .filter((c) => c.reconstructed)
    .flatMap((c) => {
      try {
        getAdapter(c.harness).buildInvocation(c, { prompt: '', workspaceDir: process.cwd() });
        return [];
      } catch (err) {
        return [`${c.id}: ${(err as Error).message}`];
      }
    });
  if (invocationProblems.length > 0) {
    throw new ConfigError(
      `run ${runId} has no ${RUN_SPEC_FILENAME}, and the definitions recovered from state.json are ` +
        `not enough to invoke:\n  ${invocationProblems.join('\n  ')}\n` +
        'Add those config ids back to the runconfig, or hand-write ' +
        `results/${runId}/${RUN_SPEC_FILENAME}. Refusing to guess.`,
    );
  }

  // The axes. Everything defaults to the RECORDED grid; only a flag the operator
  // actually typed on this command line overrides it.
  const explicit = {
    tasks: splitList(values.tasks).length > 0,
    configs: splitList(values.configs).length > 0,
    docs: values.docs !== undefined,
    trials: values.trials !== undefined,
  };
  const evalsRoot = path.resolve(values.evals ?? spec.execution.evalsRoot);
  let taskIds = [...spec.grid.taskIds];
  if (explicit.tasks) {
    const patterns = splitList(values.tasks);
    const matched = await discoverTasks(evalsRoot, patterns);
    if (matched.length === 0) {
      throw new ConfigError(`--tasks ${patterns.join(', ')} matched no task under ${evalsRoot}`);
    }
    taskIds = matched.map((t) => t.id);
  }
  let configIds = [...spec.grid.configIds];
  if (explicit.configs) {
    configIds = splitList(values.configs);
    const known = new Set([...spec.configs.map((c) => c.id), ...rc.configs.map((c) => c.id)]);
    const unknown = configIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new ConfigError(
        `unknown config ${unknown.join(', ')}. Recorded in this run: ${spec.grid.configIds.join(', ')}`,
      );
    }
  }
  const axes: RequestedAxes = {
    taskIds,
    configIds,
    docsConditions: explicit.docs ? parseDocs(values.docs) : [...spec.grid.docsConditions],
    trials: explicit.trials
      ? intOpt(values.trials, spec.grid.trials, '--trials')
      : spec.grid.trials,
    explicit,
  };

  // Docs pins live on the config, so a config added by --expand needs its
  // current definition to expand correctly.
  const pinSource: SpecConfig[] = [...spec.configs];
  for (const id of axes.configIds) {
    if (pinSource.some((c) => c.id === id)) continue;
    const fromFile = rc.configs.find((c) => c.id === id);
    if (fromFile) pinSource.push({ ...fromFile });
  }
  const requested = expandGrid(
    {
      taskIds: axes.taskIds,
      configIds: axes.configIds,
      docsConditions: axes.docsConditions,
      trials: axes.trials,
    },
    pinSource,
  );
  const diff = diffGrid(spec, requested, axes);

  let expanded = false;
  if (diff.added.length > 0) {
    if (values.expand !== true) {
      // The whole point of the fix: adding cells to a run in flight is a
      // decision, and a decision needs a decision-maker.
      process.stderr.write(
        `${renderRefusal(spec, diff)}\n` +
          `  run ${runId} recorded ${specCells(spec).length} cell(s) — ${describeGrid(spec.grid)}\n` +
          `  source: ${specSource}\n` +
          `  this invocation asks for ${requested.length} cell(s)\n`,
      );
      return 2;
    }
    const newConfigs: SpecConfig[] = axes.configIds
      .filter((id) => !spec!.configs.some((c) => c.id === id))
      .map((id) => {
        const fromFile = rc.configs.find((c) => c.id === id);
        if (!fromFile) {
          throw new ConfigError(
            `--expand cannot add config "${id}": it is not in ${runconfigPath ?? 'the built-in roster'}`,
          );
        }
        return { ...fromFile };
      });
    spec = expandSpec(spec, { axes, requested, diff, newConfigs, argv });
    expanded = true;
    dirty = true;
  }

  const drift = detectDrift(spec, rc.configs);
  if (drift.length > 0) {
    const withDrift = recordDrift(spec, drift, argv);
    if (withDrift !== spec) {
      spec = withDrift;
      dirty = true;
    }
  }

  const gridCells = specCells(spec);
  const gridKeys = new Set(gridCells.map(cellKey));
  const requestedKeys = new Set(requested.map(cellKey));
  const filtered = explicit.tasks || explicit.configs || explicit.docs || explicit.trials;
  let passCells = filtered
    ? gridCells.filter((c) => requestedKeys.has(cellKey(c)))
    : gridCells;

  // --redo: the fix-and-re-run path. It is deliberately NOT a filter — a filter
  // narrows which pending cells run, and the whole problem with a task that was
  // found to be broken is that its cells are already *done*, holding verdicts
  // produced by a verifier that was wrong. So --redo also invalidates them, and
  // it restricts the pass to exactly those cells so "fix task 7, re-run task 7"
  // is one command that touches nothing else.
  const redoTaskIds = splitList(values.redo);
  let redoCells: CellCoords[] = [];
  let redoDone = 0;
  let redoRows = 0;
  if (redoTaskIds.length > 0) {
    const recordedTasks = new Set(gridCells.map((c) => c.taskId));
    const unknown = redoTaskIds.filter((id) => !recordedTasks.has(id));
    if (unknown.length > 0) {
      throw new ConfigError(
        `--redo ${unknown.join(', ')}: not in run ${runId}'s recorded grid. ` +
          `Recorded: ${[...recordedTasks].sort().join(', ')}. ` +
          '(--redo re-runs a task this run already measured; use --expand to add a new one.)',
      );
    }
    const wanted = new Set(redoTaskIds);
    redoCells = gridCells.filter((c) => wanted.has(c.taskId));
    redoDone = redoCells.filter((c) => state.cells?.[cellKey(c)]?.status === 'done').length;
    redoRows = await countTaskRows(path.join(resultsRoot, runId), wanted);
    // Filters compose with --redo: `--redo t --configs a` redoes only a's cells.
    const redoKeys = new Set(redoCells.map(cellKey));
    passCells = filtered ? passCells.filter((c) => redoKeys.has(cellKey(c))) : redoCells;
    if (filtered) redoCells = redoCells.filter((c) => requestedKeys.has(cellKey(c)));
  }

  const strayKeys = Object.keys(state.cells ?? {}).filter((k) => !gridKeys.has(k));
  const strayStarted = strayKeys.filter((k) => {
    const cell = state.cells[k];
    return (
      cell !== undefined &&
      (cell.status !== 'pending' ||
        cell.attempts > 0 ||
        cell.rateLimitedAttempts > 0 ||
        (cell.history?.length ?? 0) > 0)
    );
  }).length;

  const usedConfigIds = new Set(gridCells.map((c) => c.configId));
  return {
    spec,
    specSource,
    notes,
    drift,
    diff,
    expanded,
    gridCells,
    passCells,
    redoTaskIds,
    redoCells,
    redoDone,
    redoRows,
    strayKeys,
    strayStarted,
    configs: spec.configs.filter((c) => usedConfigIds.has(c.id)),
    taskIds: [...new Set(gridCells.map((c) => c.taskId))].sort(),
    state,
    dirty,
  };
}

/**
 * Fill in what a pre-spec state.json could not record.
 *
 * `RunMeta.configs` holds only (id, harness, model, reasoningEffort, cliVersion);
 * pricing, labels and `command-template` invocations are not in there. The
 * recorded identity always wins — the config file only supplies the fields the
 * old format had nowhere to put — and the substitution is stated out loud,
 * because it is the one place a resume reads today's config for something other
 * than a drift report.
 */
function hydrateConfigs(
  spec: RunSpecFile,
  current: AgentConfig[],
  notes: string[],
): SpecConfig[] {
  const byId = new Map(current.map((c) => [c.id, c]));
  const merged: string[] = [];
  const out = spec.configs.map((recorded) => {
    if (!recorded.reconstructed) return recorded;
    const now = byId.get(recorded.id);
    if (!now) return recorded;
    merged.push(recorded.id);
    return {
      ...now,
      harness: recorded.harness,
      model: recorded.model,
      reasoningEffort: recorded.reasoningEffort,
      cliVersion: recorded.cliVersion,
      reconstructed: true,
    } satisfies SpecConfig;
  });
  if (merged.length > 0) {
    notes.push(
      `state.json recorded only harness/model/effort for ${merged.join(', ')}; their label, ` +
        'pricing and invocation details were taken from the current config file — check them ' +
        'before trusting this run\'s cost column',
    );
  }
  return out;
}

/** Print what a resume is about to do, before it does any of it. */
function printReplay(replay: Replay): void {
  process.stdout.write(
    `resuming ${replay.spec.runId} — replaying the recorded grid ` +
      `(${replay.gridCells.length} cell(s); ${replay.specSource})\n`,
  );
  for (const note of replay.notes) process.stdout.write(`  note: ${note}\n`);
  if (replay.expanded) {
    process.stdout.write(
      `  --expand: ADDING ${replay.diff.added.length} cell(s) to this run — ` +
        `${replay.diff.reasons.join(', ')}\n` +
        `  the run now measures ${describeGrid(replay.spec.grid)}; the expansion is recorded in ` +
        `${RUN_SPEC_FILENAME}\n`,
    );
  }
  if (replay.redoTaskIds.length > 0) {
    process.stdout.write(
      `  --redo ${replay.redoTaskIds.join(', ')}: INVALIDATING ${replay.redoCells.length} recorded ` +
        `cell(s) (${replay.redoDone} already done) and retiring ${replay.redoRows} scored row(s) ` +
        'to results.superseded.jsonl — nothing is deleted, no other task is touched\n',
    );
  }
  if (replay.passCells.length < replay.gridCells.length) {
    process.stdout.write(
      `  filters restrict this pass to ${replay.passCells.length} of ${replay.gridCells.length} ` +
        'recorded cell(s); the rest keep their state\n',
    );
  }
  if (replay.drift.length > 0) {
    process.stderr.write(
      `\n!! CONFIG DRIFT — runconfig.json no longer matches run ${replay.spec.runId}:\n`,
    );
    for (const line of driftLines(replay.drift)) process.stderr.write(`     ${line}\n`);
    process.stderr.write(
      '   This resume replays the definitions recorded at launch, so results are not mixed.\n' +
        '   To measure the new definitions, start a new run.\n' +
        (isSeriousDrift(replay.drift)
          ? '   (Model/effort/harness drift means the config file and this run now describe ' +
            'different experiments.)\n'
          : '') +
        '\n',
    );
  }
}

/**
 * Rows in results.jsonl belonging to these tasks. Read-only, and tolerant of a
 * run that has not scored anything yet.
 */
async function countTaskRows(runDir: string, taskIds: Set<string>): Promise<number> {
  try {
    const { records } = await readResults(runDir);
    return records.filter((r) => taskIds.has(r.taskId)).length;
  } catch {
    return 0;
  }
}

/** The state-mutating half of a resume. Never reached by --dry-run. */
async function applyReplay(
  cp: Checkpoint,
  replay: Replay,
  resultsRoot: string,
  argv: string[],
): Promise<void> {
  const added = await cp.ensureCells(replay.gridCells);
  if (added > 0) process.stdout.write(`  ${added} cell(s) added to state.json\n`);
  if (replay.strayKeys.length > 0) {
    const removed = await cp.dropCells(replay.strayKeys);
    process.stdout.write(
      `  pruned ${removed} cell(s) from state.json that are not in the recorded grid` +
        (replay.strayStarted > 0 ? ` (${replay.strayStarted} of them had been started)` : '') +
        '\n',
    );
  }
  await cp.updateMeta({
    trials: replay.spec.grid.trials,
    docsConditions: [...replay.spec.grid.docsConditions],
    taskIds: [...replay.taskIds],
    concurrency: replay.spec.execution.concurrency,
    maxAttempts: replay.spec.execution.maxAttempts,
    cooldownMs: replay.spec.execution.cooldownMs,
    configs: replay.spec.configs.map((c) => ({
      id: c.id,
      harness: c.harness,
      model: c.model,
      reasoningEffort: c.reasoningEffort,
      cliVersion: c.cliVersion,
    })),
  });

  // --redo, in the order that survives a crash between the two steps: retire the
  // stale rows FIRST, then reset the cells. Crash in between and the cells are
  // still `done` with no row — which `notionbench doctor` reports as a missing
  // result and a plain `--resume` leaves alone — rather than pending cells
  // racing against rows that still claim a verdict for them.
  let spec = replay.spec;
  if (replay.redoTaskIds.length > 0) {
    const wanted = new Set(replay.redoTaskIds);
    const keys = new Set(replay.redoCells.map(cellKey));
    const superseded = await supersedeResults(
      path.join(resultsRoot, cp.runId),
      (r) => wanted.has(r.taskId) && keys.has(cellKey(r)),
    );
    const reset = await cp.resetCells(
      [...keys],
      `--redo ${replay.redoTaskIds.join(', ')}: the recorded verdicts were produced against a ` +
        'task that has since been changed',
    );
    process.stdout.write(
      `  --redo ${replay.redoTaskIds.join(', ')}: invalidated ${reset.length} cell(s) and retired ` +
        `${superseded.moved} scored row(s) to ${path.basename(superseded.archivePath)}\n`,
    );
    await appendRunLog(
      path.join(resultsRoot, cp.runId),
      `redo ${replay.redoTaskIds.join(', ')}  cells=${reset.length} superseded=${superseded.moved}`,
    );
    spec = recordRedo(spec, {
      taskIds: replay.redoTaskIds,
      cells: reset.length,
      supersededRows: superseded.moved,
      argv,
    });
    await writeRunSpec(resultsRoot, spec);
    return;
  }
  if (replay.dirty) await writeRunSpec(resultsRoot, spec);
}

function resumePlanFor(replay: Replay): ResumePlan {
  const grid = tallyStateCells(replay.state, replay.gridCells);
  const pass = tallyStateCells(replay.state, replay.passCells);
  return {
    runId: replay.spec.runId,
    specSource: replay.specSource,
    specOrigin: replay.spec.origin,
    recordedAt: replay.spec.createdAt,
    cells: replay.gridCells.length,
    done: grid.done,
    pending: grid.pending,
    running: grid.running,
    failed: grid.failed,
    // --redo invalidates its cells, so every one of them will run — including
    // the ones state.json currently calls `done`.
    wouldRun:
      replay.redoTaskIds.length > 0 ? replay.passCells.length : pass.pending + pass.running,
    stray: replay.strayKeys.length,
    excluded: replay.gridCells.length - replay.passCells.length,
    adding: replay.expanded ? replay.diff.added.length : 0,
    addDiffs: replay.diff.reasons,
    drift: driftLines(replay.drift),
    notes: replay.notes,
    redo:
      replay.redoTaskIds.length > 0
        ? {
            taskIds: replay.redoTaskIds,
            cells: replay.redoCells.length,
            done: replay.redoDone,
            scoredRows: replay.redoRows,
          }
        : undefined,
  };
}

interface CellTally {
  total: number;
  done: number;
  pending: number;
  running: number;
  failed: number;
}

function tallyBy(
  cells: CellCoords[],
  lookup: (c: CellCoords) => { status: string } | undefined,
): CellTally {
  const out: CellTally = { total: cells.length, done: 0, pending: 0, running: 0, failed: 0 };
  for (const c of cells) {
    const status = lookup(c)?.status;
    if (status === 'done') out.done++;
    else if (status === 'running') out.running++;
    else if (status === 'failed') out.failed++;
    else out.pending++;
  }
  return out;
}

function tallyCells(cp: Checkpoint, cells: CellCoords[]): CellTally {
  return tallyBy(cells, (c) => cp.get(c));
}

function tallyStateCells(state: RunStateFile, cells: CellCoords[]): CellTally {
  return tallyBy(cells, (c) => state.cells?.[cellKey(c)]);
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
 * One cell, start to finish: **(provision →) spawn → score → checkpoint (→ teardown)**.
 *
 * The order is the contract. The verifier needs the trial workspace, which is
 * deleted in `finally`, so scoring happens before cleanup; and the results row
 * is appended before the cell is marked done, so an interrupted run never
 * leaves a cell claiming a verdict that was never written.
 *
 * Live tasks bracket that with a Notion fixture. Provisioning is inside the try,
 * so a failure marks the cell failed and lets the scheduler retry it — the
 * alternative, scoring an unprovisioned workspace, would record a confident 0
 * about an agent that was handed nothing. Teardown is in the `finally`, after
 * the verdict is durable, and is never allowed to fail the cell.
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
  /** Present only when some selected task provisions a live fixture. */
  live?: LiveFixtures;
  keepWorkspaces: boolean;
  signal: AbortSignal;
  /**
   * Called exactly once per finished cell with what the watchdog needs to
   * classify it. The classification is made HERE, not inferred from the
   * persisted row, because "the verifier crashed" and "we deliberately did not
   * verify" (rate window, spawn error, --no-score) are both `scored: false` on
   * disk, and confusing them would halt a healthy run every time a usage window
   * closed.
   */
  onObserve?: (obs: WatchdogObservation) => void;
}): Promise<CellOutcome> {
  const { cell, cp, config, task } = args;
  const coords: CellCoords = {
    taskId: cell.taskId,
    configId: cell.configId,
    docsCondition: cell.docsCondition,
    trial: cell.trial,
  };
  const observe = (obs: Omit<WatchdogObservation, 'taskId' | 'configId' | 'trial' | 'docsCondition'>): void => {
    args.onObserve?.({
      taskId: coords.taskId,
      configId: coords.configId,
      trial: coords.trial,
      docsCondition: coords.docsCondition,
      ...obs,
    });
  };
  await cp.markRunning(coords);

  const workspace = await prepareWorkspace({
    taskDir: task.dir,
    docsCondition: cell.docsCondition,
    docsBundle: docsBundleFor(task),
    label: `${task.id.replace(/\//g, '-')}-${config.id}-t${cell.trial}`,
    keep: args.keepWorkspaces,
  });
  const wantsFixture = args.live?.wants(task) === true;
  const lease =
    task.runtime === 'live' || wantsFixture ? await args.tokens.acquire() : undefined;

  let fixture: ProvisionedFixture | undefined;
  /** Set when the throw came from provisioning, which is signal (c), not (b). */
  let provisioningFailed: string | undefined;
  /** Hoisted so `finally` can snapshot the workspace into it before cleanup. */
  const trialDir = path.join(args.resultsRoot, cp.runId, trialDirFor(coords));
  try {
    if (wantsFixture) {
      try {
        fixture = await args.live!.provision({
          task,
          workspaceDir: workspace.dir,
          token: lease?.token,
          // Folded into the fixture root's title so a leaked page names the cell
          // that leaked it.
          label: `${cp.runId} ${cellKey(coords)}`,
        });
      } catch (err) {
        provisioningFailed = (err as Error).message;
        throw err;
      }
    }

    const prompt = await readPrompt(task);
    const timeoutSec = task.limits?.time ?? args.defaultTimeoutSec;
    const outcome = await runTrial({
      config,
      identity: { runId: cp.runId, ...coords },
      prompt,
      workspaceDir: workspace.dir,
      trialDir,
      timeoutMs: timeoutSec * 1000,
      killGraceMs: args.killGraceMs,
      notionHome: workspace.notionHome,
      notionApiToken: lease?.token,
      // A runconfig-supplied API base would not otherwise reach the child (env
      // is inherited, a config file is not), and an agent talking to a different
      // Notion than its fixture lives in fails for reasons no verifier can explain.
      extraEnv: fixture ? args.live?.childEnv() : undefined,
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
      // Not a measurement of anything: the agent never got its turn.
      observe({ kind: 'unmeasured' });
      return { kind: 'rate-limited', cooldownMs: outcome.rateLimit.cooldownMs, detail: 'usage window' };
    }
    if (outcome.status === 'spawn_error') {
      await cp.markFailed(coords, outcome.error ?? 'spawn error', outcome.status);
      observe({ kind: 'unmeasured', error: outcome.error });
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
      observe({ kind: 'unmeasured' });
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
      liveCtx: fixture?.ctx,
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
    // The verifier ran. Either it returned a verdict (a real data point the
    // watchdog compares across configs) or it did not, which is a broken
    // measurement apparatus and never an agent failure.
    observe(
      score.ok
        ? { kind: 'scored', score: score.score, diagnostics: score.diagnostics }
        : { kind: 'verifier-crash', error: score.error },
    );
    return { kind: 'done' };
  } catch (err) {
    // Infrastructure, not a verdict: workspace prep, fixture provisioning, a
    // failed append. Say so on the console — "failed 1" with the reason only in
    // state.json is how an operator loses an evening.
    process.stderr.write(
      `  ${pad('ERROR', 13)} ${cellKey(coords)}  ${firstLine((err as Error).message)}\n`,
    );
    await cp.markFailed(coords, (err as Error).message);
    observe(
      provisioningFailed !== undefined
        ? { kind: 'fixture-failure', error: provisioningFailed }
        : { kind: 'runner-error', error: (err as Error).message },
    );
    return { kind: 'failed', detail: (err as Error).message };
  } finally {
    // Snapshot before cleanup: once the workspace is gone, a verifier bug found
    // later can only be fixed by re-running the cell. See artifacts.ts.
    await snapshotWorkspace(workspace.dir, trialDir);
    // After the verdict is durable, and never fatal: `teardown` swallows its own
    // errors into an ORPHAN line in run.log rather than throwing.
    if (fixture) await args.live?.teardown(fixture);
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
