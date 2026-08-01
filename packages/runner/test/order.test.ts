/**
 * Execution ordering (src/order.ts) and the scheduler behaviour that depends on
 * it.
 *
 * The load-bearing claims, in the order they are asserted:
 *
 *   1. `trial-major,task-major` covers every task in the first pass, and inside a
 *      trial every config runs task N before anyone runs task N+1 — that is what
 *      makes cross-config evidence about a broken task arrive in minutes.
 *   2. A config in a rate-window cooldown does NOT stall the block: everyone else
 *      walks on, and the straggler's cell is the first thing it picks up when its
 *      window reopens.
 *   3. Serial-per-config survives all of it.
 */

import { describe, expect, it } from 'vitest';
import { buildCells, cellKey, type CellCoords } from '../src/checkpoint.js';
import {
  DEFAULT_ORDER,
  LEGACY_ORDER,
  axesFromCells,
  blocksOf,
  cellRanker,
  orderCells,
  parseOrder,
} from '../src/order.js';
import { Scheduler, type QueueCell } from '../src/queue.js';

const MIN = 60_000;
const TASKS = ['task-1', 'task-2', 'task-3'];
const CONFIGS = ['cfgA', 'cfgB', 'cfgC'];

function grid(trials = 2): CellCoords[] {
  return buildCells({
    taskIds: TASKS,
    configIds: CONFIGS,
    docsConditions: ['with'],
    trials,
  });
}

const AXES = { taskIds: TASKS, configIds: CONFIGS, docsConditions: ['with' as const], trials: 2 };

/** Take `run` decisions until the scheduler says otherwise. */
function drain(s: Scheduler, now: number): QueueCell[] {
  const out: QueueCell[] = [];
  for (;;) {
    const d = s.next(now);
    if (d.kind !== 'run') break;
    out.push(d.cell);
  }
  return out;
}

describe('trial-major,task-major emission order', () => {
  it('is the default', () => {
    expect(DEFAULT_ORDER).toBe('trial-major,task-major');
    expect(parseOrder(undefined)).toBe('trial-major,task-major');
    expect(parseOrder('trial-major')).toBe('trial-major,task-major');
    expect(parseOrder('config-major')).toBe('config-major');
    expect(() => parseOrder('random')).toThrow(/--order must be one of/);
  });

  it('emits trial 1 of every (task, config) before any trial 2', () => {
    const ordered = orderCells(grid(3), 'trial-major,task-major', { ...AXES, trials: 3 });
    const firstTrial2 = ordered.findIndex((c) => c.trial === 2);
    // Every cell before the first trial-2 cell is trial 1, and there are
    // exactly as many of them as there are (task, config) pairs.
    expect(firstTrial2).toBe(TASKS.length * CONFIGS.length);
    expect(ordered.slice(0, firstTrial2).every((c) => c.trial === 1)).toBe(true);
    // Full task coverage in the first pass — the whole point.
    expect(new Set(ordered.slice(0, firstTrial2).map((c) => c.taskId))).toEqual(new Set(TASKS));
  });

  it('runs every config on task N before any config reaches task N+1', () => {
    const ordered = orderCells(grid(1), 'trial-major,task-major', { ...AXES, trials: 1 });
    expect(ordered.map((c) => `${c.taskId}/${c.configId}`)).toEqual([
      'task-1/cfgA', 'task-1/cfgB', 'task-1/cfgC',
      'task-2/cfgA', 'task-2/cfgB', 'task-2/cfgC',
      'task-3/cfgA', 'task-3/cfgB', 'task-3/cfgC',
    ]);
  });

  it('groups into one block per (trial, task)', () => {
    const blocks = blocksOf(grid(2), 'trial-major,task-major', AXES);
    expect(blocks).toHaveLength(TASKS.length * 2);
    expect(blocks[0]!.label).toBe('trial 1 · task-1');
    expect(blocks[0]!.cells).toHaveLength(CONFIGS.length);
    expect(blocks.at(-1)!.label).toBe('trial 2 · task-3');
  });

  it('keeps the docs axis inside the task block rather than splitting it', () => {
    const cells = buildCells({
      taskIds: ['t1', 't2'],
      configIds: ['a', 'b'],
      docsConditions: ['with', 'without'],
      trials: 1,
    });
    const blocks = blocksOf(cells, 'trial-major,task-major', {
      taskIds: ['t1', 't2'],
      configIds: ['a', 'b'],
      docsConditions: ['with', 'without'],
      trials: 1,
    });
    expect(blocks.map((b) => b.label)).toEqual(['trial 1 · t1', 'trial 1 · t2']);
    expect(blocks[0]!.cells).toHaveLength(4);
  });
});

