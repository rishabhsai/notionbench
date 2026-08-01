/**
 * A raw-`fetch` Notion helper for **oracle scripts only**.
 *
 * `live/solution.mjs` and `live/wrong.mjs` stand in for the agent during QC, so
 * they must not share code with the thing that grades them. If an oracle used
 * `notion.ts`'s `queryAllRows`, then `investigate-db-001` — a task whose entire
 * subject is pagination — would be checking one implementation of pagination
 * against itself. This module is therefore deliberately separate from, and
 * simpler than, `notion.ts`: no pacing, no retries, no property helpers.
 *
 * At *run* time nothing here is used. The agent under test drives the real
 * `ntn` CLI against api.notion.com; these scripts exist only so CI can prove
 * that each task's verifier says 1 for a correct workspace and 0 for a wrong
 * one, with no Notion account in the loop.
 *
 * Env contract (set by `qc-live.ts`):
 *   NOTION_API_BASE      API root — the fake server during QC
 *   NOTION_API_TOKEN     bearer token
 *   NOTIONBENCH_ROOT_ID  the fixture root page
 *   NOTIONBENCH_ID_MAP   JSON {specKey → notionId}
 */

export const NOTION_VERSION = "2026-03-11"

export function env() {
  const base = (process.env.NOTION_API_BASE ?? "https://api.notion.com").replace(/\/+$/, "")
  const token = process.env.NOTION_API_TOKEN
  const rootId = process.env.NOTIONBENCH_ROOT_ID
  if (!token) throw new Error("NOTION_API_TOKEN is not set")
  if (!rootId) throw new Error("NOTIONBENCH_ROOT_ID is not set")
  let idMap = {}
  try {
    idMap = JSON.parse(process.env.NOTIONBENCH_ID_MAP ?? "{}")
  } catch {
    idMap = {}
  }
  return { base, token, rootId, idMap }
}

/** One request. Throws with the API's own message so QC failures are readable. */
export async function api(method, path, body) {
  const { base, token } = env()
  const response = await fetch(`${base}/v1/${path.replace(/^\/+/, "")}`, {
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

/** `[{type:"text",…}]` from a plain string. */
export function rt(text) {
  return text ? [{ type: "text", text: { content: text } }] : []
}

/** Plain text out of a rich-text array. */
export function plain(value) {
  if (!Array.isArray(value)) return ""
  return value.map((p) => p?.plain_text ?? p?.text?.content ?? "").join("")
}

/** Scalar for one API property value. */
export function prop(value) {
  if (!value || typeof value !== "object") return null
  switch (value.type) {
    case "title":
      return plain(value.title)
    case "rich_text":
      return plain(value.rich_text)
    case "number":
      return typeof value.number === "number" ? value.number : null
    case "select":
      return value.select?.name ?? null
    case "status":
      return value.status?.name ?? null
    case "multi_select":
      return (value.multi_select ?? []).map((o) => o.name)
    case "date":
      return value.date?.start ?? null
    case "checkbox":
      return Boolean(value.checkbox)
    default:
      return null
  }
}

/** All scalar properties of a row, keyed by name. */
export function props(page) {
  const out = {}
  for (const [name, value] of Object.entries(page.properties ?? {})) out[name] = prop(value)
  return out
}

/**
 * Resolve `{databaseId, dataSourceId}` for a database titled `title` under
 * `rootId` — the same discovery an agent has to perform, since the prompt only
 * hands over the root page.
 */
export async function findDatabase(rootId, title, maxDepth = 4) {
  const queue = [{ id: rootId, depth: 0 }]
  const seen = new Set()
  while (queue.length > 0) {
    const { id, depth } = queue.shift()
    if (seen.has(id) || depth > maxDepth) continue
    seen.add(id)
    const children = await listChildren(id)
    for (const block of children) {
      if (block.type === "child_database" && block.child_database?.title === title) {
        const db = await api("get", `databases/${block.id}`)
        return { databaseId: db.id, dataSourceId: db.data_sources?.[0]?.id }
      }
      if (block.type === "child_page") queue.push({ id: block.id, depth: depth + 1 })
    }
  }
  throw new Error(`no database titled "${title}" under ${rootId}`)
}

export async function findPage(rootId, title, maxDepth = 4) {
  const queue = [{ id: rootId, depth: 0 }]
  const seen = new Set()
  while (queue.length > 0) {
    const { id, depth } = queue.shift()
    if (seen.has(id) || depth > maxDepth) continue
    seen.add(id)
    for (const block of await listChildren(id)) {
      if (block.type !== "child_page") continue
      if (block.child_page?.title === title) return block.id
      queue.push({ id: block.id, depth: depth + 1 })
    }
  }
  throw new Error(`no page titled "${title}" under ${rootId}`)
}

export async function listChildren(blockId) {
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

/** One page of rows. Deliberately *not* paginating — see `queryAll`. */
export function queryOnce(dataSourceId, body = {}) {
  return api("post", `data_sources/${dataSourceId}/query`, body)
}

/** Every row, following cursors. Written out longhand: this is the skill under test. */
export async function queryAll(dataSourceId, body = {}) {
  const rows = []
  let cursor
  for (;;) {
    const page = await queryOnce(dataSourceId, {
      ...body,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    })
    rows.push(...page.results)
    if (!page.has_more || !page.next_cursor) return rows
    cursor = page.next_cursor
  }
}
