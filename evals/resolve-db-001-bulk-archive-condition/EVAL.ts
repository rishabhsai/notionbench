/**
 * resolve-db-001-bulk-archive-condition — a destructive bulk operation, graded
 * on its blast radius as much as on its effect.
 *
 * Any bulk archive has two halves and only one of them is obvious. "Did the
 * duplicates go?" is easy; "did anything else go with them?" is the half that
 * costs someone their week. So the verifier asserts both sides exactly:
 *
 *   1. every row the fixture seeded as `Duplicate` is in the trash — checked by
 *      id, so relabelling a row instead of archiving it does not pass;
 *   2. the surviving set is *exactly* the other rows, with every property still
 *      carrying the value the fixture gave it.
 *
 * The "before" state comes from `fixture/spec.json` through the same
 * deterministic generator provisioning used, so nothing here is hard-coded and
 * re-seeding the fixture cannot invalidate the expectation. It has to come from
 * the spec rather than the workspace: by the time the verifier runs, the rows it
 * needs to reason about are in the trash and gone from every query result.
 *
 * ── Why the QC path and the run path differ ────────────────────────────────
 * At RUN time the agent works in the trial workspace with the real `ntn` CLI,
 * authenticated by a leased token against api.notion.com. It never sees this
 * file, `fixture/spec.json`, or anything under `live/`.
 *
 * At QC time there is no Notion workspace. `evals/_lib/live/qc-live.ts` boots
 * the in-memory `fake-notion.ts` — whose trashing cascades and drops rows from
 * query results exactly as the real API does — provisions `fixture/spec.json`
 * against it, and points `NOTION_API_BASE` at it. `ntn` cannot be redirected
 * that way, so the oracle and the plausibly-wrong solution under `live/` are
 * plain Node scripts issuing `fetch` calls. They stand in for the *agent*, not
 * for the CLI: what CI proves is that this verifier returns 1 for a precise
 * archive and 0 for one that took extra rows with it.
 *
 * The verifier is the same code on both paths — it honors `NOTION_API_BASE` and
 * reads the workspace through the public API either way.
 */
import * as path from "node:path"
import { isTrashed, readProperties, type PropValue } from "../_lib/live/notion.ts"
import { findDatabase, resolveLiveContext } from "../_lib/live/context.ts"
import { loadSpec, materializeRows } from "../_lib/live/spec.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const DATABASE_TITLE = "Inbox Requests"
const DATABASE_KEY = "requests"
const ARCHIVE_STATUS = "Duplicate"

/** Keep a mismatch report readable when a bulk operation went badly wrong. */
const MAX_REPORTED = 10

interface Seeded {
  /** Spec key, e.g. `req7` — how the row is looked up in the fixture id map. */
  key?: string
  name: string
  properties: Record<string, PropValue>
}

