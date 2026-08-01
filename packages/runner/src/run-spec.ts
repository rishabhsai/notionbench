/**
 * The run spec — what a run was launched to measure, frozen at creation.
 *
 * A full grid is a multi-day, rate-window-paced experiment that is resumed many
 * times, often unattended. Before this file existed, `--resume <runId>` rebuilt
 * the grid from *today's* runconfig.json + CLI defaults, so any edit to the
 * config file — or simply the absence of the flags the run was launched with —
 * silently redefined the experiment mid-flight. Run 20260801-085000 was launched
 * as 5 tasks × 7 configs × docs=with × 1 trial (35 cells) and a bare
 * `--resume 20260801-085000` re-expanded it to 3,120 cells across a docs arm the
 * project had cut, a config not in the published roster, and k=5.
 *
 * So: the cell set, the resolved config definitions that produce it, and the
 * execution knobs that decide how cells run are written to
 * `results/<runId>/run-spec.json` at launch, and `--resume` replays *that*.
 * runconfig.json is consulted on resume only to report drift, never to decide
 * what runs.
 *
 * state.json remains the record of per-cell progress; run-spec.json is the
 * record of intent. They are separate files on purpose: the spec is written once
 * (plus an appended history entry per explicit `--expand`), so a torn write of
 * the hot, per-trial state file can never take the run's definition with it.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { cellKey, type CellCoords, type CellState, type RunStateFile } from './checkpoint.js';
import type { AgentConfig } from './config.js';
import { writeJsonAtomic } from './spawn.js';
import type { DocsCondition } from './types.js';

export const RUN_SPEC_VERSION = 1;
export const RUN_SPEC_FILENAME = 'run-spec.json';

/**
 * A config exactly as it was resolved at launch — everything `spawn` needs to
 * reproduce the invocation, plus the pricing the run's costs were computed with.
 *
 * This is the whole point of the file: a resume executes these, not whatever
 * runconfig.json says today.
 */
export type SpecConfig = AgentConfig & {
  /** `<cli> --version` as probed when the run was created. */
  cliVersion?: string;
  /**
   * True when this definition was rebuilt from a pre-spec state.json, which
   * records only (id, harness, model, reasoningEffort, cliVersion). Anything
   * else here was filled in from the current runconfig.json and is a guess.
   */
  reconstructed?: boolean;
};

export interface RunSpecGrid {
  taskIds: string[];
  configIds: string[];
  docsConditions: DocsCondition[];
  trials: number;
  /**
   * When present the run's cell set is *exactly* this list, and the axes above
   * are only a human-readable summary of it. Set when the set is not a clean
   * cartesian product — a legacy run reconstructed from a ragged state.json, or
   * an `--expand` that widened one axis for only some of another.
   */
  cells?: CellCoords[];
}

/** Knobs that decide how a cell executes. Replayed, so a resume runs like the launch did. */
export interface RunSpecExecution {
  concurrency: number;
  maxAttempts: number;
  cooldownMs: number;
  defaultTimeoutSec: number;
  killGraceMs: number;
  evalsRoot: string;
  resultsRoot: string;
  scoring: { enabled: boolean; timeoutMs: number };
}

export interface RunSpecProvenance {
  /** Path the configs came from, or undefined for the built-in roster. */
  runconfigPath?: string;
  /** sha256 over the canonicalized `configs` array — the drift check's fast path. */
  configHash: string;
  /** argv the run was launched with (after the program name). */
  argv: string[];
  createdAt: string;
  node: string;
  platform: string;
  arch: string;
  cwd: string;
  /** Harness CLI versions probed at launch, by config id. */
  cliVersions: Record<string, string>;
}

