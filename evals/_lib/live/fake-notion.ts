/**
 * An in-memory Notion API, good enough to run live-task QC entirely offline.
 *
 * The live tasks' *scoring* path — provision the fixture, apply an oracle, read
 * the workspace back and assert — must be provable in CI, where there is no
 * Notion workspace and no token. This server implements the ~15 endpoints those
 * paths touch, at API version 2025-09-03+/2026-03-11 semantics, so
 * `NOTION_API_BASE=http://127.0.0.1:<port>` makes the entire chain hermetic.
 *
 * What it models faithfully (because tasks depend on it):
 *  - the **database / data source split**: `POST /v1/databases` takes
 *    `initial_data_source`, rows are created with `parent.data_source_id`,
 *    schema edits go to `PATCH /v1/data_sources/{id}`;
 *  - **100-row pagination** with `start_cursor` / `next_cursor` / `has_more`,
 *    and a `validation_error` for `page_size > 100` — this is the whole point of
 *    `investigate-db-001`, so a truncating solution has to actually truncate;
 *  - **filters and sorts** on query, enough for a filtered export;
 *  - **trashing**: `in_trash` (and the legacy `archived`) cascades to a page's
 *    subtree, so fixture teardown is testable and trashed rows leave query results.
 *
 * What it does not model: permissions, users beyond `users/me`, comments, file
 * uploads, views, relations/rollups/formulas, rate limits. Add endpoints when a
 * task needs them, not before.
 *
 * Determinism: ids come from a counter (never `crypto.randomUUID`), timestamps
 * from a virtual clock that advances 1 ms per mutation (never `Date.now`), and
 * the listener binds to port 0. Nothing here reads the wall clock, so QC output
 * is byte-stable and no test ever sleeps.
 *
 *   const server = await startFakeNotion()
 *   process.env.NOTION_API_BASE = server.url
 *   process.env.NOTION_API_TOKEN = server.token
 *   process.env.NOTION_PARENT_PAGE_ID = server.parentPageId
 *   …
 *   await server.close()
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

const TYPE_KEYS = [
  "title",
  "rich_text",
  "number",
  "select",
  "status",
  "multi_select",
  "date",
  "checkbox",
  "url",
  "email",
  "phone_number",
  "people",
  "files",
  "relation",
] as const

const MAX_PAGE_SIZE = 100

/** Virtual epoch. Fixed so two runs produce identical `created_time`s. */
const EPOCH = Date.UTC(2026, 6, 1, 0, 0, 0)

interface PageRecord {
  id: string
  kind: "page"
  parent: Record<string, unknown>
  /** Row values keyed by property name; page titles live under `__title`. */
  values: Record<string, unknown>
  title: string
  icon: unknown
  cover: unknown
  inTrash: boolean
  children: string[]
  createdTime: string
  lastEditedTime: string
  /** Set when the page is a data-source row. */
  dataSourceId?: string
}

interface BlockRecord {
  id: string
  kind: "block"
  type: string
  payload: Record<string, unknown>
  parentId: string
  children: string[]
  inTrash: boolean
  createdTime: string
  lastEditedTime: string
}

interface DatabaseRecord {
  id: string
  kind: "database"
  parent: Record<string, unknown>
  title: string
  icon: unknown
  dataSourceIds: string[]
  inTrash: boolean
  createdTime: string
  lastEditedTime: string
}

interface PropertyDef {
  id: string
  name: string
  type: string
  config: Record<string, unknown>
}

interface DataSourceRecord {
  id: string
  kind: "data_source"
  databaseId: string
  name: string
  /** Ordered — property order is observable via `Object.keys`. */
  properties: PropertyDef[]
  rowIds: string[]
  createdTime: string
  lastEditedTime: string
}

type Record_ = PageRecord | BlockRecord | DatabaseRecord | DataSourceRecord

/**
 * Plain fields, not constructor parameter properties: everything under
 * `evals/_lib/` is executed by Node's strip-only type stripping, which rejects
 * `constructor(readonly x: T)`.
 */
class ApiError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
  }
}

const badRequest = (message: string): ApiError => new ApiError(400, "validation_error", message)
const notFound = (message: string): ApiError => new ApiError(404, "object_not_found", message)

/** The whole workspace. Exposed on the server handle for white-box assertions. */
export class Store {
  pages = new Map<string, PageRecord>()
  blocks = new Map<string, BlockRecord>()
  databases = new Map<string, DatabaseRecord>()
  dataSources = new Map<string, DataSourceRecord>()
  #seq = 0
  #tick = 0

  /** Deterministic uuid-shaped id: counter in the last 12 hex digits. */
  nextId(): string {
    const n = ++this.#seq
    const hex = n.toString(16).padStart(12, "0")
    return `00000000-0000-4000-8000-${hex}`
  }

  nextPropertyId(): string {
    return `p${(++this.#seq).toString(36)}`
  }

