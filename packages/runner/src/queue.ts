/**
 * Trial scheduling.
 *
 * Two hard requirements from docs/PLAN.md:
 *
 *  1. **Serial per config.** Two trials of the same agent config must never run
 *     concurrently — they'd share (and race through) the same subscription rate
 *     window, and they'd contend for the same CLI's local state. Different configs
 *     run in parallel up to a global cap (default 2).
 *
 *  2. **Rate-window backoff.** When a config's usage window is exhausted, that
 *     config is paused for a cooldown (default 30 min) and the OTHER configs keep
 *     going. The cell goes back to pending without burning an attempt.
 *
 * `Scheduler` is a pure, synchronous state machine over an injected clock so the
 * backoff behaviour is testable without timers or sleeping. `runQueue` is the thin
 * async driver on top.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { CellCoords } from './checkpoint.js';
import { cellKey } from './checkpoint.js';
import { writeJsonAtomic } from './spawn.js';

export interface QueueCell extends CellCoords {
  key: string;
  attempts: number;
}

export type CellOutcome =
  | { kind: 'done' }
  | { kind: 'failed'; detail?: string }
  | { kind: 'rate-limited'; cooldownMs?: number; detail?: string };

export type Decision =
  /** Run this cell now. Calling `next` has already marked it in-flight. */
  | { kind: 'run'; cell: QueueCell }
  /** Nothing runnable until `untilMs`; every remaining config is cooling down. */
  | { kind: 'wait'; untilMs: number; reason: 'cooldown' }
  /** At capacity, or waiting on in-flight work to free a config. */
  | { kind: 'busy' }
  /** Queue drained. */
  | { kind: 'done' };

/**
 * Rate-limited aborts tolerated on one cell before its config is called blocked.
 * 20 × 30min ≈ 10h, comfortably longer than a legitimate 5-hour window.
 */
export const DEFAULT_MAX_RATE_LIMITED_ATTEMPTS = 20;

/** File the rate-window state is mirrored to, inside `results/<runId>/`. */
export const RATE_WINDOW_STATE_FILENAME = 'rate-window.json';

/**
 * The scheduler's rate-window state, in a form another process can read.
 *
 * `state.json` records per-cell facts; *which config is cooling down right now*
 * is scheduler state, and it only ever lived in memory. `notionbench serve`
 * runs out-of-process, so the two statuses that are pure scheduler state —
 * `cooldown` and `blocked` — would otherwise be unobservable. Mirroring is
 * strictly additive and opt-in (`onRateWindowChange`): a Scheduler constructed
 * without it behaves exactly as before and writes nothing.
 */
export interface RateWindowState {
  updatedAt: string;
  /** Configs paused by a usage window, with the epoch ms they resume at. */
  cooldowns: Array<{ configId: string; untilMs: number }>;
  /**
   * Configs the permanently-blocked backstop gave up on (expired subscription,
   * revoked login) — not merely inside a usage window.
   */
  blocked: string[];
}

export function rateWindowStatePath(runDir: string): string {
  return path.join(runDir, RATE_WINDOW_STATE_FILENAME);
}

/** Mirror the scheduler's rate-window state next to the run's state.json. */
export async function writeRateWindowState(runDir: string, state: RateWindowState): Promise<void> {
  await writeJsonAtomic(rateWindowStatePath(runDir), state);
}

/** Read the mirror back. Missing or unreadable file → no cooldowns, none blocked. */
export async function readRateWindowState(runDir: string): Promise<RateWindowState> {
  const empty: RateWindowState = { updatedAt: '', cooldowns: [], blocked: [] };
  let raw: string;
  try {
    raw = await readFile(rateWindowStatePath(runDir), 'utf8');
  } catch {
    return empty;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RateWindowState>;
    return {
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      cooldowns: (parsed.cooldowns ?? []).filter(
        (c): c is { configId: string; untilMs: number } =>
          !!c && typeof c.configId === 'string' && Number.isFinite(c.untilMs),
      ),
      blocked: (parsed.blocked ?? []).filter((b): b is string => typeof b === 'string'),
    };
  } catch {
    // A torn write is not worth failing a status request over.
    return empty;
  }
}

export interface SchedulerOptions {
  /** Global in-flight cap across all configs. */
  concurrency?: number;
  /** Pause length after a rate-window hit, when the CLI gives no reset time. */
  cooldownMs?: number;
  /** Attempts per cell before it is abandoned. Rate-limited aborts don't count. */
  maxAttempts?: number;
  /**
   * Backstop for a config that is permanently blocked (expired subscription,
   * revoked login) rather than merely inside a usage window. Without it an
   * unattended run would sleep-and-retry forever. 20 × 30min ≈ 10h, comfortably
   * longer than a legitimate 5-hour window. Default 20.
   */
  maxRateLimitedAttempts?: number;
  /**
   * Called whenever a config starts cooling down, resumes, or is declared
   * permanently blocked, with the full current state (not a delta). Optional and
   * best-effort — the scheduler never awaits it and never fails because of it.
   * `notionbench run` wires it to `results/<runId>/rate-window.json` so
   * `notionbench serve` can report `cooldown` / `blocked`.
   */
  onRateWindowChange?: (state: RateWindowState) => void;
}

