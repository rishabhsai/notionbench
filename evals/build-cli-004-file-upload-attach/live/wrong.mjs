/**
 * Plausibly-wrong solution for build-cli-004 — *the* failure this task exists
 * to catch.
 *
 * A `files` property accepts an external entry directly, with no upload, no
 * multipart POST and no second round-trip. One PATCH and the row shows an
 * attachment named `v2.4.0.md`, which is what the request asked for as far as
 * anything visible is concerned. What it does not do is move a single byte into
 * Notion: the property points at a URL somewhere else, which is the exact
 * situation the request was trying to end. Must score 0.
 */
import { api, env, findDatabase, queryAll } from "../../_lib/live/oracle-fetch.mjs"

const { rootId } = env()
const { dataSourceId } = await findDatabase(rootId, "Release Log")

const rows = await queryAll(dataSourceId)
const target = rows.find((row) =>
  Object.values(row.properties).some(
    (p) => p.type === "title" && p.title.map((t) => t.plain_text ?? t.text?.content ?? "").join("") === "v2.4.0",
  ),
)
if (!target) throw new Error("no v2.4.0 row in the Release Log")

await api("patch", `pages/${target.id}`, {
  properties: {
    Assets: {
      files: [
        {
          type: "external",
          name: "v2.4.0.md",
          external: { url: "https://example.com/ledger/release-notes/v2.4.0.md" },
        },
      ],
    },
  },
})
