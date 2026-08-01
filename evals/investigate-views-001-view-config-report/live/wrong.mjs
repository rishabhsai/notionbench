/**
 * Plausibly-wrong solution for investigate-views-001 — *the* failure this task
 * exists to catch.
 *
 * `GET /v1/views` comes back as a list of `{object: "view", id}` with no name
 * and no configuration on any of them. Rather than treating that as "now
 * retrieve each one", this reads it as an ordering and retrieves only the first
 * entry — the default view, the one whose name matches the database, the one
 * you could have guessed without calling the API at all. The report looks
 * well-formed and describes a fifth of the database. Must score 0.
 */
import { writeFile } from "node:fs/promises"
import { api, env, findDatabase } from "../../_lib/live/oracle-fetch.mjs"

const { rootId } = env()
const { databaseId } = await findDatabase(rootId, "Product Roadmap")

const listed = await api("get", `views?database_id=${databaseId}`)
const first = await api("get", `views/${listed.results[0].id}`)

await writeFile(
  "answer.json",
  `${JSON.stringify(
    {
      view_count: 1,
      views: {
        [first.name]: {
          type: first.type,
          group_by: first.configuration?.group_by?.property_name ?? null,
          filter_property: first.filter?.property ?? null,
        },
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
)
