/**
 * Run checkpointing.
 *
 * A full grid is ~2,100 rollouts spread over several days of subscription rate
 * windows (docs/PLAN.md "Pacing"), so the run WILL be interrupted — by a laptop
 * sleeping, a window exhausting, or a crash. State lives at
 * `results/<runId>/state.json` and every mutation is written temp-then-rename so a
 * kill -9 mid-write can never produce a half-written state file.
 *
 * Granularity is the cell: (task, config, docsCondition, trial).
 */

import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from './spawn.js';
import type { TrialOutcome, TrialStatus } from './spawn.js';
import type { DocsCondition, TokenUsage } from './types.js';

export const STATE_VERSION = 1;
const MAX_HISTORY = 20;

export type CellStatus = 'pending' | 'running' | 'done' | 'failed';

export interface CellState {
  taskId: string;
  configId: string;
  docsCondition: DocsCondition;
  trial: number;
  status: CellStatus;
  /** Real attempts (rate-limited aborts do not count against the budget). */
  attempts: number;
  /** Times this cell was abandoned because the config's usage window was exhausted. */
  rateLimitedAttempts: number;
  lastTrialStatus?: TrialStatus;
  lastError?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  usage?: TokenUsage | null;
  toolCalls?: number;
  toolErrors?: number;
  apiEquivalentCostUsd?: number;
  /** Relative to the results root, so a results tree stays movable. */
  trialDir?: string;
  /**
   * The verifier's verdict, mirrored here purely so `notionbench status` can
   * show progress without reading results.jsonl. results.jsonl remains the
   * record of truth — the report is built from it, never from state.json.
   */
  score?: number;
  /** False when the verifier itself failed; `score` is then meaningless. */
  scored?: boolean;
  scoreError?: string;
  history: Array<{ at: string; event: string; detail?: string }>;
}

/** What `markDone` records about a scored trial. */
export interface CellScore {
  score: number;
  scored: boolean;
  error?: string;
}

export interface RunMeta {
  concurrency: number;
  trials: number;
  docsConditions: DocsCondition[];
  maxAttempts: number;
  cooldownMs: number;
  evalsRoot: string;
  resultsRoot: string;
  configs: Array<{
    id: string;
    harness: string;
    model: string;
    reasoningEffort?: string;
    cliVersion?: string;
  }>;
  taskIds: string[];
  /** Free-form provenance (host, node version, git sha, …). */
  provenance?: Record<string, unknown>;
}

export interface RunStateFile {
  version: number;
  runId: string;
  createdAt: string;
  updatedAt: string;
  meta: RunMeta;
  cells: Record<string, CellState>;
}

export interface CellCoords {
  taskId: string;
  configId: string;
  docsCondition: DocsCondition;
  trial: number;
}

/** Stable, human-greppable cell key. */
export function cellKey(c: CellCoords): string {
  return `${c.taskId}::${c.configId}::${c.docsCondition}::${c.trial}`;
}

export function parseCellKey(key: string): CellCoords {
  const parts = key.split('::');
  if (parts.length !== 4) throw new Error(`malformed cell key: ${key}`);
  const [taskId, configId, docsCondition, trialStr] = parts as [string, string, string, string];
  const trial = Number(trialStr);
  if (!Number.isInteger(trial)) throw new Error(`malformed trial number in cell key: ${key}`);
  if (docsCondition !== 'with' && docsCondition !== 'without') {
    throw new Error(`malformed docs condition in cell key: ${key}`);
  }
  return { taskId, configId, docsCondition, trial };
}

/** Path segment layout for a trial's artifacts. */
export function trialDirFor(c: CellCoords): string {
  return path.join(c.taskId, c.configId, `docs-${c.docsCondition}`, `trial-${c.trial}`);
}

export class Checkpoint {
  readonly runId: string;
  readonly resultsRoot: string;
  readonly statePath: string;
  private state: RunStateFile;
  /** Serializes writes so concurrent trials can't interleave state.json writes. */
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(state: RunStateFile, resultsRoot: string) {
    this.state = state;
    this.runId = state.runId;
    this.resultsRoot = resultsRoot;
    this.statePath = statePathFor(resultsRoot, state.runId);
  }

  static statePath(resultsRoot: string, runId: string): string {
    return statePathFor(resultsRoot, runId);
  }

  static async create(args: {
    runId: string;
    resultsRoot: string;
    meta: RunMeta;
    cells: CellCoords[];
  }): Promise<Checkpoint> {
    const nowIso = new Date().toISOString();
    const cells: Record<string, CellState> = {};
    for (const c of args.cells) {
      cells[cellKey(c)] = newCell(c);
    }
    const state: RunStateFile = {
      version: STATE_VERSION,
      runId: args.runId,
      createdAt: nowIso,
      updatedAt: nowIso,
      meta: args.meta,
      cells,
    };
    await mkdir(path.join(args.resultsRoot, args.runId), { recursive: true });
    const cp = new Checkpoint(state, args.resultsRoot);
    await cp.save();
    return cp;
  }