export interface RunSpecHistoryEntry {
  at: string;
  event: 'created' | 'reconstructed' | 'expanded' | 'drift' | 'replayed';
  detail: string;
  /** argv of the invocation that produced the entry. */
  argv?: string[];
  /** `expanded`: how many cells were added, and the axis diffs that added them. */
  added?: number;
  diffs?: string[];
  /** `drift`: the config definitions that no longer match runconfig.json. */
  drift?: ConfigDrift[];
  /** `expanded`: the grid as it stood before the expansion. */
  previousGrid?: RunSpecGrid;
}

export interface RunSpecFile {
  version: number;
  runId: string;
  createdAt: string;
  updatedAt: string;
  /** `launch` — written by the run that created it. `reconstructed` — rebuilt from state.json. */
  origin: 'launch' | 'reconstructed';
  grid: RunSpecGrid;
  configs: SpecConfig[];
  execution: RunSpecExecution;
  provenance: RunSpecProvenance;
  history: RunSpecHistoryEntry[];
}

export function runSpecPath(resultsRoot: string, runId: string): string {
  return path.join(resultsRoot, runId, RUN_SPEC_FILENAME);
}

/** Read a run's spec. `undefined` means "this run predates run-spec.json". */
export async function readRunSpec(
  resultsRoot: string,
  runId: string,
): Promise<RunSpecFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(runSpecPath(resultsRoot, runId), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  let parsed: RunSpecFile;
  try {
    parsed = JSON.parse(raw) as RunSpecFile;
  } catch (err) {
    throw new Error(
      `${runSpecPath(resultsRoot, runId)} is not valid JSON (${(err as Error).message}). ` +
        'Refusing to guess this run\'s grid — fix or delete the file (deleting falls back to ' +
        'reconstructing the grid from state.json).',
    );
  }
  if (parsed.version !== RUN_SPEC_VERSION) {
    throw new Error(
      `run spec version ${parsed.version} is not supported by this runner (expected ${RUN_SPEC_VERSION})`,
    );
  }
  return parsed;
}

