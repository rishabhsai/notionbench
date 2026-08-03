/**
 * The run watchdog — "is this task broken, or is it just hard?"
 *
 * A 798-cell grid is several days of paid subscription time. The expensive
 * failure mode is not a crash; it is a run that completes beautifully and whose
 * results have to be thrown away because task 7's verifier was wrong the whole
 * time. Two real bugs presented exactly that way — `unexpected field \`views\``
 * and `missing field \`type\``, each failing the same task across three
 * different configs with the same diagnostic. Both were caught by a human
 * reading the log, hours in.
 *
 * This module is that human, made deterministic. It is evaluated in-process
 * after every cell is scored, it uses **no model** — only counting, set
 * intersection and string normalization — and its whole job is to separate:
 *
 *   "every frontier agent failed this task with the SAME complaint"
 *     → almost certainly the verifier or the fixture, not the agents. HALT.
 *
 *   "several agents failed this task with DIFFERENT complaints"
 *     → that is what a hard task looks like. Keep going.
 *
 * ## Signals and their defaults
 *
 * | # | signal | default threshold | halts? | why that number |
 * |---|--------|-------------------|--------|-----------------|
 * | a | cross-config identical failure | 3 configs, **or** ≥60% of the configs *in the run*, sharing a normalized diagnostic | yes | 3 is what both real bugs looked like. Three independent frontier models do not produce the same failure text by coincidence; they do produce *different* failure texts on a genuinely hard task. The 60% arm exists so a narrow grid (`--configs a,b,c`) is not blind. The denominator is the run's config count, never "the configs that have reported so far" — otherwise the first two verdicts of every block are trivially 100% of them. |
 * | b | verifier crash / malformed verdict | 1 occurrence | yes | `scored: false` after the verifier actually ran means the measurement apparatus failed. That is never a legitimate agent failure, and every subsequent cell on that task is unmeasured too. One is enough. |
 * | c | fixture provisioning failure on a live task | 2 for the same task | yes | One can be a Notion 500. Two on the same task's `spec.json`, when other tasks provision fine, is the spec. |
 * | d | total-task failure (every config scored 0) | 5 configs | **no — warns** | A task all frontier models fail may be broken *or* may be brutally hard, and NotionBench exists to contain tasks nothing solves. Halting the grid on "hard" would be the benchmark censoring its own headline result. Flag it, name it, let a human look. `watchdog.totalTaskFailure.halt: true` opts in. |
 * | e | infrastructure: nothing completed in 60 min while work was runnable | 60 min | yes | 4× the 900s default per-trial budget, and the stall clock only advances while at least one config was actually free to run — a legitimate 30-minute all-configs cooldown cannot trip it. |
 * | e | infrastructure: free disk below 5 GB | 5 GB | yes | Transcripts and workspaces are the run's only durable output; a run that fills the disk destroys what it already earned. |
 * | e | infrastructure: every config blocked / cooling | all *blocked* | yes (blocked) / warns (merely cooling) | Every config permanently blocked (expired subscription, revoked login) means the run cannot progress at all. Every config merely *cooling* is the normal shape of a paced grid, so that only warns. |
 *
 * Every threshold is configurable under `runconfig.json`'s `watchdog` block;
 * `--no-watchdog` disables it entirely and `--watchdog-warn-only` downgrades
 * every halt to a warning.
 *
 * ## Acknowledgments
 *
 * Signals (a) and (d) can be right about the evidence and wrong about the
 * conclusion: a task whose *prompt* leads several agents into the same mistake
 * produces exactly the cross-config signature of a broken verifier. `--ack
 * <task>[:<pattern>] --ack-reason "<why>"` (ack.ts) records that a human read
 * that signature and found it legitimate — the alert is still raised, still
 * written to ALERT.json, still shown by `doctor`, at `level: "acknowledged"`
 * with the reason attached — and only the *halt* is withheld. Signals (b) and
 * (c) are apparatus faults and are never acknowledgeable at any syntax.
 *
 * ## What "halt" means
 *
 * Halt stops *scheduling*. In-flight cells run to completion and are scored
 * normally — killing a trial mid-flight would waste the one thing that is
 * genuinely expensive and would leave a workspace un-verified. Then
 * `results/<runId>/ALERT.json` and a banner in `run.log` are written, and the
 * process exits non-zero naming the task and the evidence.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from './spawn.js';
import {
  ackFlag,
  matchAck,
  renderAcknowledgments,
  type Acknowledgment,
} from './ack.js';

export const ALERT_FILENAME = 'ALERT.json';
export const ALERT_FILE_VERSION = 1;

/** Exit code for "the run was halted by the watchdog". Distinct from 1 (cells failed) and 2 (usage). */
export const WATCHDOG_EXIT_CODE = 3;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface WatchdogSettings {
  enabled: boolean;
  /** Raise and record alerts, but never stop the run. */
  warnOnly: boolean;
  crossConfig: {
    /** Distinct configs sharing a normalized diagnostic that trip the signal. */
    minConfigs: number;
    /** …or this fraction of the configs in the run (min 2 matching configs). */
    minFraction: number;
    /** Shortest shared substring accepted as evidence when no diagnostic matches exactly. */
    minSharedChars: number;
  };
  verifierCrash: {
    enabled: boolean;
    minOccurrences: number;
  };
  fixtureFailure: {
    enabled: boolean;
    minOccurrences: number;
  };
  totalTaskFailure: {
    enabled: boolean;
    minConfigs: number;
    /** False (the default): flag as SUSPECT and keep running. */
    halt: boolean;
  };
  infrastructure: {
    /** Minutes with no cell completing while work was runnable. 0 disables. */
    stallMinutes: number;
    /** Free space on the results volume, GB. 0 disables. */
    minFreeDiskGb: number;
    haltOnStall: boolean;
    haltOnLowDisk: boolean;
    haltOnAllConfigsBlocked: boolean;
  };
}

