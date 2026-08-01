/**
 * Oracle for investigate-db-002. QC only — never visible to an agent, never run
 * during a benchmark trial. See the header of ../EVAL.ts for why the oracle
 * uses `fetch` while the agent under test uses the `ntn` CLI.
 *
 * The one thing that matters: the complete list of references comes from
 * `GET /v1/pages/{id}/properties/{property_id}`, never from the page object,
 * which stops at 25.
 */
import { writeFile } from "node:fs/promises"
import { api, env, findDatabase, props, queryAll } from "../../_lib/live/oracle-fetch.mjs"

const { rootId } = env()
const programs = await findDatabase(rootId, "Programs")
const initiatives = await findDatabase(rootId, "Initiatives")

const program = (await queryAll(programs.dataSourceId)).find(
  (row) => props(row).Name === "Platform Modernization",
)

const schema = await api("get", `data_sources/${programs.dataSourceId}`)
const propertyId = schema.properties["Linked Initiatives"].id

const item = await api("get", `pages/${program.id}/properties/${encodeURIComponent(propertyId)}`)
const codes = item.multi_select.map((option) => option.name)

const byName = new Map()
for (const row of await queryAll(initiatives.dataSourceId)) {
  const p = props(row)
  byName.set(p.Name, p)
}

const answer = { linked_count: codes.length, at_risk_count: 0, total_effort: 0 }
for (const code of codes) {
  const initiative = byName.get(code)
  if (!initiative) continue
  if (initiative.Status === "At risk") answer.at_risk_count++
  answer.total_effort += initiative["Effort (points)"] ?? 0
}

await writeFile("answer.json", `${JSON.stringify(answer, null, 2)}\n`, "utf8")
