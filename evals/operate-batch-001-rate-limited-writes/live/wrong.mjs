/**
 * Plausibly-wrong solution for operate-batch-001 — the short import.
 *
 * Fifty creations are fired off in chunks with no pacing. Against
 * api.notion.com the later chunks come back `429 rate_limited`; those rejections
 * are caught, counted and logged, and the loop moves on. The script exits 0, the
 * database looks full, and three contacts from the conference are simply not
 * there.
 *
 * `fake-notion.ts` models no rate limit, so the throttling cannot be reproduced
 * at QC time. This script therefore produces the *outcome* under test directly —
 * it writes 47 of the 50 and reports the rest as dropped — so CI can prove the
 * verifier rejects a short import. See the note on timing in ../EVAL.ts.
 * Must score 0.
 */
import { readFile } from "node:fs/promises"
import { api, env, findDatabase } from "../../_lib/live/oracle-fetch.mjs"

/** What survived the burst. The tail of the file is what gets throttled. */
const DELIVERED = 47

const { rootId } = env()
const { dataSourceId } = await findDatabase(rootId, "Contact Imports")

const contacts = JSON.parse(await readFile("contacts.json", "utf8"))
const delivered = contacts.slice(0, DELIVERED)
const dropped = contacts.slice(DELIVERED)

await Promise.all(
  delivered.map((contact) =>
    api("post", "pages", {
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties: {
        Name: { title: [{ type: "text", text: { content: contact.name } }] },
        Email: { email: contact.email },
        Company: { rich_text: [{ type: "text", text: { content: contact.company } }] },
        Segment: { select: { name: contact.segment } },
      },
    }),
  ),
)

console.log(`imported ${delivered.length} contacts (${dropped.length} rate-limited, skipped)`)
