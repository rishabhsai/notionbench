/**
 * build-cli-002-filtered-export — exact match of a produced artifact against
 * ground truth read back from the live workspace.
 *
 * The expected array is never hard-coded: the verifier queries the Support
 * Tickets data source itself (all pages, cursors followed), applies the filter
 * and the sort in JS, and compares element by element. That keeps the task
 * honest if the fixture spec is ever re-seeded, and means the comparison tests
 * the agent's export rather than the fixture author's arithmetic.
 *
 * The sort is checked, not just the set: the fixture is seeded so that creation
 * order differs from the requested order and so that ties on `points` exist,
 * which is what makes the secondary sort key observable.
 *
 * ── Why the QC path and the run path differ ────────────────────────────────
 * At RUN time the agent works in the trial workspace with the real `ntn` CLI,
 * authenticated by a leased token against api.notion.com. It never sees this
 * file, `fixture/spec.json`, or anything under `live/`.
 *
 * At QC time there is no Notion workspace. `evals/_lib/live/qc-live.ts` boots
 * the in-memory `fake-notion.ts`, provisions `fixture/spec.json` against it, and
 * points `NOTION_API_BASE` at it. `ntn` cannot be redirected that way — it is a
 * native binary that talks to the real service — so the oracle and the
 * plausibly-wrong solution under `live/` are plain Node scripts issuing `fetch`
 * calls. They stand in for the *agent*, not for the CLI: what CI proves is that
 * this verifier returns 1 for a correct artifact and 0 for a wrong one.
 *
 * The verifier is the same code on both paths — it honors `NOTION_API_BASE` and
 * reads the workspace through the public API either way.
 */
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { readProperties } from "../_lib/live/notion.ts"
import { findDatabase, resolveLiveContext } from "../_lib/live/context.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const DATABASE_TITLE = "Support Tickets"
const EXPORT_FILE = "export.json"
const MIN_POINTS = 5
const OPEN = "Open"

/** Rows that must appear, in the order they must appear in. */
interface Row {
  name: string
  priority: string
  points: number
}

/** Keep a mismatch report readable when the export is wrong in many places. */
const MAX_REPORTED = 8

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = { file: 0, json: 0, shape: 0, contents: 0, order: 0 }

  const live = await resolveLiveContext({ workspaceDir, ctx })
  const { client, rootId } = live
  diagnostics.push(`api=${live.apiBase} root=${rootId} (${live.source.root})`)

  // ---- ground truth --------------------------------------------------------
  const db =
    (live.idMap["tickets.ds"] ? { dataSourceId: live.idMap["tickets.ds"] } : undefined) ??
    (await findDatabase(client, rootId, DATABASE_TITLE))
  if (!db) {
    diagnostics.push(`the fixture's "${DATABASE_TITLE}" database could not be located — fixture is damaged`)
    return { score: 0, subscores, diagnostics }
  }
  const rows = await client.queryAllRows(db.dataSourceId)
  const expected: Row[] = rows
    .map(readProperties)
    .filter((p) => p.Status === OPEN && typeof p.Points === "number" && p.Points >= MIN_POINTS)
    .map((p) => ({ name: String(p.Name), priority: String(p.Priority), points: Number(p.Points) }))
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, "en"))
  diagnostics.push(
    `ground truth: ${expected.length} of ${rows.length} tickets are ${OPEN} with points ≥ ${MIN_POINTS}`,
  )
  if (expected.length < 3) {
    // A degenerate fixture would make the sort untestable; fail loudly rather
    // than hand out a free point.
    diagnostics.push("fixture produced fewer than 3 matching rows — the task is not gradeable")
    return { score: 0, subscores, diagnostics }
  }

  // ---- the artifact --------------------------------------------------------
  const file = path.join(workspaceDir, EXPORT_FILE)
  let raw: string
  try {
    raw = await fs.readFile(file, "utf8")
  } catch {
    diagnostics.push(`no ${EXPORT_FILE} in the workspace`)
    return { score: 0, subscores, diagnostics }
  }
  subscores.file = 1

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    diagnostics.push(`${EXPORT_FILE} is not valid JSON: ${(err as Error).message}`)
    return { score: 0, subscores, diagnostics }
  }
  subscores.json = 1

  if (!Array.isArray(parsed)) {
    diagnostics.push(`${EXPORT_FILE} must be a JSON array, got ${typeof parsed}`)
    return { score: 0, subscores, diagnostics }
  }

  const shapeProblems: string[] = []
  const actual: Row[] = []
  parsed.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      shapeProblems.push(`[${index}] is ${JSON.stringify(entry)}, expected an object`)
      return
    }
    const record = entry as Record<string, unknown>
    const keys = Object.keys(record).sort()
    if (keys.join(",") !== "name,points,priority") {
      shapeProblems.push(`[${index}] has keys [${keys.join(", ")}], expected exactly name, points, priority`)
    }
    if (typeof record.points !== "number") {
      shapeProblems.push(`[${index}].points is ${JSON.stringify(record.points)}, expected a number`)
    }
    actual.push({
      name: String(record.name ?? ""),
      priority: String(record.priority ?? ""),
      points: typeof record.points === "number" ? record.points : Number.NaN,
    })
  })
  if (shapeProblems.length === 0) {
    subscores.shape = 1
  } else {
    for (const problem of shapeProblems.slice(0, MAX_REPORTED)) diagnostics.push(problem)
    if (shapeProblems.length > MAX_REPORTED) {
      diagnostics.push(`… and ${shapeProblems.length - MAX_REPORTED} more shape problem(s)`)
    }
  }

  // ---- contents (as a set) then order --------------------------------------
  const key = (row: Row) => `${row.name}|${row.priority}|${row.points}`
  const expectedKeys = expected.map(key).sort()
  const actualKeys = actual.map(key).sort()
  const missing = expectedKeys.filter((k) => !actualKeys.includes(k))
  const extra = actualKeys.filter((k) => !expectedKeys.includes(k))
  if (missing.length === 0 && extra.length === 0 && actual.length === expected.length) {
    subscores.contents = 1
    diagnostics.push(`the ${expected.length} expected tickets are all present, with no extras`)
  } else {
    if (missing.length > 0) diagnostics.push(`missing: ${missing.slice(0, MAX_REPORTED).join(", ")}`)
    if (extra.length > 0) diagnostics.push(`unexpected: ${extra.slice(0, MAX_REPORTED).join(", ")}`)
    if (actual.length !== expected.length) {
      diagnostics.push(`exported ${actual.length} rows, expected ${expected.length}`)
    }
  }

  const firstBadIndex = expected.findIndex((want, i) => !actual[i] || key(actual[i]) !== key(want))
  if (firstBadIndex === -1 && actual.length === expected.length) {
    subscores.order = 1
    diagnostics.push("order matches: points descending, then name ascending")
  } else if (subscores.contents === 1) {
    // Right rows, wrong sequence — the interesting failure, so name it.
    diagnostics.push(
      `order differs from row ${firstBadIndex}: expected ${key(expected[firstBadIndex])}, ` +
        `got ${actual[firstBadIndex] ? key(actual[firstBadIndex]) : "(nothing)"}`,
    )
    diagnostics.push(`expected sequence: ${expected.map((r) => `${r.name}:${r.points}`).join(" ")}`)
    diagnostics.push(`exported sequence: ${actual.map((r) => `${r.name}:${r.points}`).join(" ")}`)
  }

  const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
  return { score: score as 0 | 1, subscores, diagnostics }
}