  /** Virtual clock: 1 ms per mutation. Never reads the host clock. */
  now(): string {
    return new Date(EPOCH + this.#tick++).toISOString().replace(/\.\d{3}Z$/, ".000Z")
  }

  get(id: string): Record_ | undefined {
    return this.pages.get(id) ?? this.blocks.get(id) ?? this.databases.get(id) ?? this.dataSources.get(id)
  }

  reset(): void {
    this.pages.clear()
    this.blocks.clear()
    this.databases.clear()
    this.dataSources.clear()
    this.#seq = 0
    this.#tick = 0
  }
}

export interface FakeNotionOptions {
  /** Bearer token the server accepts. Default `"fake-notion-token"`. */
  token?: string
  /**
   * Title of the pre-created page that stands in for the operator's shared
   * parent page. Provisioning creates fixture roots under it, exactly as it
   * would in a real workspace.
   */
  parentPageTitle?: string
  /** Bind host. Default 127.0.0.1. */
  host?: string
  /** Bind port. Default 0 — always ask the OS, never guess. */
  port?: number
}

export interface FakeNotionServer {
  url: string
  token: string
  /** Use as `NOTION_PARENT_PAGE_ID`; stands in for a workspace-shared page. */
  parentPageId: string
  store: Store
  /** Every request seen, in order. `{method, path}` — for "did it paginate?" checks. */
  requests: Array<{ method: string; path: string }>
  /** Wipe the workspace and re-create the parent page. Returns the new id. */
  reset(): string
  close(): Promise<void>
  server: Server
}

export async function startFakeNotion(opts: FakeNotionOptions = {}): Promise<FakeNotionServer> {
  const token = opts.token ?? "fake-notion-token"
  const parentTitle = opts.parentPageTitle ?? "NotionBench Sandbox"
  const store = new Store()
  const requests: Array<{ method: string; path: string }> = []

  const seedParent = (): string => {
    const id = store.nextId()
    const time = store.now()
    store.pages.set(id, {
      id,
      kind: "page",
      // A page shared into the integration; its own parent is the workspace,
      // which is precisely the thing that cannot be archived via the API.
      parent: { type: "workspace", workspace: true },
      values: {},
      title: parentTitle,
      icon: null,
      cover: null,
      inTrash: false,
      children: [],
      createdTime: time,
      lastEditedTime: time,
    })
    return id
  }

  let parentPageId = seedParent()

  const server = createServer((req, res) => {
    void handle(req, res, { store, token, requests })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
      server.removeListener("error", reject)
      resolve()
    })
  })

  const address = server.address() as AddressInfo
  const url = `http://${address.address === "::" ? "127.0.0.1" : address.address}:${address.port}`

  return {
    url,
    token,
    get parentPageId() {
      return parentPageId
    },
    store,
    requests,
    reset(): string {
      store.reset()
      requests.length = 0
      parentPageId = seedParent()
      return parentPageId
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
    },
    server,
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { store: Store; token: string; requests: Array<{ method: string; path: string }> },
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase()
  const url = new URL(req.url ?? "/", "http://fake")
  ctx.requests.push({ method, path: url.pathname + (url.search || "") })

  try {
    const auth = req.headers.authorization ?? ""
    if (auth !== `Bearer ${ctx.token}`) {
      throw new ApiError(401, "unauthorized", "API token is invalid.")
    }
    const body = await readJsonBody(req)
    const result = route(method, url, body, ctx.store)
    send(res, 200, result)
  } catch (err) {
    if (err instanceof ApiError) {
      send(res, err.status, {
        object: "error",
        status: err.status,
        code: err.code,
        message: err.message,
        request_id: "fake",
      })
      return
    }
    send(res, 500, {
      object: "error",
      status: 500,
      code: "internal_server_error",
      message: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err),
    })
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(text)),
  })
  res.end(text)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  const raw = Buffer.concat(chunks).toString("utf8").trim()
  if (raw === "") return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    throw badRequest("body failed to parse as JSON")
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function route(method: string, url: URL, body: Record<string, unknown>, store: Store): unknown {
  const segments = url.pathname.split("/").filter(Boolean)
  if (segments[0] !== "v1") throw notFound(`unknown path ${url.pathname}`)
  const [, resource, id, sub, subId] = segments

  switch (resource) {
    case "pages":
      if (method === "POST" && !id) return createPage(body, store)
      if (!id) break
      if (sub === "markdown") {
        if (method === "GET") return { object: "markdown", markdown: renderMarkdown(id, store) }
        if (method === "PATCH") return updateMarkdown(id, body, store)
        break
      }
      if (sub === "properties" && method === "GET") return retrievePageProperty(id, subId, store)
      if (method === "GET") return serializePage(requirePage(id, store), store)
      if (method === "PATCH") return updatePage(id, body, store)
      break

    case "databases":
      if (method === "POST" && !id) return createDatabase(body, store)
      if (!id) break
      if (method === "GET") return serializeDatabase(requireDatabase(id, store), store)
      if (method === "PATCH") return updateDatabase(id, body, store)
      break

    case "data_sources":
      if (method === "POST" && !id) throw badRequest("standalone data source creation is not modelled")
      if (!id) break
      if (sub === "query" && method === "POST") return queryDataSource(id, body, store)
      if (method === "GET") return serializeDataSource(requireDataSource(id, store), store)
      if (method === "PATCH") return updateDataSource(id, body, store)
      break

    case "blocks":
      if (!id) break
      if (sub === "children") {
        if (method === "GET") return listChildren(id, url, store)
        if (method === "PATCH") return appendChildren(id, body, store)
        break
      }
      if (method === "GET") return serializeBlock(requireBlock(id, store))
      if (method === "DELETE") return deleteBlock(id, store)
      break

    case "search":
      if (method === "POST") return search(body, store)
      break

    case "users":
      if (id === "me" && method === "GET") return botUser()
      if (!id && method === "GET") {
        return list([botUser()], null, false)
      }
      break
  }
  throw notFound(`${method} ${url.pathname} is not implemented by the fake Notion server`)
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function requirePage(id: string, store: Store): PageRecord {
  const page = store.pages.get(id)
  if (!page) throw notFound(`Could not find page with ID: ${id}.`)
  return page
}

function requireDatabase(id: string, store: Store): DatabaseRecord {
  const db = store.databases.get(id)
  if (!db) {
    if (store.dataSources.has(id)) {
      // The single most common post-2025-09-03 mistake, and worth a pointed error.
      throw badRequest(
        `${id} is a data source id, not a database id. Use GET /v1/data_sources/${id} for the schema.`,
      )
    }
    throw notFound(`Could not find database with ID: ${id}.`)
  }
  return db
}

function requireDataSource(id: string, store: Store): DataSourceRecord {
  const ds = store.dataSources.get(id)
  if (!ds) {
    if (store.databases.has(id)) {
      throw badRequest(
        `${id} is a database id, not a data source id. Retrieve the database and use one of its data_sources[].id.`,
      )
    }
    throw notFound(`Could not find data source with ID: ${id}.`)
  }
  return ds
}

function requireBlock(id: string, store: Store): BlockRecord {
  const block = store.blocks.get(id)
  if (!block) throw notFound(`Could not find block with ID: ${id}.`)
  return block
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function createPage(body: Record<string, unknown>, store: Store): unknown {
  const parent = (body.parent ?? {}) as Record<string, unknown>
  const time = store.now()
  const id = store.nextId()

  const dataSourceId = resolveRowParent(parent, store)
  if (dataSourceId) {
    const ds = requireDataSource(dataSourceId, store)
    const values = normalizeProperties(body.properties, ds, store)
    const page: PageRecord = {
      id,
      kind: "page",
      parent: { type: "data_source_id", data_source_id: ds.id, database_id: ds.databaseId },
      values,
      title: titleOfValues(values, ds),
      icon: body.icon ?? null,
      cover: body.cover ?? null,
      inTrash: false,
      children: [],
      createdTime: time,
      lastEditedTime: time,
      dataSourceId: ds.id,
    }
    store.pages.set(id, page)
    ds.rowIds.push(id)
    appendBlocks(page.children, body.children, id, store)
    return serializePage(page, store)
  }

  const parentPageId = typeof parent.page_id === "string" ? parent.page_id : undefined
  const parentBlockId = typeof parent.block_id === "string" ? parent.block_id : undefined
  const container = parentPageId ?? parentBlockId
  if (!container) {
    throw badRequest("parent must be one of page_id, block_id, data_source_id or database_id")
  }
  const parentPage = store.pages.get(container)
  const parentBlock = store.blocks.get(container)
  if (!parentPage && !parentBlock) throw notFound(`Could not find parent with ID: ${container}.`)

  const page: PageRecord = {
    id,
    kind: "page",
    parent: parentPageId ? { type: "page_id", page_id: container } : { type: "block_id", block_id: container },
    values: {},
    title: extractTitleText(body.properties),
    icon: body.icon ?? null,
    cover: body.cover ?? null,
    inTrash: false,
    children: [],
    createdTime: time,
    lastEditedTime: time,
  }
  store.pages.set(id, page)
  ;(parentPage?.children ?? parentBlock?.children)?.push(id)
  appendBlocks(page.children, body.children, id, store)
  return serializePage(page, store)
}

/** `data_source_id` wins; a legacy `database_id` resolves to the default source. */
function resolveRowParent(parent: Record<string, unknown>, store: Store): string | undefined {
  if (typeof parent.data_source_id === "string") return parent.data_source_id
  if (typeof parent.database_id === "string") {
    const db = requireDatabase(parent.database_id, store)
    const first = db.dataSourceIds[0]
    if (!first) throw badRequest(`database ${db.id} has no data sources`)
    return first
  }
  return undefined
}

function updatePage(id: string, body: Record<string, unknown>, store: Store): unknown {
  const page = requirePage(id, store)
  if ("in_trash" in body || "archived" in body) {
    const trashed = body.in_trash === true || body.archived === true
    setTrashed(page, trashed, store)
  }
  if ("icon" in body) page.icon = body.icon
  if ("cover" in body) page.cover = body.cover
  if (body.properties && typeof body.properties === "object") {
    if (page.dataSourceId) {
      const ds = requireDataSource(page.dataSourceId, store)
      Object.assign(page.values, normalizeProperties(body.properties, ds, store))
      page.title = titleOfValues(page.values, ds)
    } else {
      const title = extractTitleText(body.properties)
      if (title !== "") page.title = title
    }
  }
  page.lastEditedTime = store.now()
  return serializePage(page, store)
}

/** Trashing cascades — that is what makes archiving one fixture root sufficient. */
function setTrashed(page: PageRecord, trashed: boolean, store: Store): void {
  if (page.inTrash === trashed) return
  page.inTrash = trashed
  page.lastEditedTime = store.now()
  for (const childId of page.children) {
    const child = store.pages.get(childId)
    if (child) setTrashed(child, trashed, store)
    const block = store.blocks.get(childId)
    if (block) block.inTrash = trashed
    const db = store.databases.get(childId)
    if (db) setDatabaseTrashed(db, trashed, store)
  }
}

function setDatabaseTrashed(db: DatabaseRecord, trashed: boolean, store: Store): void {
  db.inTrash = trashed
  db.lastEditedTime = store.now()
  for (const dsId of db.dataSourceIds) {
    const ds = store.dataSources.get(dsId)
    if (!ds) continue
    for (const rowId of ds.rowIds) {
      const row = store.pages.get(rowId)
      if (row) setTrashed(row, trashed, store)
    }
  }
}

function retrievePageProperty(pageId: string, propertyId: string | undefined, store: Store): unknown {
  const page = requirePage(pageId, store)
  if (!page.dataSourceId) throw badRequest("page has no data source properties")
  const ds = requireDataSource(page.dataSourceId, store)
  const def = ds.properties.find((p) => p.id === propertyId || p.name === propertyId)
  if (!def) throw notFound(`Could not find property with ID: ${String(propertyId)}.`)
  return { object: "property_item", ...serializeProperty(def, page.values[def.name]) }
}

// ---------------------------------------------------------------------------
// Databases & data sources
// ---------------------------------------------------------------------------

function createDatabase(body: Record<string, unknown>, store: Store): unknown {
  const parent = (body.parent ?? {}) as Record<string, unknown>
  const parentPageId = typeof parent.page_id === "string" ? parent.page_id : undefined
  if (!parentPageId) throw badRequest("database parent must be a page_id")
  const parentPage = requirePage(parentPageId, store)

  const initial = (body.initial_data_source ?? {}) as Record<string, unknown>
  const rawProperties = (initial.properties ?? body.properties) as Record<string, unknown> | undefined
  if (!rawProperties || typeof rawProperties !== "object") {
    throw badRequest(
      "database creation requires initial_data_source.properties (the 2025-09-03+ shape; a top-level `properties` is the pre-split form)",
    )
  }

  const time = store.now()
  const dbId = store.nextId()
  const dsId = store.nextId()
  const title = plainText(body.title)

  const db: DatabaseRecord = {
    id: dbId,
    kind: "database",
    parent: { type: "page_id", page_id: parentPageId },
    title,
    icon: body.icon ?? null,
    dataSourceIds: [dsId],
    inTrash: false,
    createdTime: time,
    lastEditedTime: time,
  }
  const ds: DataSourceRecord = {
    id: dsId,
    kind: "data_source",
    databaseId: dbId,
    name: typeof initial.name === "string" ? initial.name : title,
    properties: buildSchema(rawProperties, store),
    rowIds: [],
    createdTime: time,
    lastEditedTime: time,
  }
  store.databases.set(dbId, db)
  store.dataSources.set(dsId, ds)
  parentPage.children.push(dbId)
  return serializeDatabase(db, store)
}

function updateDatabase(id: string, body: Record<string, unknown>, store: Store): unknown {
  const db = requireDatabase(id, store)
  if (body.title !== undefined) db.title = plainText(body.title)
  if (body.icon !== undefined) db.icon = body.icon
  if (body.in_trash === true || body.archived === true) setDatabaseTrashed(db, true, store)
  if (body.in_trash === false || body.archived === false) setDatabaseTrashed(db, false, store)
  // A pre-split caller sending `properties` here is a real, common bug.
  if (body.properties !== undefined) {
    throw badRequest(
      "a database has no properties; the schema belongs to its data source — PATCH /v1/data_sources/{id} instead",
    )
  }
  db.lastEditedTime = store.now()
  return serializeDatabase(db, store)
}

function updateDataSource(id: string, body: Record<string, unknown>, store: Store): unknown {
  const ds = requireDataSource(id, store)
  if (body.name !== undefined) ds.name = typeof body.name === "string" ? body.name : plainText(body.name)
  if (body.title !== undefined) ds.name = plainText(body.title)

  const patch = body.properties
  if (patch && typeof patch === "object") {
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      const existing = ds.properties.find((p) => p.name === key || p.id === key)
      if (value === null) {
        if (!existing) continue
        if (existing.type === "title") throw badRequest("the title property cannot be removed")
        ds.properties = ds.properties.filter((p) => p !== existing)
        for (const rowId of ds.rowIds) {
          const row = store.pages.get(rowId)
          if (row) delete row.values[existing.name]
        }
        continue
      }
      const patchObj = (value ?? {}) as Record<string, unknown>
      if (existing) {
        if (typeof patchObj.name === "string" && patchObj.name !== existing.name) {
          const oldName = existing.name
          existing.name = patchObj.name
          for (const rowId of ds.rowIds) {
            const row = store.pages.get(rowId)
            if (row && oldName in row.values) {
              row.values[patchObj.name] = row.values[oldName]
              delete row.values[oldName]
            }
          }
        }
        const type = detectType(patchObj)
        if (type) {
          existing.type = type
          existing.config = (patchObj[type] ?? {}) as Record<string, unknown>
        }
        continue
      }
      const type = detectType(patchObj)
      if (!type) throw badRequest(`new property "${key}" declares no known type`)
      ds.properties.push({
        id: type === "title" ? "title" : store.nextPropertyId(),
        name: typeof patchObj.name === "string" ? patchObj.name : key,
        type,
        config: (patchObj[type] ?? {}) as Record<string, unknown>,
      })
    }
  }
  ds.lastEditedTime = store.now()
  return serializeDataSource(ds, store)
}

function queryDataSource(id: string, body: Record<string, unknown>, store: Store): unknown {
  const ds = requireDataSource(id, store)
  const rows = ds.rowIds
    .map((rowId) => store.pages.get(rowId))
    .filter((row): row is PageRecord => Boolean(row) && !(row as PageRecord).inTrash)

  const filter = body.filter as Record<string, unknown> | undefined
  const filtered = filter ? rows.filter((row) => matchesFilter(row, filter, ds)) : rows

  const sorts = Array.isArray(body.sorts) ? (body.sorts as Array<Record<string, unknown>>) : []
  const sorted = sorts.length > 0 ? applySorts(filtered, sorts, ds) : filtered

  const { slice, nextCursor, hasMore } = paginate(sorted, body.page_size, body.start_cursor)
  return list(
    slice.map((row) => serializePage(row, store)),
    nextCursor,
    hasMore,
    { type: "page_or_data_source", page_or_data_source: {} },
  )
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function childIdsOf(id: string, store: Store): string[] {
  const page = store.pages.get(id)
  if (page) return page.children
  const block = store.blocks.get(id)
  if (block) return block.children
  throw notFound(`Could not find block with ID: ${id}.`)
}

function listChildren(id: string, url: URL, store: Store): unknown {
  const ids = childIdsOf(id, store)
  const objects = ids
    .map((childId) => {
      const block = store.blocks.get(childId)
      if (block) return block.inTrash ? undefined : serializeBlock(block)
      const page = store.pages.get(childId)
      if (page) {
        return page.inTrash
          ? undefined
          : childBlock(page.id, "child_page", { title: page.title }, page)
      }
      const db = store.databases.get(childId)
      if (db) return db.inTrash ? undefined : childBlock(db.id, "child_database", { title: db.title }, db)
      return undefined
    })
    .filter((v): v is Record<string, unknown> => v !== undefined)

  const pageSizeParam = url.searchParams.get("page_size")
  const { slice, nextCursor, hasMore } = paginate(
    objects,
    pageSizeParam === null ? undefined : Number(pageSizeParam),
    url.searchParams.get("start_cursor") ?? undefined,
  )
  return list(slice, nextCursor, hasMore, { type: "block", block: {} })
}

function childBlock(
  id: string,
  type: string,
  payload: Record<string, unknown>,
  source: { createdTime: string; lastEditedTime: string },
): Record<string, unknown> {
  return {
    object: "block",
    id,
    type,
    [type]: payload,
    has_children: true,
    archived: false,
    in_trash: false,
    created_time: source.createdTime,
    last_edited_time: source.lastEditedTime,
  }
}

function appendChildren(id: string, body: Record<string, unknown>, store: Store): unknown {
  const children = childIdsOf(id, store)
  const before = children.length
  appendBlocks(children, body.children, id, store)
  const added = children
    .slice(before)
    .map((blockId) => store.blocks.get(blockId))
    .filter((b): b is BlockRecord => Boolean(b))
    .map(serializeBlock)
  return list(added, null, false, { type: "block", block: {} })
}

function appendBlocks(
  target: string[],
  children: unknown,
  parentId: string,
  store: Store,
): void {
  if (!Array.isArray(children)) return
  for (const raw of children) {
    const spec = (raw ?? {}) as Record<string, unknown>
    const type = typeof spec.type === "string" ? spec.type : detectBlockType(spec)
    if (!type) throw badRequest("block is missing a type")
    const payload = (spec[type] ?? {}) as Record<string, unknown>
    const time = store.now()
    const blockId = store.nextId()
    const nested = payload.children
    const block: BlockRecord = {
      id: blockId,
      kind: "block",
      type,
      payload: { ...payload, children: undefined },
      parentId,
      children: [],
      inTrash: false,
      createdTime: time,
      lastEditedTime: time,
    }
    delete block.payload.children
    store.blocks.set(blockId, block)
    target.push(blockId)
    if (Array.isArray(nested)) appendBlocks(block.children, nested, blockId, store)
  }
}

function detectBlockType(spec: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(spec)) {
    if (key === "object" || key === "type") continue
    if (spec[key] && typeof spec[key] === "object") return key
  }
  return undefined
}

function deleteBlock(id: string, store: Store): unknown {
  const block = store.blocks.get(id)
  if (block) {
    block.inTrash = true
    block.lastEditedTime = store.now()
    return serializeBlock(block)
  }
  const page = requirePage(id, store)
  setTrashed(page, true, store)
  return serializePage(page, store)
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function search(body: Record<string, unknown>, store: Store): unknown {
  const query = typeof body.query === "string" ? body.query.toLowerCase() : ""
  const filter = body.filter as { value?: string; property?: string } | undefined
  const want = filter?.property === "object" ? filter.value : undefined

  const results: Array<Record<string, unknown>> = []
  if (!want || want === "page") {
    for (const page of store.pages.values()) {
      if (page.inTrash || page.dataSourceId) continue
      if (query && !page.title.toLowerCase().includes(query)) continue
      results.push(serializePage(page, store) as Record<string, unknown>)
    }
  }
  // Post-2025-09-03 search surfaces `data_source` objects; `database` is opt-in.
  if (!want || want === "data_source") {
    for (const ds of store.dataSources.values()) {
      const db = store.databases.get(ds.databaseId)
      if (db?.inTrash) continue
      if (query && !ds.name.toLowerCase().includes(query)) continue
      results.push(serializeDataSource(ds, store) as Record<string, unknown>)
    }
  }
  if (want === "database") {
    for (const db of store.databases.values()) {
      if (db.inTrash) continue
      if (query && !db.title.toLowerCase().includes(query)) continue
      results.push(serializeDatabase(db, store) as Record<string, unknown>)
    }
  }

  const { slice, nextCursor, hasMore } = paginate(results, body.page_size, body.start_cursor)
  return list(slice, nextCursor, hasMore, { type: "page_or_data_source", page_or_data_source: {} })
}

function botUser(): Record<string, unknown> {
  return {
    object: "user",
    id: "00000000-0000-4000-9000-00000000bot0",
    name: "NotionBench Fixture Bot",
    type: "bot",
    bot: { owner: { type: "workspace", workspace: true }, workspace_name: "NotionBench Fake Workspace" },
  }
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function renderMarkdown(pageId: string, store: Store): string {
  const page = requirePage(pageId, store)
  const lines: string[] = [`# ${page.title}`, ""]
  const walk = (ids: string[], depth: number): void => {
    for (const id of ids) {
      const block = store.blocks.get(id)
      if (!block || block.inTrash) continue
      const text = plainText((block.payload as { rich_text?: unknown }).rich_text)
      const indent = "  ".repeat(depth)
      switch (block.type) {
        case "heading_1":
          lines.push(`${indent}# ${text}`)
          break
        case "heading_2":
          lines.push(`${indent}## ${text}`)
          break
        case "heading_3":
          lines.push(`${indent}### ${text}`)
          break
        case "bulleted_list_item":
          lines.push(`${indent}- ${text}`)
          break
        case "numbered_list_item":
          lines.push(`${indent}1. ${text}`)
          break
        case "to_do":
          lines.push(`${indent}- [${(block.payload as { checked?: boolean }).checked ? "x" : " "}] ${text}`)
          break
        default:
          lines.push(`${indent}${text}`)
      }
      if (block.children.length > 0) walk(block.children, depth + 1)
    }
  }
  walk(page.children, 0)
  return `${lines.join("\n")}\n`
}

/** Whole-page replace. Enough to exercise a markdown-clobber task's verifier. */
function updateMarkdown(pageId: string, body: Record<string, unknown>, store: Store): unknown {
  const page = requirePage(pageId, store)
  const markdown = typeof body.markdown === "string" ? body.markdown : undefined
  if (markdown === undefined) throw badRequest("markdown is required")
  for (const id of page.children) {
    const block = store.blocks.get(id)
    if (block) store.blocks.delete(id)
  }
  page.children = page.children.filter((id) => !store.blocks.has(id) && store.get(id) !== undefined)
  const blocks = markdown
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => parseMarkdownLine(line))
  appendBlocks(page.children, blocks, page.id, store)
  page.lastEditedTime = store.now()
  return { object: "markdown", markdown: renderMarkdown(pageId, store) }
}

function parseMarkdownLine(line: string): Record<string, unknown> {
  const make = (type: string, text: string, extra: Record<string, unknown> = {}) => ({
    object: "block",
    type,
    [type]: { rich_text: [{ type: "text", text: { content: text }, plain_text: text }], ...extra },
  })
  const todo = /^- \[( |x)\] (.*)$/.exec(line)
  if (todo) return make("to_do", todo[2], { checked: todo[1] === "x" })
  if (line.startsWith("### ")) return make("heading_3", line.slice(4))
  if (line.startsWith("## ")) return make("heading_2", line.slice(3))
  if (line.startsWith("# ")) return make("heading_1", line.slice(2))
  if (line.startsWith("- ")) return make("bulleted_list_item", line.slice(2))
  return make("paragraph", line)
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

function paginate<T>(
  items: T[],
  pageSizeRaw: unknown,
  cursorRaw: unknown,
): { slice: T[]; nextCursor: string | null; hasMore: boolean } {
  let pageSize = MAX_PAGE_SIZE
  if (pageSizeRaw !== undefined && pageSizeRaw !== null && pageSizeRaw !== "") {
    const n = Number(pageSizeRaw)
    if (!Number.isInteger(n) || n < 1) throw badRequest("page_size should be a positive integer")
    if (n > MAX_PAGE_SIZE) throw badRequest(`page_size should be ≤ \`${MAX_PAGE_SIZE}\`, instead was \`${n}\`.`)
    pageSize = n
  }

  let offset = 0
  if (typeof cursorRaw === "string" && cursorRaw !== "") {
    const parsed = decodeCursor(cursorRaw)
    if (parsed === undefined) throw badRequest(`start_cursor is invalid: ${cursorRaw}`)
    offset = parsed
  }

  const slice = items.slice(offset, offset + pageSize)
  const end = offset + slice.length
  const hasMore = end < items.length
  return { slice, nextCursor: hasMore ? encodeCursor(end) : null, hasMore }
}

/** Cursors are opaque to clients; base64 of the offset keeps them deterministic. */
function encodeCursor(offset: number): string {
  return Buffer.from(`nb:${offset}`, "utf8").toString("base64url")
}

function decodeCursor(cursor: string): number | undefined {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8")
    const match = /^nb:(\d+)$/.exec(decoded)
    return match ? Number(match[1]) : undefined
  } catch {
    return undefined
  }
}

function list(
  results: unknown[],
  nextCursor: string | null,
  hasMore: boolean,
  type?: Record<string, unknown>,
): Record<string, unknown> {
  return { object: "list", results, next_cursor: nextCursor, has_more: hasMore, ...(type ?? {}) }
}

// ---------------------------------------------------------------------------
// Filters & sorts
// ---------------------------------------------------------------------------

function matchesFilter(row: PageRecord, filter: Record<string, unknown>, ds: DataSourceRecord): boolean {
  if (Array.isArray(filter.and)) {
    return (filter.and as Array<Record<string, unknown>>).every((f) => matchesFilter(row, f, ds))
  }
  if (Array.isArray(filter.or)) {
    return (filter.or as Array<Record<string, unknown>>).some((f) => matchesFilter(row, f, ds))
  }
  const propName = typeof filter.property === "string" ? filter.property : undefined
  if (!propName) throw badRequest("filter needs a property, an `and`, or an `or`")
  const def = ds.properties.find((p) => p.name === propName || p.id === propName)
  if (!def) throw badRequest(`Could not find property with name or id: ${propName}`)

  const conditionKey = Object.keys(filter).find((k) => k !== "property")
  if (!conditionKey) throw badRequest(`filter on "${propName}" has no condition`)
  const condition = (filter[conditionKey] ?? {}) as Record<string, unknown>
  const value = scalarOf(def, row.values[def.name])

  for (const [op, operand] of Object.entries(condition)) {
    if (!evaluate(op, value, operand)) return false
  }
  return true
}

function evaluate(op: string, value: unknown, operand: unknown): boolean {
  switch (op) {
    case "equals":
      return Array.isArray(value) ? value.includes(operand as string) : value === operand
    case "does_not_equal":
      return Array.isArray(value) ? !value.includes(operand as string) : value !== operand
    case "contains":
      return Array.isArray(value)
        ? value.includes(operand as string)
        : String(value ?? "").includes(String(operand))
    case "does_not_contain":
      return Array.isArray(value)
        ? !value.includes(operand as string)
        : !String(value ?? "").includes(String(operand))
    case "starts_with":
      return String(value ?? "").startsWith(String(operand))
    case "ends_with":
      return String(value ?? "").endsWith(String(operand))
    case "greater_than":
      return numeric(value) > Number(operand)
    case "greater_than_or_equal_to":
      return numeric(value) >= Number(operand)
    case "less_than":
      return numeric(value) < Number(operand)
    case "less_than_or_equal_to":
      return numeric(value) <= Number(operand)
    case "is_empty":
      return operand === true ? isEmpty(value) : !isEmpty(value)
    case "is_not_empty":
      return operand === true ? !isEmpty(value) : isEmpty(value)
    case "after":
      return String(value ?? "") > String(operand)
    case "on_or_after":
      return String(value ?? "") >= String(operand)
    case "before":
      return String(value ?? "") < String(operand)
    case "on_or_before":
      return String(value ?? "") !== "" && String(value) <= String(operand)
    default:
      throw badRequest(`filter condition "${op}" is not implemented by the fake Notion server`)
  }
}

function numeric(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true
  if (Array.isArray(value)) return value.length === 0
  return false
}

function applySorts(
  rows: PageRecord[],
  sorts: Array<Record<string, unknown>>,
  ds: DataSourceRecord,
): PageRecord[] {
  // Stable: `Array.prototype.sort` is spec-stable, so equal keys keep insertion
  // (creation) order — the same tie-breaking a real query exhibits.
  return [...rows].sort((a, b) => {
    for (const sort of sorts) {
      const direction = sort.direction === "descending" ? -1 : 1
      let av: unknown
      let bv: unknown
      if (typeof sort.timestamp === "string") {
        const key = sort.timestamp === "last_edited_time" ? "lastEditedTime" : "createdTime"
        av = a[key as "createdTime"]
        bv = b[key as "createdTime"]
      } else {
        const name = String(sort.property ?? "")
        const def = ds.properties.find((p) => p.name === name || p.id === name)
        if (!def) throw badRequest(`Could not find property with name or id: ${name}`)
        av = scalarOf(def, a.values[def.name])
        bv = scalarOf(def, b.values[def.name])
      }
      const cmp = compare(av, bv)
      if (cmp !== 0) return cmp * direction
    }
    return 0
  })
}

function compare(a: unknown, b: unknown): number {
  const aEmpty = a === null || a === undefined || a === ""
  const bEmpty = b === null || b === undefined || b === ""
  if (aEmpty && bEmpty) return 0
  if (aEmpty) return 1 // Notion sorts empties last
  if (bEmpty) return -1
  if (typeof a === "number" && typeof b === "number") return a - b
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1
  return String(a).localeCompare(String(b), "en")
}

// ---------------------------------------------------------------------------
// Property encoding
// ---------------------------------------------------------------------------

function buildSchema(raw: Record<string, unknown>, store: Store): PropertyDef[] {
  const props: PropertyDef[] = []
  for (const [name, value] of Object.entries(raw)) {
    const def = (value ?? {}) as Record<string, unknown>
    const type = detectType(def)
    if (!type) throw badRequest(`property "${name}" declares no known type`)
    props.push({
      id: type === "title" ? "title" : store.nextPropertyId(),
      name,
      type,
      config: (def[type] ?? {}) as Record<string, unknown>,
    })
  }
  if (!props.some((p) => p.type === "title")) {
    throw badRequest("a data source schema must contain exactly one title property")
  }
  return props
}

function detectType(def: Record<string, unknown>): string | undefined {
  if (typeof def.type === "string" && (TYPE_KEYS as readonly string[]).includes(def.type)) return def.type
  for (const key of TYPE_KEYS) {
    if (key in def) return key
  }
  return undefined
}

/**
 * Accept a `properties` payload keyed by property name *or* id, drop the type
 * envelope, and reject unknown properties — which is how the fake server catches
 * an oracle that misspells a column.
 */
function normalizeProperties(
  raw: unknown,
  ds: DataSourceRecord,
  _store: Store,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!raw || typeof raw !== "object") return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const def = ds.properties.find((p) => p.name === key || p.id === key)
    if (!def) {
      throw badRequest(
        `${key} is not a property that exists. Known properties: ${ds.properties.map((p) => p.name).join(", ")}`,
      )
    }
    const payload = (value ?? {}) as Record<string, unknown>
    const inner = def.type in payload ? payload[def.type] : undefined
    if (inner === undefined) {
      throw badRequest(`property "${def.name}" is a ${def.type}; payload must carry a \`${def.type}\` key`)
    }
    out[def.name] = inner
    if (def.type === "select" && inner !== null) {
      ensureOption(def, (inner as { name?: string }).name)
    }
    if (def.type === "multi_select" && Array.isArray(inner)) {
      for (const option of inner as Array<{ name?: string }>) ensureOption(def, option.name)
    }
  }
  return out
}

