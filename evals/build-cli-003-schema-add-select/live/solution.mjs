/**
 * Oracle for build-cli-003. QC only — never visible to an agent, never run
 * during a benchmark trial. See the header of ../EVAL.ts for why the oracle
 * uses `fetch` while the agent under test uses the `ntn` CLI.
 *
 * Note where the schema edit goes: `PATCH /v1/data_sources/{id}`. A database has
 * no `properties` post-2025-09-03, so patching the database id would fail.
 */
import { api, env, findDatabase, props, queryAll } from "../../_lib/live/oracle-fetch.mjs"

const { rootId } = env()
const { dataSourceId } = await findDatabase(rootId, "Content Calendar")

await api("patch", `data_sources/${dataSourceId}`, {
  properties: {
    Channel: {
      select: {
        options: [
          { name: "Blog", color: "blue" },
          { name: "Newsletter", color: "yellow" },
          { name: "Social", color: "pink" },
          { name: "Docs", color: "gray" },
        ],
      },
    },
  },
})

const assignments = { "Post 01": "Blog", "Post 05": "Social", "Post 12": "Docs" }
const rows = await queryAll(dataSourceId)

for (const row of rows) {
  const name = props(row).Name
  const channel = assignments[name]
  if (!channel) continue
  await api("patch", `pages/${row.id}`, { properties: { Channel: { select: { name: channel } } } })
}