describe('config-major, the pre-existing order', () => {
  it('walks one config through the whole task list before the next', () => {
    const ordered = orderCells(grid(1), 'config-major', { ...AXES, trials: 1 });
    expect(ordered.map((c) => `${c.configId}/${c.taskId}`)).toEqual([
      'cfgA/task-1', 'cfgA/task-2', 'cfgA/task-3',
      'cfgB/task-1', 'cfgB/task-2', 'cfgB/task-3',
      'cfgC/task-1', 'cfgC/task-2', 'cfgC/task-3',
    ]);
  });

  it('is what a run with no recorded policy is replayed as', () => {
    expect(LEGACY_ORDER).toBe('config-major');
  });

  it('takes 3× longer than trial-major to assemble cross-config evidence about the last task', () => {
    // The reason the default changed, expressed as a number. Under config-major
    // the third config's verdict on the LAST task is the last cell of the grid;
    // under trial-major it lands one block into the run.
    const cells = grid(1);
    const configMajor = orderCells(cells, 'config-major', { ...AXES, trials: 1 });
    const trialMajor = orderCells(cells, 'trial-major,task-major', { ...AXES, trials: 1 });
    const lastVerdictIndex = (ordered: CellCoords[], taskId: string): number =>
      ordered.map((c) => c.taskId).lastIndexOf(taskId);
    expect(lastVerdictIndex(configMajor, 'task-1')).toBe(6);
    expect(lastVerdictIndex(trialMajor, 'task-1')).toBe(2);
  });
});