/** Notion auto-creates unseen select options; mirror that so writes never 400. */
function ensureOption(def: PropertyDef, name: string | undefined): void {
  if (!name) return
  const options = (def.config.options ?? []) as Array<{ name: string; color?: string }>
  if (options.some((o) => o.name === name)) return
  options.push({ name, color: "default" })
  def.config.options = options
}

function scalarOf(def: PropertyDef, stored: unknown): unknown {
  switch (def.type) {
    case "title":
    case "rich_text":
      return plainText(stored)
    case "number":
      return typeof stored === "number" ? stored : null
    case "select":
    case "status":
      return (stored as { name?: string } | null)?.name ?? null
    case "multi_select":
      return ((stored as Array<{ name?: string }>) ?? []).map((o) => o.name ?? "")
    case "date":
      return (stored as { start?: string } | null)?.start ?? null
    case "checkbox":
      return stored === true
    default:
      return stored ?? null
  }
}

function emptyValue(type: string): unknown {
  switch (type) {
    case "title":
    case "rich_text":
    case "multi_select":
    case "people":
    case "files":
    case "relation":
      return []
    case "checkbox":
      return false
    default:
      return null
  }
}

function serializeProperty(def: PropertyDef, stored: unknown): Record<string, unknown> {
  return {
    id: def.id,
    type: def.type,
    [def.type]: stored === undefined ? emptyValue(def.type) : stored,
  }
}

