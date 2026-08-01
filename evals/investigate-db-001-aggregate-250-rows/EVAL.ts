/**
 * investigate-db-001-aggregate-250-rows — the silent-truncation trap.
 *
 * `POST /v1/data_sources/{id}/query` returns at most 100 rows and announces the
 * rest only through `has_more` / `next_cursor`. An agent that issues one query
 * and totals what comes back gets a plausible-looking, confidently-wrong answer
 * — no error, no warning. The fixture seeds 250 rows precisely so that failure
 * is forced into the open, which is why this task lives in the `regression`
 * suite rather than the frozen benchmark set.
 *
 * Grading is exact match against ground truth the verifier computes itself, by
 * paginating the same data source to exhaustion. Nothing is hard-coded, so
 * re-seeding the fixture cannot silently invalidate the expected answer.
 *
 * When the submitted answer equals the first-page-only aggregate, the verifier
 * says so in as many words: that diagnostic is the whole point of the task and
 * feeds the failure-mode gallery in the write-up.
 *
 * ── Why the QC path and the run path differ ────────────────────────────────
 * At RUN time the agent works in the trial workspace with the real `ntn` CLI,
 * authenticated by a leased token against api.notion.com. It never sees this
 * file, `fixture/spec.json`, or anything under `live/`.
 *
 * At QC time there is no Notion workspace. `evals/_lib/live/qc-live.ts` boots
 * the in-memory `fake-notion.ts` — which enforces the 100-row cap and rejects
 * `page_size > 100` exactly as the real API does — provisions
 * `fixture/spec.json` against it, and points `NOTION_API_BASE` at it. `ntn`
 * cannot be redirected that way, so the oracle and the plausibly-wrong solution
 * under `live/` are plain Node scripts issuing `fetch` calls; `live/wrong.mjs`
 * is the single-query truncation. They stand in for the *agent*, not for the
 * CLI: what CI proves is that this verifier returns 1 for a fully-paginated
 * answer and 0 for a truncated one.
 *
 * The verifier is the same code on both paths — it honors `NOTION_API_BASE` and
 * reads the workspace through the public API either way.
 */
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { MAX_PAGE_SIZE, readProperties } from "../_lib/live/notion.ts"
import { findDatabase, resolveLiveContext } from "../_lib/live/context.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const DATABASE_TITLE = "Q3 Orders"
const ANSWER_FILE = "answer.json"
const REGIONS = ["NA", "EU", "APAC"]

interface Answer {
  row_count: number
  total_amount: number
  paid_amount: number
  region_totals: Record<string, number>
}

function aggregate(rows: Array<Record<string, unknown>>): Answer {
  const answer: Answer = {
    row_count: rows.length,
    total_amount: 0,
    paid_amount: 0,
    region_totals: Object.fromEntries(REGIONS.map((r) => [r, 0])),
  }
  for (const row of rows) {
    const amount = typeof row.Amount === "number" ? row.Amount : 0
    answer.total_amount += amount
    if (row.Status === "Paid") answer.paid_amount += amount
    const region = String(row.Region ?? "")
    if (region in answer.region_totals) answer.region_totals[region] += amount
  }
  return answer
}

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    file: 0,
    row_count: 0,
    total_amount: 0,
    paid_amount: 0,
    region_totals: 0,
  }

  const live = await resolveLiveContext({ workspaceDir, ctx })
  const { client, rootId } = live
  diagnostics.push(`api=${live.apiBase} root=${rootId} (${live.source.root})`)

  const dataSourceId =
    live.idMap["orders.ds"] ?? (await findDatabase(client, rootId, DATABASE_TITLE))?.dataSourceId
  if (!dataSourceId) {
    diagnostics.push(`the fixture's "${DATABASE_TITLE}" database could not be located — fixture is damaged`)
    return { score: 0, subscores, diagnostics }
  }

  // ---- ground truth, paginated to exhaustion -------------------------------
  const rows = (await client.queryAllRows(dataSourceId)).map(readProperties)
  const expected = aggregate(rows as Array<Record<string, unknown>>)
  const truncated = aggregate(rows.slice(0, MAX_PAGE_SIZE) as Array<Record<string, unknown>>)
  diagnostics.push(
    `ground truth over ${expected.row_count} rows: total=${expected.total_amount} paid=${expected.paid_amount} ` +
      `regions=${JSON.stringify(expected.region_totals)}`,
  )
  if (expected.row_count <= MAX_PAGE_SIZE) {
    diagnostics.push(
      `fixture holds only ${expected.row_count} rows — a single query would not truncate, so the trap is disarmed`,
    )
    return { score: 0, subscores, diagnostics }
  }

  // ---- the answer file -----------------------------------------------------
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(path.join(workspaceDir, ANSWER_FILE), "utf8"))
  } catch (err) {
    diagnostics.push(`could not read ${ANSWER_FILE}: ${(err as Error).message}`)
    return { score: 0, subscores, diagnostics }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    diagnostics.push(`${ANSWER_FILE} must be a JSON object, got ${JSON.stringify(parsed)}`)
    return { score: 0, subscores, diagnostics }
  }
  subscores.file = 1
  const answer = parsed as Record<string, unknown>

  const checkNumber = (key: "row_count" | "total_amount" | "paid_amount"): void => {
    const got = answer[key]
    if (got === expected[key]) {
      subscores[key] = 1
      return
    }
    if (typeof got !== "number") {
      diagnostics.push(`${key} is ${JSON.stringify(got)}, expected the number ${expected[key]}`)
      return
    }
    diagnostics.push(`${key} is ${got}, expected ${expected[key]} (off by ${got - expected[key]})`)
  }
  checkNumber("row_count")
  checkNumber("total_amount")
  checkNumber("paid_amount")

  const regions = answer.region_totals
  if (regions === null || typeof regions !== "object" || Array.isArray(regions)) {
    diagnostics.push(`region_totals is ${JSON.stringify(regions)}, expected an object keyed by region`)
  } else {
    const got = regions as Record<string, unknown>
    const problems = REGIONS.flatMap((region) =>
      got[region] === expected.region_totals[region]
        ? []
        : [`${region}: ${JSON.stringify(got[region])} ≠ ${expected.region_totals[region]}`],
    )
    const extras = Object.keys(got).filter((k) => !REGIONS.includes(k))
    if (extras.length > 0) problems.push(`unexpected region key(s): ${extras.join(", ")}`)
    if (problems.length === 0) subscores.region_totals = 1
    else diagnostics.push(`region_totals mismatch — ${problems.join("; ")}`)
  }

  const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
  if (score === 1) {
    diagnostics.push("answer matches the full-table aggregate")
  } else if (
    answer.row_count === truncated.row_count &&
    answer.total_amount === truncated.total_amount
  ) {
    // The failure this task was built to catch. Name it explicitly.
    diagnostics.push(
      `SILENT TRUNCATION: the answer is exactly the first ${MAX_PAGE_SIZE}-row page ` +
        `(${truncated.row_count} rows, total ${truncated.total_amount}). ` +
        `The query returned has_more=true and the remaining ${expected.row_count - truncated.row_count} rows were never fetched.`,
    )
  }
  return { score: score as 0 | 1, subscores, diagnostics }
}
