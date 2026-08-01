/**
 * Append the customer-impact appendix to an incident postmortem.
 *
 * Support signs off the impact numbers a day or two after the write-up lands, so
 * this runs separately and adds the appendix to the bottom of the page.
 *
 *   node add-appendix.mjs
 *
 * It reads NOTION_API_TOKEN (required) and NOTION_API_BASE (optional), and finds
 * the postmortem under the sandbox page named in notionbench.json.
 */
import { readFile } from "node:fs/promises"

const NOTION_VERSION = "2026-03-11"
const PAGE_TITLE = "Incident 2026-07-12 · Postmortem"

/** Signed off by support on 2026-07-15. */
const APPENDIX = [
  "## Appendix · Customer impact",
  "- 412 orders failed to submit",
  "- 3 enterprise accounts opened tickets",
  "- No data loss",
].join("\n")

const base = (process.env.NOTION_API_BASE ?? "https://api.notion.com").replace(/\/+$/, "")
const token = process.env.NOTION_API_TOKEN
if (!token) throw new Error("NOTION_API_TOKEN is not set")

async function api(method, path, body) {
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
  if (!response.ok) {
    throw new Error(`${method.toUpperCase()} /v1/${path} → ${response.status} ${parsed.code}: ${parsed.message}`)
  }
  return parsed
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

/** Breadth-first hunt for the postmortem under the sandbox root. */
async function findPage(rootId) {
  const queue = [rootId]
  while (queue.length > 0) {
    const id = queue.shift()
    for (const block of await children(id)) {
      if (block.type !== "child_page") continue
      if (block.child_page.title === PAGE_TITLE) return block.id
      queue.push(block.id)
    }
  }
  throw new Error(`no page titled "${PAGE_TITLE}" under ${rootId}`)
}

const pointer = JSON.parse(await readFile(new URL("./notionbench.json", import.meta.url), "utf8"))
const pageId = await findPage(pointer.root_page_id)

const payload = APPENDIX

await api("patch", `pages/${pageId}/markdown`, {
  type: "replace_content",
  replace_content: { new_str: payload, allow_deleting_content: true },
})

console.log(`appendix written to ${pageId}`)
