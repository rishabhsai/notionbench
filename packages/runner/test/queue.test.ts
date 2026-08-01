import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCells, cellKey, type CellCoords } from '../src/checkpoint.js';
import {
  Scheduler,
  readRateWindowState,
  runQueue,
  writeRateWindowState,
  type CellOutcome,
  type QueueCell,
  type RateWindowState,
  type SchedulerEvent,
} from '../src/queue.js';

const MIN = 60_000;

function cells(args: {
  tasks?: string[];
  configs?: string[];
  docs?: Array<'with' | 'without'>;
  trials?: number;
}): CellCoords[] {
  return buildCells({
    taskIds: args.tasks ?? ['t1'],
    configIds: args.configs ?? ['cfgA', 'cfgB'],
    docsConditions: args.docs ?? ['with'],
    trials: args.trials ?? 2,
  });
}

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

describe('serial-per-config scheduling', () => {
  it('never runs two trials of the same config at once', () => {
    const s = new Scheduler({ concurrency: 4 });
    s.enqueue(cells({ configs: ['cfgA', 'cfgB'], trials: 5 }));

    const started = drain(s, 0);
    expect(started).toHaveLength(2);
    expect(new Set(started.map((c) => c.configId))).toEqual(new Set(['cfgA', 'cfgB']));
    // Even with capacity to spare, no third trial starts — both configs are busy.
    expect(s.next(0).kind).toBe('busy');
  });

  it('frees the config as soon as its trial settles', () => {
    const s = new Scheduler({ concurrency: 4 });
    s.enqueue(cells({ configs: ['cfgA'], trials: 3 }));

    const first = drain(s, 0);
    expect(first).toHaveLength(1);
    s.settle(first[0]!.key, { kind: 'done' }, 0);

    const second = drain(s, 0);
    expect(second).toHaveLength(1);
    expect(second[0]!.key).not.toBe(first[0]!.key);
  });

  it('respects the global concurrency cap across configs (default 2)', () => {
    const s = new Scheduler(); // default concurrency 2
    s.enqueue(cells({ configs: ['a', 'b', 'c', 'd'], trials: 1 }));
    expect(drain(s, 0)).toHaveLength(2);
    expect(s.stats(0).running).toBe(2);
  });

  it('reports done once every cell has settled', () => {
    const s = new Scheduler({ concurrency: 2 });
    const grid = cells({ configs: ['a'], trials: 2 });
    s.enqueue(grid);
    for (let i = 0; i < grid.length; i++) {
      const d = s.next(0);
      expect(d.kind).toBe('run');
      if (d.kind === 'run') s.settle(d.cell.key, { kind: 'done' }, 0);
    }
    expect(s.next(0).kind).toBe('done');
  });

  it('ignores duplicate enqueues of the same cell', () => {
    const s = new Scheduler({ concurrency: 4 });
    const grid = cells({ configs: ['a'], trials: 2 });
    s.enqueue(grid);
    s.enqueue(grid);
    expect(s.stats(0).pending).toBe(2);
  });
});

