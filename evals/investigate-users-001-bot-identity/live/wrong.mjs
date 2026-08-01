/**
 * Plausibly-wrong solution for investigate-users-001 — *the* failure this task
 * exists to catch.
 *
 * "Who is this token?" gets answered from `GET /v1/users`, the workspace's
 * membership list, because it is the endpoint whose name matches the question.
 * The first entry that isn't obviously an integration is taken as the identity,
 * which produces a real user id belonging to a real human. Everything else —
 * owner type, workspace, head count — is still read off `users/me`, so the file
 * is complete, internally consistent and names the wrong subject. Must score 0.
 */
import { writeFile } from "node:fs/promises"
import { api } from "../../_lib/live/oracle-fetch.mjs"

const me = await api("get", "users/me")
const members = (await api("get", "users?page_size=100")).results
const person = members.find((u) => u.type === "person")

await writeFile(
  "answer.json",
  `${JSON.stringify(
    {
      bot_id: person.id,
      bot_name: person.name,
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
