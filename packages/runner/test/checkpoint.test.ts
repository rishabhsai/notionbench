import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Checkpoint,
  buildCells,
  cellKey,
  claimRunId,
  newRunId,
  parseCellKey,
  resume,
  trialDirFor,
  type CellCoords,
  type RunMeta,
} from '../src/checkpoint.js';
import type { TrialOutcome } from '../src/spawn.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nb-ckpt-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const META: RunMeta = {
  concurrency: 2,
  trials: 2,
  docsConditions: ['with', 'without'],
  maxAttempts: 3,
  cooldownMs: 1_800_000,
  evalsRoot: '/repo/evals',
  resultsRoot: '/repo/results',
  configs: [
    { id: 'claude-code-opus-5', harness: 'claude-code', model: 'opus', cliVersion: '2.1.220' },
    { id: 'codex-high', harness: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
  ],
  taskIds: ['build-cli-001', 'build-nac-001'],
};

const CELLS = buildCells({
  taskIds: ['build-cli-001', 'build-nac-001'],
  configIds: ['claude-code-opus-5', 'codex-high'],
  docsConditions: ['with', 'without'],
  trials: 2,
});

function fakeOutcome(
  coords: CellCoords,
  overrides: Partial<TrialOutcome> = {},
  runId = 'run1',
): TrialOutcome {
  return {
    identity: { runId, ...coords },
    status: 'completed',
    exitCode: 0,
    signal: null,
    timedOut: false,
    startedAt: '2026-07-31T00:00:00.000Z',
    finishedAt: '2026-07-31T00:05:00.000Z',
    durationMs: 300_000,
    trialDir: path.join(root, runId, trialDirFor(coords)),
    transcriptPath: 'x/transcript.jsonl',
    resultPath: 'x/result.json',
    workspaceDir: '/tmp/ws',
    parsed: {
      usage: null,
      usageRaw: null,
      toolCalls: 12,
      toolErrors: 2,
      rateLimitSignals: [],
      parseWarnings: [],
    },
    usage: {
      inputTokens: 100,
      outputTokens: 200,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 400,
      reasoningOutputTokens: 0,
      totalTokens: 1000,
      inputTokensIncludeCached: false,
    },
    apiEquivalentCostUsd: 0.42,
    rateLimit: { detected: false, signals: [] },
    invocation: { command: 'claude', args: [], cwd: '/tmp/ws', envKeys: [] },
    stdoutBytes: 1234,
    stderrBytes: 0,
    truncatedInMemory: false,
    ...overrides,
  };
}

describe('cell keys', () => {
  it('round-trips through parseCellKey', () => {
    const coords: CellCoords = {
      taskId: 'nac/idempotent-extend',
      configId: 'codex-gpt-5.6-sol-high',
      docsCondition: 'without',
      trial: 4,
    };
    expect(parseCellKey(cellKey(coords))).toEqual(coords);
  });

  it('rejects malformed keys loudly', () => {
    expect(() => parseCellKey('a::b::c')).toThrow(/malformed/);
    expect(() => parseCellKey('a::b::sideways::1')).toThrow(/docs condition/);
    expect(() => parseCellKey('a::b::with::nope')).toThrow(/trial number/);
  });

  it('lays trial dirs out as task/config/docs/trial', () => {
    expect(
      trialDirFor({ taskId: 'build-cli-001', configId: 'opus', docsCondition: 'with', trial: 3 }),
    ).toBe(path.join('build-cli-001', 'opus', 'docs-with', 'trial-3'));
  });
});

describe('buildCells', () => {
  it('expands the full grid across all four axes', () => {
    expect(CELLS).toHaveLength(2 * 2 * 2 * 2);
    expect(new Set(CELLS.map(cellKey)).size).toBe(CELLS.length);
  });
});

