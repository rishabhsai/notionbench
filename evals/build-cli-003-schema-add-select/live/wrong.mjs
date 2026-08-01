/**
 * Plausibly-wrong solution for build-cli-003: the right property, the right four
 * options in the right order, the right three assignments — but the option
 * colours are never sent, so Notion picks its own. The prompt asks for specific
 * colours; this is the "close enough, ship it" failure. Must score 0.
 */
import { api, env, findDatabase, props, queryAll } from "../../_lib/live/oracle-fetch.mjs"

const { rootId } = env()
const { dataSourceId } = await findDatabase(rootId, "Content Calendar")

await api("patch", `data_sources/${dataSourceId}`, {
  properties: {
    Channel: {
      select: {
        options: [{ name: "Blog" }, { name: "Newsletter" }, { name: "Social" }, { name: "Docs" }],
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