  static async load(runId: string, resultsRoot: string): Promise<Checkpoint> {
    const p = statePathFor(resultsRoot, runId);
    let raw: string;
    try {
      raw = await readFile(p, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`no run state at ${p} (unknown runId "${runId}"?)`);
      }
      throw err;
    }
    const parsed = JSON.parse(raw) as RunStateFile;
    if (parsed.version !== STATE_VERSION) {
      throw new Error(
        `run state version ${parsed.version} is not supported by this runner (expected ${STATE_VERSION})`,
      );
    }
    // Tolerate hand-edited / older files missing newer optional fields.
    for (const [key, cell] of Object.entries(parsed.cells ?? {})) {
      parsed.cells[key] = { ...newCell(parseCellKey(key)), ...cell };
    }
    return new Checkpoint(parsed, resultsRoot);
  }

  /**
   * Add cells that aren't in the state yet. Existing cells keep their status.
   *
   * NOT a decision point: what a run's cells *are* is decided by the run spec
   * (run-spec.ts), never by whatever grid the current invocation happens to
   * compute. Callers must diff against the spec and refuse (or record an
   * `--expand`) before widening a run — see `cmdRun`.
   */
  async ensureCells(cells: CellCoords[]): Promise<number> {
    let added = 0;
    for (const c of cells) {
      const key = cellKey(c);
      if (!this.state.cells[key]) {
        this.state.cells[key] = newCell(c);
        added++;
      }
    }
    if (added > 0) await this.save();
    return added;
  }

  /**
   * Drop cells from the run.
   *
   * Used to repair a state file holding cells that were never part of the run's
   * recorded grid — the residue of a resume that rebuilt the grid from config
   * defaults. `results.jsonl` is the record of truth and is never touched, so
   * this can only lose the *enumeration* of a cell, never a verdict.
   */
  async dropCells(keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.state.cells[key]) {
        delete this.state.cells[key];
        removed++;
      }
    }
    if (removed > 0) await this.save();
    return removed;
  }

  get meta(): RunMeta {
    return this.state.meta;
  }

  async updateMeta(patch: Partial<RunMeta>): Promise<void> {
    this.state.meta = { ...this.state.meta, ...patch };
    await this.save();
  }

  snapshot(): RunStateFile {
    return structuredClone(this.state);
  }

  get(coords: CellCoords): CellState | undefined {
    return this.state.cells[cellKey(coords)];
  }

  cells(): CellState[] {
    return Object.values(this.state.cells);
  }

  /** Cells that still need work, in a stable order. */
  pending(): CellState[] {
    return this.cells()
      .filter((c) => c.status === 'pending')
      .sort(compareCells);
  }

  isDone(coords: CellCoords): boolean {
    return this.get(coords)?.status === 'done';
  }

  /**
   * Crash recovery: any cell left `running` when the process died is put back to
   * `pending`. Its `attempts` count is preserved so a cell that reliably kills the
   * runner still eventually exhausts `maxAttempts` instead of looping forever.
   */
  async resetRunning(): Promise<number> {
    let n = 0;
    for (const cell of this.cells()) {
      if (cell.status === 'running') {
        cell.status = 'pending';
        pushHistory(cell, 'reset-running', 'process exited while this cell was in flight');
        n++;
      }
    }
    if (n > 0) await this.save();
    return n;
  }

  async markRunning(coords: CellCoords): Promise<CellState> {
    const cell = this.require(coords);
    cell.status = 'running';
    cell.attempts += 1;
    cell.startedAt = new Date().toISOString();
    cell.lastError = undefined;
    pushHistory(cell, 'running', `attempt ${cell.attempts}`);
    await this.save();
    return cell;
  }

  async markDone(coords: CellCoords, outcome: TrialOutcome, score?: CellScore): Promise<CellState> {
    const cell = this.require(coords);
    cell.status = 'done';
    cell.lastTrialStatus = outcome.status;
    cell.finishedAt = outcome.finishedAt;
    cell.durationMs = outcome.durationMs;
    cell.usage = outcome.usage;
    cell.toolCalls = outcome.parsed.toolCalls;
    cell.toolErrors = outcome.parsed.toolErrors;
    cell.apiEquivalentCostUsd = outcome.apiEquivalentCostUsd;
    cell.trialDir = path.relative(path.join(this.resultsRoot, this.runId), outcome.trialDir ?? '') || undefined;
    cell.lastError = undefined;
    cell.score = score?.score;
    cell.scored = score?.scored;
    cell.scoreError = score?.error;
    pushHistory(
      cell,
      'done',
      score === undefined
        ? outcome.status
        : `${outcome.status} score=${score.scored ? score.score : `unverified (${score.error ?? 'no verdict'})`}`,
    );
    await this.save();
    return cell;
  }

  async markFailed(coords: CellCoords, detail: string, trialStatus?: TrialStatus): Promise<CellState> {
    const cell = this.require(coords);
    const maxAttempts = this.state.meta.maxAttempts;
    cell.lastTrialStatus = trialStatus;
    cell.lastError = detail;
    cell.finishedAt = new Date().toISOString();
    if (cell.attempts >= maxAttempts) {
      cell.status = 'failed';
      pushHistory(cell, 'failed', `${detail} (attempts exhausted: ${cell.attempts}/${maxAttempts})`);
    } else {
      cell.status = 'pending';
      pushHistory(cell, 'retry', `${detail} (attempt ${cell.attempts}/${maxAttempts})`);
    }
    await this.save();
    return cell;
  }

  /**
   * The config's usage window is exhausted. Put the cell back to `pending` and
   * refund the attempt — a rate window is not the model failing the task, and
   * charging it would silently shrink the retry budget across a multi-day run.
   */
  async markRateLimited(coords: CellCoords, detail: string): Promise<CellState> {
    const cell = this.require(coords);
    cell.status = 'pending';
    cell.attempts = Math.max(0, cell.attempts - 1);
    cell.rateLimitedAttempts += 1;
    cell.lastTrialStatus = 'rate_limited';
    cell.lastError = detail;
    pushHistory(cell, 'rate-limited', detail);
    await this.save();
    return cell;
  }

  summary(): {
    total: number;
    pending: number;
    running: number;
    done: number;
    failed: number;
    rateLimitedAttempts: number;
    /** Done cells whose verifier returned a verdict. */
    scored: number;
    /** Of those, the ones that met the solve threshold (score 1). */
    solved: number;
    /** Done cells the verifier could not measure — neither pass nor fail. */
    unverified: number;
    byConfig: Record<string, { total: number; done: number; failed: number; pending: number; running: number }>;
  } {
    const byConfig: Record<
      string,
      { total: number; done: number; failed: number; pending: number; running: number }
    > = {};
    let pending = 0;
    let running = 0;
    let done = 0;
    let failed = 0;
    let rateLimitedAttempts = 0;
    let scored = 0;
    let solved = 0;
    let unverified = 0;
    for (const cell of this.cells()) {
      if (cell.status === 'done' && cell.scored !== undefined) {
        if (cell.scored) {
          scored++;
          if ((cell.score ?? 0) >= 1) solved++;
        } else {
          unverified++;
        }
      }
      const bucket = (byConfig[cell.configId] ??= {
        total: 0,
        done: 0,
        failed: 0,
        pending: 0,
        running: 0,
      });
      bucket.total++;
      bucket[cell.status]++;
      rateLimitedAttempts += cell.rateLimitedAttempts;
      if (cell.status === 'pending') pending++;
      else if (cell.status === 'running') running++;
      else if (cell.status === 'done') done++;
      else failed++;
    }
    return {
      total: this.cells().length,
      pending,
      running,
      done,
      failed,
      rateLimitedAttempts,
      scored,
      solved,
      unverified,
      byConfig,
    };
  }

  private require(coords: CellCoords): CellState {
    const cell = this.state.cells[cellKey(coords)];
    if (!cell) throw new Error(`no such cell in run ${this.runId}: ${cellKey(coords)}`);
    return cell;
  }

  /** Atomic, serialized save. */
  async save(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    const payload = structuredClone(this.state);
    this.writeChain = this.writeChain.then(() => writeJsonAtomic(this.statePath, payload));
    return this.writeChain;
  }
}

