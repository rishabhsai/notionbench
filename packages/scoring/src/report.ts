/**
 * Turning `results.jsonl` into the table the README publishes.
 *
 * The report is a pure function of the records — no run state, no transcripts —
 * so `notionbench score` can be re-run on an archived results file years later
 * and produce the same numbers.
 *
 * Two reporting decisions are deliberate and should not be "simplified":
 *
 *  - **Discovery and reliability are separate columns.** avg@k answers "can this
 *    config ever do it", pass^k answers "can I depend on it". A single headline
 *    number would hide exactly the failure mode the benchmark exists to expose.
 *  - **avg@k is macro-averaged over tasks, then given a Wilson interval on the
 *    underlying solve rate.** Every task weighs the same regardless of how many
 *    trials it happens to have on disk.
 */
import {
  aggregateTrials,
  wilsonInterval,
  type TaskTrials,
  type WilsonInterval,
} from "./stats.js"
import { dedupeByCell, type TrialRecord } from "./results-store.js"

/** docs/COVERAGE.md stages, in reporting order. Task ids are `<stage>-<area>-<nnn>-<slug>`. */
export const STAGES = ["build", "investigate", "resolve", "operate"] as const

/**
 * The stage a task belongs to, read from its id prefix (the naming convention
 * docs/COVERAGE.md fixes), falling back to the recorded frontmatter.
 */
export function stageOf(record: Pick<TrialRecord, "taskId" | "stage">): string {
  const prefix = record.taskId.split("-", 1)[0]
  if ((STAGES as readonly string[]).includes(prefix ?? "")) return prefix!
  return record.stage ?? "other"
}

/** The product area a task belongs to: recorded frontmatter, else the id's second segment. */
export function familyOf(record: Pick<TrialRecord, "taskId" | "family">): string {
  if (record.family) return record.family
  return record.taskId.split("-")[1] ?? "other"
}

/**
 * The unit avg@k and pass^k are computed over.
 *
 * NOT the task: the docs condition is part of a cell's coordinates, so a task
 * run under both conditions is two independent k-trial experiments. Keying on
 * the task alone would silently report avg@2k over a mixture of the two
 * conditions — and then find no cell with 2k trials in the per-docs breakdown.
 */
function cellKeyOf(r: Pick<TrialRecord, "taskId" | "docsCondition">): string {
  return `${r.taskId}@docs-${r.docsCondition}`
}

export interface ReportRow {
  configId: string
  label: string
  /** Breakdown bucket this row belongs to (family / stage / docs condition). */
  group?: string
  /** Distinct tasks contributing to this row. */
  tasks: number
  /** (task, docs condition) cells contributing to this row. */
  cells: number
  /** Trials counted: `cells * k`. */
  trials: number
  k: number
  /** Macro-average over tasks of avg@k. */
  avgScore: number
  /** Wilson CI on the underlying solve rate. */
  ci: WilsonInterval
  /** Macro-average over tasks of pass^k. */
  passHatK: number
  solved: number
  /** Trials whose verifier never returned a verdict (counted as 0, reported apart). */
  unscored: number
  toolCalls: number
  toolErrors: number
  totalTokens: number
  meanTokens: number
  /** Summed API-equivalent cost; only meaningful when `costKnown`. */
  costUsd: number
  /** False when no config in this row published per-token prices. */
  costKnown: boolean
  totalWallMs: number
  meanWallMs: number
  /** Median wall time over counted trials — what one task typically costs. */
  medianWallMs: number
  /** Cells dropped from this row for having fewer than k trials. */
  droppedTasks: string[]
}

export interface Breakdown {
  dimension: "family" | "stage" | "docs"
  /** Bucket names present, in reporting order. */
  groups: string[]
  rows: ReportRow[]
}

export interface Report {
  runId?: string
  generatedAt: string
  /** Trials per task counted everywhere in this report. */
  k: number
  /** Records considered after de-duplicating replayed cells. */
  records: number
  tasks: number
  configs: number
  /** Trials the verifier could not score anywhere in the run. */
  unscored: number
  /** One row per config. */
  overall: ReportRow[]
  byFamily: Breakdown
  byStage: Breakdown
  /** Present only when both docs conditions appear in the data. */
  byDocs?: Breakdown
  /** Non-fatal issues worth printing above the tables. */
  notes: string[]
}