function titleOfValues(values: Record<string, unknown>, ds: DataSourceRecord): string {
  const def = ds.properties.find((p) => p.type === "title")
  return def ? plainText(values[def.name]) : ""
}

function extractTitleText(properties: unknown): string {
  if (!properties || typeof properties !== "object") return ""
  for (const value of Object.values(properties as Record<string, unknown>)) {
    const v = (value ?? {}) as Record<string, unknown>
    if (Array.isArray(v.title)) return plainText(v.title)
  }
  return ""
}

function plainText(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value
    .map((part) => {
      const p = (part ?? {}) as { plain_text?: unknown; text?: { content?: unknown } }
      if (typeof p.plain_text === "string") return p.plain_text
      if (typeof p.text?.content === "string") return p.text.content
      return ""
    })
    .join("")
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializePage(page: PageRecord, store: Store): unknown {
  let properties: Record<string, unknown>
  if (page.dataSourceId) {
    const ds = store.dataSources.get(page.dataSourceId)
    properties = {}
    for (const def of ds?.properties ?? []) {
      properties[def.name] = serializeProperty(def, page.values[def.name])
    }
  } else {
    properties = { title: { id: "title", type: "title", title: richText(page.title) } }
  }
  return {
    object: "page",
    id: page.id,
    created_time: page.createdTime,
    last_edited_time: page.lastEditedTime,
    created_by: { object: "user", id: botUser().id },
    last_edited_by: { object: "user", id: botUser().id },
    cover: page.cover,
    icon: page.icon,
    parent: page.parent,
    archived: page.inTrash,
    in_trash: page.inTrash,
    properties,
    url: `https://www.notion.so/${page.id.replace(/-/g, "")}`,
    public_url: null,
  }
}

function serializeDatabase(db: DatabaseRecord, store: Store): unknown {
  return {
    object: "database",
    id: db.id,
    created_time: db.createdTime,
    last_edited_time: db.lastEditedTime,
    title: richText(db.title),
    description: [],
    icon: db.icon,
    cover: null,
    parent: db.parent,
    archived: db.inTrash,
    in_trash: db.inTrash,
    is_inline: false,
    // The 2025-09-03 split, made visible: schema and rows live over here.
    data_sources: db.dataSourceIds.map((id) => ({
      id,
      name: store.dataSources.get(id)?.name ?? "",
    })),
    url: `https://www.notion.so/${db.id.replace(/-/g, "")}`,
  }
}

function serializeDataSource(ds: DataSourceRecord, store: Store): unknown {
  const db = store.databases.get(ds.databaseId)
  const properties: Record<string, unknown> = {}
  for (const def of ds.properties) {
    properties[def.name] = { id: def.id, name: def.name, type: def.type, [def.type]: def.config }
  }
  return {
    object: "data_source",
    id: ds.id,
    created_time: ds.createdTime,
    last_edited_time: ds.lastEditedTime,
    name: ds.name,
    title: richText(ds.name),
    description: [],
    properties,
    parent: { type: "database_id", database_id: ds.databaseId },
    database_parent: db?.parent ?? null,
    archived: db?.inTrash ?? false,
    in_trash: db?.inTrash ?? false,
  }
}

function serializeBlock(block: BlockRecord): Record<string, unknown> {
  return {
    object: "block",
    id: block.id,
    parent: { type: "block_id", block_id: block.parentId },
    type: block.type,
    [block.type]: block.payload,
    has_children: block.children.length > 0,
    archived: block.inTrash,
    in_trash: block.inTrash,
    created_time: block.createdTime,
    last_edited_time: block.lastEditedTime,
  }
}

function richText(text: string): Array<Record<string, unknown>> {
  if (!text) return []
  return [
    {
      type: "text",
      text: { content: text, link: null },
      annotations: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: "default",
      },
      plain_text: text,
      href: null,
    },
  ]
}

// ---------------------------------------------------------------------------
// Standalone: `node evals/_lib/live/fake-notion.ts` for manual poking.
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const portArg = process.argv.indexOf("--port")
  const server = await startFakeNotion({
    port: portArg > -1 ? Number(process.argv[portArg + 1]) : 0,
  })
  console.log(
    JSON.stringify(
      {
        NOTION_API_BASE: server.url,
        NOTION_API_TOKEN: server.token,
        NOTION_PARENT_PAGE_ID: server.parentPageId,
      },
      null,
      2,
    ),
  )
}
