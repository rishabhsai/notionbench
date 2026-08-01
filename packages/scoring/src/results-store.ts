/**
 * `results/<runId>/results.jsonl` — the append-only record of scored trials.
 *
 * This is the file every published number is computed from, and it is written
 * during a run that is expected to be interrupted (docs/PLAN.md "Pacing": a full
 * grid spans days of subscription rate windows). Two consequences shape the
 * format:
 *
 *  - **Append-only, one JSON object per line.** A partially written last line
 *    costs one trial, never the file. `readResults` reports such a line as a
 *    recoverable problem instead of throwing.
 *  - **Self-describing rows.** Each line carries its own task/config/docs
 *    coordinates and metric values, so the report can be regenerated from
 *    results.jsonl alone — no state.json, no transcripts, no re-scoring.
 *
 * The file is *not* deduplicated on write: a resumed run that re-executes a
 * cell appends a second row. `dedupeByCell` picks the last row per cell when
 * that matters, which keeps replay honest (the history stays on disk).
 */
import { appendFile, mkdir, open, readFile } from "node:fs/promises"
import * as path from "node:path"

export const RESULTS_FILENAME = "results.jsonl"
export const TRIAL_RECORD_VERSION = 1

/** Whether Notion's own AGENTS.md / skills docs were present in the workspace. */
export type DocsCondition = "with" | "without"

/** Normalized token accounting; mirrors the runner's `TokenUsage`. */
export interface TrialTokens {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  /** True when `inputTokens` already contains `cacheReadInputTokens` (Codex). */
  inputTokensIncludeCached: boolean
}

/**
 * One scored rollout: the runner's trial outcome merged with the verifier's
 * verdict.
 */
export interface TrialRecord {
  /** Record schema version; bump on a breaking field change. */
  v: number
  runId: string

  // ---- coordinates --------------------------------------------------------
  taskId: string
  /** Product area (docs/COVERAGE.md). Falls back to the task id when absent. */
  family?: string
  /** build | investigate | resolve | operate. Falls back to the task id prefix. */
  stage?: string
  suite?: string
  configId: string
  configLabel?: string
  harness?: string
  model?: string
  reasoningEffort?: string
  docsCondition: DocsCondition
  /** 1-based trial index within the k independent trials. */
  trial: number

  // ---- verdict ------------------------------------------------------------
  /** Verified outcome in [0,1]. `0` when `scored` is false. */
  score: number
  /**
   * False when the verifier itself did not produce a verdict (crash, timeout,
   * missing EVAL.ts) — the trial is unmeasured, not failed. Reports surface
   * these separately rather than averaging them in as zeros.
   */
  scored: boolean
  subscores?: Record<string, number>
  diagnostics?: string[]
  /** Why the verifier could not be trusted. Set iff `scored` is false. */
  scoreError?: string
  scoreDurationMs?: number

  // ---- rollout ------------------------------------------------------------
  /** Runner trial status: completed | failed | timeout | rate_limited | spawn_error. */
  status: string
  toolCalls?: number
  toolErrors?: number
  tokens?: TrialTokens | null
  apiEquivalentCostUsd?: number
  /** Wall-clock duration of the agent rollout, ms (verification excluded). */
  wallTimeMs: number
  startedAt?: string
  finishedAt?: string
  /** Trial artifacts directory, relative to `results/<runId>/`. */
  trialDir?: string
  /** Set when the rollout itself failed (non-zero exit, timeout, spawn error). */
  error?: string
}

/** Stable identity of the cell a record belongs to. */
export function recordCellKey(r: Pick<TrialRecord, "taskId" | "configId" | "docsCondition" | "trial">): string {
  return `${r.taskId}::${r.configId}::${r.docsCondition}::${r.trial}`
}

export function resultsPath(runDir: string): string {
  return path.join(runDir, RESULTS_FILENAME)
}

/**
 * Append one record.
 *
 * The whole line is handed to a single `O_APPEND` write and flushed with
 * `fsync` before resolving, so a crash between two trials can lose at most the
 * row currently in flight — and the runner only checkpoints a cell as done
 * after this resolves.
 */
export async function appendResult(runDir: string, record: TrialRecord): Promise<void> {
  await mkdir(runDir, { recursive: true })
  const line = `${JSON.stringify(record)}\n`
  const handle = await open(resultsPath(runDir), "a")
  try {
    await handle.writeFile(line, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Append without the fsync round-trip — for tests and bulk imports. */
export async function appendResultFast(runDir: string, record: TrialRecord): Promise<void> {
  await mkdir(runDir, { recursive: true })
  await appendFile(resultsPath(runDir), `${JSON.stringify(record)}\n`, "utf8")
}

export interface ReadResults {
  records: TrialRecord[]
  /** Lines that could not be parsed (with 1-based line numbers). */
  problems: Array<{ line: number; reason: string }>
}

/**
 * Read `results.jsonl`. A malformed line is reported, never fatal: the common
 * case is a torn final line from a `kill -9`, and losing the other 2,099 rows
 * to it would be absurd.
 */
export async function readResults(runDir: string): Promise<ReadResults> {
  let raw: string
  try {
    raw = await readFile(resultsPath(runDir), "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`no ${RESULTS_FILENAME} in ${runDir} — has this run scored anything yet?`)
    }
    throw err
  }
  const records: TrialRecord[] = []
  const problems: ReadResults["problems"] = []
  const lines = raw.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.trim()
    if (text.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      problems.push({ line: i + 1, reason: `invalid JSON (${(err as Error).message})` })
      continue
    }
    const problem = validate(parsed)
    if (problem) problems.push({ line: i + 1, reason: problem })
    else records.push(parsed as TrialRecord)
  }
  return { records, problems }
}

function validate(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "not a JSON object"
  const r = value as Partial<TrialRecord>
  if (typeof r.taskId !== "string" || r.taskId.length === 0) return "missing taskId"
  if (typeof r.configId !== "string" || r.configId.length === 0) return "missing configId"
  if (r.docsCondition !== "with" && r.docsCondition !== "without") return "missing docsCondition"
  if (!Number.isInteger(r.trial)) return "missing trial index"
  if (typeof r.score !== "number" || !Number.isFinite(r.score) || r.score < 0 || r.score > 1) {
    return `score out of range: ${JSON.stringify(r.score)}`
  }
  return undefined
}

/**
 * Last record per cell, in first-seen order.
 *
 * A resumed run re-executes cells it never finished, and an operator may
 * deliberately re-score one. The newest row wins; the superseded ones stay in
 * the file as history.
 */
export function dedupeByCell(records: readonly TrialRecord[]): TrialRecord[] {
  const byCell = new Map<string, TrialRecord>()
  for (const r of records) byCell.set(recordCellKey(r), r)
  return [...byCell.values()]
}
