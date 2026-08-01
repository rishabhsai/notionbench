/**
 * Oracle for build-cli-002. QC only — never visible to an agent, never run
 * during a benchmark trial. See the header of ../EVAL.ts for why the oracle
 * uses `fetch` while the agent under test uses the `ntn` CLI.
 *
 * Filtering and sorting are pushed to the API (the natural thing to do from the
 * CLI), then the result is written verbatim.
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
  sorts: [
    { property: "Points", direction: "descending" },
    { property: "Name", direction: "ascending" },
  ],
})

const exported = rows.map((row) => {
  const p = props(row)
  return { name: p.Name, priority: p.Priority, points: p.Points }
})

await writeFile("export.json", `${JSON.stringify(exported, null, 2)}\n`, "utf8")
