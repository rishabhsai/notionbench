/**
 * `--resume <runId>` replays the run's own grid.
 *
 * The regression this file exists for is real: run 20260801-085000 was launched
 * with explicit filters (5 tasks × 7 configs × docs=with × 1 trial = 35 cells)
 * and a bare `notionbench run --resume 20260801-085000` rebuilt the grid from
 * runconfig.json + flag defaults instead, producing 3,120 cells — a docs arm the
 * project had cut, a config outside the published roster, k=5 instead of k=3 —
 * printing "3085 new cell(s) added" and starting to execute. ~271h of agent time,
 * caught by hand after ten seconds.
 *
 * So the assertions here are mostly counts: a 35-cell run must resume as at most
 * 35 cells, whatever the config file says today.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { buildCells, cellKey, type CellCoords, type RunStateFile } from '../src/checkpoint.js';
import { RUN_SPEC_FILENAME, specCells, type RunSpecFile } from '../src/run-spec.js';

let scratch: string;
let evalsRoot: string;
let resultsRoot: string;
let runconfigPath: string;
let agentPath: string;
let out: string[];
let err: string[];
let restore: (() => void) | undefined;

/** Every task the eval tree contains; only the first five are in the recorded run. */
const ALL_TASKS = [
  'build-fake-001',
  'build-fake-002',
  'build-fake-003',
  'build-fake-004',
  'build-fake-005',
  'build-fake-006',
  'build-fake-007',
  'build-fake-008',
  'build-fake-009',
];
const RUN_TASKS = ALL_TASKS.slice(0, 5);

/** Configs the run recorded, and the extra one the config file grew afterwards. */
const RUN_CONFIGS = ['cfg-1', 'cfg-2', 'cfg-3', 'cfg-4', 'cfg-5', 'cfg-6', 'cfg-7'];
const ALL_CONFIGS = [...RUN_CONFIGS, 'cfg-8'];