export interface ReportOptions {
  runId?: string
  /** Trials per task to count. Default: the largest k every task supports. */
  k?: number
  /** Score at or above which a trial counts as solved. Default 1. */
  threshold?: number
  /** z for the Wilson interval. Default 1.96 (95%). */
  z?: number
  /** Skip de-duplication of replayed cells (keeps every appended row). */
  keepReplays?: boolean
  generatedAt?: Date
}

/** Build the whole report from raw `results.jsonl` records. */
export function buildReport(records: readonly TrialRecord[], opts: ReportOptions = {}): Report {
  const rows = opts.keepReplays ? [...records] : dedupeByCell(records)
  const notes: string[] = []

  const perCell = new Map<string, number>()
  for (const r of rows) {
    const key = `${r.configId}|${cellKeyOf(r)}`
    perCell.set(key, (perCell.get(key) ?? 0) + 1)
  }
  const k = opts.k ?? (perCell.size === 0 ? 1 : Math.min(...perCell.values()))
  const threshold = opts.threshold ?? 1
  const z = opts.z ?? 1.96

  const unscored = rows.filter((r) => r.scored === false).length
  if (unscored > 0) {
    notes.push(
      `${unscored} trial(s) could not be verified (crashed or timed out verifier). ` +
        `They are counted as 0 in avg@k and pass^k and listed in the "unverified" column.`,
    )
  }

  const configIds = [...new Set(rows.map((r) => r.configId))].sort()
  const overall = configIds
    .map((configId) => summarizeRow(rows.filter((r) => r.configId === configId), { k, threshold, z }))
    .filter((row): row is ReportRow => row !== undefined)

  const byFamily = breakdown(rows, "family", familyOf, { k, threshold, z })
  const byStage = breakdown(rows, "stage", stageOf, { k, threshold, z }, [...STAGES])
  const docsConditions = [...new Set(rows.map((r) => r.docsCondition))]
  const byDocs =
    docsConditions.length > 1
      ? breakdown(rows, "docs", (r) => r.docsCondition, { k, threshold, z }, ["with", "without"])
      : undefined

  return {
    runId: opts.runId ?? rows[0]?.runId,
    generatedAt: (opts.generatedAt ?? new Date()).toISOString(),
    k,
    records: rows.length,
    tasks: new Set(rows.map((r) => r.taskId)).size,
    configs: configIds.length,
    unscored,
    overall,
    byFamily,
    byStage,
    byDocs,
    notes,
  }
}

interface RowOptions {
  k: number
  threshold: number
  z: number
}

function breakdown(
  rows: readonly TrialRecord[],
  dimension: Breakdown["dimension"],
  keyOf: (r: TrialRecord) => string,
  opts: RowOptions,
  order?: string[],
): Breakdown {
  const present = [...new Set(rows.map(keyOf))]
  const groups = order
    ? [...order.filter((g) => present.includes(g)), ...present.filter((g) => !order.includes(g)).sort()]
    : present.sort()
  const configIds = [...new Set(rows.map((r) => r.configId))].sort()

  const out: ReportRow[] = []
  for (const group of groups) {
    for (const configId of configIds) {
      const subset = rows.filter((r) => r.configId === configId && keyOf(r) === group)
      const row = summarizeRow(subset, opts)
      if (row) out.push({ ...row, group })
    }
  }
  return { dimension, groups, rows: out }
}

/**
 * Collapse one config's (or one config × bucket's) records into a table row.
 *
 * Cells with fewer than k trials are dropped rather than averaged over a
 * shorter k — mixing k across a row would make pass^k incomparable between
 * cells of the same table.
 */
