/**
 * Backfill owners onto the Release Tracker.
 *
 * Every row still sitting in `Backlog` gets moved to `Ready` and stamped with
 * the owner we agreed in planning. Rows that already moved on are left alone.
 *
 * Run it with the integration token in the environment:
 *
 *   node backfill.mjs
 *
 * It reads NOTION_API_TOKEN (required) and NOTION_API_BASE (optional), and finds
 * the tracker under the sandbox page named in notionbench.json.
 */
import { readFile } from "node:fs/promises"

const NOTION_VERSION = "2026-03-11"
const DATABASE_TITLE = "Release Tracker"

/** Agreed in the planning review. Rows not listed here keep whatever owner they have. */
const OWNERS = {
  "REL-01": "Ada Lovelace",
  "REL-02": "Grace Hopper",
  "REL-03": "Katherine Johnson",
  "REL-04": "Radia Perlman",
  "REL-05": "Barbara Liskov",
  "REL-06": "Alan Turing",
}

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

/** Breadth-first hunt for the tracker under the sandbox root. */
async function findDatabase(rootId) {
  const queue = [rootId]
  while (queue.length > 0) {
    const id = queue.shift()
    for (const block of await children(id)) {
      if (block.type === "child_database" && block.child_database.title === DATABASE_TITLE) {
        return api("get", `databases/${block.id}`)
      }
      if (block.type === "child_page") queue.push(block.id)
    }
  }
  throw new Error(`no database titled "${DATABASE_TITLE}" under ${rootId}`)
}

const pointer = JSON.parse(await readFile(new URL("./notionbench.json", import.meta.url), "utf8"))
const database = await findDatabase(pointer.root_page_id)

const dataSourceId = database.id

const rows = []
let cursor
for (;;) {
  const page = await api("post", `data_sources/${dataSourceId}/query`, {
    page_size: 100,
    ...(cursor ? { start_cursor: cursor } : {}),
  })
  rows.push(...page.results)
  if (!page.has_more || !page.next_cursor) break
  cursor = page.next_cursor
}

let moved = 0
for (const row of rows) {
  const name = (row.properties.Name?.title ?? []).map((p) => p.plain_text ?? p.text?.content ?? "").join("")
  if (row.properties.Stage?.select?.name !== "Backlog") continue
  const owner = OWNERS[name]
  await api("patch", `pages/${row.id}`, {
    properties: {
      Stage: { select: { name: "Ready" } },
      ...(owner ? { Owner: { rich_text: [{ type: "text", text: { content: owner } }] } } : {}),
    },
  })
  moved++
}

console.log(`moved ${moved} of ${rows.length} rows out of Backlog`)
