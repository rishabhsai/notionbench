/**
 * Oracle for operate-batch-001. QC only — never visible to an agent, never run
 * during a benchmark trial. See the header of ../EVAL.ts for why the oracle
 * uses `fetch` while the agent under test uses the `ntn` CLI, and why timing is
 * not asserted.
 *
 * Two things make this correct rather than lucky:
 *
 *  1. **Serial, paced writes.** One creation at a time with a minimum interval
 *     between them, so the burst that earns a 429 never happens.
 *  2. **A retry that honours `Retry-After`.** Pacing narrows the window; it does
 *     not close it. A 429 that is not retried is a dropped row, which is exactly
 *     the failure the verifier looks for.
 *
 * The pacer switches itself off against anything that is not api.notion.com —
 * the same rule `_lib/live/notion.ts` applies to its own client. There is no
 * rate limit to respect on the fake server, and 50 × 350ms of sleeping would be
 * a permanent tax on every CI run for no signal at all.
 */
import { readFile } from "node:fs/promises"
import { env } from "../../_lib/live/oracle-fetch.mjs"

const NOTION_VERSION = "2026-03-11"

const { base, token, rootId } = env()

/** ~3 requests/second is Notion's published average. 350ms leaves a margin. */
const MIN_INTERVAL_MS = /(^|\.)notion\.com$/i.test(new URL(base).hostname) ? 350 : 0
const MAX_RETRIES = 5

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let lastRequestAt = 0

async function api(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastRequestAt = Date.now()

    const response = await fetch(`${base}/v1/${path}`, {
      method: method.toUpperCase(),
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    const parsed = text ? JSON.parse(text) : {}
    if (response.ok) return parsed

    if (response.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = Number(response.headers.get("retry-after"))
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500)
      continue
    }
    throw new Error(`${method.toUpperCase()} /v1/${path} → ${response.status} ${parsed.code}: ${parsed.message}`)
  }
}

async function children(blockId) {
  const out = []
  let cursor
  for (;;) {
    const query = new URLSearchParams({ page_size: "100" })
    if (cursor) query.set("start_cursor", cursor)
    const page = await api("get", `blocks/${blockId}/children?${query}`)
    out.push(...page.results)
    if (!page.has_more) return out
    cursor = page.next_cursor
  }
}

async function findDataSource(title) {
  const queue = [rootId]
  while (queue.length > 0) {
    const id = queue.shift()
    for (const block of await children(id)) {
      if (block.type === "child_database" && block.child_database.title === title) {
        const database = await api("get", `databases/${block.id}`)
        return database.data_sources[0].id
      }
      if (block.type === "child_page") queue.push(block.id)
    }
  }
  throw new Error(`no database titled "${title}" under ${rootId}`)
}

const dataSourceId = await findDataSource("Contact Imports")
const contacts = JSON.parse(await readFile("contacts.json", "utf8"))

for (const contact of contacts) {
  await api("post", "pages", {
    parent: { type: "data_source_id", data_source_id: dataSourceId },
    properties: {
      Name: { title: [{ type: "text", text: { content: contact.name } }] },
      Email: { email: contact.email },
      Company: { rich_text: [{ type: "text", text: { content: contact.company } }] },
      Segment: { select: { name: contact.segment } },
    },
  })
}