export interface SchedulerEvent {
  type: 'started' | 'done' | 'failed' | 'retry' | 'rate-limited' | 'config-paused' | 'config-resumed';
  cell?: QueueCell;
  configId?: string;
  detail?: string;
  untilMs?: number;
}

interface CellRecord extends QueueCell {
  state: 'pending' | 'running' | 'settled';
  settledAs?: 'done' | 'failed';
  rateLimitedAttempts: number;
}

export class Scheduler {
  readonly concurrency: number;
  readonly cooldownMs: number;
  readonly maxAttempts: number;
  readonly maxRateLimitedAttempts: number;

  private readonly records = new Map<string, CellRecord>();
  /** Insertion-ordered pending keys. */
  private pendingKeys: string[] = [];
  private readonly inFlight = new Set<string>();
  private readonly inFlightConfigs = new Set<string>();
  private readonly pausedUntil = new Map<string, number>();
  private readonly blocked = new Set<string>();
  private readonly listeners: Array<(e: SchedulerEvent) => void> = [];
  private readonly onRateWindowChange?: (state: RateWindowState) => void;

  constructor(opts: SchedulerOptions = {}) {
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.cooldownMs = Math.max(0, opts.cooldownMs ?? 30 * 60 * 1000);
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    this.maxRateLimitedAttempts = Math.max(1, opts.maxRateLimitedAttempts ?? DEFAULT_MAX_RATE_LIMITED_ATTEMPTS);
    this.onRateWindowChange = opts.onRateWindowChange;
  }

  /** The rate-window facts an out-of-process reader needs. */
  rateWindowState(now: number = Date.now()): RateWindowState {
    return {
      updatedAt: new Date(now).toISOString(),
      cooldowns: this.pausedConfigs(now),
      blocked: [...this.blocked],
    };
  }

  private publishRateWindow(now: number): void {
    if (!this.onRateWindowChange) return;
    try {
      this.onRateWindowChange(this.rateWindowState(now));
    } catch {
      /* a status mirror must never take the run down */
    }
  }