describe('Checkpoint round-trip', () => {
  it('persists to results/<run>/state.json and reloads identically', async () => {
    const runId = newRunId();
    const cp = await Checkpoint.create({ runId, resultsRoot: root, meta: META, cells: CELLS });
    expect(cp.statePath).toBe(path.join(root, runId, 'state.json'));

    const coords = CELLS[0]!;
    await cp.markRunning(coords);
    await cp.markDone(coords, fakeOutcome(coords, {}, runId));

    const reloaded = await Checkpoint.load(runId, root);
    expect(reloaded.summary().done).toBe(1);
    expect(reloaded.summary().total).toBe(CELLS.length);
    expect(reloaded.get(coords)).toMatchObject({
      status: 'done',
      attempts: 1,
      toolCalls: 12,
      toolErrors: 2,
      apiEquivalentCostUsd: 0.42,
      durationMs: 300_000,
    });
    expect(reloaded.get(coords)!.usage!.totalTokens).toBe(1000);
    // trialDir is stored relative to the run dir so a results tree stays movable.
    expect(reloaded.get(coords)!.trialDir).toBe(trialDirFor(coords));
    expect(reloaded.meta).toEqual(META);
  });

  it('writes state atomically, leaving no partial file behind', async () => {
    const runId = 'atomic-run';
    const cp = await Checkpoint.create({ runId, resultsRoot: root, meta: META, cells: CELLS });
    await Promise.all(CELLS.slice(0, 4).map((c) => cp.markRunning(c)));
    await cp.save();

    const entries = await readdir(path.join(root, runId));
    expect(entries).toEqual(['state.json']); // no .tmp-* leftovers
    const text = await readFile(cp.statePath, 'utf8');
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('serializes concurrent saves so the file is never interleaved', async () => {
    const cp = await Checkpoint.create({ runId: 'race', resultsRoot: root, meta: META, cells: CELLS });
    await Promise.all(
      CELLS.map(async (c) => {
        await cp.markRunning(c);
        await cp.markDone(c, fakeOutcome(c));
      }),
    );
    const reloaded = await Checkpoint.load('race', root);
    expect(reloaded.summary().done).toBe(CELLS.length);
  });

  it('refuses to load a state file from a different schema version', async () => {
    const cp = await Checkpoint.create({ runId: 'v', resultsRoot: root, meta: META, cells: CELLS });
    const state = JSON.parse(await readFile(cp.statePath, 'utf8'));
    state.version = 99;
    await writeFile(cp.statePath, JSON.stringify(state), 'utf8');
    await expect(Checkpoint.load('v', root)).rejects.toThrow(/version 99/);
  });

  it('gives a useful error for an unknown runId', async () => {
    await expect(Checkpoint.load('never-ran', root)).rejects.toThrow(/unknown runId/);
  });

  it('backfills fields missing from an older/hand-edited state file', async () => {
    const cp = await Checkpoint.create({ runId: 'old', resultsRoot: root, meta: META, cells: CELLS });
    const state = JSON.parse(await readFile(cp.statePath, 'utf8'));
    const key = cellKey(CELLS[0]!);
    state.cells[key] = { status: 'done' }; // everything else stripped
    await writeFile(cp.statePath, JSON.stringify(state), 'utf8');

    const reloaded = await Checkpoint.load('old', root);
    expect(reloaded.get(CELLS[0]!)).toMatchObject({
      status: 'done',
      taskId: CELLS[0]!.taskId,
      attempts: 0,
      rateLimitedAttempts: 0,
    });
    expect(reloaded.get(CELLS[0]!)!.history).toEqual([]);
  });
});

describe('resume', () => {
  it('skips done cells and re-queues cells that were in flight when the process died', async () => {
    const runId = 'resume-1';
    const cp = await Checkpoint.create({ runId, resultsRoot: root, meta: META, cells: CELLS });

    const done = CELLS[0]!;
    const crashed = CELLS[1]!;
    await cp.markRunning(done);
    await cp.markDone(done, fakeOutcome(done));
    await cp.markRunning(crashed); // process dies here

    const resumed = await resume(runId, root);
    expect(resumed.isDone(done)).toBe(true);
    expect(resumed.get(crashed)!.status).toBe('pending');
    // The attempt is NOT refunded: a cell that reliably kills the runner must
    // eventually exhaust its budget rather than loop forever.
    expect(resumed.get(crashed)!.attempts).toBe(1);
    expect(resumed.pending().map(cellKey)).not.toContain(cellKey(done));
    expect(resumed.pending().map(cellKey)).toContain(cellKey(crashed));
  });

  it('is idempotent — resuming twice changes nothing', async () => {
    const runId = 'resume-2';
    const cp = await Checkpoint.create({ runId, resultsRoot: root, meta: META, cells: CELLS });
    await cp.markRunning(CELLS[0]!);
    await cp.markDone(CELLS[0]!, fakeOutcome(CELLS[0]!));

    const a = await resume(runId, root);
    const b = await resume(runId, root);
    expect(b.summary()).toEqual(a.summary());
  });

  it('ensureCells adds newly-selected cells without disturbing existing ones', async () => {
    const runId = 'grow';
    const cp = await Checkpoint.create({ runId, resultsRoot: root, meta: META, cells: CELLS });
    await cp.markRunning(CELLS[0]!);
    await cp.markDone(CELLS[0]!, fakeOutcome(CELLS[0]!));

    // Raise --trials from 2 to 3.
    const wider = buildCells({
      taskIds: ['build-cli-001', 'build-nac-001'],
      configIds: ['claude-code-opus-5', 'codex-high'],
      docsConditions: ['with', 'without'],
      trials: 3,
    });
    const added = await cp.ensureCells(wider);
    expect(added).toBe(wider.length - CELLS.length);
    expect(cp.isDone(CELLS[0]!)).toBe(true);
    expect(cp.summary().total).toBe(wider.length);
    expect(await cp.ensureCells(wider)).toBe(0);
  });
});

describe('attempt accounting', () => {
  it('retries a failure until maxAttempts, then marks it failed', async () => {
    const cp = await Checkpoint.create({ runId: 'fail', resultsRoot: root, meta: META, cells: CELLS });
    const coords = CELLS[0]!;

    for (let i = 1; i <= 2; i++) {
      await cp.markRunning(coords);
      const cell = await cp.markFailed(coords, `boom ${i}`, 'failed');
      expect(cell.status).toBe('pending');
      expect(cell.attempts).toBe(i);
    }
    await cp.markRunning(coords);
    const final = await cp.markFailed(coords, 'boom 3', 'failed');
    expect(final.status).toBe('failed');
    expect(final.attempts).toBe(3);
    expect(final.lastError).toBe('boom 3');
    expect(cp.summary().failed).toBe(1);
  });

  it('refunds the attempt when a trial dies to the subscription rate window', async () => {
    const cp = await Checkpoint.create({ runId: 'rl', resultsRoot: root, meta: META, cells: CELLS });
    const coords = CELLS[0]!;

    // A rate window must not eat the retry budget over a multi-day run.
    for (let i = 0; i < 5; i++) {
      await cp.markRunning(coords);
      const cell = await cp.markRateLimited(coords, 'usage limit reached');
      expect(cell.status).toBe('pending');
      expect(cell.attempts).toBe(0);
      expect(cell.rateLimitedAttempts).toBe(i + 1);
    }
    expect(cp.summary().failed).toBe(0);
    expect(cp.summary().rateLimitedAttempts).toBe(5);

    // The real attempt budget is still fully intact afterwards.
    await cp.markRunning(coords);
    expect((await cp.markFailed(coords, 'boom', 'failed')).status).toBe('pending');
  });

  it('records a timed-out trial as done — the verifier, not the runner, decides pass/fail', async () => {
    const cp = await Checkpoint.create({ runId: 'to', resultsRoot: root, meta: META, cells: CELLS });
    const coords = CELLS[0]!;
    await cp.markRunning(coords);
    await cp.markDone(coords, fakeOutcome(coords, { status: 'timeout', timedOut: true, exitCode: null }));
    expect(cp.get(coords)).toMatchObject({ status: 'done', lastTrialStatus: 'timeout' });
  });

  it('throws for a cell that is not part of the run', async () => {
    const cp = await Checkpoint.create({ runId: 'x', resultsRoot: root, meta: META, cells: CELLS });
    await expect(
      cp.markRunning({ taskId: 'nope', configId: 'opus', docsCondition: 'with', trial: 1 }),
    ).rejects.toThrow(/no such cell/);
  });

  it('caps per-cell history so a long run cannot grow state.json without bound', async () => {
    const cp = await Checkpoint.create({ runId: 'h', resultsRoot: root, meta: META, cells: CELLS });
    const coords = CELLS[0]!;
    for (let i = 0; i < 40; i++) {
      await cp.markRunning(coords);
      await cp.markRateLimited(coords, `window ${i}`);
    }
    expect(cp.get(coords)!.history.length).toBeLessThanOrEqual(20);
  });
});

describe('summary', () => {
  it('breaks progress down per config', async () => {
    const cp = await Checkpoint.create({ runId: 's', resultsRoot: root, meta: META, cells: CELLS });
    for (const c of CELLS.filter((c) => c.configId === 'codex-high')) {
      await cp.markRunning(c);
      await cp.markDone(c, fakeOutcome(c));
    }
    const s = cp.summary();
    expect(s.byConfig['codex-high']).toMatchObject({ done: 8, pending: 0, total: 8 });
    expect(s.byConfig['claude-code-opus-5']).toMatchObject({ done: 0, pending: 8, total: 8 });
  });
});

describe('claimRunId', () => {
  it('never hands two runs the same directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nb-runid-'));
    const at = new Date('2026-08-02T03:14:36Z');
    const a = await claimRunId(root, at);
    const b = await claimRunId(root, at);
    const c = await claimRunId(root, at);
    expect(a).toBe('20260802-031436');
    expect(new Set([a, b, c]).size).toBe(3);
    // Every id keeps the canonical shape — a suffix would truncate to another
    // run's id under the parsers that read run ids out of paths and logs.
    for (const id of [a, b, c]) expect(id).toMatch(/^\d{8}-\d{6}$/);
    await rm(root, { recursive: true, force: true });
  });
});
