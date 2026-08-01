/**
 * The end-to-end half of "detect an invalid task early, stop, fix it, re-run
 * only it": `notionbench run` with the watchdog live, and `--redo`.
 *
 * The agent is a shell script and the verifier a handful of lines, so this
 * exercises the real CLI path — spawn, score, checkpoint, watchdog, ALERT.json,
 * exit code, invalidation — without a model or a network.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readResults } from '@notionbench/scoring';
import { main } from '../src/cli.js';
import type { AlertFile } from '../src/watchdog.js';
import type { RunSpecFile } from '../src/run-spec.js';
import type { RunStateFile } from '../src/checkpoint.js';

let scratch: string;
let evalsRoot: string;
let resultsRoot: string;
let runconfigPath: string;
let out: string[];

const CONFIG_IDS = ['cfg-a', 'cfg-b', 'cfg-c'];

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'nb-halt-'));
  evalsRoot = path.join(scratch, 'evals');
  resultsRoot = path.join(scratch, 'results');
  runconfigPath = path.join(scratch, 'runconfig.json');
  out = [];
  await mkdir(evalsRoot, { recursive: true });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Captures stdout+stderr for the duration of one `main()` call. */
async function run(args: string[]): Promise<number> {
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stderr.write;
  try {
    return await main(args);
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

function printed(): string {
  return out.join('');
}

function runIdFrom(text: string): string {
  const id = /run (\d{8}-\d{6})/.exec(text)?.[1];
  if (!id) throw new Error(`no run id in output:\n${text}`);
  return id;
}

/**
 * @param verdict the body of EVAL.ts's default export, so a test can make a
 *        task look broken (every config, same diagnostic), hard (every config,
 *        different diagnostics) or fine. The body sees `workspaceDir` and `ctx`,
 *        exactly as a real verifier does.
 */
async function writeTask(id: string, verdict: string): Promise<void> {
  const dir = path.join(evalsRoot, id);
  await mkdir(path.join(dir, 'fixture', 'workspace'), { recursive: true });
  await writeFile(
    path.join(dir, 'PROMPT.md'),
    `---\nid: ${id}\nsuite: benchmark\nfamily: nac\nstage: build\nruntime: offline\nlimits: { time: 30 }\n---\n\nWrite DONE into solved.txt.\n`,
    'utf8',
  );
  await writeFile(path.join(dir, 'fixture', 'workspace', 'README.md'), '# fixture\n', 'utf8');
  await writeFile(
    path.join(dir, 'EVAL.ts'),
    `export default async ({ workspaceDir, ctx }) => {\n${verdict}\n}\n`,
    'utf8',
  );
}

/** Every config fails it with the same complaint: a verifier bug. */
const BROKEN = `  return { score: 0, subscores: {}, diagnostics: ["unexpected field \\\`views\\\` at intents[" + ctx.configId.length + "]"] }`;
/** Every config fails it, each for its own reason: a hard task. */
const HARD = `  const why = {
    "cfg-a": "rollup aggregation is sum, expected average",
    "cfg-b": "relation points at the wrong data source",
    "cfg-c": "board view has no group-by clause",
  }
  if (!why[ctx.configId]) throw new Error("unexpected configId " + ctx.configId)
  return { score: 0, subscores: {}, diagnostics: [why[ctx.configId]] }`;
/** Solvable, and the fake agent solves it. */
const FINE = `  const { readFile } = await import("node:fs/promises")
  const path = await import("node:path")
  try {
    const text = await readFile(path.join(workspaceDir, "solved.txt"), "utf8")
    return { score: text.trim() === "DONE" ? 1 : 0, subscores: {}, diagnostics: ["read solved.txt"] }
  } catch { return { score: 0, subscores: {}, diagnostics: ["no solved.txt"] } }`;
/** The verifier itself blows up — never an agent failure. */
const CRASHES = `  throw new Error("intents.map is not a function")`;

const AGENT = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake 1.0"; exit 0; fi
printf 'DONE\\n' > "$1/solved.txt"
echo '{"usage":{"input_tokens":10,"output_tokens":5}}'
`;

async function writeRunconfig(extra: Record<string, unknown> = {}): Promise<void> {
  const agent = path.join(scratch, 'agent.sh');
  await writeFile(agent, AGENT, 'utf8');
  await chmod(agent, 0o755);
  await writeFile(
    runconfigPath,
    JSON.stringify({
      configs: CONFIG_IDS.map((id) => ({
        id,
        label: id,
        harness: 'command-template',
        command: agent,
        argsTemplate: ['{workspace}', '{prompt}'],
        model: 'fake-1',
        enabled: true,
      })),
      resultsRoot,
      evalsRoot,
      concurrency: 3,
      trials: 1,
      timeoutSec: 30,
      ...extra,
    }),
    'utf8',
  );
}

async function readAlert(runId: string): Promise<AlertFile> {
  return JSON.parse(await readFile(path.join(resultsRoot, runId, 'ALERT.json'), 'utf8')) as AlertFile;
}

async function readState(runId: string): Promise<RunStateFile> {
  return JSON.parse(await readFile(path.join(resultsRoot, runId, 'state.json'), 'utf8')) as RunStateFile;
}

async function readSpec(runId: string): Promise<RunSpecFile> {
  return JSON.parse(await readFile(path.join(resultsRoot, runId, 'run-spec.json'), 'utf8')) as RunSpecFile;
}

// ---------------------------------------------------------------------------

describe('halt semantics', () => {
  it('stops the run, writes ALERT.json + a run.log banner, and exits non-zero', async () => {
    await writeTask('build-nac-001-broken', BROKEN);
    await writeTask('build-nac-002-fine', FINE);
    await writeTask('build-nac-003-fine', FINE);
    await writeRunconfig();

    const code = await run(['run', '--runconfig', runconfigPath, '--docs', 'with', '--trials', '1']);
    expect(code).toBe(3);

    const runId = runIdFrom(printed());
    const alert = await readAlert(runId);
    expect(alert.halted).toBe(true);
    expect(alert.halting!.kind).toBe('cross-config-identical-failure');
    expect(alert.halting!.taskId).toBe('build-nac-001-broken');
    expect(alert.halting!.evidence).toContain('unexpected field "views"');
    // Three configs in the grid, so the fraction arm (≥60% of the run's configs)
    // trips at the second matching verdict — before the third config's cell has
    // even been scored. The named configs are the ones the evidence came from.
    expect(alert.halting!.configIds.length).toBeGreaterThanOrEqual(2);
    expect(alert.halting!.configIds.every((id) => CONFIG_IDS.includes(id))).toBe(true);

    const log = await readFile(path.join(resultsRoot, runId, 'run.log'), 'utf8');
    expect(log).toContain('WATCHDOG HALT');
    expect(log).toContain('build-nac-001-broken');

    // The exit message names the task and the exact way back in.
    expect(printed()).toContain('HALTED by the watchdog');
    expect(printed()).toContain(`--resume ${runId} --redo build-nac-001-broken`);
  });

  it('lets in-flight cells finish and be scored — nothing is killed mid-trial', async () => {
    // The broken task is FIRST in trial-major order, so all three configs are in
    // flight on it when the third verdict trips the watchdog. All three must
    // still land in results.jsonl.
    await writeTask('build-nac-001-broken', BROKEN);
    await writeTask('build-nac-002-fine', FINE);
    await writeRunconfig();

    await run(['run', '--runconfig', runconfigPath, '--docs', 'with', '--trials', '1']);
    const runId = runIdFrom(printed());

    const { records } = await readResults(path.join(resultsRoot, runId));
    const broken = records.filter((r) => r.taskId === 'build-nac-001-broken');
    expect(broken).toHaveLength(3);
    for (const r of broken) {
      expect(r.scored).toBe(true);
      expect(r.score).toBe(0);
    }
    const state = await readState(runId);
    for (const cell of Object.values(state.cells)) {
      if (cell.taskId === 'build-nac-001-broken') expect(cell.status).toBe('done');
    }
  });

  it('does not schedule the rest of the grid after halting', async () => {
    await writeTask('build-nac-001-broken', BROKEN);
    for (const n of ['002', '003', '004', '005']) await writeTask(`build-nac-${n}-fine`, FINE);
    await writeRunconfig();

    await run(['run', '--runconfig', runconfigPath, '--docs', 'with', '--trials', '1']);
    const runId = runIdFrom(printed());
    const state = await readState(runId);
    const pending = Object.values(state.cells).filter((c) => c.status === 'pending');
    // 5 tasks × 3 configs = 15 cells; only the first block ran.
    expect(pending.length).toBeGreaterThan(0);
    expect(Object.values(state.cells).filter((c) => c.status === 'done').length).toBeLessThan(15);
  });

  it('halts on a single verifier crash', async () => {
    await writeTask('build-nac-001-crashes', CRASHES);
    await writeTask('build-nac-002-fine', FINE);
    await writeRunconfig();

    const code = await run(['run', '--runconfig', runconfigPath, '--docs', 'with', '--trials', '1']);
    expect(code).toBe(3);
    const alert = await readAlert(runIdFrom(printed()));
    expect(alert.halting!.kind).toBe('verifier-crash');
    expect(alert.halting!.taskId).toBe('build-nac-001-crashes');
  });

  it('does NOT halt on a task every config failed for different reasons', async () => {
    await writeTask('build-nac-001-hard', HARD);
    await writeTask('build-nac-002-fine', FINE);
    await writeRunconfig();

    const code = await run(['run', '--runconfig', runconfigPath, '--docs', 'with', '--trials', '1']);
    expect(code).toBe(0);
    const runId = runIdFrom(printed());
    const { records } = await readResults(path.join(resultsRoot, runId));
    // The whole grid ran: 2 tasks × 3 configs.
    expect(records).toHaveLength(6);
    expect(records.filter((r) => r.taskId === 'build-nac-001-hard').every((r) => r.score === 0)).toBe(true);
    // Three configs is below the total-task-failure threshold of five, so this
    // grid is not even worth a warning: nothing was written at all.
    await expect(readAlert(runId)).rejects.toThrow();
  });

  it('flags an all-configs-fail task as SUSPECT — a warning, never a halt', async () => {
    await writeTask('build-nac-001-hard', HARD);
    await writeTask('build-nac-002-fine', FINE);
    // Lower the bar so this three-config grid can reach it.
    await writeRunconfig({ watchdog: { totalTaskFailure: { minConfigs: 3 } } });

    const code = await run(['run', '--runconfig', runconfigPath, '--docs', 'with', '--trials', '1']);
    expect(code).toBe(0);
    const runId = runIdFrom(printed());
    expect((await readResults(path.join(resultsRoot, runId))).records).toHaveLength(6);
    const alert = await readAlert(runId);
    expect(alert.halted).toBe(false);
    expect(alert.alerts).toHaveLength(1);
    expect(alert.alerts[0]).toMatchObject({
      level: 'warn',
      kind: 'total-task-failure',
      taskId: 'build-nac-001-hard',
    });
  });

  it('--no-watchdog runs the whole grid and writes no ALERT.json', async () => {
    await writeTask('build-nac-001-broken', BROKEN);
    await writeTask('build-nac-002-fine', FINE);
    await writeRunconfig();

    const code = await run([
      'run', '--runconfig', runconfigPath, '--docs', 'with', '--trials', '1', '--no-watchdog',
    ]);
    expect(code).toBe(0);
    const runId = runIdFrom(printed());
    expect((await readResults(path.join(resultsRoot, runId))).records).toHaveLength(6);
    await expect(readAlert(runId)).rejects.toThrow();
  });

  it('--watchdog-warn-only alerts loudly, finishes the grid, and exits 0', async () => {
    await writeTask('build-nac-001-broken', BROKEN);
    await writeTask('build-nac-002-fine', FINE);
    await writeRunconfig();

    const code = await run([
      'run', '--runconfig', runconfigPath, '--docs', 'with', '--trials', '1', '--watchdog-warn-only',
    ]);
    expect(code).toBe(0);
    const runId = runIdFrom(printed());
    expect((await readResults(path.join(resultsRoot, runId))).records).toHaveLength(6);
    const alert = await readAlert(runId);
    expect(alert.halted).toBe(false);
    expect(alert.alerts.some((a) => a.kind === 'cross-config-identical-failure')).toBe(true);
    expect(alert.alerts.every((a) => a.level === 'warn')).toBe(true);
  });

  it('honours a runconfig watchdog block', async () => {
    await writeTask('build-nac-001-broken', BROKEN);
    await writeTask('build-nac-002-fine', FINE);
    // Raise the bar past what this grid can produce: 3 configs, need 4.
    await writeRunconfig({ watchdog: { crossConfig: { minConfigs: 4, minFraction: 1.5 } } });

    const code = await run(['run', '--runconfig', runconfigPath, '--docs', 'with', '--trials', '1']);
    expect(code).toBe(0);
    expect((await readResults(path.join(resultsRoot, runIdFrom(printed())))).records).toHaveLength(6);
  });
});

describe('the ordering policy is recorded and replayed', () => {
  it('records the default in run-spec.json', async () => {
    await writeTask('build-nac-001-fine', FINE);
    await writeRunconfig();
    await run(['run', '--runconfig', runconfigPath, '--docs', 'with', '--trials', '1']);
    const spec = await readSpec(runIdFrom(printed()));
    expect(spec.execution.order).toBe('trial-major,task-major');
  });

  it('records an explicit --order and replays it on resume without being told again', async () => {
    await writeTask('build-nac-001-fine', FINE);
    await writeTask('build-nac-002-fine', FINE);
    await writeRunconfig();
    await run([
      'run', '--runconfig', runconfigPath, '--docs', 'with', '--trials', '1', '--order', 'config-major',
    ]);
    const runId = runIdFrom(printed());
    expect((await readSpec(runId)).execution.order).toBe('config-major');

    out = [];
    await run(['run', '--runconfig', runconfigPath, '--resume', runId, '--dry-run']);
    // The bare resume prints the recorded policy, not today's default.
    expect(printed()).toContain('order           config-major');
    expect(printed()).not.toContain('order           trial-major');
  });

  it('replays a spec that predates ordering as config-major, and says so', async () => {
    await writeTask('build-nac-001-fine', FINE);
    await writeRunconfig();
    await run(['run', '--runconfig', runconfigPath, '--docs', 'with', '--trials', '1']);
    const runId = runIdFrom(printed());

    // Simulate a run-spec.json written before the policy existed.
    const spec = await readSpec(runId);
    delete (spec.execution as { order?: string }).order;
    await writeFile(path.join(resultsRoot, runId, 'run-spec.json'), JSON.stringify(spec), 'utf8');

    out = [];
    await run(['run', '--runconfig', runconfigPath, '--resume', runId, '--dry-run']);
    expect(printed()).toContain('recorded no ordering policy');
    expect(printed()).toContain('order           config-major');
  });
});

describe('--redo: fix one task and re-run only it', () => {
  async function firstRun(): Promise<string> {
    await writeTask('build-nac-001-broken', BROKEN);
    await writeTask('build-nac-002-fine', FINE);
    await writeRunconfig();
    await run([
      'run', '--runconfig', runconfigPath, '--docs', 'with', '--trials', '1', '--watchdog-warn-only',
    ]);
    return runIdFrom(printed());
  }

  it('invalidates only that task\'s cells and rows, then re-runs exactly them', async () => {
    const runId = await firstRun();
    const before = await readResults(path.join(resultsRoot, runId));
    expect(before.records).toHaveLength(6);
    expect(before.records.filter((r) => r.taskId === 'build-nac-001-broken')).toHaveLength(3);

    // "Fix" the task: its verifier now grades the workspace honestly.
    await writeTask('build-nac-001-broken', FINE);

    out = [];
    const code = await run([
      'run', '--runconfig', runconfigPath, '--resume', runId, '--redo', 'build-nac-001-broken',
    ]);
    expect(code).toBe(0);

    const after = await readResults(path.join(resultsRoot, runId));
    // Still 6 rows — but the three stale ones were retired, not left to be
    // averaged in alongside the new ones.
    expect(after.records).toHaveLength(6);
    const redone = after.records.filter((r) => r.taskId === 'build-nac-001-broken');
    expect(redone).toHaveLength(3);
    for (const r of redone) {
      expect(r.score).toBe(1);
      expect(r.diagnostics).toEqual(['read solved.txt']);
    }
    // The untouched task's rows are byte-identical to what they were.
    const untouched = after.records.filter((r) => r.taskId === 'build-nac-002-fine');
    expect(untouched.map((r) => JSON.stringify(r)).sort()).toEqual(
      before.records.filter((r) => r.taskId === 'build-nac-002-fine').map((r) => JSON.stringify(r)).sort(),
    );
  });

  it('keeps the retired rows on disk in results.superseded.jsonl', async () => {
    const runId = await firstRun();
    await writeTask('build-nac-001-broken', FINE);
    out = [];
    await run(['run', '--runconfig', runconfigPath, '--resume', runId, '--redo', 'build-nac-001-broken']);

    const archived = await readFile(path.join(resultsRoot, runId, 'results.superseded.jsonl'), 'utf8');
    const lines = archived.trim().split('\n').map((l) => JSON.parse(l) as { taskId: string; diagnostics: string[] });
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.taskId === 'build-nac-001-broken')).toBe(true);
    expect(lines[0]!.diagnostics[0]).toContain('unexpected field');
  });

  it('resets the cells so `status` stops claiming the retired verdict', async () => {
    const runId = await firstRun();
    const stale = await readState(runId);
    expect(
      Object.values(stale.cells).filter((c) => c.taskId === 'build-nac-001-broken' && c.status === 'done'),
    ).toHaveLength(3);

    await writeTask('build-nac-001-broken', FINE);
    out = [];
    await run(['run', '--runconfig', runconfigPath, '--resume', runId, '--redo', 'build-nac-001-broken']);

    const fresh = await readState(runId);
    for (const cell of Object.values(fresh.cells)) {
      expect(cell.status).toBe('done');
      if (cell.taskId === 'build-nac-001-broken') {
        expect(cell.score).toBe(1);
        expect(cell.history.some((h) => h.event === 'redo')).toBe(true);
      }
    }
  });

  it('records the redo in run-spec.json history', async () => {
    const runId = await firstRun();
    await writeTask('build-nac-001-broken', FINE);
    out = [];
    await run(['run', '--runconfig', runconfigPath, '--resume', runId, '--redo', 'build-nac-001-broken']);

    const entry = (await readSpec(runId)).history.find((h) => h.event === 'redo')!;
    expect(entry.redo).toEqual({
      taskIds: ['build-nac-001-broken'],
      cells: 3,
      supersededRows: 3,
    });
    expect(entry.detail).toContain('results.superseded.jsonl');
  });

  it('--dry-run --redo describes the invalidation and changes nothing', async () => {
    const runId = await firstRun();
    const before = await readFile(path.join(resultsRoot, runId, 'results.jsonl'), 'utf8');
    out = [];
    const code = await run([
      'run', '--runconfig', runconfigPath, '--resume', runId, '--redo', 'build-nac-001-broken', '--dry-run',
    ]);
    expect(code).toBe(0);
    expect(printed()).toContain('would INVALIDATE 3 cell(s)');
    expect(printed()).toContain('retire 3 scored row(s)');
    expect(printed()).toContain('nothing is deleted');
    expect(await readFile(path.join(resultsRoot, runId, 'results.jsonl'), 'utf8')).toBe(before);
    await expect(
      readFile(path.join(resultsRoot, runId, 'results.superseded.jsonl'), 'utf8'),
    ).rejects.toThrow();
  });

  it('refuses a task that is not in the recorded grid', async () => {
    const runId = await firstRun();
    out = [];
    const code = await run([
      'run', '--runconfig', runconfigPath, '--resume', runId, '--redo', 'build-nac-999-nope',
    ]);
    expect(code).toBe(2);
    expect(printed()).toContain("not in run");
    expect(printed()).toContain('--expand');
  });

  it('refuses --redo without --resume', async () => {
    await writeRunconfig();
    await writeTask('build-nac-001-fine', FINE);
    out = [];
    const code = await run(['run', '--runconfig', runconfigPath, '--redo', 'build-nac-001-fine']);
    expect(code).toBe(2);
    expect(printed()).toContain('--redo only applies with --resume');
  });

  it('composes with --configs, redoing one config\'s cells only', async () => {
    const runId = await firstRun();
    await writeTask('build-nac-001-broken', FINE);
    out = [];
    await run([
      'run', '--runconfig', runconfigPath, '--resume', runId,
      '--redo', 'build-nac-001-broken', '--configs', 'cfg-a',
    ]);
    const { records } = await readResults(path.join(resultsRoot, runId));
    const redone = records.filter((r) => r.taskId === 'build-nac-001-broken');
    expect(redone).toHaveLength(3);
    expect(redone.find((r) => r.configId === 'cfg-a')!.score).toBe(1);
    // The other two configs' cells were left exactly as they were.
    expect(redone.find((r) => r.configId === 'cfg-b')!.score).toBe(0);
  });
});
