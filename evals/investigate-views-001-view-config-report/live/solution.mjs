/**
 * Oracle for investigate-views-001. QC only — never visible to an agent, never
 * run during a benchmark trial. See the header of ../EVAL.ts for why the oracle
 * uses `fetch` while the agent under test uses the `ntn` CLI.
 *
 * The one thing that matters: `GET /v1/views` hands back bare ids, so every
 * fact in the report comes from a follow-up `GET /v1/views/{id}`.
 */
import { writeFile } from "node:fs/promises"
import { api, env, findDatabase } from "../../_lib/live/oracle-fetch.mjs"

const { rootId } = env()
const { databaseId } = await findDatabase(rootId, "Product Roadmap")

const stubs = []
let cursor
for (;;) {
  const query = new URLSearchParams({ database_id: databaseId, page_size: "100" })
  if (cursor) query.set("start_cursor", cursor)
  const page = await api("get", `views?${query}`)
  stubs.push(...page.results)
  if (!page.has_more || !page.next_cursor) break
  cursor = page.next_cursor
}

// Views reference properties by opaque id; the report asks for names, so pull
// the schema once and translate. Values already spelled as names pass through.
const database = await api("get", `databases/${databaseId}`)
const dataSource = await api("get", `data_sources/${database.data_sources[0].id}`)
const nameById = Object.fromEntries(
  Object.entries(dataSource.properties ?? {}).map(([name, prop]) => [prop.id, name]),
)
const nameOf = (v) => (typeof v === "string" ? (nameById[v] ?? v) : null)

const views = {}
for (const stub of stubs) {
  const view = await api("get", `views/${stub.id}`)
  const groupBy = view.configuration?.group_by
  views[view.name] = {
    type: view.type,
    group_by: nameOf(groupBy?.property_name) ?? nameOf(groupBy?.property_id),
    filter_property: nameOf(view.filter?.property),
  }
}

await writeFile(
  "answer.json",
  `${JSON.stringify({ view_count: stubs.length, views }, null, 2)}\n`,
  "utf8",
)