export async function writeRunSpec(
  resultsRoot: string,
  spec: RunSpecFile,
): Promise<RunSpecFile> {
  const next: RunSpecFile = { ...spec, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(runSpecPath(resultsRoot, spec.runId), next);
  return next;
}

/**
 * The run's cell set.
 *
 * Honours a config's `docsCondition` pin exactly as `cmdRun` does when it builds
 * the grid, so `specCells(specFor(run)) === the run's cells` by construction.
 */
export function specCells(spec: RunSpecFile): CellCoords[] {
  return gridCells(spec.grid, spec.configs);
}

/**
 * Expand a grid into cells, honouring each config's `docsCondition` pin exactly
 * as `cmdRun` does when it builds a fresh run's cells.
 */
export function gridCells(grid: RunSpecGrid, configs: SpecConfig[]): CellCoords[] {
  if (grid.cells) return dedupeCells(grid.cells);
  const pinned = new Map(configs.map((c) => [c.id, c.docsCondition]));
  const out: CellCoords[] = [];
  for (const taskId of grid.taskIds) {
    for (const configId of grid.configIds) {
      const pin = pinned.get(configId);
      for (const docsCondition of pin ? [pin] : grid.docsConditions) {
        for (let trial = 1; trial <= grid.trials; trial++) {
          out.push({ taskId, configId, docsCondition, trial });
        }
      }
    }
  }
  return out;
}

export function cellKeySet(cells: CellCoords[]): Set<string> {
  return new Set(cells.map(cellKey));
}

function dedupeCells(cells: CellCoords[]): CellCoords[] {
  const seen = new Set<string>();
  const out: CellCoords[] = [];
  for (const c of cells) {
    const k = cellKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/** Stable hash of the resolved config objects, for cheap drift detection. */
export function hashConfigs(configs: SpecConfig[]): string {
  return createHash('sha256').update(canonicalJson(configs)).digest('hex').slice(0, 16);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export interface CreateSpecOptions {
  runId: string;
  grid: RunSpecGrid;
  configs: SpecConfig[];
  execution: RunSpecExecution;
  runconfigPath?: string;
  argv: string[];
  now?: Date;
}

export function createRunSpec(opts: CreateSpecOptions): RunSpecFile {
  const at = (opts.now ?? new Date()).toISOString();
  const cliVersions: Record<string, string> = {};
  for (const c of opts.configs) if (c.cliVersion) cliVersions[c.id] = c.cliVersion;
  return {
    version: RUN_SPEC_VERSION,
    runId: opts.runId,
    createdAt: at,
    updatedAt: at,
    origin: 'launch',
    grid: normalizeGrid(opts.grid, opts.configs),
    configs: opts.configs,
    execution: opts.execution,
    provenance: {
      runconfigPath: opts.runconfigPath,
      configHash: hashConfigs(opts.configs),
      argv: opts.argv,
      createdAt: at,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
      cliVersions,
    },
    history: [
      {
        at,
        event: 'created',
        detail: describeGrid(opts.grid),
        argv: opts.argv,
      },
    ],
  };
}

function normalizeGrid(grid: RunSpecGrid, configs: SpecConfig[]): RunSpecGrid {
  // Drop an explicit cell list that is exactly the product of the axes: the
  // rectangle is the honest description and it keeps the file readable.
  if (!grid.cells) return grid;
  const listed = dedupeCells(grid.cells);
  const rect = gridCells({ ...grid, cells: undefined }, configs);
  const rectKeys = cellKeySet(rect);
  if (rect.length === listed.length && listed.every((c) => rectKeys.has(cellKey(c)))) {
    return { ...grid, cells: undefined };
  }
  return { ...grid, cells: listed };
}

export function describeGrid(grid: RunSpecGrid): string {
  const n = grid.cells
    ? grid.cells.length
    : grid.taskIds.length * grid.configIds.length * grid.docsConditions.length * grid.trials;
  return (
    `${grid.taskIds.length} task(s) × ${grid.configIds.length} config(s) × ` +
    `docs ${grid.docsConditions.join('+')} × ${grid.trials} trial(s)` +
    (grid.cells ? ` = ${grid.cells.length} explicit cell(s)` : ` = ${n} cell(s)`)
  );
}

// ---------------------------------------------------------------------------
// Back-compat: runs created before run-spec.json existed
// ---------------------------------------------------------------------------

export interface Reconstruction {
  spec: RunSpecFile;
  /** What was assumed, in the operator's words. Always printed. */
  notes: string[];
}

/** True for a cell that has actually been worked on, as opposed to merely enumerated. */
function hasEvidence(cell: CellState): boolean {
  return (
    cell.status !== 'pending' ||
    cell.attempts > 0 ||
    cell.rateLimitedAttempts > 0 ||
    (cell.history?.length ?? 0) > 0
  );
}

/**
 * Rebuild a run's grid from its own recorded history.
 *
 * `state.json`'s `meta` block is written once at creation and never widened by
 * `ensureCells`, so `meta.{taskIds, configs, docsConditions, trials}` *is* the
 * launch grid even for a state file whose cell map was later inflated by an
 * unguarded resume. That is the primary source. Cells outside it are kept only
 * when they are `done` — real results that must not vanish — while never-run
 * cells outside it are dropped as the artefacts of the bug this file fixes.
 *
 * Throws rather than guessing when neither source can describe a grid.
 */
export function reconstructSpec(args: {
  state: RunStateFile;
  execution: RunSpecExecution;
  runconfigPath?: string;
  argv: string[];
  now?: Date;
}): Reconstruction {
  const { state } = args;
  const at = (args.now ?? new Date()).toISOString();
  const notes: string[] = [];
  const meta = state.meta;
  const cells = Object.values(state.cells ?? {});

  const metaUsable =
    Array.isArray(meta?.taskIds) &&
    meta.taskIds.length > 0 &&
    Array.isArray(meta?.configs) &&
    meta.configs.length > 0 &&
    Array.isArray(meta?.docsConditions) &&
    meta.docsConditions.length > 0 &&
    Number.isInteger(meta?.trials) &&
    meta.trials > 0;

  let grid: RunSpecGrid;
  let configs: SpecConfig[];

  if (metaUsable) {
    configs = meta.configs.map((c) => ({
      id: c.id,
      label: c.id,
      harness: c.harness as AgentConfig['harness'],
      model: c.model,
      reasoningEffort: c.reasoningEffort,
      enabled: true,
      cliVersion: c.cliVersion,
      reconstructed: true,
    }));
    grid = {
      taskIds: [...meta.taskIds],
      configIds: configs.map((c) => c.id),
      docsConditions: [...meta.docsConditions],
      trials: meta.trials,
    };
    const rectCells = gridCells(grid, configs);
    const rect = cellKeySet(rectCells);
    const doneOutside = cells.filter((c) => c.status === 'done' && !rect.has(cellKey(c)));
    const strayNeverDone = cells.filter((c) => c.status !== 'done' && !rect.has(cellKey(c)));
    notes.push(
      `no ${RUN_SPEC_FILENAME}: reconstructed the grid from state.json's recorded run metadata ` +
        `(${describeGrid(grid)})`,
    );
    if (doneOutside.length > 0) {
      grid = normalizeGrid(
        { ...grid, cells: [...rectCells, ...doneOutside.map(toCoords)] },
        configs,
      );
      notes.push(
        `kept ${doneOutside.length} completed cell(s) recorded outside that grid — real results, ` +
          'so they are part of this run',
      );
    }
    if (strayNeverDone.length > 0) {
      const started = strayNeverDone.filter(hasEvidence).length;
      notes.push(
        `ignoring ${strayNeverDone.length} never-completed cell(s) in state.json that are not in the ` +
          `recorded grid` +
          (started > 0 ? ` (${started} of them had been started)` : '') +
          ' — they were added by a resume that rebuilt the grid from config defaults',
      );
    }
  } else {
    const executed = cells.filter(hasEvidence);
    if (executed.length === 0) {
      throw new Error(
        `cannot reconstruct the grid for run ${state.runId}: state.json has no usable run metadata ` +
          '(meta.taskIds / meta.configs / meta.docsConditions / meta.trials) and no cell has been ' +
          'executed, so there is no record of what this run was launched to measure. Refusing to ' +
          'fall back to the current runconfig.json — start a new run instead, or hand-write ' +
          `results/${state.runId}/${RUN_SPEC_FILENAME}.`,
      );
    }
    const coords = executed.map(toCoords);
    configs = [...new Set(coords.map((c) => c.configId))].map((id) => ({
      id,
      label: id,
      harness: (meta?.configs?.find((c) => c.id === id)?.harness ??
        'command-template') as AgentConfig['harness'],
      model: meta?.configs?.find((c) => c.id === id)?.model ?? 'unknown',
      reasoningEffort: meta?.configs?.find((c) => c.id === id)?.reasoningEffort,
      enabled: true,
      reconstructed: true,
    }));
    grid = normalizeGrid(
      {
        taskIds: [...new Set(coords.map((c) => c.taskId))].sort(),
        configIds: configs.map((c) => c.id),
        docsConditions: [...new Set(coords.map((c) => c.docsCondition))],
        trials: Math.max(...coords.map((c) => c.trial)),
        cells: coords,
      },
      configs,
    );
    notes.push(
      `no ${RUN_SPEC_FILENAME} and no usable run metadata in state.json: reconstructed the grid ` +
        `from the ${executed.length} cell(s) this run actually executed`,
    );
  }

  const spec: RunSpecFile = {
    version: RUN_SPEC_VERSION,
    runId: state.runId,
    createdAt: state.createdAt ?? at,
    updatedAt: at,
    origin: 'reconstructed',
    grid,
    configs,
    execution: args.execution,
    provenance: {
      runconfigPath: args.runconfigPath,
      configHash: hashConfigs(configs),
      argv: args.argv,
      createdAt: state.createdAt ?? at,
      node: String((meta?.provenance as Record<string, unknown>)?.node ?? process.version),
      platform: String((meta?.provenance as Record<string, unknown>)?.platform ?? process.platform),
      arch: String((meta?.provenance as Record<string, unknown>)?.arch ?? process.arch),
      cwd: process.cwd(),
      cliVersions: Object.fromEntries(
        (meta?.configs ?? [])
          .filter((c) => c.cliVersion)
          .map((c) => [c.id, c.cliVersion as string]),
      ),
    },
    history: [
      { at, event: 'reconstructed', detail: notes.join('; '), argv: args.argv },
    ],
  };
  return { spec, notes };
}

function toCoords(cell: CellState): CellCoords {
  return {
    taskId: cell.taskId,
    configId: cell.configId,
    docsCondition: cell.docsCondition,
    trial: cell.trial,
  };
}

// ---------------------------------------------------------------------------
// Grid diffing — "would this resume add cells?"
// ---------------------------------------------------------------------------

export interface RequestedAxes {
  taskIds: string[];
  configIds: string[];
  docsConditions: DocsCondition[];
  trials: number;
  /** Which axes the operator actually typed on this invocation. */
  explicit: { tasks: boolean; configs: boolean; docs: boolean; trials: boolean };
}

export interface GridDiff {
  /** Cells the invocation asks for that the run has never recorded. */
  added: CellCoords[];
  /** Recorded cells the invocation's filters exclude from this pass. */
  excluded: CellCoords[];
  /** One human-readable clause per axis that widened, for the refusal message. */
  reasons: string[];
}

export function diffGrid(
  spec: RunSpecFile,
  requested: CellCoords[],
  axes: RequestedAxes,
): GridDiff {
  const recorded = specCells(spec);
  const recordedKeys = cellKeySet(recorded);
  const requestedKeys = cellKeySet(requested);
  const added = requested.filter((c) => !recordedKeys.has(cellKey(c)));
  const excluded = recorded.filter((c) => !requestedKeys.has(cellKey(c)));

  const reasons: string[] = [];
  if (axes.explicit.trials && axes.trials > spec.grid.trials) {
    reasons.push(`--trials ${axes.trials} vs recorded ${spec.grid.trials}`);
  }
  const newDocs = axes.docsConditions.filter((d) => !spec.grid.docsConditions.includes(d));
  if (newDocs.length > 0) {
    reasons.push(
      `docs ${axes.docsConditions.join('+')} vs recorded ${spec.grid.docsConditions.join('+')}`,
    );
  }
  const newTasks = axes.taskIds.filter((t) => !spec.grid.taskIds.includes(t));
  if (newTasks.length > 0) {
    reasons.push(
      `${newTasks.length} task(s) not in the recorded grid: ${summarizeIds(newTasks)}`,
    );
  }
  const newConfigs = axes.configIds.filter((c) => !spec.grid.configIds.includes(c));
  if (newConfigs.length > 0) {
    reasons.push(
      `${newConfigs.length} config(s) not in the recorded grid: ${summarizeIds(newConfigs)}`,
    );
  }
  // Something widened that the per-axis clauses did not explain (a ragged
  // recorded set, say). Never let the refusal message be empty.
  if (added.length > 0 && reasons.length === 0) {
    reasons.push(`${added.length} cell(s) outside the recorded cell set`);
  }
  return { added, excluded, reasons };
}

function summarizeIds(ids: string[], max = 4): string {
  return ids.length <= max
    ? ids.join(', ')
    : `${ids.slice(0, max).join(', ')} … +${ids.length - max} more`;
}

export function renderRefusal(spec: RunSpecFile, diff: GridDiff): string {
  return (
    `refusing to add ${diff.added.length} cell(s) to run ${spec.runId}: ` +
    `${diff.reasons.join(', ')}; pass --expand to extend this run`
  );
}

/**
 * Fold an accepted expansion into the spec.
 *
 * When the requested rectangle covers everything already recorded, the grid
 * becomes that rectangle (the file stays readable). Otherwise the union is
 * pinned as an explicit cell list, because no rectangle describes it honestly.
 */
export function expandSpec(
  spec: RunSpecFile,
  args: {
    axes: RequestedAxes;
    requested: CellCoords[];
    diff: GridDiff;
    newConfigs: SpecConfig[];
    argv: string[];
    now?: Date;
  },
): RunSpecFile {
  const at = (args.now ?? new Date()).toISOString();
  const recorded = specCells(spec);
  const requestedKeys = cellKeySet(args.requested);
  const covers = recorded.every((c) => requestedKeys.has(cellKey(c)));

  const configs = [...spec.configs];
  for (const c of args.newConfigs) {
    if (!configs.some((existing) => existing.id === c.id)) configs.push(c);
  }

  const grid: RunSpecGrid = covers
    ? {
        taskIds: [...args.axes.taskIds],
        configIds: [...args.axes.configIds],
        docsConditions: [...args.axes.docsConditions],
        trials: args.axes.trials,
      }
    : normalizeGrid(
        {
          taskIds: [...new Set([...spec.grid.taskIds, ...args.axes.taskIds])],
          configIds: [...new Set([...spec.grid.configIds, ...args.axes.configIds])],
          docsConditions: [
            ...new Set([...spec.grid.docsConditions, ...args.axes.docsConditions]),
          ] as DocsCondition[],
          trials: Math.max(spec.grid.trials, args.axes.trials),
          cells: [...recorded, ...args.requested],
        },
        configs,
      );

  return {
    ...spec,
    updatedAt: at,
    grid,
    configs,
    provenance: { ...spec.provenance, configHash: hashConfigs(configs) },
    history: [
      ...spec.history,
      {
        at,
        event: 'expanded',
        detail: `--expand added ${args.diff.added.length} cell(s): ${args.diff.reasons.join(', ')}`,
        added: args.diff.added.length,
        diffs: args.diff.reasons,
        previousGrid: spec.grid,
        argv: args.argv,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Drift — "does runconfig.json still describe what this run is measuring?"
// ---------------------------------------------------------------------------

/**
 * Fields whose change alters what the agent actually does. A run that mixed
 * results from two of these would be measuring two different things under one
 * label, so a resume keeps executing the *recorded* definition and says so.
 */
const BEHAVIORAL_FIELDS = [
  'harness',
  'model',
  'reasoningEffort',
  'docsCondition',
  'command',
  'argsTemplate',
  'promptVia',
  'versionArgs',
  'extraArgs',
  'env',
] as const;

/** Changes worth reporting that cannot change a trajectory. */
const METADATA_FIELDS = ['enabled'] as const;

export type DriftKind = 'behavioral' | 'pricing' | 'metadata' | 'missing';

export interface ConfigDrift {
  configId: string;
  kind: DriftKind;
  changes: Array<{ field: string; recorded: unknown; current: unknown }>;
}

/**
 * Compare each recorded config against the config file as it stands today.
 *
 * The run still executes the recorded definition either way — this is a report,
 * not a decision. That is what keeps "results already scored under the old
 * definition are not silently mixed with new ones" true by construction: there
 * are no new definitions in this run.
 *
 * Pricing-only drift is a WARNING, not an error (README "Resume replays the run,
 * not the config file"): the API-equivalent cost column is derived from the
 * *recorded* pricing, so the run stays internally consistent, and erroring would
 * block the unattended overnight resume that is the normal path for the full grid
 * — over an edit that cannot change a single token of a trajectory.
 */
export function detectDrift(spec: RunSpecFile, current: AgentConfig[]): ConfigDrift[] {
  const byId = new Map(current.map((c) => [c.id, c]));
  const out: ConfigDrift[] = [];
  for (const recorded of spec.configs) {
    const now = byId.get(recorded.id);
    if (!now) {
      out.push({ configId: recorded.id, kind: 'missing', changes: [] });
      continue;
    }
    const behavioral = fieldChanges(recorded, now, BEHAVIORAL_FIELDS);
    if (behavioral.length > 0) {
      out.push({ configId: recorded.id, kind: 'behavioral', changes: behavioral });
    }
    if (canonicalJson(recorded.pricing ?? null) !== canonicalJson(now.pricing ?? null)) {
      out.push({
        configId: recorded.id,
        kind: 'pricing',
        changes: [{ field: 'pricing', recorded: recorded.pricing, current: now.pricing }],
      });
    }
    const metadata = fieldChanges(recorded, now, METADATA_FIELDS);
    if (metadata.length > 0) {
      out.push({ configId: recorded.id, kind: 'metadata', changes: metadata });
    }
  }
  return out;
}

function fieldChanges(
  recorded: SpecConfig,
  now: AgentConfig,
  fields: readonly string[],
): Array<{ field: string; recorded: unknown; current: unknown }> {
  const out: Array<{ field: string; recorded: unknown; current: unknown }> = [];
  for (const field of fields) {
    const a = (recorded as unknown as Record<string, unknown>)[field];
    const b = (now as unknown as Record<string, unknown>)[field];
    if (canonicalJson(a ?? null) !== canonicalJson(b ?? null)) {
      out.push({ field, recorded: a, current: b });
    }
  }
  return out;
}

const DRIFT_HEADLINE: Record<DriftKind, string> = {
  behavioral: 'CHANGED DEFINITION',
  pricing: 'changed pricing',
  metadata: 'changed metadata',
  missing: 'NO LONGER IN THE CONFIG FILE',
};

/** One line per drifted field, for the console and for run.log. */
export function driftLines(drift: ConfigDrift[]): string[] {
  const lines: string[] = [];
  for (const d of drift) {
    if (d.kind === 'missing') {
      lines.push(`${d.configId}: ${DRIFT_HEADLINE.missing} — replaying the definition recorded at launch`);
      continue;
    }
    for (const c of d.changes) {
      lines.push(
        `${d.configId}: ${DRIFT_HEADLINE[d.kind]} ${c.field}: ` +
          `recorded ${JSON.stringify(c.recorded ?? null)} → now ${JSON.stringify(c.current ?? null)}`,
      );
    }
  }
  return lines;
}

/** Drift that changes what an agent does, or removes a config outright. */
export function isSeriousDrift(drift: ConfigDrift[]): boolean {
  return drift.some((d) => d.kind === 'behavioral' || d.kind === 'missing');
}

/**
 * Append a drift report to the spec's history.
 *
 * Idempotent: an unattended grid is resumed dozens of times against the same
 * edited config file, and the history is a record of *changes*, not of how often
 * someone re-ran the command. Returns the spec unchanged when the same drift is
 * already the latest thing recorded.
 */
export function recordDrift(
  spec: RunSpecFile,
  drift: ConfigDrift[],
  argv: string[],
  now: Date = new Date(),
): RunSpecFile {
  if (drift.length === 0) return spec;
  const previous = [...spec.history].reverse().find((h) => h.event === 'drift');
  if (previous && canonicalJson(previous.drift ?? []) === canonicalJson(drift)) return spec;
  const at = now.toISOString();
  return {
    ...spec,
    updatedAt: at,
    history: [
      ...spec.history,
      {
        at,
        event: 'drift',
        detail: `runconfig.json no longer matches ${drift.length} recorded config definition(s); ` +
          'the recorded definitions were replayed',
        drift,
        argv,
      },
    ],
  };
}
