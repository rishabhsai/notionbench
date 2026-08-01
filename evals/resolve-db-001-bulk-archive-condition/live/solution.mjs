/**
 * Oracle for resolve-db-001. QC only — never visible to an agent, never run
 * during a benchmark trial. See the header of ../EVAL.ts for why the oracle
 * uses `fetch` while the agent under test uses the `ntn` CLI.
 *
 * The filter is pushed to the API so the set being trashed is exactly the set
 * the prompt named, and each row is trashed with `in_trash: true` rather than
 * relabelled.
 */
import { api, env, findDatabase, queryAll } from "../../_lib/live/oracle-fetch.mjs"

const { rootId } = env()
const { dataSourceId } = await findDatabase(rootId, "Inbox Requests")

const duplicates = await queryAll(dataSourceId, {
  filter: { property: "Status", select: { equals: "Duplicate" } },
})

for (const row of duplicates) {
  await api("patch", `pages/${row.id}`, { in_trash: true })
}