export const DEFAULT_WATCHDOG_SETTINGS: WatchdogSettings = {
  enabled: true,
  warnOnly: false,
  crossConfig: { minConfigs: 3, minFraction: 0.6, minSharedChars: 24 },
  verifierCrash: { enabled: true, minOccurrences: 1 },
  fixtureFailure: { enabled: true, minOccurrences: 2 },
  totalTaskFailure: { enabled: true, minConfigs: 5, halt: false },
  infrastructure: {
    stallMinutes: 60,
    minFreeDiskGb: 5,
    haltOnStall: true,
    haltOnLowDisk: true,
    haltOnAllConfigsBlocked: true,
  },
};

/** Deep-merge a partial `watchdog` block from runconfig.json over the defaults. */
export function resolveWatchdogSettings(
  partial: DeepPartial<WatchdogSettings> | undefined,
): WatchdogSettings {
  const d = DEFAULT_WATCHDOG_SETTINGS;
  const p = partial ?? {};
  return {
    enabled: p.enabled ?? d.enabled,
    warnOnly: p.warnOnly ?? d.warnOnly,
    crossConfig: {
      minConfigs: num(p.crossConfig?.minConfigs, d.crossConfig.minConfigs),
      minFraction: num(p.crossConfig?.minFraction, d.crossConfig.minFraction),
      minSharedChars: num(p.crossConfig?.minSharedChars, d.crossConfig.minSharedChars),
    },
    verifierCrash: {
      enabled: p.verifierCrash?.enabled ?? d.verifierCrash.enabled,
      minOccurrences: num(p.verifierCrash?.minOccurrences, d.verifierCrash.minOccurrences),
    },
    fixtureFailure: {
      enabled: p.fixtureFailure?.enabled ?? d.fixtureFailure.enabled,
      minOccurrences: num(p.fixtureFailure?.minOccurrences, d.fixtureFailure.minOccurrences),
    },
    totalTaskFailure: {
      enabled: p.totalTaskFailure?.enabled ?? d.totalTaskFailure.enabled,
      minConfigs: num(p.totalTaskFailure?.minConfigs, d.totalTaskFailure.minConfigs),
      halt: p.totalTaskFailure?.halt ?? d.totalTaskFailure.halt,
    },
    infrastructure: {
      stallMinutes: num(p.infrastructure?.stallMinutes, d.infrastructure.stallMinutes),
      minFreeDiskGb: num(p.infrastructure?.minFreeDiskGb, d.infrastructure.minFreeDiskGb),
      haltOnStall: p.infrastructure?.haltOnStall ?? d.infrastructure.haltOnStall,
      haltOnLowDisk: p.infrastructure?.haltOnLowDisk ?? d.infrastructure.haltOnLowDisk,
      haltOnAllConfigsBlocked:
        p.infrastructure?.haltOnAllConfigsBlocked ?? d.infrastructure.haltOnAllConfigsBlocked,
    },
  };
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

/**
 * `halt` stops scheduling. `warn` is recorded and printed. `acknowledged` is a
 * `halt` a human reviewed in advance (`--ack`): fully recorded, never halting,
 * and carrying the reason it was accepted.
 */
export type AlertLevel = 'halt' | 'warn' | 'acknowledged';

export type AlertKind =
  | 'cross-config-identical-failure'
  | 'verifier-crash'
  | 'fixture-provisioning-failure'
  | 'total-task-failure'
  | 'infrastructure-stall'
  | 'infrastructure-low-disk'
  | 'infrastructure-all-configs-blocked';

export interface WatchdogAlert {
  level: AlertLevel;
  kind: AlertKind;
  /** The task this is about. Absent for infrastructure alerts. */
  taskId?: string;
  /** The configs the evidence came from. */
  configIds: string[];
  trial?: number;
  /** One line a human can act on — the shared diagnostic, the crash, the count. */
  evidence: string;
  /** Supporting lines: the per-config diagnostics, the raw counts. */
  detail: string[];
  at: string;
  /** True when this alert is what stopped the run. */
  halted: boolean;
  /**
   * Set when `level` is `acknowledged`: the `--ack` that covered this signature,
   * with the operator's mandatory reason. Present so ALERT.json alone answers
   * "what was suppressed in this run, and on whose say-so".
   */
  acknowledgment?: Acknowledgment;
}

export interface AlertFile {
  version: number;
  runId: string;
  at: string;
  halted: boolean;
  /** The alert that stopped the run, when one did. */
  halting?: WatchdogAlert;
  alerts: WatchdogAlert[];
  /**
   * Every acknowledgment in force for this run — including ones that never
   * matched anything. An unused suppression is still a suppression a reader is
   * entitled to see.
   */
  acknowledgments?: Acknowledgment[];
}

export function alertPath(runDir: string): string {
  return path.join(runDir, ALERT_FILENAME);
}

export async function writeAlertFile(runDir: string, file: AlertFile): Promise<void> {
  await writeJsonAtomic(alertPath(runDir), file);
}

/** Read a run's alerts. Missing or unreadable → undefined; never throws. */
export async function readAlertFile(runDir: string): Promise<AlertFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(alertPath(runDir), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AlertFile>;
    if (!Array.isArray(parsed.alerts)) return undefined;
    return {
      version: typeof parsed.version === 'number' ? parsed.version : ALERT_FILE_VERSION,
      runId: String(parsed.runId ?? ''),
      at: String(parsed.at ?? ''),
      halted: parsed.halted === true,
      halting: parsed.halting,
      alerts: parsed.alerts.filter((a): a is WatchdogAlert => !!a && typeof a === 'object'),
      ...(Array.isArray(parsed.acknowledgments)
        ? {
            acknowledgments: parsed.acknowledgments.filter(
              (a): a is Acknowledgment =>
                !!a && typeof a === 'object' && typeof (a as Acknowledgment).taskId === 'string',
            ),
          }
        : {}),
    };
  } catch {
    // A torn write of an advisory file is not worth failing a status request over.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Diagnostic normalization
// ---------------------------------------------------------------------------

/**
 * Strip everything a diagnostic says about *this cell* so that what remains is
 * what it says about the *task*.
 *
 * Ids, uuids, urls, paths and numbers all differ between two configs failing the
 * same way (`root=3af6ab85-…`, `12.4s`, `/tmp/nb-…/workspace`), and leaving them
 * in would mean two identical complaints never compare equal. Quote styles are
 * unified because `missing field 'type'` and "missing field `type`" are the same
 * complaint from two different verifiers.
 *
 * Deliberately lossy and deliberately ordered: urls, then uuids/hex ids, then
 * paths (which contain digits), then bare numbers.
 */
export function normalizeDiagnostic(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\bhttps?:\/\/\S+/g, '<url>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>')
    .replace(/\b[0-9a-f]{32}\b/g, '<id>')
    .replace(/\b[0-9a-f]{16,}\b/g, '<id>')
    .replace(/(?:[a-z]:)?(?:[\\/][\w.@+-]+){2,}[\\/]?/g, '<path>')
    .replace(/\b0x[0-9a-f]+\b/g, '<n>')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|kb|mb|gb|%)?\b/g, '<n>')
    .replace(/[`'"‘’“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SharedEvidence {
  /** `exact`: a whole normalized diagnostic matched. `substring`: only a run of it did. */
  kind: 'exact' | 'substring';
  text: string;
  configIds: string[];
}

/**
 * The strongest thing several configs' diagnostics have in common.
 *
 * Exact match first — the signature of a verifier bug is that every config gets
 * the *same sentence* — then the longest common substring, which catches the
 * case where each verifier line carries a little cell-specific tail that
 * normalization did not reach.
 *
 * Returns undefined when the configs failed for different reasons, which is the
 * whole point: that is what a hard task looks like, and it must not trip.
 */
export function sharedEvidence(
  perConfig: Array<{ configId: string; diagnostics: string[] }>,
  minSharedChars: number,
  /** Normalized lines that also appear on a PASSING cell — context, not a finding. */
  uninformative: ReadonlySet<string> = new Set(),
): SharedEvidence | undefined {
  const cleaned = perConfig
    .map((c) => ({
      configId: c.configId,
      lines: [
        ...new Set(
          c.diagnostics
            .map(normalizeDiagnostic)
            .filter((d) => d.length >= 4 && !uninformative.has(d)),
        ),
      ],
    }))
    .filter((c) => c.lines.length > 0);
  if (cleaned.length < 2) return undefined;

  // 1. A whole normalized diagnostic present in several configs.
  const byLine = new Map<string, string[]>();
  for (const c of cleaned) {
    for (const line of c.lines) {
      const bucket = byLine.get(line);
      if (bucket) bucket.push(c.configId);
      else byLine.set(line, [c.configId]);
    }
  }
  let best: SharedEvidence | undefined;
  for (const [text, configIds] of byLine) {
    if (configIds.length < 2) continue;
    if (
      !best ||
      configIds.length > best.configIds.length ||
      (configIds.length === best.configIds.length && text.length > best.text.length)
    ) {
      best = { kind: 'exact', text, configIds };
    }
  }
  if (best) return best;

  // 2. Nothing matched whole; look for a long shared run of text across ALL of
  //    them. Short accidental overlaps ("failed", "expected ") are rejected by
  //    minSharedChars.
  let common = cleaned[0]!.lines.join(' · ');
  for (let i = 1; i < cleaned.length; i++) {
    common = longestCommonSubstring(common, cleaned[i]!.lines.join(' · '));
    if (common.length < minSharedChars) return undefined;
  }
  const text = common.trim();
  if (text.length < minSharedChars) return undefined;
  return { kind: 'substring', text, configIds: cleaned.map((c) => c.configId) };
}

/** Classic DP; diagnostics are short, so the O(n·m) table is free. */
export function longestCommonSubstring(a: string, b: string): string {
  if (a.length === 0 || b.length === 0) return '';
  let prev = new Uint32Array(b.length + 1);
  let curr = new Uint32Array(b.length + 1);
  let bestLen = 0;
  let bestEnd = 0;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1]! + 1;
        if (curr[j]! > bestLen) {
          bestLen = curr[j]!;
          bestEnd = i;
        }
      } else {
        curr[j] = 0;
      }
    }
    const swap = prev;
    prev = curr;
    curr = swap;
    curr.fill(0);
  }
  return a.slice(bestEnd - bestLen, bestEnd);
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

/**
 * What happened to one cell, from the watchdog's point of view.
 *
 * `kind` is decided at the call site rather than inferred, because the
 * difference between "the verifier crashed" and "we chose not to verify"
 * (`rate_limited`, `spawn_error`, `--no-score`) is invisible in the persisted
 * row — both are `scored: false` — and confusing them would halt a healthy run
 * every time a usage window closed.
 */
export interface WatchdogObservation {
  taskId: string;
  configId: string;
  trial: number;
  docsCondition?: string;
  kind:
    /** The verifier ran and returned a verdict. `score` is meaningful. */
    | 'scored'
    /** The verifier ran and did NOT return a usable verdict. Signal (b). */
    | 'verifier-crash'
    /** A live fixture could not be provisioned. Signal (c). */
    | 'fixture-failure'
    /** Something else went wrong before a verdict (workspace prep, spawn). */
    | 'runner-error'
    /** Deliberately not verified: rate window, spawn error, --no-score. Ignored. */
    | 'unmeasured';
  score?: number;
  diagnostics?: string[];
  error?: string;
  at?: string;
}

interface TaskTrialState {
  attempted: Set<string>;
  /** configId → diagnostics of its graded failure. */
  failed: Map<string, string[]>;
  solved: Set<string>;
  /**
   * Normalized diagnostics seen on cells that PASSED this task/trial.
   *
   * Verifiers print context as well as findings — "fixture holds 3 incident(s)",
   * "ground truth: 6 view(s)" — and that context is identical whether the cell
   * passed or failed. Matching on it makes every config that fails a task look
   * like it failed for the same reason, which is the signature this signal is
   * supposed to be detecting. A line that also appears on a pass carries no
   * information about the failure, so it is excluded from the comparison.
   */
  solvedLines: Set<string>;
}

export interface WatchdogOptions {
  settings?: WatchdogSettings;
  runId: string;
  /** The configs in this run — needed for "every config is blocked". */
  configIds: string[];
  /**
   * Failure signatures a human reviewed and accepted (`--ack`, replayed from
   * run-spec.json on resume). They downgrade a matching halt to `acknowledged`;
   * they never suppress the alert, and never apply to a verifier crash or a
   * fixture-provisioning failure (ack.ts `matchAck`).
   */
  acknowledgments?: Acknowledgment[];
  now?: () => number;
}

/** Input for the periodic infrastructure sweep. */
export interface InfrastructureSnapshot {
  now: number;
  pendingCells: number;
  inFlightCells: number;
  cooldownConfigIds: string[];
  blockedConfigIds: string[];
  /** Free bytes on the results volume, or undefined when it could not be read. */
  freeDiskBytes?: number;
}

export class Watchdog {
  readonly settings: WatchdogSettings;
  readonly runId: string;
  readonly acknowledgments: Acknowledgment[];
  private readonly configIds: string[];
  private readonly now: () => number;

  private readonly byTaskTrial = new Map<string, TaskTrialState>();
  private readonly fixtureFailures = new Map<string, string[]>();
  private readonly crashCounts = new Map<string, number>();
  private readonly raised = new Set<string>();
  private readonly all: WatchdogAlert[] = [];
  private halting?: WatchdogAlert;

  /** Epoch ms of the last cell completion, and of the last time work was runnable. */
  private lastCompletionMs: number;
  private stallClockStartedMs: number;

  constructor(opts: WatchdogOptions) {
    this.settings = opts.settings ?? DEFAULT_WATCHDOG_SETTINGS;
    this.runId = opts.runId;
    this.acknowledgments = [...(opts.acknowledgments ?? [])];
    this.configIds = [...opts.configIds];
    this.now = opts.now ?? (() => Date.now());
    this.lastCompletionMs = this.now();
    this.stallClockStartedMs = this.lastCompletionMs;
  }

  get alerts(): readonly WatchdogAlert[] {
    return this.all;
  }

  get halted(): boolean {
    return this.halting !== undefined;
  }

  get haltingAlert(): WatchdogAlert | undefined {
    return this.halting;
  }

  /** Alerts that WOULD have halted the run had they not been acknowledged. */
  get acknowledgedAlerts(): readonly WatchdogAlert[] {
    return this.all.filter((a) => a.level === 'acknowledged');
  }

  snapshot(): AlertFile {
    return {
      version: ALERT_FILE_VERSION,
      runId: this.runId,
      at: new Date(this.now()).toISOString(),
      halted: this.halted,
      halting: this.halting,
      alerts: [...this.all],
      ...(this.acknowledgments.length > 0
        ? { acknowledgments: [...this.acknowledgments] }
        : {}),
    };
  }

  /**
   * Record one scored cell and return any alert this made newly true.
   *
   * Pure accumulation plus threshold checks — no I/O, no clock beyond the
   * injected one, so the whole signal set is testable against synthetic results.
   */
  observe(obs: WatchdogObservation): WatchdogAlert[] {
    if (!this.settings.enabled) return [];
    const at = obs.at ?? new Date(this.now()).toISOString();
    this.lastCompletionMs = this.now();
    const out: WatchdogAlert[] = [];

    if (obs.kind === 'unmeasured') return out;

    if (obs.kind === 'fixture-failure') {
      const bucket = this.fixtureFailures.get(obs.taskId) ?? [];
      bucket.push(obs.configId);
      this.fixtureFailures.set(obs.taskId, bucket);
      const cfg = this.settings.fixtureFailure;
      if (cfg.enabled && bucket.length >= Math.max(1, cfg.minOccurrences)) {
        this.push(out, {
          level: 'halt',
          kind: 'fixture-provisioning-failure',
          taskId: obs.taskId,
          configIds: [...new Set(bucket)],
          evidence:
            `${bucket.length} fixture provisioning failure(s) for ${obs.taskId} — ` +
            `its fixture/spec.json is not provisionable`,
          detail: [obs.error ?? 'no error text recorded'],
          at,
          halted: false,
        });
      }
      return out;
    }

    if (obs.kind === 'verifier-crash') {
      const cfg = this.settings.verifierCrash;
      if (!cfg.enabled) return out;
      const key = `verifier-crash::${obs.taskId}`;
      const seen = (this.crashCounts.get(obs.taskId) ?? 0) + 1;
      this.crashCounts.set(obs.taskId, seen);
      if (seen >= Math.max(1, cfg.minOccurrences)) {
        this.push(
          out,
          {
            level: 'halt',
            kind: 'verifier-crash',
            taskId: obs.taskId,
            configIds: [obs.configId],
            trial: obs.trial,
            evidence:
              `the verifier for ${obs.taskId} did not return a usable verdict ` +
              `(${obs.configId}, trial ${obs.trial}) — that is never an agent failure`,
            detail: [obs.error ?? 'no verifier error recorded'],
            at,
            halted: false,
          },
          key,
        );
      }
      return out;
    }

    if (obs.kind === 'runner-error') return out;

    // --- a graded cell -------------------------------------------------------
    const key = `${obs.taskId}::${obs.trial}`;
    let state = this.byTaskTrial.get(key);
    if (!state) {
      state = {
        attempted: new Set(),
        failed: new Map(),
        solved: new Set(),
        solvedLines: new Set(),
      };
      this.byTaskTrial.set(key, state);
    }
    state.attempted.add(obs.configId);
    if ((obs.score ?? 0) >= 1) {
      state.solved.add(obs.configId);
      state.failed.delete(obs.configId);
      for (const d of obs.diagnostics ?? []) state.solvedLines.add(normalizeDiagnostic(d));
    } else {
      state.failed.set(obs.configId, obs.diagnostics ?? []);
    }

    this.checkCrossConfig(state, obs.taskId, obs.trial, at, out);
    this.checkTotalFailure(state, obs.taskId, obs.trial, at, out);
    return out;
  }

  private checkCrossConfig(
    state: TaskTrialState,
    taskId: string,
    trial: number,
    at: string,
    out: WatchdogAlert[],
  ): void {
    const cfg = this.settings.crossConfig;
    if (state.failed.size < 2) return;
    const evidence = sharedEvidence(
      [...state.failed].map(([configId, diagnostics]) => ({ configId, diagnostics })),
      cfg.minSharedChars,
      state.solvedLines,
    );
    if (!evidence) return;

    const matched = evidence.configIds.length;
    const attempted = state.attempted.size;
    // The denominator is the number of configs that WILL attempt this task, not
    // the number that happen to have reported so far. Otherwise the first two
    // configs to finish a block are always "100% of those that attempted", and
    // every task whose first two verdicts rhyme halts a healthy grid.
    const lane = Math.max(attempted, this.configIds.length);
    const byCount = matched >= Math.max(2, cfg.minConfigs);
    const byFraction = matched >= 2 && lane > 0 && matched / lane >= cfg.minFraction;
    if (!byCount && !byFraction) return;

    this.push(
      out,
      {
        level: 'halt',
        kind: 'cross-config-identical-failure',
        taskId,
        trial,
        configIds: [...evidence.configIds].sort(),
        evidence:
          `${matched} of ${attempted} config(s) failed ${taskId} (trial ${trial}) with the ` +
          `${evidence.kind === 'exact' ? 'same' : 'same underlying'} diagnostic: "${truncate(evidence.text, 160)}"`,
        detail: [
          `threshold: ${byCount ? `≥${cfg.minConfigs} configs` : `≥${Math.round(cfg.minFraction * 100)}% of the ${lane} config(s) in this run`}`,
          ...[...state.failed].map(
            ([configId, diagnostics]) =>
              `${configId}: ${truncate(diagnostics.join(' · ') || '(no diagnostics)', 200)}`,
          ),
        ],
        at,
        halted: false,
      },
      `cross-config::${taskId}::${trial}`,
      // A patterned --ack is matched against the SHARED diagnostic — the exact
      // thing this signal fired on — so acknowledging one failure mode of a task
      // leaves every other failure mode on it halting as before.
      [evidence.text],
    );
  }

  private checkTotalFailure(
    state: TaskTrialState,
    taskId: string,
    trial: number,
    at: string,
    out: WatchdogAlert[],
  ): void {
    const cfg = this.settings.totalTaskFailure;
    if (!cfg.enabled) return;
    if (state.solved.size > 0) return;
    if (state.failed.size < Math.max(2, cfg.minConfigs)) return;
    if (state.failed.size < state.attempted.size) return;
    // "EVERY config failed it" is only true once every config has spoken. Firing
    // at 5-of-7 would routinely be retracted by the sixth, and an alert nobody
    // can trust is worse than no alert.
    if (this.configIds.length > 0 && state.attempted.size < this.configIds.length) return;

    this.push(
      out,
      {
        level: cfg.halt ? 'halt' : 'warn',
        kind: 'total-task-failure',
        taskId,
        trial,
        configIds: [...state.failed.keys()].sort(),
        evidence:
          `SUSPECT: all ${state.attempted.size} config(s) that attempted ${taskId} ` +
          `(trial ${trial}) scored 0, with no shared diagnostic`,
        detail: [
          'a task every frontier model fails may be broken, or may simply be very hard — ' +
            'this warns rather than halting (watchdog.totalTaskFailure.halt to change that)',
          ...[...state.failed].map(
            ([configId, diagnostics]) =>
              `${configId}: ${truncate(diagnostics.join(' · ') || '(no diagnostics)', 200)}`,
          ),
        ],
        at,
        halted: false,
      },
      `total-failure::${taskId}::${trial}`,
      // There is no shared diagnostic here by construction, so a patterned ack
      // must hold for EVERY failing config before it covers this alert.
      [...state.failed.values()].map((diagnostics) =>
        normalizeDiagnostic(diagnostics.join(' · ')),
      ),
    );
  }

  /**
   * The periodic sweep: things that are wrong *because nothing is happening*.
   *
   * Called on a timer rather than per-cell, since by construction none of these
   * are observable from a completion.
   */
  checkInfrastructure(snapshot: InfrastructureSnapshot): WatchdogAlert[] {
    const out: WatchdogAlert[] = [];
    if (!this.settings.enabled) return out;
    const at = new Date(snapshot.now).toISOString();
    const infra = this.settings.infrastructure;

    // Every config down.
    const blocked = new Set(snapshot.blockedConfigIds);
    const cooling = new Set(snapshot.cooldownConfigIds);
    const known = this.configIds.length > 0 ? this.configIds : [...blocked, ...cooling];
    const allBlocked = known.length > 0 && known.every((id) => blocked.has(id));
    const allDown = known.length > 0 && known.every((id) => blocked.has(id) || cooling.has(id));
    if (allBlocked && snapshot.pendingCells > 0) {
      this.push(
        out,
        {
          level: infra.haltOnAllConfigsBlocked ? 'halt' : 'warn',
          kind: 'infrastructure-all-configs-blocked',
          configIds: [...blocked].sort(),
          evidence:
            `all ${known.length} config(s) are blocked (not merely cooling) with ` +
            `${snapshot.pendingCells} cell(s) still pending — the run cannot progress`,
          detail: ['a blocked config is an expired subscription or a revoked login, not a usage window'],
          at,
          halted: false,
        },
        'all-blocked',
      );
    } else if (allDown && snapshot.pendingCells > 0) {
      this.push(
        out,
        {
          level: 'warn',
          kind: 'infrastructure-all-configs-blocked',
          configIds: [...new Set([...blocked, ...cooling])].sort(),
          evidence: `all ${known.length} config(s) are simultaneously cooling down or blocked`,
          detail: ['normal for a paced grid; noted so a run that never wakes up is explicable'],
          at,
          halted: false,
        },
        'all-cooling',
      );
    }

    // Stall. The clock only advances while at least one config could have run:
    // a legitimate all-configs cooldown must never look like a stall.
    const runnable = snapshot.pendingCells > 0 && !allDown;
    if (!runnable) this.stallClockStartedMs = snapshot.now;
    const sinceProgress = snapshot.now - Math.max(this.lastCompletionMs, this.stallClockStartedMs);
    if (infra.stallMinutes > 0 && runnable && sinceProgress >= infra.stallMinutes * 60_000) {
      this.push(
        out,
        {
          level: infra.haltOnStall ? 'halt' : 'warn',
          kind: 'infrastructure-stall',
          configIds: [],
          evidence:
            `no cell completed in ${Math.round(sinceProgress / 60_000)} minute(s) while ` +
            `${snapshot.pendingCells} cell(s) were pending and ${snapshot.inFlightCells} in flight`,
          detail: [`threshold: ${infra.stallMinutes} minute(s)`],
          at,
          halted: false,
        },
        'stall',
      );
    }

    // Disk.
    if (infra.minFreeDiskGb > 0 && snapshot.freeDiskBytes !== undefined) {
      const freeGb = snapshot.freeDiskBytes / 1024 ** 3;
      if (freeGb < infra.minFreeDiskGb) {
        this.push(
          out,
          {
            level: infra.haltOnLowDisk ? 'halt' : 'warn',
            kind: 'infrastructure-low-disk',
            configIds: [],
            evidence: `${freeGb.toFixed(1)} GB free on the results volume (threshold ${infra.minFreeDiskGb} GB)`,
            detail: ['transcripts and workspaces are the run\'s only durable output'],
            at,
            halted: false,
          },
          'low-disk',
        );
      }
    }
    return out;
  }

  /** Note that this alert is the one that stopped the run. */
  markHalted(alert: WatchdogAlert): void {
    alert.halted = true;
    this.halting = alert;
  }

  /**
   * @param ackSubject the normalized diagnostic text(s) a patterned `--ack` is
   *        matched against. Omitted for kinds that are never acknowledgeable,
   *        which is belt-and-braces: `matchAck` refuses those kinds anyway.
   */
  private push(
    out: WatchdogAlert[],
    alert: WatchdogAlert,
    dedupeKey?: string,
    ackSubject?: string[],
  ): void {
    const key = dedupeKey ?? `${alert.kind}::${alert.taskId ?? ''}::${alert.trial ?? ''}`;
    if (this.raised.has(key)) return;
    this.raised.add(key);

    // Acknowledgment first, then --watchdog-warn-only. An acknowledged alert
    // keeps the more informative level: "a human reviewed this exact signature
    // and here is their reason" says strictly more than "warnings only today".
    const ack =
      alert.taskId !== undefined && this.acknowledgments.length > 0
        ? matchAck(this.acknowledgments, {
            kind: alert.kind,
            taskId: alert.taskId,
            normalizedTexts: ackSubject ?? [],
          })
        : undefined;
    if (ack) {
      alert.level = 'acknowledged';
      alert.acknowledgment = ack;
      alert.detail.push(
        `ACKNOWLEDGED by --ack ${ackFlag(ack)} — reason: ${ack.reason}`,
        `recorded ${ack.at}${ack.argv && ack.argv.length > 0 ? `  ·  ${ack.argv.join(' ')}` : ''}`,
        'the failure is recorded as a failure; only the halt was withheld',
      );
    } else if (this.settings.warnOnly) {
      alert.level = 'warn';
    }

    this.all.push(alert);
    out.push(alert);
    if (alert.level === 'halt' && !this.halting) this.markHalted(alert);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The banner written to run.log and printed to stderr when a run is halted. */
export function renderAlertBanner(file: AlertFile, runDir: string): string {
  const rule = '='.repeat(78);
  const acknowledged = file.alerts.filter((a) => a.level === 'acknowledged').length;
  const lines: string[] = [rule];
  lines.push(
    file.halted
      ? `!! WATCHDOG HALT — run ${file.runId} stopped scheduling new cells`
      : `!! WATCHDOG — run ${file.runId} raised ${file.alerts.length} alert(s)` +
        (acknowledged > 0 ? ` (${acknowledged} acknowledged, not halted)` : ''),
  );
  lines.push(rule);
  for (const alert of file.alerts) {
    lines.push(
      `[${alert.level.toUpperCase()}] ${alert.kind}${alert.taskId ? `  task=${alert.taskId}` : ''}` +
        (alert.trial !== undefined ? `  trial=${alert.trial}` : ''),
    );
    lines.push(`  ${alert.evidence}`);
    if (alert.configIds.length > 0) lines.push(`  configs: ${alert.configIds.join(', ')}`);
    for (const d of alert.detail) lines.push(`    ${d}`);
  }
  // Printed whether or not any of them matched: an acknowledgment that never
  // fired is still a suppression in force, and the reader decides whether it
  // should still be there.
  if (file.acknowledgments && file.acknowledgments.length > 0) {
    lines.push(rule);
    for (const l of renderAcknowledgments(file.acknowledgments)) lines.push(l);
  }
  lines.push(rule);
  lines.push(`in-flight cells were allowed to finish and are scored; nothing was killed.`);
  lines.push(`full record: ${alertPath(runDir)}`);
  lines.push(`audit the whole run: notionbench doctor ${runDir}`);
  const halting = file.halting;
  if (halting?.taskId) {
    lines.push(
      `after fixing ${halting.taskId}: notionbench run --resume ${file.runId} --redo ${halting.taskId}`,
    );
  }
  lines.push(rule);
  return lines.join('\n');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Free bytes on the volume holding `dir`, or undefined when it cannot be read. */
export async function freeDiskBytes(dir: string): Promise<number | undefined> {
  try {
    const { statfs } = await import('node:fs/promises');
    if (typeof statfs !== 'function') return undefined;
    const st = await statfs(dir);
    return Number(st.bsize) * Number(st.bavail);
  } catch {
    return undefined;
  }
}