function summarizeRow(rows: readonly TrialRecord[], opts: RowOptions): ReportRow | undefined {
  if (rows.length === 0) return undefined
  const configId = rows[0]!.configId
  const label = rows.find((r) => r.configLabel)?.configLabel ?? configId

  const byCell = new Map<string, TrialRecord[]>()
  for (const r of rows) {
    const key = cellKeyOf(r)
    const list = byCell.get(key) ?? []
    list.push(r)
    byCell.set(key, list)
  }

  const entries: TaskTrials[] = []
  const droppedTasks: string[] = []
  const counted: TrialRecord[] = []
  for (const [cellKey, trials] of [...byCell.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (trials.length < opts.k) {
      droppedTasks.push(cellKey)
      continue
    }
    const ordered = [...trials].sort((a, b) => a.trial - b.trial).slice(0, opts.k)
    counted.push(...ordered)
    entries.push({
      taskId: cellKey,
      family: familyOf(trials[0]!),
      scores: ordered.map((t) => (t.scored === false ? 0 : t.score)),
    })
  }

  if (entries.length === 0) {
    return {
      configId,
      label,
      tasks: 0,
      cells: 0,
      trials: 0,
      k: opts.k,
      avgScore: 0,
      ci: wilsonInterval(0, 0, opts.z),
      passHatK: 0,
      solved: 0,
      unscored: rows.filter((r) => r.scored === false).length,
      toolCalls: 0,
      toolErrors: 0,
      totalTokens: 0,
      meanTokens: 0,
      costUsd: 0,
      costKnown: false,
      totalWallMs: 0,
      meanWallMs: 0,
      medianWallMs: 0,
      droppedTasks,
    }
  }

  const stats = aggregateTrials(entries, { k: opts.k, threshold: opts.threshold, z: opts.z })
  const sum = (pick: (r: TrialRecord) => number): number => counted.reduce((a, r) => a + pick(r), 0)
  const costKnown = counted.some((r) => typeof r.apiEquivalentCostUsd === "number")
  const totalTokens = sum((r) => r.tokens?.totalTokens ?? 0)
  const totalWallMs = sum((r) => r.wallTimeMs ?? 0)

  return {
    configId,
    label,
    tasks: new Set(counted.map((r) => r.taskId)).size,
    cells: stats.overall.tasks,
    trials: stats.overall.trials,
    k: opts.k,
    avgScore: stats.overall.avgScore,
    ci: stats.overall.ci,
    passHatK: stats.overall.passHatK,
    solved: stats.overall.solved,
    unscored: counted.filter((r) => r.scored === false).length,
    toolCalls: sum((r) => r.toolCalls ?? 0),
    toolErrors: sum((r) => r.toolErrors ?? 0),
    totalTokens,
    meanTokens: totalTokens / counted.length,
    costUsd: sum((r) => r.apiEquivalentCostUsd ?? 0),
    costKnown,
    totalWallMs,
    meanWallMs: totalWallMs / counted.length,
    medianWallMs: median(counted.map((r) => r.wallTimeMs ?? 0)),
    droppedTasks,
  }
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/** The full summary document written to `results/<run>/summary.md` and stdout. */
export function renderReport(report: Report): string {
  const out: string[] = []
  out.push(`# NotionBench results${report.runId ? ` — run \`${report.runId}\`` : ""}`)
  out.push("")
  out.push(
    `${report.tasks} task(s) × ${report.configs} config(s) · k=${report.k} trial(s) per ` +
      `(task, docs condition) cell · ${report.records} scored trial(s) · generated ${report.generatedAt}`,
  )
  out.push("")
  out.push(
    "Solve rate (avg@k) is macro-averaged over cells (each weighs the same); the interval " +
      "is a 95% Wilson score interval on it. Reliable (pass^k) is the probability that " +
      "k trials drawn from the observed ones all succeeded — discovery and reliability are " +
      "different questions and are reported separately.",
  )
  out.push("")
  out.push(
    "Tokens and time are each reported under both aggregations because they answer " +
      "different questions: tokens/trial (the mean over counted trials) and median time " +
      "(the per-trial median) say what one task costs with this agent; total tokens and " +
      "total time (sums over the counted trials) say what running the whole suite costs.",
  )
  out.push("")
  for (const note of report.notes) out.push(`> ${note}`)
  if (report.notes.length > 0) out.push("")

  out.push(mainTable(report))

  out.push("")
  out.push(`## By product area`)
  out.push("")
  out.push(breakdownTable(report.byFamily, "Family"))

  out.push("")
  out.push(`## By stage`)
  out.push("")
  out.push(breakdownTable(report.byStage, "Stage"))

  if (report.byDocs) {
    out.push("")
    out.push(`## By docs condition`)
    out.push("")
    out.push(
      "`with` = Notion's own AGENTS.md and skills present in the workspace; `without` = stripped.",
    )
    out.push("")
    out.push(breakdownTable(report.byDocs, "Docs"))
  }

  const dropped = new Set<string>()
  for (const row of report.overall) for (const t of row.droppedTasks) dropped.add(t)
  if (dropped.size > 0) {
    out.push("")
    out.push(
      `> Cells excluded for having fewer than k=${report.k} trials: ${[...dropped].sort().join(", ")}`,
    )
  }

  out.push("")
  return out.join("\n")
}

/** Just the config table — the block that goes into the README. */
export function mainTable(report: Report): string {
  const k = report.k
  const header = [
    "Config",
    // Plain English over notation: the two columns answer different questions and
    // readers were decoding `avg@k` vs `pass^k` instead of reading the gap.
    `Solve rate (95% CI)`,
    `Reliable (${k}/${k})`,
    "Tool calls/trial",
    // A raw error count is a rate with the denominator missing: 2.4 errors on 14
    // calls and 0.1 on 20 are opposite findings that look similar in a count.
    "Tool error rate",
    "Tokens/trial",
    "Total tokens",
    "API-equiv cost",
    "Median time",
    "Total time",
  ]
  const align = [
    "---", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:",
  ]
  // A total is only comparable across configs that completed the same number of
  // cells; on a partial run the short rows' totals get an asterisk and a footnote.
  const maxCells = report.overall.reduce((a, r) => Math.max(a, r.cells), 0)
  let starred = false
  const body = report.overall.map((r) => {
    const short = r.cells < maxCells
    if (short) starred = true
    const star = short ? "\\*" : ""
    return [
      r.label,
      `${pct(r.avgScore)} [${pct(r.ci.low)}–${pct(r.ci.high)}]`,
      r.tasks === 0 ? "—" : pct(r.passHatK),
      r.trials === 0 ? "–" : (r.toolCalls / r.trials).toFixed(1),
      r.toolCalls === 0
        ? "–"
        : `${pct(r.toolErrors / r.toolCalls)}${r.unscored > 0 ? ` (${r.unscored} unverified)` : ""}`,
      compactNumber(r.meanTokens),
      compactNumber(r.totalTokens) + star,
      r.costKnown ? usd(r.costUsd) : "–",
      duration(r.medianWallMs),
      duration(r.totalWallMs) + star,
    ]
  })
  const md = table(header, align, body)
  if (!starred) return md
  return (
    md +
    "\n\n" +
    "\\* This config completed fewer cells than the fullest config in this table, so its " +
    "totals cover less work and are not comparable across rows. Per-trial columns are."
  )
}

function breakdownTable(breakdownData: Breakdown, groupHeader: string): string {
  const header = [groupHeader, "Config", "Tasks", `avg@k (95% CI)`, "pass^k", "Tool errors"]
  const align = ["---", "---", "---:", "---:", "---:", "---:"]
  let previous: string | undefined
  const body = breakdownData.rows.map((r) => {
    const group = r.group === previous ? "" : (r.group ?? "")
    previous = r.group
    return [
      group,
      r.label,
      String(r.tasks),
      `${pct(r.avgScore)} [${pct(r.ci.low)}–${pct(r.ci.high)}]`,
      r.tasks === 0 ? "—" : pct(r.passHatK),
      String(r.toolErrors),
    ]
  })
  if (body.length === 0) return "_no data_"
  return table(header, align, body)
}

function table(header: string[], align: string[], body: string[][]): string {
  const lines = [`| ${header.join(" | ")} |`, `|${align.map((a) => a).join("|")}|`]
  for (const row of body) lines.push(`| ${row.join(" | ")} |`)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

export function usd(x: number): string {
  if (x === 0) return "$0.00"
  if (x < 0.01) return `$${x.toFixed(4)}`
  return `$${x.toFixed(2)}`
}

export function compactNumber(x: number): string {
  if (!Number.isFinite(x) || x === 0) return "0"
  if (x >= 1_000_000) return `${(x / 1_000_000).toFixed(1)}M`
  if (x >= 1_000) return `${(x / 1_000).toFixed(1)}k`
  return x.toFixed(0)
}

export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  const totalSeconds = Math.round(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`
  return `${s}s`
}
