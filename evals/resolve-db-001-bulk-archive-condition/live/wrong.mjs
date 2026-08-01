/**
 * Plausibly-wrong solution for resolve-db-001 — the filter widened by one word.
 *
 * "Clear the noise out of the inbox" reads like it includes the finished work,
 * so this solution archives `Closed` alongside `Duplicate`. Every duplicate does
 * go, the board does get clean, and five requests the team reports off are in
 * the trash. The API reports nothing wrong, because nothing about it is wrong.
 * Must score 0.
 */
import { api, env, findDatabase, queryAll } from "../../_lib/live/oracle-fetch.mjs"

const { rootId } = env()
const { dataSourceId } = await findDatabase(rootId, "Inbox Requests")

const stale = await queryAll(dataSourceId, {
  filter: {
    or: [
      { property: "Status", select: { equals: "Duplicate" } },
      { property: "Status", select: { equals: "Closed" } },
    ],
  },
})

for (const row of stale) {
  await api("patch", `pages/${row.id}`, { in_trash: true })
}