const AGENT = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake 1.0"; exit 0; fi
printf 'DONE\\n' > "$1/solved.txt"
echo '{"usage":{"input_tokens":100,"output_tokens":50},"tool_calls":1,"tool_errors":0}'
`;

async function writeTask(id: string): Promise<void> {
  const dir = path.join(evalsRoot, id);
  await mkdir(path.join(dir, 'fixture', 'workspace'), { recursive: true });
  await writeFile(
    path.join(dir, 'PROMPT.md'),
    `---\nid: ${id}\nsuite: benchmark\nfamily: fake\nstage: build\nruntime: offline\nlimits: { time: 30 }\n---\n\nWrite DONE into solved.txt.\n`,
    'utf8',
  );
  await writeFile(path.join(dir, 'fixture', 'workspace', 'README.md'), '# fixture\n', 'utf8');
  await writeFile(
    path.join(dir, 'EVAL.ts'),
    `import { readFile } from "node:fs/promises"
     import * as path from "node:path"
     export default async ({ workspaceDir }) => {
       try {
         const text = await readFile(path.join(workspaceDir, "solved.txt"), "utf8")
         const ok = text.trim() === "DONE"
         return { score: ok ? 1 : 0, subscores: { wrote: ok ? 1 : 0 }, diagnostics: [] }
       } catch { return { score: 0, subscores: { wrote: 0 }, diagnostics: ["no solved.txt"] } }
     }
    `,
    'utf8',
  );
}

interface ConfigOverride {
  model?: string;
  reasoningEffort?: string;
  pricing?: Record<string, number>;
  enabled?: boolean;
}

/**
 * The config file as it stands *today*: eight configs, five trials, both docs
 * conditions. A resume must ignore every one of those numbers.
 */
async function writeRunconfig(overrides: Record<string, ConfigOverride> = {}): Promise<void> {
  await writeFile(
    runconfigPath,
    JSON.stringify({
      configs: ALL_CONFIGS.map((id) => ({
        id,
        label: `Fake ${id}`,
        harness: 'command-template',
        command: agentPath,
        argsTemplate: ['{workspace}', '{prompt}'],
        model: `fake-model-${id}`,
        enabled: true,
        pricing: { inputPerMTok: 1, outputPerMTok: 2 },
        ...overrides[id],
      })),
      resultsRoot,
      evalsRoot,
      concurrency: 1,
      trials: 5,
      timeoutSec: 30,
    }),
    'utf8',
  );
}

/** A state.json for a run that was launched with the 35-cell grid. */
function incidentState(runId: string, opts: { inflated: boolean }): RunStateFile {
  const recorded = buildCells({
    taskIds: RUN_TASKS,
    configIds: RUN_CONFIGS,
    docsConditions: ['with'],
    trials: 1,
  });
  // What the unguarded resume produced: the full config-file product.
  const inflated = buildCells({
    taskIds: ALL_TASKS,
    configIds: ALL_CONFIGS,
    docsConditions: ['with', 'without'],
    trials: 5,
  });
  const cells: Record<string, RunStateFile['cells'][string]> = {};
  const add = (c: CellCoords): void => {
    cells[cellKey(c)] = {
      taskId: c.taskId,
      configId: c.configId,
      docsCondition: c.docsCondition,
      trial: c.trial,
      status: 'pending',
      attempts: 0,
      rateLimitedAttempts: 0,
      history: [],
    };
  };
  for (const c of recorded) add(c);
  if (opts.inflated) for (const c of inflated) add(c);

  // Four cells finished before the pause.
  for (const configId of RUN_CONFIGS.slice(0, 4)) {
    const key = cellKey({ taskId: RUN_TASKS[0]!, configId, docsCondition: 'with', trial: 1 });
    Object.assign(cells[key]!, { status: 'done', attempts: 1, score: 1, scored: true });
  }
  if (opts.inflated) {
    // Two trial-2 cells the runaway resume had already started when it was killed.
    for (const configId of RUN_CONFIGS.slice(0, 2)) {
      const key = cellKey({ taskId: RUN_TASKS[0]!, configId, docsCondition: 'with', trial: 2 });
      Object.assign(cells[key]!, { status: 'running', attempts: 1 });
    }
  }

  return {
    version: 1,
    runId,
    createdAt: '2026-08-01T08:50:01.067Z',
    updatedAt: '2026-08-01T09:10:55.419Z',
    meta: {
      concurrency: 2,
      trials: 1,
      docsConditions: ['with'],
      maxAttempts: 3,
      cooldownMs: 1_800_000,
      evalsRoot,
      resultsRoot,
      configs: RUN_CONFIGS.map((id) => ({
        id,
        harness: 'command-template',
        model: `fake-model-${id}`,
        cliVersion: 'fake 1.0',
      })),
      taskIds: [...RUN_TASKS],
      provenance: { node: process.version, platform: process.platform, arch: process.arch },
    },
    cells,
  };
}

/** Materialize a run directory. `spec: false` makes it a pre-run-spec.json run. */
async function seedRun(
  runId: string,
  opts: { inflated: boolean; spec: boolean },
): Promise<RunStateFile> {
  const state = incidentState(runId, { inflated: opts.inflated });
  await mkdir(path.join(resultsRoot, runId), { recursive: true });
  await writeFile(
    path.join(resultsRoot, runId, 'state.json'),
    `${JSON.stringify(state, null, 2)}\n`,
    'utf8',
  );
  if (opts.spec) {
    const spec: RunSpecFile = {
      version: 1,
      runId,
      createdAt: state.createdAt,
      updatedAt: state.createdAt,
      origin: 'launch',
      grid: {
        taskIds: [...RUN_TASKS],
        configIds: [...RUN_CONFIGS],
        docsConditions: ['with'],
        trials: 1,
      },
      configs: RUN_CONFIGS.map((id) => ({
        id,
        label: `Fake ${id}`,
        harness: 'command-template',
        command: agentPath,
        argsTemplate: ['{workspace}', '{prompt}'],
        model: `fake-model-${id}`,
        enabled: true,
        pricing: { inputPerMTok: 1, outputPerMTok: 2 },
        cliVersion: 'fake 1.0',
      })),
      execution: {
        concurrency: 1,
        maxAttempts: 3,
        cooldownMs: 1_800_000,
        defaultTimeoutSec: 30,
        killGraceMs: 10_000,
        evalsRoot,
        resultsRoot,
        scoring: { enabled: true, timeoutMs: 600_000 },
      },
      provenance: {
        runconfigPath,
        configHash: 'seeded',
        argv: ['run', '--tasks', RUN_TASKS.join(','), '--trials', '1', '--docs', 'with'],
        createdAt: state.createdAt,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cwd: scratch,
        cliVersions: {},
      },
      history: [{ at: state.createdAt, event: 'created', detail: 'seeded' }],
    };
    await writeFile(
      path.join(resultsRoot, runId, RUN_SPEC_FILENAME),
      `${JSON.stringify(spec, null, 2)}\n`,
      'utf8',
    );
  }
  return state;
}

function capture(): void {
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  restore = () => {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  };
}

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  out = [];
  err = [];
  capture();
  try {
    const code = await main(args);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    restore?.();
    restore = undefined;
  }
}

async function readSpec(runId: string): Promise<RunSpecFile> {
  return JSON.parse(
    await readFile(path.join(resultsRoot, runId, RUN_SPEC_FILENAME), 'utf8'),
  ) as RunSpecFile;
}

async function readState(runId: string): Promise<RunStateFile> {
  return JSON.parse(
    await readFile(path.join(resultsRoot, runId, 'state.json'), 'utf8'),
  ) as RunStateFile;
}

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'nb-resume-'));
  evalsRoot = path.join(scratch, 'evals');
  resultsRoot = path.join(scratch, 'results');
  runconfigPath = path.join(scratch, 'runconfig.json');
  out = [];
  err = [];
  await mkdir(evalsRoot, { recursive: true });
  for (const id of ALL_TASKS) await writeTask(id);
  agentPath = path.join(scratch, 'agent.sh');
  await writeFile(agentPath, AGENT, 'utf8');
  await chmod(agentPath, 0o755);
  await writeRunconfig();
});

afterEach(async () => {
  restore?.();
  restore = undefined;
  await rm(scratch, { recursive: true, force: true });
});

describe('run: the spec is written at launch', () => {
  it('records the grid, the resolved configs and the provenance, and round-trips', async () => {
    const { code, stdout } = await cli([
      'run',
      '--runconfig',
      runconfigPath,
      '--tasks',
      'build-fake-001,build-fake-002',
      '--configs',
      'cfg-1',
      '--docs',
      'with',
      '--trials',
      '1',
    ]);
    expect(code).toBe(0);
    const runId = /run (\d{8}-\d{6})/.exec(stdout)![1]!;

    const spec = await readSpec(runId);
    expect(spec.version).toBe(1);
    expect(spec.runId).toBe(runId);
    expect(spec.origin).toBe('launch');
    expect(spec.grid).toEqual({
      taskIds: ['build-fake-001', 'build-fake-002'],
      configIds: ['cfg-1'],
      docsConditions: ['with'],
      trials: 1,
    });
    // The config as resolved at launch — harness, model, effort and pricing.
    expect(spec.configs).toHaveLength(1);
    expect(spec.configs[0]).toMatchObject({
      id: 'cfg-1',
      harness: 'command-template',
      model: 'fake-model-cfg-1',
      command: agentPath,
      pricing: { inputPerMTok: 1, outputPerMTok: 2 },
      cliVersion: 'fake 1.0',
    });
    expect(spec.execution).toMatchObject({
      concurrency: 1,
      maxAttempts: 3,
      defaultTimeoutSec: 30,
      evalsRoot,
      resultsRoot,
      scoring: { enabled: true },
    });
    expect(spec.provenance.runconfigPath).toBe(runconfigPath);
    expect(spec.provenance.configHash).toMatch(/^[0-9a-f]{16}$/);
    expect(spec.provenance.argv).toContain('--trials');
    expect(spec.provenance.node).toBe(process.version);
    expect(spec.history[0]!.event).toBe('created');

    // The spec's cell set is exactly the run's cell set.
    const state = await readState(runId);
    expect(specCells(spec).map(cellKey).sort()).toEqual(Object.keys(state.cells).sort());
  });
});

describe('run --resume replays the recorded grid', () => {
  it('resumes a 35-cell run as 35 cells, not the 720 the config file describes today', async () => {
    await seedRun('20260801-085000', { inflated: false, spec: true });
    const { code, stdout } = await cli([
      'run',
      '--runconfig',
      runconfigPath,
      '--dry-run',
      '--resume',
      '20260801-085000',
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('35 cell(s)');
    expect(stdout).toContain('4 done, 31 pending');
    expect(stdout).toContain('5 task(s) × 7 config(s) × with docs × 1 trial(s) = 35 cell(s)');
    // The config file's defaults (9 tasks, 8 configs, both docs, 5 trials).
    expect(stdout).not.toContain('720');
    expect(stdout).not.toContain('cfg-8');
  });

  it('ignores the cells an unguarded resume already injected into state.json', async () => {
    // The real incident: state.json holds 720 cells, only 35 of which the run
    // was ever launched to measure.
    await seedRun('20260801-085000', { inflated: true, spec: true });
    const { code, stdout } = await cli([
      'run',
      '--runconfig',
      runconfigPath,
      '--dry-run',
      '--resume',
      '20260801-085000',
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('recorded grid    35 cell(s)');
    expect(stdout).toContain('4 done, 31 pending');
    expect(stdout).toContain('would prune      685 cell(s)');
  });

  it('runs only the recorded grid, and repairs state.json to match it', async () => {
    await seedRun('20260801-085000', { inflated: true, spec: true });
    const { code, stdout } = await cli([
      'run',
      '--runconfig',
      runconfigPath,
      '--resume',
      '20260801-085000',
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('pruned 685 cell(s)');

    const state = await readState('20260801-085000');
    expect(Object.keys(state.cells)).toHaveLength(35);
    expect(Object.values(state.cells).every((c) => c.status === 'done')).toBe(true);
    expect(state.meta.trials).toBe(1);
    expect(state.meta.docsConditions).toEqual(['with']);
    // 31 pending cells ran; the 4 that were already done were not re-run.
    expect(
      Object.values(state.cells).filter((c) => c.attempts === 1 && c.trialDir !== undefined),
    ).toHaveLength(31);
  });

  it('does not re-read trials, docs or configs from runconfig.json', async () => {
    await seedRun('run-a', { inflated: false, spec: true });
    // Config file says 5 trials, both docs, 8 configs. None of it may leak in.
    const { stdout } = await cli([
      'run',
      '--runconfig',
      runconfigPath,
      '--dry-run',
      '--resume',
      'run-a',
    ]);
    expect(stdout).toContain('× with docs × 1 trial(s)');
    expect(stdout).toContain('7 config(s)');
    expect(stdout).not.toContain('with/without');
  });

  it('refuses to resume a grid whose tasks no longer exist', async () => {
    await seedRun('run-a', { inflated: false, spec: true });
    await rm(path.join(evalsRoot, RUN_TASKS[1]!), { recursive: true, force: true });
    const { code, stderr } = await cli([
      'run',
      '--runconfig',
      runconfigPath,
      '--dry-run',
      '--resume',
      'run-a',
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain('recorded 1 task(s) that no longer exist');
    expect(stderr).toContain(RUN_TASKS[1]!);
  });
});

describe('run --resume refuses to add cells without --expand', () => {
  it('names every axis that differs, and the cell count', async () => {
    await seedRun('run-a', { inflated: false, spec: true });
    const { code, stderr, stdout } = await cli([
      'run',
      '--runconfig',
      runconfigPath,
      '--resume',
      'run-a',
      '--trials',
      '5',
      '--docs',
      'both',
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain('refusing to add');
    expect(stderr).toContain('--trials 5 vs recorded 1');
    expect(stderr).toContain('docs with+without vs recorded with');
    expect(stderr).toContain('pass --expand to extend this run');
    // 5 tasks × 7 configs × 2 docs × 5 trials = 350, minus the 35 recorded.
    expect(stderr).toContain('refusing to add 315 cell(s)');
    // Nothing ran, nothing was written.
    expect(stdout).not.toContain('resuming');
    expect(Object.keys((await readState('run-a')).cells)).toHaveLength(35);
  });

  it('names tasks and configs that are not in the recorded grid', async () => {
    await seedRun('run-a', { inflated: false, spec: true });
    const { code, stderr } = await cli([
      'run',
      '--runconfig',
      runconfigPath,
      '--resume',
      'run-a',
      '--tasks',
      'build-fake-00*',
      '--configs',
      'cfg-1,cfg-8',
    ]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/4 task\(s\) not in the recorded grid/);
    expect(stderr).toContain('1 config(s) not in the recorded grid: cfg-8');
  });

  it('allows a narrowing resume — filters may shrink a pass, never grow the run', async () => {
    await seedRun('run-a', { inflated: false, spec: true });
    const { code, stdout } = await cli([
      'run',
      '--runconfig',
      runconfigPath,
      '--dry-run',
      '--resume',
      'run-a',
      '--configs',
      'cfg-1',
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('recorded grid    35 cell(s)');
    expect(stdout).toContain('would run        4 cell(s)');
    expect(stdout).toContain('30 recorded cell(s) excluded');
  });
});

describe('run --resume --expand', () => {
  it('adds the cells, says so loudly, and records the expansion in the spec', async () => {
    await seedRun('run-a', { inflated: false, spec: true });
    const { code, stdout } = await cli([
      'run',
      '--runconfig',
      runconfigPath,
      '--resume',
      'run-a',
      '--expand',
      '--trials',
      '2',
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('--expand: ADDING 35 cell(s)');
    expect(stdout).toContain('--trials 2 vs recorded 1');

    const spec = await readSpec('run-a');
    expect(spec.grid.trials).toBe(2);
    expect(specCells(spec)).toHaveLength(70);
    const expansion = spec.history.find((h) => h.event === 'expanded');
    expect(expansion).toBeDefined();
    expect(expansion!.added).toBe(35);
    expect(expansion!.diffs).toContain('--trials 2 vs recorded 1');
    expect(expansion!.previousGrid!.trials).toBe(1);
    expect(expansion!.argv).toContain('--expand');
    expect(Object.keys((await readState('run-a')).cells)).toHaveLength(70);
  });

  it('rejects --expand without --resume', async () => {
    const { code, stderr } = await cli([
      'run',
      '--runconfig',
      runconfigPath,
      '--expand',
      '--dry-run',
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain('--expand only applies with --resume');
  });
});

describe('run --resume: config drift', () => {
  it('warns prominently when a recorded config no longer matches the config file', async () => {
    await seedRun('run-a', { inflated: false, spec: true });
    await writeRunconfig({ 'cfg-1': { model: 'fake-model-CHANGED', reasoningEffort: 'high' } });
    const { code, stdout, stderr } = await cli([
      'run',
      '--runconfig',
      runconfigPath,
      '--resume',
      'run-a',
    ]);
    expect(code).toBe(0);
    expect(stderr).toContain('CONFIG DRIFT');
    expect(stderr).toContain('cfg-1: CHANGED DEFINITION model');
    expect(stderr).toContain('"fake-model-cfg-1"');
    expect(stderr).toContain('"fake-model-CHANGED"');
    expect(stderr).toContain('replays the definitions recorded at launch');
    // Recorded definition wins: the run keeps measuring what it was measuring.
    expect(stdout).not.toContain('fake-model-CHANGED');

    const spec = await readSpec('run-a');
    const drift = spec.history.find((h) => h.event === 'drift');
    expect(drift).toBeDefined();
    expect(drift!.drift![0]).toMatchObject({ configId: 'cfg-1', kind: 'behavioral' });
    expect(spec.configs.find((c) => c.id === 'cfg-1')!.model).toBe('fake-model-cfg-1');
  });

  it('treats pricing-only drift as a warning, not an error', async () => {
    await seedRun('run-a', { inflated: false, spec: true });
    await writeRunconfig({ 'cfg-2': { pricing: { inputPerMTok: 9, outputPerMTok: 99 } } });
    const { code, stderr } = await cli([
      'run',
      '--runconfig',
      runconfigPath,
      '--dry-run',
      '--resume',
      'run-a',
    ]);
    expect(code).toBe(0);
    expect(stderr).not.toContain('CONFIG DRIFT');
    const { stdout } = await cli([
      'run',
      '--runconfig',
      runconfigPath,
      '--dry-run',
      '--resume',
      'run-a',
      '--json',
    ]);
    const plan = JSON.parse(stdout) as { resume: { drift: string[] } };
    expect(plan.resume.drift.join('\n')).toContain('cfg-2: changed pricing');
  });

  it('records drift once, not once per resume', async () => {
    await seedRun('run-a', { inflated: false, spec: true });
    await writeRunconfig({ 'cfg-1': { model: 'fake-model-CHANGED' } });
    await cli(['run', '--runconfig', runconfigPath, '--resume', 'run-a']);
    await cli(['run', '--runconfig', runconfigPath, '--resume', 'run-a']);
    const spec = await readSpec('run-a');
    expect(spec.history.filter((h) => h.event === 'drift')).toHaveLength(1);
  });
});

describe('run --resume: runs with no spec file', () => {
  it('reconstructs the grid from state.json instead of falling back to config defaults', async () => {
    await seedRun('20260801-085000', { inflated: true, spec: false });
    const { code, stdout } = await cli([
      'run',
      '--runconfig',
      runconfigPath,
      '--dry-run',
      '--resume',
      '20260801-085000',
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('no run-spec.json');
    expect(stdout).toContain("reconstructed the grid from state.json's recorded run metadata");
    expect(stdout).toContain('recorded grid    35 cell(s)');
    expect(stdout).toContain('4 done, 31 pending');
    expect(stdout).toContain('would prune      685 cell(s)');
    expect(stdout).toContain('2 of them had been started');
  });

  it('persists the reconstructed spec on a real resume, so the next one is exact', async () => {
    await seedRun('20260801-085000', { inflated: true, spec: false });
    const { code } = await cli([
      'run',
      '--runconfig',
      runconfigPath,
      '--resume',
      '20260801-085000',
    ]);
    expect(code).toBe(0);
    const spec = await readSpec('20260801-085000');
    expect(spec.origin).toBe('reconstructed');
    expect(spec.grid.taskIds).toEqual(RUN_TASKS);
    expect(spec.grid.configIds).toEqual(RUN_CONFIGS);
    expect(spec.grid.trials).toBe(1);
    expect(spec.grid.docsConditions).toEqual(['with']);
    expect(spec.history[0]!.event).toBe('reconstructed');
    expect(specCells(spec)).toHaveLength(35);
  });

  it('fails with a clear message rather than guessing when nothing can be reconstructed', async () => {
    await mkdir(path.join(resultsRoot, 'run-empty'), { recursive: true });
    await writeFile(
      path.join(resultsRoot, 'run-empty', 'state.json'),
      JSON.stringify({
        version: 1,
        runId: 'run-empty',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        meta: {
          concurrency: 1,
          trials: 0,
          docsConditions: [],
          maxAttempts: 3,
          cooldownMs: 1000,
          evalsRoot,
          resultsRoot,
          configs: [],
          taskIds: [],
        },
        cells: {},
      }),
      'utf8',
    );
    const { code, stderr } = await cli([
      'run',
      '--runconfig',
      runconfigPath,
      '--dry-run',
      '--resume',
      'run-empty',
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain('cannot reconstruct the grid for run run-empty');
    expect(stderr).toContain('Refusing to fall back to the current runconfig.json');
  });
});

describe('run --dry-run --resume', () => {
  it('prints the replayed grid and changes nothing on disk', async () => {
    await seedRun('run-a', { inflated: true, spec: true });
    const statePath = path.join(resultsRoot, 'run-a', 'state.json');
    const before = await readFile(statePath, 'utf8');
    const mtimeBefore = (await stat(statePath)).mtimeMs;

    const { code, stdout } = await cli([
      'run',
      '--runconfig',
      runconfigPath,
      '--dry-run',
      '--resume',
      'run-a',
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('DRY RUN — nothing will be spawned, no state will be written.');
    expect(stdout).toContain('resume run-a');
    expect(stdout).toContain('would run        31 cell(s)');

    expect(await readFile(statePath, 'utf8')).toBe(before);
    expect((await stat(statePath)).mtimeMs).toBe(mtimeBefore);
    // No trial directories, and the interrupted cells were NOT reset.
    const state = JSON.parse(before) as RunStateFile;
    expect(Object.values(state.cells).filter((c) => c.status === 'running')).toHaveLength(2);
    await expect(stat(path.join(resultsRoot, 'run-a', RUN_TASKS[0]!))).rejects.toThrow();
  });

  it('is machine-readable with --json', async () => {
    await seedRun('run-a', { inflated: false, spec: true });
    const { stdout } = await cli([
      'run',
      '--runconfig',
      runconfigPath,
      '--dry-run',
      '--resume',
      'run-a',
      '--json',
    ]);
    const plan = JSON.parse(stdout) as {
      totalCells: number;
      resume: { runId: string; cells: number; done: number; pending: number; wouldRun: number };
    };
    expect(plan.totalCells).toBe(35);
    expect(plan.resume).toMatchObject({
      runId: 'run-a',
      cells: 35,
      done: 4,
      pending: 31,
      wouldRun: 31,
    });
  });
});
