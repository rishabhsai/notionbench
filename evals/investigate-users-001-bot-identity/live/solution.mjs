/**
 * Oracle for investigate-users-001. QC only — never visible to an agent, never
 * run during a benchmark trial. See the header of ../EVAL.ts for why the oracle
 * uses `fetch` while the agent under test uses the `ntn` CLI.
 *
 * The one thing that matters: identity comes from `users/me`; the membership
 * list is only good for counting people.
 */
import { writeFile } from "node:fs/promises"
import { api } from "../../_lib/live/oracle-fetch.mjs"

const me = await api("get", "users/me")

const members = []
let cursor
for (;;) {
  const query = new URLSearchParams({ page_size: "100" })
  if (cursor) query.set("start_cursor", cursor)
  const page = await api("get", `users?${query}`)
  members.push(...page.results)
  if (!page.has_more || !page.next_cursor) break
  cursor = page.next_cursor
}

await writeFile(
  "answer.json",
  `${JSON.stringify(
    {
      bot_id: me.id,
      bot_name: me.name,
      owner_type: me.bot?.owner?.type ?? null,
      workspace_id: me.bot?.workspace_id ?? null,
      workspace_name: me.bot?.workspace_name ?? null,
      person_count: members.filter((u) => u.type === "person").length,
    },
    null,
    2,
  )}\n`,
  "utf8",
)
