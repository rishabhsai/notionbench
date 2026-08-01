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

const views = {}
for (const stub of stubs) {
  const view = await api("get", `views/${stub.id}`)
  views[view.name] = {
    type: view.type,
    group_by: view.configuration?.group_by?.property_name ?? null,
    filter_property: view.filter?.property ?? null,
  }
}

await writeFile(
  "answer.json",
  `${JSON.stringify({ view_count: stubs.length, views }, null, 2)}\n`,
  "utf8",
)