describe('rate-window backoff', () => {
  it('pauses only the throttled config and keeps the others running', () => {
    const s = new Scheduler({ concurrency: 2, cooldownMs: 30 * MIN });
    s.enqueue(cells({ configs: ['cfgA', 'cfgB'], trials: 3 }));

    const started = drain(s, 0);
    const a = started.find((c) => c.configId === 'cfgA')!;
    const b = started.find((c) => c.configId === 'cfgB')!;

    s.settle(a.key, { kind: 'rate-limited' }, 0);
    expect(s.isPaused('cfgA', 0)).toBe(true);
    expect(s.isPaused('cfgB', 0)).toBe(false);

    // cfgB keeps going immediately; cfgA contributes nothing.
    s.settle(b.key, { kind: 'done' }, 0);
    const next = drain(s, 1000);
    expect(next.map((c) => c.configId)).toEqual(['cfgB']);
  });

  it('does not charge a rate-limited abort against the attempt budget', () => {
    const s = new Scheduler({ concurrency: 1, cooldownMs: 10 * MIN, maxAttempts: 2 });
    s.enqueue(cells({ configs: ['a'], trials: 1 }));

    let t = 0;
    for (let i = 0; i < 5; i++) {
      const d = s.next(t);
      expect(d.kind).toBe('run');
      if (d.kind !== 'run') return;
      s.settle(d.cell.key, { kind: 'rate-limited' }, t);
      expect(s.attemptsOf(d.cell.key)).toBe(0);
      t += 10 * MIN + 1;
    }
    // Still pending, never failed: a usage window is not a task failure.
    expect(s.stats(t).failed).toBe(0);
    expect(s.stats(t).pending).toBe(1);
  });

  it('resumes the config exactly when the cooldown expires', () => {
    const s = new Scheduler({ concurrency: 2, cooldownMs: 30 * MIN });
    s.enqueue(cells({ configs: ['a'], trials: 2 }));

    const first = drain(s, 0)[0]!;
    s.settle(first.key, { kind: 'rate-limited' }, 0);

    const waiting = s.next(29 * MIN);
    expect(waiting).toEqual({ kind: 'wait', untilMs: 30 * MIN, reason: 'cooldown' });

    const resumed = s.next(30 * MIN + 1);
    expect(resumed.kind).toBe('run');
  });

  it('honours a CLI-supplied reset time over the default cooldown', () => {
    const s = new Scheduler({ concurrency: 1, cooldownMs: 30 * MIN });
    s.enqueue(cells({ configs: ['a'], trials: 1 }));
    const cell = drain(s, 0)[0]!;
    s.settle(cell.key, { kind: 'rate-limited', cooldownMs: 5 * MIN }, 0);

    expect(s.next(4 * MIN)).toMatchObject({ kind: 'wait', untilMs: 5 * MIN });
    expect(s.next(5 * MIN + 1).kind).toBe('run');
  });

  it('retries the throttled cell first once the window reopens', () => {
    const s = new Scheduler({ concurrency: 1, cooldownMs: MIN });
    s.enqueue(cells({ configs: ['a'], trials: 3 }));

    const first = drain(s, 0)[0]!;
    s.settle(first.key, { kind: 'rate-limited' }, 0);

    const afterCooldown = s.next(MIN + 1);
    expect(afterCooldown.kind).toBe('run');
    if (afterCooldown.kind === 'run') {
      // The interrupted trial goes to the FRONT — it already burned setup work.
      expect(afterCooldown.cell.key).toBe(first.key);
    }
  });

  it('eventually gives up on a config that is blocked rather than merely throttled', () => {
    // An expired subscription looks exactly like a usage window forever; without a
    // backstop an unattended multi-day run would sleep-and-retry indefinitely.
    const s = new Scheduler({ concurrency: 1, cooldownMs: MIN, maxRateLimitedAttempts: 4 });
    s.enqueue(cells({ configs: ['a'], trials: 1 }));

    let t = 0;
    const details: string[] = [];
    s.on((e) => {
      if (e.type === 'failed') details.push(e.detail ?? '');
    });
    for (let i = 0; i < 4; i++) {
      const d = s.next(t);
      expect(d.kind).toBe('run');
      if (d.kind !== 'run') return;
      s.settle(d.cell.key, { kind: 'rate-limited' }, t);
      t += MIN + 1;
    }
    expect(s.stats(t).failed).toBe(1);
    expect(details.join(' ')).toMatch(/permanently blocked/);
    expect(s.next(t).kind).toBe('done');
  });

  it('resets the rate-limit streak once the cell actually gets to run', () => {
    const s = new Scheduler({ concurrency: 1, cooldownMs: MIN, maxAttempts: 10, maxRateLimitedAttempts: 3 });
    s.enqueue(cells({ configs: ['a'], trials: 1 }));

    let t = 0;
    const step = (outcome: CellOutcome) => {
      const d = s.next(t);
      expect(d.kind).toBe('run');
      if (d.kind === 'run') s.settle(d.cell.key, outcome, t);
      t += MIN + 1;
    };
    step({ kind: 'rate-limited' });
    step({ kind: 'rate-limited' });
    step({ kind: 'failed' }); // a real attempt breaks the streak
    step({ kind: 'rate-limited' });
    step({ kind: 'rate-limited' });
    expect(s.stats(t).failed).toBe(0);
  });

  it('extends, never shortens, an existing pause', () => {
    const s = new Scheduler({ concurrency: 1 });
    s.pauseConfig('a', 100 * MIN);
    s.pauseConfig('a', 10 * MIN);
    expect(s.isPaused('a', 50 * MIN)).toBe(true);
    expect(s.pausedConfigs(50 * MIN)[0]!.untilMs).toBe(100 * MIN);
  });

  it('emits paused/resumed events for operator visibility', () => {
    const events: SchedulerEvent[] = [];
    const s = new Scheduler({ concurrency: 1, cooldownMs: MIN });
    s.on((e) => events.push(e));
    s.enqueue(cells({ configs: ['a'], trials: 2 }));

    const cell = drain(s, 0)[0]!;
    s.settle(cell.key, { kind: 'rate-limited' }, 0);
    s.next(MIN + 1);

    expect(events.map((e) => e.type)).toContain('config-paused');
    expect(events.map((e) => e.type)).toContain('config-resumed');
    expect(events.map((e) => e.type)).toContain('rate-limited');
  });

  it('waits rather than spinning when every remaining config is cooling down', () => {
    const s = new Scheduler({ concurrency: 2, cooldownMs: 20 * MIN });
    s.enqueue(cells({ configs: ['a', 'b'], trials: 1 }));

    for (const c of drain(s, 0)) s.settle(c.key, { kind: 'rate-limited' }, 0);
    const d = s.next(MIN);
    expect(d.kind).toBe('wait');
    if (d.kind === 'wait') expect(d.untilMs).toBe(20 * MIN);
  });
});

