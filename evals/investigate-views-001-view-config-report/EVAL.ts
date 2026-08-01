/**
 * investigate-views-001-view-config-report — the list-endpoint-returns-stubs trap.
 *
 * `GET /v1/views?database_id=…` answers with `{object: "view", id}` and nothing
 * else. No name, no type, no configuration. Everything this task asks for lives
 * behind a second call per view, `GET /v1/views/{id}`, and an agent that reads
 * the first response as "here are the views" has an array of bare ids and no
 * obvious next move — the common recovery is to report the one view it can
 * name, the default that shares the database's title.
 *
 * Grading is exact match against ground truth the verifier computes itself, by
 * listing and then retrieving every view. Nothing is hard-coded, so editing
 * `fixture/spec.json` cannot silently invalidate the expected answer.
 *
 * ── Why the QC path and the run path differ ────────────────────────────────
 * At RUN time the agent works in the trial workspace with the real `ntn` CLI,
 * authenticated by a leased token against api.notion.com. It never sees this
 * file, `fixture/spec.json`, or anything under `live/`.
 *
 * At QC time there is no Notion workspace. `evals/_lib/live/qc-live.ts` boots
 * the in-memory `fake-notion.ts` — whose `GET /v1/views` returns stubs, exactly
 * as the reference specifies — provisions `fixture/spec.json` against it, and
 * points `NOTION_API_BASE` at it. `ntn` cannot be redirected that way, so the
 * oracle and the plausibly-wrong solution under `live/` are plain Node scripts
 * issuing `fetch` calls. They stand in for the *agent*, not for the CLI: what
 * CI proves is that this verifier returns 1 for a complete inventory and 0 for
 * one that stopped at the default view.
 *
 * The verifier is the same code on both paths — it honors `NOTION_API_BASE` and
 * reads the workspace through the public API either way.
 */
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { findDatabase, resolveLiveContext } from "../_lib/live/context.ts"
import type { NotionView } from "../_lib/live/notion.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const DATABASE_TITLE = "Product Roadmap"
const ANSWER_FILE = "answer.json"

interface ViewFacts {
  type: string
  group_by: string | null
  filter_property: string | null
}

/**
 * The three facts the task asks for, pulled out of one view object.
 *
 * Properties come back spelled two different ways depending on the endpoint and
 * how the view was authored: real Notion answers with opaque property *ids*
 * (`"Kg@B"`), while a view created by name may echo the *name* back. The task
 * prompt asks for names — its own example answer shows `"filter_property":
 * "Quarter"` — so both spellings are normalized to the name here via the
 * schema's id→name map. Anything not found in the map passes through unchanged.
 */
function factsOf(view: NotionView, propertyNames: Record<string, string>): ViewFacts {
  const nameOf = (v: unknown): string | null =>
    typeof v === "string" ? (propertyNames[v] ?? v) : null

  const configuration = (view.configuration ?? {}) as {
    group_by?: { property_name?: unknown; property_id?: unknown }
  }
  const groupBy = configuration.group_by
  const filter = (view.filter ?? null) as { property?: unknown } | null
  return {
    type: String(view.type),
    group_by: nameOf(groupBy?.property_name) ?? nameOf(groupBy?.property_id),
    filter_property: nameOf(filter?.property),
  }
}

