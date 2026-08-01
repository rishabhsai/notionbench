/**
 * resolve-api-001-datasource-id-confusion — did the repaired script write to the
 * right place?
 *
 * The 2025-09-03 API split turned a database into a container: its schema and
 * its rows moved to a *data source*. `POST /v1/data_sources/{id}/query` with a
 * database id is the single most common way that split bites, and it is the bug
 * seeded into `fixture/workspace/backfill.mjs`.
 *
 * The interesting part is not "does it stop erroring" — swapping the id for
 * *some* other id makes the 400 go away. It is "did the rows land in the right
 * database". So the verifier grades both trackers:
 *
 *   - **Release Tracker** must show the backfill: every `Backlog` row moved to
 *     `Ready` with its agreed owner, every other row byte-identical to how the
 *     fixture seeded it;
 *   - **Release Tracker (2025)**, the frozen archive, must be untouched.
 *
 * Ground truth for the "before" state is read out of `fixture/spec.json` rather
 * than hard-coded, so re-seeding the fixture cannot silently invalidate this
 * file. `OWNERS` and the `Backlog → Ready` rule mirror `backfill.mjs`; if they
 * drift, the `solution` variant of `qc:live` scores 0 and the gate goes red.
 *
 * ── Why the QC path and the run path differ ────────────────────────────────
 * At RUN time the agent works in the trial workspace with the real `ntn` CLI and
 * a leased token against api.notion.com. It never sees this file,
 * `fixture/spec.json`, or anything under `live/`.
 *
 * At QC time there is no Notion workspace. `evals/_lib/live/qc-live.ts` boots
 * the in-memory `fake-notion.ts` — which rejects a database id on a data-source
 * endpoint with the same pointed message the real API gives — provisions
 * `fixture/spec.json` against it, and points `NOTION_API_BASE` at it. The oracle
 * and the plausibly-wrong solution under `live/` are plain Node scripts: each
 * one edits `backfill.mjs` the way an agent would and then runs it, so what CI
 * proves is that this verifier returns 1 for a correctly repaired script and 0
 * for one that was merely made to stop erroring.
 *
 * The verifier is the same code on both paths — it honors `NOTION_API_BASE` and
 * reads the workspace through the public API either way.
 */
import * as path from "node:path"
import { readProperties } from "../_lib/live/notion.ts"
import { findDatabase, resolveLiveContext } from "../_lib/live/context.ts"
import { loadSpec, materializeRows } from "../_lib/live/spec.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const LIVE_TRACKER = "Release Tracker"
const ARCHIVE_TRACKER = "Release Tracker (2025)"

/** Mirrors the `OWNERS` table in `fixture/workspace/backfill.mjs`. */
const OWNERS: Record<string, string> = {
  "REL-01": "Ada Lovelace",
  "REL-02": "Grace Hopper",
  "REL-03": "Katherine Johnson",
  "REL-04": "Radia Perlman",
  "REL-05": "Barbara Liskov",
  "REL-06": "Alan Turing",
}

interface RowState {
  Stage: string
  Owner: string
}

const describe = (row: RowState): string => `Stage=${row.Stage} Owner=${JSON.stringify(row.Owner)}`

/** The fixture's rows for one database key, as `{name → {Stage, Owner}}`. */
async function seededRows(taskDir: string, dbKey: string): Promise<Map<string, RowState>> {
  const spec = await loadSpec(path.join(taskDir, "fixture", "spec.json"))
  const db = (spec.databases ?? []).find((d) => d.key === dbKey)
  if (!db) throw new Error(`fixture spec has no database keyed "${dbKey}"`)
  const out = new Map<string, RowState>()
  for (const row of materializeRows(db, spec.seed ?? 1)) {
    out.set(String(row.properties.Name), {
      Stage: String(row.properties.Stage ?? ""),
      Owner: String(row.properties.Owner ?? ""),
    })
  }
  return out
}

/** Apply the backfill the script is supposed to perform. */
function afterBackfill(before: Map<string, RowState>): Map<string, RowState> {
  const out = new Map<string, RowState>()
  for (const [name, row] of before) {
    if (row.Stage !== "Backlog") {
      out.set(name, { ...row })
      continue
    }
    out.set(name, { Stage: "Ready", Owner: OWNERS[name] ?? row.Owner })
  }
  return out
}