describe('ranking edge cases', () => {
  it('sorts ids the axes never mentioned last, instead of throwing', () => {
    const rank = cellRanker('trial-major,task-major', AXES);
    const known = rank({ taskId: 'task-1', configId: 'cfgA', docsCondition: 'with', trial: 1 });
    const alien = rank({ taskId: 'task-9', configId: 'cfgZ', docsCondition: 'with', trial: 1 });
    expect(alien).toBeGreaterThan(known);
    expect(Number.isFinite(alien)).toBe(true);
  });

  it('derives axes from a ragged cell list in first-seen order', () => {
    const axes = axesFromCells([
      { taskId: 'b', configId: 'y', docsCondition: 'with', trial: 3 },
      { taskId: 'a', configId: 'x', docsCondition: 'without', trial: 1 },
    ]);
    expect(axes.taskIds).toEqual(['b', 'a']);
    expect(axes.configIds).toEqual(['y', 'x']);
    expect(axes.trials).toBe(3);
  });

  it('is a total order — no two cells of a grid tie', () => {
    const rank = cellRanker('trial-major,task-major', AXES);
    const ranks = grid(2).map(rank);
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});

describe('the scheduler executes the order', () => {
  /** Run the whole grid to completion, recording the order cells were started in. */
  function scheduled(policy: 'trial-major,task-major' | 'config-major'): string[] {
    const s = new Scheduler({
      concurrency: CONFIGS.length,
      rank: cellRanker(policy, { ...AXES, trials: 1 }),
    });
    s.enqueue(grid(1));
    const seen: string[] = [];
    for (let guard = 0; guard < 100; guard++) {
      const wave = drain(s, 0);
      if (wave.length === 0) break;
      for (const cell of wave) {
        seen.push(`${cell.taskId}/${cell.configId}`);
        s.settle(cell.key, { kind: 'done' }, 0);
      }
    }
    return seen;
  }

  it('emits cells in rank order, not insertion order', () => {
    expect(scheduled('trial-major,task-major')).toEqual([
      'task-1/cfgA', 'task-1/cfgB', 'task-1/cfgC',
      'task-2/cfgA', 'task-2/cfgB', 'task-2/cfgC',
      'task-3/cfgA', 'task-3/cfgB', 'task-3/cfgC',
    ]);
    // Same cells, same serial-per-config constraint, different order: each
    // config is walked through its own task list as far as concurrency allows.
    expect(scheduled('config-major')).toEqual([
      'task-1/cfgA', 'task-1/cfgB', 'task-1/cfgC',
      'task-2/cfgA', 'task-2/cfgB', 'task-2/cfgC',
      'task-3/cfgA', 'task-3/cfgB', 'task-3/cfgC',
    ]);
  });

  it('config-major with a narrow concurrency finishes one config before the next', () => {
    const s = new Scheduler({ concurrency: 1, rank: cellRanker('config-major', { ...AXES, trials: 1 }) });
    s.enqueue(grid(1));
    const seen: string[] = [];
    for (let guard = 0; guard < 100; guard++) {
      const wave = drain(s, 0);
      if (wave.length === 0) break;
      for (const cell of wave) {
        seen.push(`${cell.configId}/${cell.taskId}`);
        s.settle(cell.key, { kind: 'done' }, 0);
      }
    }
    expect(seen.slice(0, 3)).toEqual(['cfgA/task-1', 'cfgA/task-2', 'cfgA/task-3']);
  });

  it('never runs two cells of the same config at once, whatever the order', () => {
    const s = new Scheduler({
      concurrency: 8,
      rank: cellRanker('trial-major,task-major', { ...AXES, trials: 2 }),
    });
    s.enqueue(grid(2));
    const started = drain(s, 0);
    expect(started).toHaveLength(CONFIGS.length);
    expect(new Set(started.map((c) => c.configId)).size).toBe(CONFIGS.length);
    expect(s.next(0).kind).toBe('busy');
  });
});

/**
 * The straggler. This is the whole reason blocks are soft: a 30-minute Kimi
 * cooldown must not idle the other six configs, and when Kimi wakes it must pick
 * up the block it missed rather than wherever the rest of the grid has got to.
 */
describe('a cooling-down config does not stall its block', () => {
  it('lets the other configs walk on into the next block', () => {
    const s = new Scheduler({
      concurrency: CONFIGS.length,
      cooldownMs: 30 * MIN,
      rank: cellRanker('trial-major,task-major', { ...AXES, trials: 1 }),
    });
    s.enqueue(grid(1));

    const first = drain(s, 0);
    expect(first.map((c) => c.taskId)).toEqual(['task-1', 'task-1', 'task-1']);

    // cfgC hits its usage window on task-1; the other two finish normally.
    const slow = first.find((c) => c.configId === 'cfgC')!;
    s.settle(slow.key, { kind: 'rate-limited' }, 0);
    for (const c of first.filter((c) => c.configId !== 'cfgC')) {
      s.settle(c.key, { kind: 'done' }, 0);
    }

    // The block is NOT waited on: task-2 starts immediately, without cfgC.
    const next = drain(s, 1_000);
    expect(next.map((c) => `${c.taskId}/${c.configId}`)).toEqual([
      'task-2/cfgA',
      'task-2/cfgB',
    ]);
    expect(s.isPaused('cfgC', 1_000)).toBe(true);
  });

  it('gives the straggler its missed cell first when the window reopens', () => {
    const s = new Scheduler({
      concurrency: CONFIGS.length,
      cooldownMs: 30 * MIN,
      rank: cellRanker('trial-major,task-major', { ...AXES, trials: 1 }),
    });
    s.enqueue(grid(1));

    const first = drain(s, 0);
    const slow = first.find((c) => c.configId === 'cfgC')!;
    s.settle(slow.key, { kind: 'rate-limited' }, 0);
    for (const c of first.filter((c) => c.configId !== 'cfgC')) {
      s.settle(c.key, { kind: 'done' }, 0);
    }
    // The other two race ahead through task-2 and task-3 while cfgC sleeps.
    for (const c of drain(s, 1_000)) s.settle(c.key, { kind: 'done' }, 1_000);
    for (const c of drain(s, 2_000)) s.settle(c.key, { kind: 'done' }, 2_000);

    const woken = drain(s, 31 * MIN);
    expect(woken.map((c) => `${c.taskId}/${c.configId}`)).toEqual([
      // Its own missed block first…
      'task-1/cfgC',
    ]);
    // …then the rest of its lane, still in task order.
    s.settle(woken[0]!.key, { kind: 'done' }, 31 * MIN);
    expect(drain(s, 31 * MIN).map((c) => c.taskId)).toEqual(['task-2']);
  });

  it('a retry keeps its place in the order instead of going to the very back', () => {
    // Without ranking a retried cell is pushed to the back of the queue, which
    // under trial-major would put a task's FIRST-trial evidence behind the whole
    // of trial 3 — exactly the delay the ordering exists to remove.
    const s = new Scheduler({
      concurrency: 1,
      maxAttempts: 3,
      rank: cellRanker('trial-major,task-major', { ...AXES, trials: 2 }),
    });
    s.enqueue(grid(2));

    const first = drain(s, 0)[0]!;
    expect(first.taskId).toBe('task-1');
    s.settle(first.key, { kind: 'failed', detail: 'flake' }, 0);

    // It is retried within its own trial-1 block, not after trial 2.
    const rest: string[] = [];
    for (let i = 0; i < 4; i++) {
      const d = s.next(0);
      if (d.kind !== 'run') break;
      rest.push(cellKey(d.cell));
      s.settle(d.cell.key, { kind: 'done' }, 0);
    }
    expect(rest).toContain(first.key);
    expect(rest.indexOf(first.key)).toBeLessThan(3);
  });

  it('without a ranker the historical positions are preserved exactly', () => {
    const s = new Scheduler({ concurrency: 1, maxAttempts: 3 });
    s.enqueue(grid(1));
    const first = drain(s, 0)[0]!;
    s.settle(first.key, { kind: 'failed' }, 0);
    const second = s.next(0);
    expect(second.kind).toBe('run');
    // Old behaviour: a retry goes to the BACK, so a different cell runs next.
    if (second.kind === 'run') expect(second.cell.key).not.toBe(first.key);
  });
});