  on(listener: (e: SchedulerEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(e: SchedulerEvent): void {
    for (const l of this.listeners) l(e);
  }

  enqueue(cells: Array<CellCoords & { attempts?: number }>): void {
    for (const c of cells) {
      const key = cellKey(c);
      if (this.records.has(key)) continue;
      this.records.set(key, {
        ...c,
        key,
        attempts: c.attempts ?? 0,
        rateLimitedAttempts: 0,
        state: 'pending',
      });
      this.pendingKeys.push(key);
    }
  }

  /** Pause a config directly (e.g. an out-of-band 429 seen by a fixture provisioner). */
  pauseConfig(configId: string, untilMs: number, now: number = Date.now()): void {
    const current = this.pausedUntil.get(configId);
    if (current !== undefined && current >= untilMs) return;
    this.pausedUntil.set(configId, untilMs);
    this.emit({ type: 'config-paused', configId, untilMs });
    this.publishRateWindow(now);
  }

  isPaused(configId: string, now: number): boolean {
    const until = this.pausedUntil.get(configId);
    return until !== undefined && until > now;
  }

  pausedConfigs(now: number): Array<{ configId: string; untilMs: number }> {
    const out: Array<{ configId: string; untilMs: number }> = [];
    for (const [configId, untilMs] of this.pausedUntil) {
      if (untilMs > now) out.push({ configId, untilMs });
    }
    return out;
  }

  /**
   * Pick the next runnable cell. MUTATES: a returned `run` decision has already
   * been marked in-flight, so the caller must eventually call `settle`.
   */
  next(now: number): Decision {
    this.reapPauses(now);
    if (this.inFlight.size >= this.concurrency) return { kind: 'busy' };

    let earliestPause: number | undefined;
    for (let i = 0; i < this.pendingKeys.length; i++) {
      const key = this.pendingKeys[i]!;
      const rec = this.records.get(key)!;
      // Serial per config.
      if (this.inFlightConfigs.has(rec.configId)) continue;
      const until = this.pausedUntil.get(rec.configId);
      if (until !== undefined && until > now) {
        if (earliestPause === undefined || until < earliestPause) earliestPause = until;
        continue;
      }
      this.pendingKeys.splice(i, 1);
      rec.state = 'running';
      this.inFlight.add(key);
      this.inFlightConfigs.add(rec.configId);
      const cell = toCell(rec);
      this.emit({ type: 'started', cell });
      return { kind: 'run', cell };
    }

    if (this.pendingKeys.length === 0 && this.inFlight.size === 0) return { kind: 'done' };
    if (this.inFlight.size > 0) return { kind: 'busy' };
    if (earliestPause !== undefined) return { kind: 'wait', untilMs: earliestPause, reason: 'cooldown' };
    return { kind: 'busy' };
  }

  /** Report the result of an in-flight cell. */
  settle(key: string, outcome: CellOutcome, now: number): void {
    const rec = this.records.get(key);
    if (!rec) throw new Error(`settle() for unknown cell: ${key}`);
    if (rec.state !== 'running') throw new Error(`settle() for a cell that is not running: ${key}`);
    this.inFlight.delete(key);
    this.inFlightConfigs.delete(rec.configId);

    if (outcome.kind === 'done') {
      rec.attempts += 1;
      rec.state = 'settled';
      rec.settledAs = 'done';
      this.emit({ type: 'done', cell: toCell(rec) });
      return;
    }

    if (outcome.kind === 'rate-limited') {
      rec.rateLimitedAttempts += 1;
      if (rec.rateLimitedAttempts >= this.maxRateLimitedAttempts) {
        // Not a usage window any more — the config is blocked for good. Fail the
        // cell loudly instead of sleeping forever on an unattended multi-day run.
        rec.state = 'settled';
        rec.settledAs = 'failed';
        this.blocked.add(rec.configId);
        this.emit({
          type: 'failed',
          cell: toCell(rec),
          detail:
            `rate-limited ${rec.rateLimitedAttempts}× without ever succeeding — ` +
            `config "${rec.configId}" looks permanently blocked, not merely inside a usage window`,
        });
        this.publishRateWindow(now);
        return;
      }
      // Not the model's fault: refund the attempt, requeue at the FRONT of the
      // queue so this cell is retried first once the window reopens, and pause the
      // whole config so its remaining cells don't burn the window down further.
      rec.state = 'pending';
      this.pendingKeys.unshift(key);
      const until = now + (outcome.cooldownMs ?? this.cooldownMs);
      this.pauseConfig(rec.configId, until, now);
      this.emit({ type: 'rate-limited', cell: toCell(rec), detail: outcome.detail, untilMs: until });
      return;
    }

    rec.attempts += 1;
    if (rec.attempts >= this.maxAttempts) {
      rec.state = 'settled';
      rec.settledAs = 'failed';
      this.emit({ type: 'failed', cell: toCell(rec), detail: outcome.detail });
      return;
    }
    rec.state = 'pending';
    // The cell actually got to run, so the rate-limit streak is broken.
    rec.rateLimitedAttempts = 0;
    // Back of the queue: give the rest of the grid a turn before retrying.
    this.pendingKeys.push(key);
    this.emit({ type: 'retry', cell: toCell(rec), detail: outcome.detail });
  }

  stats(now: number): {
    pending: number;
    running: number;
    done: number;
    failed: number;
    pausedConfigs: number;
  } {
    let done = 0;
    let failed = 0;
    for (const r of this.records.values()) {
      if (r.state === 'settled') {
        if (r.settledAs === 'done') done++;
        else failed++;
      }
    }
    return {
      pending: this.pendingKeys.length,
      running: this.inFlight.size,
      done,
      failed,
      pausedConfigs: this.pausedConfigs(now).length,
    };
  }

  attemptsOf(key: string): number {
    return this.records.get(key)?.attempts ?? 0;
  }

  private reapPauses(now: number): void {
    let reaped = false;
    for (const [configId, until] of this.pausedUntil) {
      if (until <= now) {
        this.pausedUntil.delete(configId);
        this.emit({ type: 'config-resumed', configId });
        reaped = true;
      }
    }
    if (reaped) this.publishRateWindow(now);
  }
}

function toCell(rec: CellRecord): QueueCell {
  return {
    key: rec.key,
    taskId: rec.taskId,
    configId: rec.configId,
    docsCondition: rec.docsCondition,
    trial: rec.trial,
    attempts: rec.attempts,
  };
}

export interface RunQueueOptions {
  execute: (cell: QueueCell) => Promise<CellOutcome>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Cap on a single sleep so a long cooldown still re-checks state periodically
   * (and so Ctrl-C is responsive during a 30-minute pause). Default 30s.
   */
  pollMs?: number;
  signal?: AbortSignal;
  onEvent?: (e: SchedulerEvent) => void;
}

/** Drive a `Scheduler` to completion. */
export async function runQueue(scheduler: Scheduler, opts: RunQueueOptions): Promise<void> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const pollMs = opts.pollMs ?? 30_000;
  if (opts.onEvent) scheduler.on(opts.onEvent);

  const running = new Map<string, Promise<void>>();

  const launch = (cell: QueueCell): void => {
    const p = opts
      .execute(cell)
      .catch((err: unknown): CellOutcome => ({ kind: 'failed', detail: errText(err) }))
      .then((outcome) => {
        scheduler.settle(cell.key, outcome, now());
      })
      .finally(() => {
        running.delete(cell.key);
      });
    running.set(cell.key, p);
  };

  for (;;) {
    if (opts.signal?.aborted) break;
    const decision = scheduler.next(now());

    if (decision.kind === 'run') {
      launch(decision.cell);
      continue;
    }
    if (decision.kind === 'done') break;
    if (decision.kind === 'busy') {
      if (running.size === 0) break; // nothing in flight and nothing runnable: give up
      await Promise.race(running.values());
      continue;
    }
    // 'wait': every remaining config is cooling down.
    const remaining = decision.untilMs - now();
    if (remaining <= 0) continue;
    await sleep(Math.min(remaining, pollMs));
  }

  await Promise.allSettled([...running.values()]);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errText(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}