function describe(facts: ViewFacts): string {
  return `${facts.type} group_by=${facts.group_by ?? "-"} filter=${facts.filter_property ?? "-"}`
}

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = { file: 0, view_count: 0, names: 0, configs: 0 }

  const live = await resolveLiveContext({ workspaceDir, ctx })
  const { client, rootId } = live
  diagnostics.push(`api=${live.apiBase} root=${rootId} (${live.source.root})`)

  const databaseId =
    live.idMap.roadmap ?? (await findDatabase(client, rootId, DATABASE_TITLE))?.databaseId
  if (!databaseId) {
    diagnostics.push(`the fixture's "${DATABASE_TITLE}" database could not be located — fixture is damaged`)
    return { score: 0, subscores, diagnostics }
  }

  // ---- ground truth: list the stubs, then retrieve every one of them -------
  const views = await client.listAllViewsFor({ database_id: databaseId })

  // Views reference properties by id; the answer is asked for by name. Build the
  // id→name map once from the database's schema so both spellings compare equal.
  let propertyNames: Record<string, string> = {}
  try {
    const dsId = (await client.getDatabase(databaseId)).data_sources?.[0]?.id
    if (dsId) {
      const ds = await client.getDataSource(dsId)
      // The schema reports property ids percent-encoded ("C~m%7C") while views
      // reference them raw ("C~m|"), so index both spellings. Ids without a
      // character needing escaping are identical either way — which is why this
      // divergence only bites some properties, and looked intermittent.
      propertyNames = Object.fromEntries(
        Object.entries(ds.properties ?? {}).flatMap(([name, prop]) => {
          const id = (prop as { id?: unknown })?.id
          if (typeof id !== "string") return []
          let decoded = id
          try {
            decoded = decodeURIComponent(id)
          } catch {
            // A literal "%" that is not an escape — keep the id as-is.
          }
          return decoded === id
            ? [[id, name] as const]
            : [
                [id, name] as const,
                [decoded, name] as const,
              ]
        }),
      )
    }
  } catch (err) {
    diagnostics.push(`could not read the schema to resolve property ids: ${(err as Error).message}`)
  }

  const expected: Record<string, ViewFacts> = {}
  for (const view of views) expected[String(view.name)] = factsOf(view, propertyNames)
  const expectedNames = Object.keys(expected)
  diagnostics.push(
    `ground truth: ${views.length} view(s) — ` +
      expectedNames.map((n) => `"${n}" (${describe(expected[n])})`).join(", "),
  )
  if (views.length < 2) {
    diagnostics.push(
      `fixture exposes only ${views.length} view(s); with nothing beyond the default the task has no trap`,
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

  if (answer.view_count === views.length) {
    subscores.view_count = 1
  } else {
    diagnostics.push(`view_count is ${JSON.stringify(answer.view_count)}, expected ${views.length}`)
  }

  const got = answer.views
  if (got === null || typeof got !== "object" || Array.isArray(got)) {
    diagnostics.push(`views is ${JSON.stringify(got)}, expected an object keyed by view name`)
    return { score: 0, subscores, diagnostics }
  }
  const reported = got as Record<string, unknown>
  const reportedNames = Object.keys(reported)

  const missing = expectedNames.filter((n) => !(n in reported))
  const extra = reportedNames.filter((n) => !(n in expected))
  if (missing.length === 0 && extra.length === 0) {
    subscores.names = 1
  } else {
    if (missing.length > 0) diagnostics.push(`views missing from the answer: ${missing.join(", ")}`)
    if (extra.length > 0) diagnostics.push(`views in the answer that do not exist: ${extra.join(", ")}`)
  }

  const problems: string[] = []
  for (const name of expectedNames) {
    if (!(name in reported)) continue
    const entry = reported[name]
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`"${name}": ${JSON.stringify(entry)} is not an object`)
      continue
    }
    const e = entry as Record<string, unknown>
    const want = expected[name]
    for (const key of ["type", "group_by", "filter_property"] as const) {
      const raw = e[key] === undefined ? null : e[key]
      // Accept either spelling from the agent: a property name, or the opaque id
      // the API reports it under. Neither is more correct than the other.
      const value =
        key === "type" || typeof raw !== "string" ? raw : (propertyNames[raw] ?? raw)
      if (value !== want[key]) {
        problems.push(`"${name}".${key} is ${JSON.stringify(value)}, expected ${JSON.stringify(want[key])}`)
      }
    }
  }
  if (problems.length === 0 && missing.length === 0) subscores.configs = 1
  else for (const problem of problems) diagnostics.push(problem)

  const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
  if (score === 1) {
    diagnostics.push(`all ${views.length} views reported, with their grouping and filtering`)
  } else if (reportedNames.length === 1 && missing.length === views.length - 1) {
    // The failure this task exists to catch. Name it explicitly.
    diagnostics.push(
      `STOPPED AT THE STUBS: one view reported out of ${views.length}. ` +
        `GET /v1/views returns {object, id} only — every name, type and configuration in this ` +
        `answer had to come from a per-view GET /v1/views/{id}, and ${views.length - 1} of those were never made.`,
    )
  }
  return { score: score as 0 | 1, subscores, diagnostics }
}
