/**
 * Execution ordering — *which* cell the scheduler reaches for next.
 *
 * A full grid is 798 cells (38 tasks × 7 configs × 3 trials) spread over several
 * days of subscription rate windows. The order those cells execute in does not
 * change the numbers, but it changes enormously how fast a *broken task* is
 * detectable — and a broken task invalidates every cell that touched it.
 *
 * Two real verifier bugs ("unexpected field `views`", "missing field `type`")
 * presented the same way: three different configs failed the same task with the
 * same diagnostic. That is only visible once several configs have *attempted the
 * same task*. Under the old, implicit ordering — each config walking its own task
 * list, config-major — cross-config evidence about task 30 assembles only when
 * every config has independently ground through tasks 1..29, which on a paced
 * multi-day grid can be days apart. Days of results that then have to be thrown
 * away.
 *
 * So the default is **`trial-major,task-major`**:
 *
 *   outer   trial 1 for every (task, config), then trial 2, then trial 3
 *   inner   within a trial, task by task: every config runs task 1, then every
 *           config runs task 2, …
 *
 * The first pass therefore covers *all* tasks, and the seven verdicts about task
 * N land within one task-block of each other rather than one grid-sweep apart.
 * `--order config-major` keeps the old behaviour for comparison.
 *
 * ## Blocks are soft barriers
 *
 * A task-block is an *emission order*, not a synchronisation point. Nothing ever
 * waits for a block to complete. The scheduler scans its pending queue front to
 * back and takes the first cell whose config is neither busy nor cooling down
 * (queue.ts `next`), so a config sitting in a 30-minute Kimi cooldown is simply
 * skipped: the other six configs walk straight on into the next task-block. The
 * straggler's cell keeps its rank, stays pending, and — because rank order puts
 * it ahead of everything that config has left — is the first thing that config
 * picks up when its window reopens.
 *
 * The cost of that choice is bounded and deliberate: a cooled-down config's
 * evidence about task N arrives late, so the watchdog may see 6 of 7 verdicts
 * for a block instead of 7. The alternative — a hard barrier — would let one
 * config's rate window idle the other six for half an hour, repeatedly, which on
 * a 798-cell grid is measured in days.
 */

import type { CellCoords } from './checkpoint.js';
import type { DocsCondition } from './types.js';

export const ORDER_POLICIES = ['trial-major,task-major', 'config-major'] as const;
export type OrderPolicy = (typeof ORDER_POLICIES)[number];

/**
 * Early detection of an invalid task beats locality of a config's CLI cache.
 * See the module header for why.
 */
export const DEFAULT_ORDER: OrderPolicy = 'trial-major,task-major';

/**
 * What a run created before this file existed executed: `cmdRun` built cells
 * config by config, so each config walked its own task list. Runs with no
 * recorded policy are replayed as this, not as today's default — a resume
 * replays the run, it does not redesign it.
 */
export const LEGACY_ORDER: OrderPolicy = 'config-major';

export function isOrderPolicy(value: unknown): value is OrderPolicy {
  return typeof value === 'string' && (ORDER_POLICIES as readonly string[]).includes(value);
}

/** Accepts the canonical names plus the obvious shorthands. */
export function parseOrder(raw: string | undefined, fallback: OrderPolicy = DEFAULT_ORDER): OrderPolicy {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (v === 'trial-major,task-major' || v === 'trial-major' || v === 'task-major') {
    return 'trial-major,task-major';
  }
  if (v === 'config-major') return 'config-major';
  throw new Error(
    `--order must be one of ${ORDER_POLICIES.join(' | ')} (got ${JSON.stringify(raw)})`,
  );
}

export function describeOrder(policy: OrderPolicy): string {
  return policy === 'trial-major,task-major'
    ? 'trial-major, task-major — trial 1 of every (task, config) first; within a trial, ' +
        'all configs run task 1 before any runs task 2'
    : 'config-major — each config walks the whole task list on its own';
}

/** The axes a rank is computed against, in the order they were declared. */
export interface OrderAxes {
  taskIds: string[];
  configIds: string[];
  docsConditions: DocsCondition[];
  trials: number;
}

