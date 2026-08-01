/**
 * Oracle for build-pages-001. QC only — never visible to an agent, never run
 * during a benchmark trial. See the header of ../EVAL.ts for why the oracle
 * uses `fetch` while the agent under test uses the `ntn` CLI.
 *
 * The shape of a safe partial edit against a whole-document PATCH endpoint:
 * fetch the document, drop the rendered title line, splice exactly one section,
 * and send every other line back untouched.
 */
import { api, env, findPage } from "../../_lib/live/oracle-fetch.mjs"

const { rootId } = env()
const pageId = await findPage(rootId, "Nightly Export Runbook")

const NEW_STEPS = [
  "- Confirm yesterday's run finished and the warehouse is idle",
  "- Snapshot the orders table row count",
  "- Start the export job",
  "- Check the exported row count against the snapshot",
]

const { markdown } = await api("get", `pages/${pageId}/markdown`)

// The first line is the page *title*, rendered for readability. Writing it back
// would append a duplicate heading block to the body.
const lines = markdown.split("\n")
const body = lines[0].startsWith("# ") ? lines.slice(1) : lines

const out = []
let inSteps = false
for (const line of body) {
  if (line.startsWith("## ")) {
    inSteps = line === "## Steps"
    out.push(line)
    if (inSteps) out.push(...NEW_STEPS)
    continue
  }
  if (!inSteps) out.push(line)
}

await api("patch", `pages/${pageId}/markdown`, {
  type: "replace_content",
  replace_content: { new_str: out.join("\n"), allow_deleting_content: true },
})