describe('failure retries', () => {
  it('retries a failed cell up to maxAttempts, then gives up', () => {
    const s = new Scheduler({ concurrency: 1, maxAttempts: 3 });
    s.enqueue(cells({ configs: ['a'], trials: 1 }));

    for (let i = 0; i < 3; i++) {
      const d = s.next(0);
      expect(d.kind).toBe('run');
      if (d.kind === 'run') s.settle(d.cell.key, { kind: 'failed', detail: 'boom' }, 0);
    }
    expect(s.stats(0).failed).toBe(1);
    expect(s.next(0).kind).toBe('done');
  });

  it('sends a retried cell to the back so the rest of the grid gets a turn', () => {
    const s = new Scheduler({ concurrency: 1, maxAttempts: 5 });
    s.enqueue(cells({ configs: ['a'], trials: 3 }));

    const first = drain(s, 0)[0]!;
    s.settle(first.key, { kind: 'failed' }, 0);

    const second = s.next(0);
    expect(second.kind).toBe('run');
    if (second.kind === 'run') expect(second.cell.key).not.toBe(first.key);
  });

  it('rejects settling a cell that is not running', () => {
    const s = new Scheduler();
    s.enqueue(cells({ configs: ['a'], trials: 1 }));
    const key = cellKey(cells({ configs: ['a'], trials: 1 })[0]!);
    expect(() => s.settle(key, { kind: 'done' }, 0)).toThrow(/not running/);
    expect(() => s.settle('bogus', { kind: 'done' }, 0)).toThrow(/unknown cell/);
  });
});

describe('runQueue driver', () => {
  it('drains a grid, honouring serial-per-config', async () => {
    const s = new Scheduler({ concurrency: 2 });
    const grid = cells({ configs: ['a', 'b'], trials: 3 });
    s.enqueue(grid);

    const inFlightPerConfig = new Map<string, number>();
    let maxPerConfig = 0;
    const order: string[] = [];

    await runQueue(s, {
      execute: async (cell) => {
        const n = (inFlightPerConfig.get(cell.configId) ?? 0) + 1;
        inFlightPerConfig.set(cell.configId, n);
        maxPerConfig = Math.max(maxPerConfig, n);
        await new Promise((r) => setTimeout(r, 1));
        inFlightPerConfig.set(cell.configId, n - 1);
        order.push(cell.key);
        return { kind: 'done' } satisfies CellOutcome;
      },
    });

    expect(order).toHaveLength(grid.length);
    expect(maxPerConfig).toBe(1);
    expect(s.stats(Date.now()).done).toBe(grid.length);
  });

  it('sleeps through a cooldown with an injected clock instead of real time', async () => {
    const s = new Scheduler({ concurrency: 2, cooldownMs: 30 * MIN });
    s.enqueue(cells({ configs: ['a'], trials: 2 }));

    let clock = 0;
    const sleeps: number[] = [];
    let firstCall = true;

    await runQueue(s, {
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      pollMs: 5 * MIN,
      execute: async () => {
        if (firstCall) {
          firstCall = false;
          return { kind: 'rate-limited' } satisfies CellOutcome;
        }
        return { kind: 'done' } satisfies CellOutcome;
      },
    });

    // 30-minute cooldown, polled in 5-minute slices, then both cells complete.
    expect(sleeps).toEqual([5 * MIN, 5 * MIN, 5 * MIN, 5 * MIN, 5 * MIN, 5 * MIN]);
    expect(clock).toBe(30 * MIN);
    expect(s.stats(clock).done).toBe(2);
  });

  it('turns a thrown execute() into a failed outcome instead of unwinding the run', async () => {
    const s = new Scheduler({ concurrency: 1, maxAttempts: 1 });
    s.enqueue(cells({ configs: ['a'], trials: 2 }));

    let calls = 0;
    await runQueue(s, {
      execute: async (cell) => {
        calls++;
        if (cell.trial === 1) throw new Error('workspace prep exploded');
        return { kind: 'done' };
      },
    });

    expect(calls).toBe(2);
    expect(s.stats(Date.now())).toMatchObject({ done: 1, failed: 1, pending: 0 });
  });

  it('stops promptly when aborted, leaving the rest pending for --resume', async () => {
    const s = new Scheduler({ concurrency: 1 });
    s.enqueue(cells({ configs: ['a'], trials: 5 }));
    const abort = new AbortController();

    let started = 0;
    await runQueue(s, {
      signal: abort.signal,
      execute: async () => {
        started++;
        if (started === 2) abort.abort();
        return { kind: 'done' };
      },
    });

    expect(started).toBeLessThan(5);
    expect(s.stats(Date.now()).pending).toBeGreaterThan(0);
  });
});