const sameValue = (a: PropValue, b: PropValue): boolean => JSON.stringify(a) === JSON.stringify(b)

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = { duplicates_archived: 0, survivors_intact: 0 }

  const live = await resolveLiveContext({ workspaceDir, ctx })
  const { client, rootId } = live
  diagnostics.push(`api=${live.apiBase} root=${rootId} (${live.source.root})`)

  const dataSourceId =
    live.idMap[`${DATABASE_KEY}.ds`] ?? (await findDatabase(client, rootId, DATABASE_TITLE))?.dataSourceId
  if (!dataSourceId) {
    diagnostics.push(`the fixture's "${DATABASE_TITLE}" database could not be located — fixture is damaged`)
    return { score: 0, subscores, diagnostics }
  }

  // ---- the "before" state, straight from the spec --------------------------
  const taskDir = typeof ctx?.taskDir === "string" ? ctx.taskDir : import.meta.dirname
  const spec = await loadSpec(path.join(taskDir, "fixture", "spec.json"))
  const dbSpec = (spec.databases ?? []).find((d) => d.key === DATABASE_KEY)
  if (!dbSpec) {
    diagnostics.push(`fixture spec has no database keyed "${DATABASE_KEY}" — fixture is damaged`)
    return { score: 0, subscores, diagnostics }
  }
  const seeded: Seeded[] = materializeRows(dbSpec, spec.seed ?? 1).map((row) => ({
    key: row.key,
    name: String(row.properties.Name),
    properties: row.properties,
  }))
  const toArchive = seeded.filter((r) => r.properties.Status === ARCHIVE_STATUS)
  const toKeep = seeded.filter((r) => r.properties.Status !== ARCHIVE_STATUS)
  diagnostics.push(
    `fixture seeded ${seeded.length} requests: ${toArchive.length} ${ARCHIVE_STATUS}, ${toKeep.length} to survive`,
  )
  if (toArchive.length === 0 || toKeep.length === 0) {
    diagnostics.push("fixture is degenerate — nothing to archive or nothing to preserve")
    return { score: 0, subscores, diagnostics }
  }

  // ---- 1. the duplicates are in the trash ----------------------------------
  const archiveProblems: string[] = []
  let checkedById = 0
  for (const row of toArchive) {
    const id = row.key ? live.idMap[row.key] : undefined
    if (!id) continue
    checkedById++
    try {
      const page = await client.getPage(id)
      if (!isTrashed(page)) {
        archiveProblems.push(`"${row.name}" is still live (Status=${JSON.stringify(readProperties(page).Status)})`)
      }
    } catch (err) {
      // A hard delete is not what was asked for, but it is not a *false*
      // archive either — say precisely what happened.
      archiveProblems.push(`"${row.name}" could not be read back: ${(err as Error).message}`)
    }
  }
  if (checkedById === 0) {
    diagnostics.push(
      "fixture id map carries no row ids — falling back to absence from the data source as the archive signal",
    )
  }

  // ---- 2. the survivors, exactly ------------------------------------------
  const rows = await client.queryAllRows(dataSourceId)
  const remaining = new Map(rows.map((row) => [String(readProperties(row).Name ?? ""), readProperties(row)]))
  diagnostics.push(`${remaining.size} of ${seeded.length} requests are still in the database`)

  const survivorProblems: string[] = []
  const wronglyArchived: string[] = []
  for (const row of toKeep) {
    const actual = remaining.get(row.name)
    if (!actual) {
      wronglyArchived.push(`${row.name} (${String(row.properties.Status)})`)
      continue
    }
    for (const [name, want] of Object.entries(row.properties)) {
      if (!sameValue(actual[name] ?? null, want)) {
        survivorProblems.push(
          `"${row.name}".${name} is ${JSON.stringify(actual[name])}, expected ${JSON.stringify(want)}`,
        )
      }
    }
  }
  const stillPresent = toArchive.filter((row) => remaining.has(row.name)).map((row) => row.name)
  const unexpected = [...remaining.keys()].filter((name) => !seeded.some((row) => row.name === name))

  // ---- report --------------------------------------------------------------
  if (stillPresent.length > 0) {
    archiveProblems.push(
      `${stillPresent.length} ${ARCHIVE_STATUS} request(s) are still in the database: ${stillPresent.slice(0, MAX_REPORTED).join(", ")}`,
    )
  }
  if (archiveProblems.length === 0) {
    subscores.duplicates_archived = 1
    diagnostics.push(`all ${toArchive.length} ${ARCHIVE_STATUS} requests are in the trash`)
  } else {
    for (const problem of archiveProblems.slice(0, MAX_REPORTED)) diagnostics.push(problem)
    if (archiveProblems.length > MAX_REPORTED) {
      diagnostics.push(`… and ${archiveProblems.length - MAX_REPORTED} more`)
    }
  }

  if (wronglyArchived.length > 0) {
    // The failure this task exists to catch: the filter was too wide.
    diagnostics.push(
      `OVER-ARCHIVED — ${wronglyArchived.length} request(s) that were not ${ARCHIVE_STATUS} are gone: ` +
        wronglyArchived.slice(0, MAX_REPORTED).join(", ") +
        (wronglyArchived.length > MAX_REPORTED ? ` … and ${wronglyArchived.length - MAX_REPORTED} more` : ""),
    )
  }
  for (const problem of survivorProblems.slice(0, MAX_REPORTED)) diagnostics.push(problem)
  if (survivorProblems.length > MAX_REPORTED) {
    diagnostics.push(`… and ${survivorProblems.length - MAX_REPORTED} more edited survivor(s)`)
  }
  if (unexpected.length > 0) diagnostics.push(`rows that were not in the fixture: ${unexpected.join(", ")}`)

  if (
    wronglyArchived.length === 0 &&
    survivorProblems.length === 0 &&
    unexpected.length === 0 &&
    remaining.size === toKeep.length
  ) {
    subscores.survivors_intact = 1
    diagnostics.push(`the ${toKeep.length} surviving requests are all present and unedited`)
  }

  const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
  return { score: score as 0 | 1, subscores, diagnostics }
}