/**
 * A total order over cells, as a single comparable number.
 *
 * One number rather than a tuple because the scheduler keeps its pending queue
 * sorted by rank and re-inserts requeued cells by binary search (queue.ts); a
 * scalar keeps that O(log n) and keeps `rank` a trivially serializable seam.
 *
 * Ids the axes do not mention sort last, so a hand-edited state.json or an
 * `--expand` that widened an axis can never make the ranker throw.
 */
export function cellRanker(policy: OrderPolicy, axes: OrderAxes): (cell: CellCoords) => number {
  const taskIndex = indexOf(axes.taskIds);
  const configIndex = indexOf(axes.configIds);
  const docsIndex = indexOf(axes.docsConditions);
  // +1 on every radix leaves room for the "not in this axis" bucket.
  const T = axes.taskIds.length + 1;
  const C = axes.configIds.length + 1;
  const D = axes.docsConditions.length + 1;
  const K = Math.max(1, axes.trials) + 1;

  if (policy === 'config-major') {
    return (cell) =>
      ((configIndex(cell.configId) * T + taskIndex(cell.taskId)) * D + docsIndex(cell.docsCondition)) * K +
      clampTrial(cell.trial, K);
  }
  return (cell) =>
    ((clampTrial(cell.trial, K) * T + taskIndex(cell.taskId)) * C + configIndex(cell.configId)) * D +
    docsIndex(cell.docsCondition);
}

/** Sort a cell list into execution order. Pure; the input is not mutated. */
export function orderCells(
  cells: readonly CellCoords[],
  policy: OrderPolicy,
  axes: OrderAxes,
): CellCoords[] {
  const rank = cellRanker(policy, axes);
  return [...cells]
    .map((cell, i) => ({ cell, rank: rank(cell), i }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((entry) => entry.cell);
}

/**
 * The axes implied by a cell set, in first-seen order.
 *
 * Used when the caller has cells but no declared axes (a resume replaying an
 * explicit, possibly ragged, cell list). First-seen order preserves the grid's
 * declared task/config order for the normal rectangular case.
 */
export function axesFromCells(cells: readonly CellCoords[]): OrderAxes {
  const taskIds: string[] = [];
  const configIds: string[] = [];
  const docsConditions: DocsCondition[] = [];
  let trials = 1;
  const seenTask = new Set<string>();
  const seenConfig = new Set<string>();
  const seenDocs = new Set<string>();
  for (const c of cells) {
    if (!seenTask.has(c.taskId)) {
      seenTask.add(c.taskId);
      taskIds.push(c.taskId);
    }
    if (!seenConfig.has(c.configId)) {
      seenConfig.add(c.configId);
      configIds.push(c.configId);
    }
    if (!seenDocs.has(c.docsCondition)) {
      seenDocs.add(c.docsCondition);
      docsConditions.push(c.docsCondition);
    }
    if (c.trial > trials) trials = c.trial;
  }
  return { taskIds, configIds, docsConditions, trials };
}

/**
 * The task-blocks the policy produces, in order — what `--dry-run` prints and
 * what the ordering tests assert against.
 *
 * A block is the unit the watchdog's cross-config comparison becomes possible
 * over: one (trial, task) under `trial-major,task-major`, one whole config lane
 * under `config-major`.
 */
export function blocksOf(
  cells: readonly CellCoords[],
  policy: OrderPolicy,
  axes: OrderAxes,
): Array<{ label: string; cells: CellCoords[] }> {
  const ordered = orderCells(cells, policy, axes);
  const out: Array<{ label: string; cells: CellCoords[] }> = [];
  let current: { label: string; cells: CellCoords[] } | undefined;
  for (const cell of ordered) {
    const label =
      policy === 'config-major' ? cell.configId : `trial ${cell.trial} · ${cell.taskId}`;
    if (!current || current.label !== label) {
      current = { label, cells: [] };
      out.push(current);
    }
    current.cells.push(cell);
  }
  return out;
}

function indexOf(values: readonly string[]): (value: string) => number {
  const map = new Map(values.map((v, i) => [v, i]));
  const fallback = values.length;
  return (value) => map.get(value) ?? fallback;
}

function clampTrial(trial: number, radix: number): number {
  if (!Number.isFinite(trial) || trial < 0) return radix - 1;
  return Math.min(Math.floor(trial), radix - 1);
}