/**
 * The scheduler's paused-config map is the only source for the dashboard's
 * `cooldown` / `blocked` statuses, and `notionbench serve` reads it from a
 * different process. The mirror is opt-in: a Scheduler built without the hook
 * must behave exactly as it did before (every other test in this file).
 */
describe('rate-window mirror', () => {
  it('publishes cooldowns as they open and close', () => {
    const seen: RateWindowState[] = [];
    const s = new Scheduler({ concurrency: 1, cooldownMs: 30 * MIN, onRateWindowChange: (st) => seen.push(st) });
    s.enqueue(cells({ configs: ['a'], trials: 2 }));

    const first = drain(s, 0)[0]!;
    expect(seen).toHaveLength(0); // nothing published until something happens

    s.settle(first.key, { kind: 'rate-limited' }, 0);
    expect(seen.at(-1)!.cooldowns).toEqual([{ configId: 'a', untilMs: 30 * MIN }]);
    expect(seen.at(-1)!.blocked).toEqual([]);

    // Reaped once the window reopens.
    s.next(31 * MIN);
    expect(seen.at(-1)!.cooldowns).toEqual([]);
  });

  it('publishes a config the permanently-blocked backstop gave up on', () => {
    const seen: RateWindowState[] = [];
    const s = new Scheduler({
      concurrency: 1,
      maxRateLimitedAttempts: 2,
      onRateWindowChange: (st) => seen.push(st),
    });
    s.enqueue(cells({ configs: ['a'], trials: 1 }));

    let clock = 0;
    for (let i = 0; i < 2; i++) {
      const cell = drain(s, clock)[0]!;
      s.settle(cell.key, { kind: 'rate-limited' }, clock);
      clock += 31 * MIN;
    }
    expect(seen.at(-1)!.blocked).toEqual(['a']);
    expect(s.rateWindowState(clock).blocked).toEqual(['a']);
  });

  it('never lets a failing mirror take the run down', () => {
    const s = new Scheduler({
      concurrency: 1,
      onRateWindowChange: () => {
        throw new Error('disk full');
      },
    });
    s.enqueue(cells({ configs: ['a'], trials: 1 }));
    const cell = drain(s, 0)[0]!;
    expect(() => s.settle(cell.key, { kind: 'rate-limited' }, 0)).not.toThrow();
  });

  it('round-trips through the run directory, and reads as empty when absent', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nb-ratewin-'));
    try {
      expect(await readRateWindowState(dir)).toEqual({ updatedAt: '', cooldowns: [], blocked: [] });
      const state: RateWindowState = {
        updatedAt: '2026-07-31T09:45:00.000Z',
        cooldowns: [{ configId: 'a', untilMs: 1_700_000_000_000 }],
        blocked: ['b'],
      };
      await writeRateWindowState(dir, state);
      expect(await readRateWindowState(dir)).toEqual(state);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