/** Load an existing run and prepare it for continued execution. */
export async function resume(runId: string, resultsRoot: string): Promise<Checkpoint> {
  const cp = await Checkpoint.load(runId, resultsRoot);
  await cp.resetRunning();
  return cp;
}

/** Expand the cartesian product of the run axes into cells. */
export function buildCells(args: {
  taskIds: string[];
  configIds: string[];
  docsConditions: DocsCondition[];
  trials: number;
}): CellCoords[] {
  const out: CellCoords[] = [];
  for (const taskId of args.taskIds) {
    for (const configId of args.configIds) {
      for (const docsCondition of args.docsConditions) {
        for (let trial = 1; trial <= args.trials; trial++) {
          out.push({ taskId, configId, docsCondition, trial });
        }
      }
    }
  }
  return out;
}

export function newRunId(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    '-',
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join('');
}

function statePathFor(resultsRoot: string, runId: string): string {
  return path.join(resultsRoot, runId, 'state.json');
}

function newCell(c: CellCoords): CellState {
  return {
    taskId: c.taskId,
    configId: c.configId,
    docsCondition: c.docsCondition,
    trial: c.trial,
    status: 'pending',
    attempts: 0,
    rateLimitedAttempts: 0,
    history: [],
  };
}

function pushHistory(cell: CellState, event: string, detail?: string): void {
  cell.history.push({ at: new Date().toISOString(), event, detail });
  if (cell.history.length > MAX_HISTORY) cell.history.splice(0, cell.history.length - MAX_HISTORY);
}

function compareCells(a: CellState, b: CellState): number {
  return (
    a.taskId.localeCompare(b.taskId) ||
    a.configId.localeCompare(b.configId) ||
    a.docsCondition.localeCompare(b.docsCondition) ||
    a.trial - b.trial
  );
}
