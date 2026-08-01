/**
 * Plausibly-wrong solution for build-cli-002: the right five fields on the right
 * rows, but the `sorts` clause is never sent, so the export comes back in the
 * data source's own order. The set is correct and the sequence is not — the
 * failure mode an order-sensitive artifact check exists to catch. Must score 0.
 */
import { writeFile } from "node:fs/promises"
import { env, findDatabase, props, queryAll } from "../../_lib/live/oracle-fetch.mjs"

const { rootId } = env()
const { dataSourceId } = await findDatabase(rootId, "Support Tickets")

const rows = await queryAll(dataSourceId, {
  filter: {
    and: [
      { property: "Status", select: { equals: "Open" } },
      { property: "Points", number: { greater_than_or_equal_to: 5 } },
    ],
  },
})

const exported = rows.map((row) => {
  const p = props(row)
  return { name: p.Name, priority: p.Priority, points: p.Points }
})

await writeFile("export.json", `${JSON.stringify(exported, null, 2)}\n`, "utf8")