/** Read a database's rows back as `{name → {Stage, Owner}}`. */
async function liveRows(
  client: Awaited<ReturnType<typeof resolveLiveContext>>["client"],
  dataSourceId: string,
): Promise<Map<string, RowState>> {
  const rows = await client.queryAllRows(dataSourceId)
  const out = new Map<string, RowState>()
  for (const row of rows) {
    const props = readProperties(row)
    out.set(String(props.Name ?? ""), {
      Stage: String(props.Stage ?? ""),
      Owner: String(props.Owner ?? ""),
    })
  }
  return out
}

function compare(want: Map<string, RowState>, got: Map<string, RowState>): string[] {
  const problems: string[] = []
  for (const [name, expected] of want) {
    const actual = got.get(name)
    if (!actual) {
      problems.push(`row "${name}" is missing`)
      continue
    }
    if (actual.Stage !== expected.Stage || actual.Owner !== expected.Owner) {
      problems.push(`row "${name}": expected ${describe(expected)}, got ${describe(actual)}`)
    }
  }
  for (const name of got.keys()) {
    if (!want.has(name)) problems.push(`unexpected row "${name}"`)
  }
  return problems
}

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = { backfilled: 0, archive_untouched: 0 }

  const live = await resolveLiveContext({ workspaceDir, ctx })
  const { client, rootId } = live
  diagnostics.push(`api=${live.apiBase} root=${rootId} (${live.source.root})`)

  const taskDir = typeof ctx?.taskDir === "string" ? ctx.taskDir : import.meta.dirname

  const trackerDs =
    live.idMap["tracker.ds"] ?? (await findDatabase(client, rootId, LIVE_TRACKER))?.dataSourceId
  const archiveDs =
    live.idMap["archive.ds"] ?? (await findDatabase(client, rootId, ARCHIVE_TRACKER))?.dataSourceId
  if (!trackerDs || !archiveDs) {
    diagnostics.push(
      `could not locate both trackers under the sandbox root (live=${Boolean(trackerDs)}, archive=${Boolean(archiveDs)}) — fixture is damaged`,
    )
    return { score: 0, subscores, diagnostics }
  }

  // ---- the live tracker: backfilled ---------------------------------------
  const trackerBefore = await seededRows(taskDir, "tracker")
  const trackerWant = afterBackfill(trackerBefore)
  const trackerGot = await liveRows(client, trackerDs)
  const backlog = [...trackerBefore.values()].filter((r) => r.Stage === "Backlog").length
  diagnostics.push(`"${LIVE_TRACKER}" started with ${backlog} of ${trackerBefore.size} rows in Backlog`)

  const trackerProblems = compare(trackerWant, trackerGot)
  if (trackerProblems.length === 0) {
    subscores.backfilled = 1
    diagnostics.push(`"${LIVE_TRACKER}" is backfilled: ${backlog} rows moved to Ready and stamped with an owner`)
  } else {
    for (const problem of trackerProblems) diagnostics.push(`${LIVE_TRACKER}: ${problem}`)
    const unchanged = compare(trackerBefore, trackerGot).length === 0
    if (unchanged) {
      diagnostics.push(
        `"${LIVE_TRACKER}" is exactly as the fixture seeded it — the backfill never reached this database`,
      )
    }
  }

  // ---- the archive: untouched ----------------------------------------------
  const archiveWant = await seededRows(taskDir, "archive")
  const archiveGot = await liveRows(client, archiveDs)
  const archiveProblems = compare(archiveWant, archiveGot)
  if (archiveProblems.length === 0) {
    subscores.archive_untouched = 1
    diagnostics.push(`"${ARCHIVE_TRACKER}" is untouched`)
  } else {
    // The failure this task is built around: the 400 went away because the id
    // was swapped for another valid one, and the writes landed in the archive.
    diagnostics.push(`WROTE TO THE ARCHIVE — "${ARCHIVE_TRACKER}" should not have changed at all:`)
    for (const problem of archiveProblems) diagnostics.push(`  ${problem}`)
  }

  const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
  return { score: score as 0 | 1, subscores, diagnostics }
}
