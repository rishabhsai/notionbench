/**
 * The run spec in isolation: expansion, diffing, drift classification and the
 * reconstruction of a run that predates the file.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cellKey, type RunStateFile } from '../src/checkpoint.js';
import type { AgentConfig } from '../src/config.js';
import {
  RUN_SPEC_FILENAME,
  createRunSpec,
  detectDrift,
  diffGrid,
  driftLines,
  expandSpec,
  gridCells,
  hashConfigs,
  isSeriousDrift,
  readRunSpec,
  reconstructSpec,
  recordDrift,
  renderRefusal,
  runSpecPath,
  specCells,
  writeRunSpec,
  type RequestedAxes,
  type RunSpecExecution,
  type RunSpecFile,
  type SpecConfig,
} from '../src/run-spec.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nb-spec-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const EXECUTION: RunSpecExecution = {
  concurrency: 2,
  maxAttempts: 3,
  cooldownMs: 1_800_000,
  defaultTimeoutSec: 900,
  killGraceMs: 10_000,
  evalsRoot: '/repo/evals',
  resultsRoot: '/repo/results',
  scoring: { enabled: true, timeoutMs: 600_000 },
};

function config(id: string, over: Partial<SpecConfig> = {}): SpecConfig {
  return {
    id,
    label: id,
    harness: 'claude-code',
    model: 'opus',
    enabled: true,
    pricing: { inputPerMTok: 5, outputPerMTok: 25 },
    ...over,
  };
}

function spec(over: Partial<RunSpecFile> = {}): RunSpecFile {
  return createRunSpec({
    runId: 'run-1',
    grid: { taskIds: ['t1', 't2'], configIds: ['a', 'b'], docsConditions: ['with'], trials: 1 },
    configs: [config('a'), config('b')],
    execution: EXECUTION,
    runconfigPath: '/repo/runconfig.json',
    argv: ['run', '--trials', '1'],
    ...over,
  });
}

function axes(over: Partial<RequestedAxes> = {}): RequestedAxes {
  return {
    taskIds: ['t1', 't2'],
    configIds: ['a', 'b'],
    docsConditions: ['with'],
    trials: 1,
    explicit: { tasks: false, configs: false, docs: false, trials: false },
    ...over,
  };
}

describe('specCells', () => {
  it('is the cartesian product of the recorded axes', () => {
    expect(specCells(spec())).toHaveLength(4);
  });

  it('honours a config pinned to one docs condition', () => {
    const s = spec({
      grid: {
        taskIds: ['t1'],
        configIds: ['a', 'b'],
        docsConditions: ['with', 'without'],
        trials: 1,
      },
      configs: [config('a'), config('b', { docsCondition: 'with' })],
    });
    // `a` contributes both conditions, `b` only its pin.
    expect(specCells(s).map(cellKey).sort()).toEqual([
      't1::a::with::1',
      't1::a::without::1',
      't1::b::with::1',
    ]);
  });

  it('uses an explicit cell list verbatim when the set is not a rectangle', () => {
    const s = spec({
      grid: {
        taskIds: ['t1', 't2'],
        configIds: ['a'],
        docsConditions: ['with'],
        trials: 2,
        cells: [
          { taskId: 't1', configId: 'a', docsCondition: 'with', trial: 1 },
          { taskId: 't2', configId: 'a', docsCondition: 'with', trial: 2 },
        ],
      },
    });
    expect(specCells(s)).toHaveLength(2);
  });
});

describe('diffGrid', () => {
  it('reports nothing when the invocation asks for exactly the recorded grid', () => {
    const s = spec();
    const diff = diffGrid(s, specCells(s), axes());
    expect(diff.added).toEqual([]);
    expect(diff.excluded).toEqual([]);
    expect(diff.reasons).toEqual([]);
  });

  it('names each widened axis, in the words the refusal uses', () => {
    const s = spec();
    const requestedAxes = axes({
      taskIds: ['t1', 't2', 't3'],
      configIds: ['a', 'b', 'c'],
      docsConditions: ['with', 'without'],
      trials: 5,
      explicit: { tasks: true, configs: true, docs: true, trials: true },
    });
    const requested = gridCells(requestedAxes, [config('a'), config('b'), config('c')]);
    const diff = diffGrid(s, requested, requestedAxes);
    expect(diff.added).toHaveLength(requested.length - specCells(s).length);
    expect(diff.reasons).toEqual([
      '--trials 5 vs recorded 1',
      'docs with+without vs recorded with',
      '1 task(s) not in the recorded grid: t3',
      '1 config(s) not in the recorded grid: c',
    ]);
    expect(renderRefusal(s, diff)).toBe(
      `refusing to add ${diff.added.length} cell(s) to run run-1: ` +
        '--trials 5 vs recorded 1, docs with+without vs recorded with, ' +
        '1 task(s) not in the recorded grid: t3, 1 config(s) not in the recorded grid: c; ' +
        'pass --expand to extend this run',
    );
  });

  it('reports cells excluded by a narrowing invocation without calling them additions', () => {
    const s = spec();
    const narrowed = axes({ configIds: ['a'], explicit: { ...axes().explicit, configs: true } });
    const diff = diffGrid(s, gridCells(narrowed, [config('a')]), narrowed);
    expect(diff.added).toEqual([]);
    expect(diff.excluded).toHaveLength(2);
  });
});

describe('expandSpec', () => {
  it('promotes the grid to the wider rectangle and records the expansion', () => {
    const s = spec();
    const wider = axes({ trials: 3, explicit: { ...axes().explicit, trials: true } });
    const requested = gridCells(wider, s.configs);
    const diff = diffGrid(s, requested, wider);
    const expanded = expandSpec(s, {
      axes: wider,
      requested,
      diff,
      newConfigs: [],
      argv: ['run', '--expand', '--trials', '3'],
    });
    expect(expanded.grid.trials).toBe(3);
    expect(expanded.grid.cells).toBeUndefined();
    expect(specCells(expanded)).toHaveLength(12);
    const entry = expanded.history.at(-1)!;
    expect(entry.event).toBe('expanded');
    expect(entry.added).toBe(8);
    expect(entry.previousGrid!.trials).toBe(1);
  });

  it('pins an explicit cell list when the union is not a rectangle', () => {
    const s = spec();
    // Ask for one extra task at 3 trials: the union of that and a 2×2×1 grid is
    // not describable as a product.
    const other = axes({
      taskIds: ['t3'],
      trials: 3,
      explicit: { tasks: true, configs: false, docs: false, trials: true },
    });
    const requested = gridCells(other, s.configs);
    const diff = diffGrid(s, requested, other);
    const expanded = expandSpec(s, {
      axes: other,
      requested,
      diff,
      newConfigs: [],
      argv: ['run', '--expand'],
    });
    expect(expanded.grid.cells).toBeDefined();
    expect(specCells(expanded)).toHaveLength(4 + 6);
  });

  it('carries the definition of a newly added config into the spec', () => {
    const s = spec();
    const wider = axes({
      configIds: ['a', 'b', 'c'],
      explicit: { ...axes().explicit, configs: true },
    });
    const newConfig = config('c', { model: 'sonnet' });
    const requested = gridCells(wider, [...s.configs, newConfig]);
    const expanded = expandSpec(s, {
      axes: wider,
      requested,
      diff: diffGrid(s, requested, wider),
      newConfigs: [newConfig],
      argv: [],
    });
    expect(expanded.configs.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(expanded.provenance.configHash).not.toBe(s.provenance.configHash);
  });
});

describe('detectDrift', () => {
  const current = (over: Partial<AgentConfig> = {}): AgentConfig[] => [
    { ...config('a'), ...over } as AgentConfig,
    config('b') as AgentConfig,
  ];

  it('is silent when the config file still matches', () => {
    expect(detectDrift(spec(), current())).toEqual([]);
  });

  it('classifies a model change as behavioral', () => {
    const drift = detectDrift(spec(), current({ model: 'sonnet' }));
    expect(drift).toEqual([
      {
        configId: 'a',
        kind: 'behavioral',
        changes: [{ field: 'model', recorded: 'opus', current: 'sonnet' }],
      },
    ]);
    expect(isSeriousDrift(drift)).toBe(true);
    expect(driftLines(drift)[0]).toBe(
      'a: CHANGED DEFINITION model: recorded "opus" → now "sonnet"',
    );
  });

  it('classifies an effort change as behavioral', () => {
    const drift = detectDrift(spec(), current({ reasoningEffort: 'xhigh' }));
    expect(drift[0]).toMatchObject({ kind: 'behavioral' });
  });

  it('classifies a pricing change on its own as pricing, and not as serious', () => {
    const drift = detectDrift(spec(), current({ pricing: { inputPerMTok: 6, outputPerMTok: 25 } }));
    expect(drift).toHaveLength(1);
    expect(drift[0]!.kind).toBe('pricing');
    expect(isSeriousDrift(drift)).toBe(false);
  });

  it('reports a config that has vanished from the file', () => {
    const drift = detectDrift(spec(), [config('a') as AgentConfig]);
    expect(drift).toEqual([{ configId: 'b', kind: 'missing', changes: [] }]);
    expect(isSeriousDrift(drift)).toBe(true);
  });

  it('records drift once per distinct change', () => {
    const drift = detectDrift(spec(), current({ model: 'sonnet' }));
    const once = recordDrift(spec(), drift, []);
    expect(once.history.filter((h) => h.event === 'drift')).toHaveLength(1);
    expect(recordDrift(once, drift, [])).toBe(once);
    const different = detectDrift(spec(), current({ model: 'haiku' }));
    expect(recordDrift(once, different, []).history.filter((h) => h.event === 'drift')).toHaveLength(
      2,
    );
  });
});

describe('hashConfigs', () => {
  it('ignores key order but not values', () => {
    const a: SpecConfig = { ...config('a'), pricing: { inputPerMTok: 5, outputPerMTok: 25 } };
    const b: SpecConfig = { ...config('a'), pricing: { outputPerMTok: 25, inputPerMTok: 5 } };
    expect(hashConfigs([a])).toBe(hashConfigs([b]));
    expect(hashConfigs([a])).not.toBe(hashConfigs([{ ...a, model: 'sonnet' }]));
  });
});

describe('read/write', () => {
  it('round-trips through disk', async () => {
    const s = spec();
    await writeRunSpec(root, s);
    const back = await readRunSpec(root, 'run-1');
    expect(back).toMatchObject({ ...s, updatedAt: expect.any(String) });
    expect(runSpecPath(root, 'run-1')).toBe(path.join(root, 'run-1', RUN_SPEC_FILENAME));
  });

  it('returns undefined for a run that has no spec', async () => {
    expect(await readRunSpec(root, 'nope')).toBeUndefined();
  });

  it('refuses a spec written by a future runner rather than mis-reading it', async () => {
    await writeRunSpec(root, { ...spec(), version: 99 });
    await expect(readRunSpec(root, 'run-1')).rejects.toThrow(/version 99 is not supported/);
  });

  it('refuses a corrupt spec rather than falling back to config defaults', async () => {
    await writeRunSpec(root, spec());
    await writeFile(runSpecPath(root, 'run-1'), '{ not json', 'utf8');
    await expect(readRunSpec(root, 'run-1')).rejects.toThrow(/not valid JSON/);
  });
});

describe('reconstructSpec', () => {
  function state(over: Partial<RunStateFile> = {}): RunStateFile {
    return {
      version: 1,
      runId: 'legacy-1',
      createdAt: '2026-08-01T08:50:01.067Z',
      updatedAt: '2026-08-01T09:10:55.419Z',
      meta: {
        concurrency: 2,
        trials: 1,
        docsConditions: ['with'],
        maxAttempts: 3,
        cooldownMs: 1_800_000,
        evalsRoot: '/repo/evals',
        resultsRoot: '/repo/results',
        configs: [{ id: 'a', harness: 'claude-code', model: 'opus', cliVersion: '2.1.220' }],
        taskIds: ['t1', 't2'],
      },
      cells: {},
      ...over,
    };
  }

  function cell(
    taskId: string,
    trial: number,
    status: 'pending' | 'done' | 'running',
    docsCondition: 'with' | 'without' = 'with',
  ): RunStateFile['cells'][string] {
    return {
      taskId,
      configId: 'a',
      docsCondition,
      trial,
      status,
      attempts: status === 'pending' ? 0 : 1,
      rateLimitedAttempts: 0,
      history: [],
    };
  }

  it('takes the grid from the run metadata, not from the inflated cell map', () => {
    const s = state({
      cells: {
        't1::a::with::1': cell('t1', 1, 'done'),
        't2::a::with::1': cell('t2', 1, 'pending'),
        // The residue of an unguarded resume: never-run cells outside the grid.
        't1::a::without::1': cell('t1', 1, 'pending', 'without'),
        't1::a::with::5': cell('t1', 5, 'pending'),
        // …including two it had already started.
        't2::a::with::2': cell('t2', 2, 'running'),
      },
    });
    const { spec: rebuilt, notes } = reconstructSpec({ state: s, execution: EXECUTION, argv: [] });
    expect(specCells(rebuilt).map(cellKey).sort()).toEqual(['t1::a::with::1', 't2::a::with::1']);
    expect(rebuilt.origin).toBe('reconstructed');
    expect(rebuilt.configs[0]).toMatchObject({ id: 'a', model: 'opus', reconstructed: true });
    expect(notes.join('\n')).toContain('ignoring 3 never-completed cell(s)');
    expect(notes.join('\n')).toContain('1 of them had been started');
  });

  it('keeps completed cells recorded outside the metadata grid', () => {
    const s = state({
      cells: {
        't1::a::with::1': cell('t1', 1, 'done'),
        // A legitimate pre-fix widening that actually produced a result.
        't1::a::with::2': cell('t1', 2, 'done'),
      },
    });
    const { spec: rebuilt } = reconstructSpec({ state: s, execution: EXECUTION, argv: [] });
    expect(specCells(rebuilt).map(cellKey)).toContain('t1::a::with::2');
    expect(specCells(rebuilt)).toHaveLength(3);
  });

  it('falls back to the executed cells when the metadata is unusable', () => {
    const s = state({
      meta: { ...state().meta, taskIds: [], configs: [], docsConditions: [], trials: 0 },
      cells: {
        't1::a::with::1': cell('t1', 1, 'done'),
        't9::a::with::1': cell('t9', 1, 'pending'),
      },
    });
    const { spec: rebuilt, notes } = reconstructSpec({ state: s, execution: EXECUTION, argv: [] });
    expect(specCells(rebuilt).map(cellKey)).toEqual(['t1::a::with::1']);
    expect(notes.join('\n')).toContain('the 1 cell(s) this run actually executed');
  });

  it('throws rather than guessing when there is nothing to reconstruct from', () => {
    const s = state({
      meta: { ...state().meta, taskIds: [], configs: [], docsConditions: [], trials: 0 },
    });
    expect(() => reconstructSpec({ state: s, execution: EXECUTION, argv: [] })).toThrow(
      /cannot reconstruct the grid for run legacy-1/,
    );
  });
});
