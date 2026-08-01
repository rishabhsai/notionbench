/**
 * Oracle for build-cli-004. QC only — never visible to an agent, never run
 * during a benchmark trial. See the header of ../EVAL.ts for why the oracle
 * uses raw `fetch` while the agent under test uses the `ntn` CLI.
 *
 * The three steps, in order: reserve the upload, POST the bytes to the url it
 * handed back, then reference it from the property.
 */
import { readFile } from "node:fs/promises"
import { api, env, findDatabase, queryAll, upload } from "../../_lib/live/oracle-fetch.mjs"

const { rootId } = env()
const { dataSourceId } = await findDatabase(rootId, "Release Log")

const bytes = await readFile("release-notes/v2.4.0.md")
const file = await upload("v2.4.0.md", bytes, "text/markdown")

const rows = await queryAll(dataSourceId)
const target = rows.find((row) =>
  Object.values(row.properties).some(
    (p) => p.type === "title" && p.title.map((t) => t.plain_text ?? t.text?.content ?? "").join("") === "v2.4.0",
  ),
)
if (!target) throw new Error("no v2.4.0 row in the Release Log")

await api("patch", `pages/${target.id}`, {
  properties: {
    Assets: { files: [{ type: "file_upload", file_upload: { id: file.id }, name: "v2.4.0.md" }] },
  },
})
