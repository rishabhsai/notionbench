/**
 * Plausibly-wrong solution for build-pages-001 — the failure a whole-document
 * PATCH endpoint invites.
 *
 * The steps are exactly right. But instead of splicing them into the document it
 * read back, this solution retypes the page: it remembers the gist of the other
 * two sections and writes those out too. `## Overview` survives by luck;
 * `## Escalation` loses its second line, because nobody re-read it before
 * hitting save. Nothing errors, the page still looks like a runbook, and a
 * compliance-signed paragraph is gone. Must score 0.
 */
import { api, env, findPage } from "../../_lib/live/oracle-fetch.mjs"

const { rootId } = env()
const pageId = await findPage(rootId, "Nightly Export Runbook")

const document = [
  "## Overview",
  "The nightly export copies the orders table into the warehouse at 02:00 UTC.",
  "## Steps",
  "- Confirm yesterday's run finished and the warehouse is idle",
  "- Snapshot the orders table row count",
  "- Start the export job",
  "- Check the exported row count against the snapshot",
  "## Escalation",
  "If the run is still red after two retries, page the on-call data engineer.",
].join("\n")

await api("patch", `pages/${pageId}/markdown`, {
  type: "replace_content",
  replace_content: { new_str: document, allow_deleting_content: true },
})
