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
 * Since the second wave of live tasks it also models, at 2026-03-11 semantics:
 *
 *  - **views** — `GET /v1/views?database_id=` returns `{object, id}` *stubs*
 *    (the real list endpoint does too, which is the whole reason
 *    `investigate-views-001` is a two-request task), `GET /v1/views/{id}`
 *    returns the full object with `type`/`filter`/`sorts`/`configuration`;
 *  - **comments** — `POST /v1/comments` (new discussion via `parent`, reply via
 *    `discussion_id`) and `GET /v1/comments?block_id=`, which returns the
 *    comments whose parent is *exactly* that block and does not recurse into
 *    children — the trap `investigate-comments-001` is built on;
 *  - **users** — `GET /v1/users` (bot first, then the workspace's people) and
 *    `GET /v1/users/{id}`, so "which id is the integration?" is answerable and
 *    gettable wrong;
 *  - **file uploads** — `POST /v1/file_uploads`, the multipart
 *    `POST /v1/file_uploads/{id}/send`, retrieve and list; attaching an
 *    `{type: "file_upload"}` reference to a `files` property, a block payload or
 *    a page icon/cover rewrites it into the `{type: "file", file: {url}}` shape
 *    the API hands back, exactly as the real service does.
 *
 * What it still does not model: permissions, relations/rollups/formulas, rate
 * limits, multi-part uploads beyond a single part. Add endpoints when a task
 * needs them, not before.
 *
 * Determinism: ids come from a counter (never `crypto.randomUUID`), timestamps
 * from a virtual clock that advances 1 ms per mutation (never `Date.now`), and
 * the listener binds to port 0. Nothing here reads the wall clock, so QC output
 * is byte-stable and no test ever sleeps. Objects added after the first wave
 * (views, comments, file uploads) draw ids from their own counters in their own
 * uuid variant slot, so switching them on cannot shift a single page or block id
 * that an earlier task's QC already depends on.
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

interface ViewRecord {
  id: string
  kind: "view"
  databaseId: string
  dataSourceId: string | null
  name: string
  type: string
  filter: unknown
  sorts: unknown
  configuration: unknown
  createdTime: string
  lastEditedTime: string
}

interface CommentRecord {
  id: string
  kind: "comment"
  /** `page_id` for a page-level discussion, `block_id` for an inline one. */
  parentType: "page_id" | "block_id"
  parentId: string
  discussionId: string
  richText: unknown[]
  displayName: unknown
  createdTime: string
  lastEditedTime: string
}

interface FileUploadRecord {
  id: string
  kind: "file_upload"
  mode: string
  filename: string | null
  contentType: string | null
  contentLength: number | null
  status: "pending" | "uploaded" | "expired" | "failed"
  externalUrl: string | null
  createdTime: string
  lastEditedTime: string
}

interface UserRecord {
  id: string
  kind: "user"
  name: string
  type: "person" | "bot"
  email?: string
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
  views = new Map<string, ViewRecord>()
  comments = new Map<string, CommentRecord>()
  fileUploads = new Map<string, FileUploadRecord>()
  /**
   * The server's own origin, filled in once the listener has a port.
   *
   * Only `upload_url` needs it: the reference says that field is an absolute
   * URL, and a client that POSTs the bytes to whatever it was handed must reach
   * this server, not api.notion.com.
   */
  baseUrl = ""
  #seq = 0
  #tick = 0
  /**
   * One counter per late-added object kind, in its own uuid variant slot.
   *
   * Sharing `#seq` would have been simpler and wrong: creating a database now
   * also creates its default view, and if that consumed a `#seq` tick every
   * page and block id minted afterwards would shift. Tasks written against the
   * first wave of endpoints must keep observing byte-identical ids.
   */
  #auxSeq = new Map<string, number>()

  /** Deterministic uuid-shaped id: counter in the last 12 hex digits. */
  nextId(): string {
    const n = ++this.#seq
    const hex = n.toString(16).padStart(12, "0")
    return `00000000-0000-4000-8000-${hex}`
  }

  /** Same shape, but namespaced by `variant` so `nextId()`'s stream is untouched. */
  nextAuxId(variant: "a" | "b" | "c"): string {
    const n = (this.#auxSeq.get(variant) ?? 0) + 1
    this.#auxSeq.set(variant, n)
    return `00000000-0000-4000-${variant}000-${n.toString(16).padStart(12, "0")}`
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
    this.views.clear()
    this.comments.clear()
    this.fileUploads.clear()
    this.#seq = 0
    this.#tick = 0
    this.#auxSeq.clear()
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
  store.baseUrl = url

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
    // `POST /v1/file_uploads/{id}/send` is the one endpoint whose body is not
    // JSON, so it is answered before the JSON reader ever sees the stream.
    const segments = url.pathname.split("/").filter(Boolean)
    if (method === "POST" && segments[0] === "v1" && segments[1] === "file_uploads" && segments[3] === "send") {
      const raw = await readRawBody(req)
      send(res, 200, sendFileUpload(segments[2], raw, req.headers["content-type"], ctx.store))
      return
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

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
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
      if (!id && method === "GET") return listUsers(url)
      if (id && method === "GET") return retrieveUser(id)
      break

    case "views":
      // No `POST /v1/views` in the public reference; provisioning needs one, so
      // it lives here as an explicitly fake-only affordance. Nothing an agent is
      // graded on may call it — tasks only ever read views.
      if (method === "POST" && !id) return createView(body, store)
      if (!id && method === "GET") return listViews(url, store)
      if (id && method === "GET") return serializeView(requireView(id, store))
      break

    case "comments":
      if (method === "POST" && !id) return createComment(body, store)
      if (!id && method === "GET") return listComments(url, store)
      if (id && method === "GET") return serializeComment(requireComment(id, store))
      break

    case "file_uploads":
      if (method === "POST" && !id) return createFileUpload(body, store)
      if (!id && method === "GET") return listFileUploads(url, store)
      if (id && method === "GET") return serializeFileUpload(requireFileUpload(id, store), store)
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

function requireView(id: string, store: Store): ViewRecord {
  const view = store.views.get(id)
  if (!view) throw notFound(`Could not find view with ID: ${id}.`)
  return view
}

function requireComment(id: string, store: Store): CommentRecord {
  const comment = store.comments.get(id)
  if (!comment) throw notFound(`Could not find comment with ID: ${id}.`)
  return comment
}

function requireFileUpload(id: string, store: Store): FileUploadRecord {
  const upload = store.fileUploads.get(id)
  if (!upload) throw notFound(`Could not find file upload with ID: ${id}.`)
  return upload
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
      icon: resolveUploadRefs(body.icon, store),
      cover: resolveUploadRefs(body.cover, store),
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
    icon: resolveUploadRefs(body.icon, store),
    cover: resolveUploadRefs(body.cover, store),
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
  if ("icon" in body) page.icon = resolveUploadRefs(body.icon, store)
  if ("cover" in body) page.cover = resolveUploadRefs(body.cover, store)
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
  // Real Notion gives every new database a default table view. A task whose
  // wrong answer is "reported the default view only" needs that default to
  // exist without anyone asking for it.
  addView(store, {
    databaseId: dbId,
    dataSourceId: dsId,
    name: ds.name,
    type: "table",
    filter: null,
    sorts: null,
    configuration: { type: "table" },
  })
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
    const payload = resolveUploadRefs((spec[type] ?? {}) as Record<string, unknown>, store) as Record<
      string,
      unknown
    >
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

// ---------------------------------------------------------------------------
// Users
//
// The workspace has one bot (the integration itself) and a handful of people.
// The distinction is the entire subject of `investigate-users-001`: `users/me`
// answers "which user am I", `GET /v1/users` answers "who else is here", and
// picking a row out of the second when the question was the first is the
// mistake the task is built to catch. People are seeded unconditionally because
// a workspace with no members is not a workspace.
// ---------------------------------------------------------------------------

const BOT_ID = "00000000-0000-4000-9000-00000000bot0"
const WORKSPACE_ID = "00000000-0000-4000-9000-0000000wksp"
const WORKSPACE_NAME = "NotionBench Fake Workspace"

/** Fixed, ordered, and never regenerated — ids are part of the QC contract. */
const PEOPLE: UserRecord[] = [
  { id: "00000000-0000-4000-9000-000000000p01", kind: "user", name: "Ada Okonkwo", type: "person", email: "ada@notionbench.test" },
  { id: "00000000-0000-4000-9000-000000000p02", kind: "user", name: "Bruno Salas", type: "person", email: "bruno@notionbench.test" },
  { id: "00000000-0000-4000-9000-000000000p03", kind: "user", name: "Chen Wei", type: "person", email: "chen@notionbench.test" },
]

function botUser(): Record<string, unknown> {
  return {
    object: "user",
    id: BOT_ID,
    name: "NotionBench Fixture Bot",
    avatar_url: null,
    type: "bot",
    bot: {
      owner: { type: "workspace", workspace: true },
      workspace_name: WORKSPACE_NAME,
      workspace_id: WORKSPACE_ID,
    },
  }
}

function serializeUser(user: UserRecord): Record<string, unknown> {
  return {
    object: "user",
    id: user.id,
    name: user.name,
    avatar_url: null,
    type: "person",
    person: { email: user.email ?? null },
  }
}

/** The bot first, then the people — the order the real endpoint happens to use. */
function allUsers(): Array<Record<string, unknown>> {
  return [botUser(), ...PEOPLE.map(serializeUser)]
}

function listUsers(url: URL): unknown {
  const pageSize = url.searchParams.get("page_size")
  const { slice, nextCursor, hasMore } = paginate(
    allUsers(),
    pageSize === null ? undefined : Number(pageSize),
    url.searchParams.get("start_cursor") ?? undefined,
  )
  return list(slice, nextCursor, hasMore, { type: "user", user: {} })
}

function retrieveUser(id: string): unknown {
  const found = allUsers().find((u) => u.id === id)
  if (!found) throw notFound(`Could not find user with ID: ${id}.`)
  return found
}

// ---------------------------------------------------------------------------
// Views
//
// `GET /v1/views` returns **stubs** — `{object, id}` and nothing else. That is
// not a shortcut here; it is what the published reference specifies, and it is
// why reporting on a database's views is a list-then-retrieve loop rather than
// one call. `investigate-views-001` grades exactly that.
// ---------------------------------------------------------------------------

interface ViewInit {
  databaseId: string
  dataSourceId: string | null
  name: string
  type: string
  filter?: unknown
  sorts?: unknown
  configuration?: unknown
}

function addView(store: Store, init: ViewInit): ViewRecord {
  const time = store.now()
  const view: ViewRecord = {
    id: store.nextAuxId("a"),
    kind: "view",
    databaseId: init.databaseId,
    dataSourceId: init.dataSourceId,
    name: init.name,
    type: init.type,
    filter: init.filter ?? null,
    sorts: init.sorts ?? null,
    configuration: init.configuration ?? null,
    createdTime: time,
    lastEditedTime: time,
  }
  store.views.set(view.id, view)
  return view
}

function createView(body: Record<string, unknown>, store: Store): unknown {
  const parent = (body.parent ?? {}) as Record<string, unknown>
  const databaseId =
    typeof body.database_id === "string"
      ? body.database_id
      : typeof parent.database_id === "string"
        ? parent.database_id
        : undefined
  let dataSourceId = typeof body.data_source_id === "string" ? body.data_source_id : undefined
  if (!databaseId && !dataSourceId) throw badRequest("a view needs a database_id or a data_source_id")

  const db = databaseId
    ? requireDatabase(databaseId, store)
    : requireDatabase(requireDataSource(dataSourceId as string, store).databaseId, store)
  if (!dataSourceId) dataSourceId = db.dataSourceIds[0]
  if (dataSourceId) requireDataSource(dataSourceId, store)

  const type = typeof body.type === "string" ? body.type : "table"
  const name = typeof body.name === "string" ? body.name : plainText(body.title) || type
  return serializeView(
    addView(store, {
      databaseId: db.id,
      dataSourceId: dataSourceId ?? null,
      name,
      type,
      filter: body.filter ?? null,
      sorts: body.sorts ?? null,
      configuration: body.configuration ?? { type },
    }),
  )
}

function listViews(url: URL, store: Store): unknown {
  const databaseId = url.searchParams.get("database_id")
  const dataSourceId = url.searchParams.get("data_source_id")
  if (!databaseId && !dataSourceId) {
    throw badRequest("GET /v1/views requires either database_id or data_source_id")
  }
  if (databaseId) requireDatabase(databaseId, store)
  if (dataSourceId) requireDataSource(dataSourceId, store)

  const matches = [...store.views.values()].filter(
    (v) =>
      (!databaseId || v.databaseId === databaseId) && (!dataSourceId || v.dataSourceId === dataSourceId),
  )
  const pageSize = url.searchParams.get("page_size")
  const { slice, nextCursor, hasMore } = paginate(
    // Stubs, deliberately: the caller must retrieve each id to learn anything.
    matches.map((v) => ({ object: "view", id: v.id })),
    pageSize === null ? undefined : Number(pageSize),
    url.searchParams.get("start_cursor") ?? undefined,
  )
  return list(slice, nextCursor, hasMore, { type: "view", view: {} })
}

function serializeView(view: ViewRecord): Record<string, unknown> {
  return {
    object: "view",
    id: view.id,
    parent: { type: "database_id", database_id: view.databaseId },
    data_source_id: view.dataSourceId,
    name: view.name,
    type: view.type,
    filter: view.filter,
    sorts: view.sorts,
    configuration: view.configuration,
    created_time: view.createdTime,
    last_edited_time: view.lastEditedTime,
    created_by: { object: "user", id: BOT_ID },
    last_edited_by: { object: "user", id: BOT_ID },
    url: `https://www.notion.so/${view.databaseId.replace(/-/g, "")}?v=${view.id.replace(/-/g, "")}`,
  }
}

// ---------------------------------------------------------------------------
// Comments
//
// `GET /v1/comments?block_id=X` returns every comment whose parent is *X*, in
// creation order, replies included — and it does **not** walk into X's children.
// So "all the comments on this page" is a tree walk plus one request per block,
// not one request. That asymmetry is the subject of
// `investigate-comments-001`; do not "helpfully" recurse here.
// ---------------------------------------------------------------------------

function createComment(body: Record<string, unknown>, store: Store): unknown {
  const parent = (body.parent ?? {}) as Record<string, unknown>
  const discussionId = typeof body.discussion_id === "string" ? body.discussion_id : undefined
  const parentPageId = typeof parent.page_id === "string" ? parent.page_id : undefined
  const parentBlockId = typeof parent.block_id === "string" ? parent.block_id : undefined
  const given = [discussionId, parentPageId, parentBlockId].filter(Boolean).length
  if (given !== 1) {
    throw badRequest("exactly one of parent.page_id, parent.block_id or discussion_id must be provided")
  }

  const rich = Array.isArray(body.rich_text)
    ? (body.rich_text as unknown[])
    : typeof body.markdown === "string"
      ? richText(body.markdown)
      : undefined
  if (!rich) throw badRequest("a comment needs rich_text or markdown")

  let parentType: "page_id" | "block_id"
  let parentId: string
  let discussion: string
  if (discussionId) {
    const sibling = [...store.comments.values()].find((c) => c.discussionId === discussionId)
    if (!sibling) throw notFound(`Could not find discussion with ID: ${discussionId}.`)
    parentType = sibling.parentType
    parentId = sibling.parentId
    discussion = discussionId
  } else if (parentPageId) {
    requirePage(parentPageId, store)
    parentType = "page_id"
    parentId = parentPageId
    discussion = store.nextAuxId("b")
  } else {
    // A block id, but a page *is* a block as far as parenting goes.
    const blockId = parentBlockId as string
    if (!store.blocks.has(blockId) && !store.pages.has(blockId)) {
      throw notFound(`Could not find block with ID: ${blockId}.`)
    }
    parentType = "block_id"
    parentId = blockId
    discussion = store.nextAuxId("b")
  }

  const time = store.now()
  const comment: CommentRecord = {
    id: store.nextAuxId("b"),
    kind: "comment",
    parentType,
    parentId,
    discussionId: discussion,
    richText: rich,
    displayName: { type: "integration" },
    createdTime: time,
    lastEditedTime: time,
  }
  store.comments.set(comment.id, comment)
  return serializeComment(comment)
}

function listComments(url: URL, store: Store): unknown {
  const blockId = url.searchParams.get("block_id")
  if (!blockId) throw badRequest("GET /v1/comments requires a block_id")
  if (!store.blocks.has(blockId) && !store.pages.has(blockId)) {
    throw notFound(`Could not find block with ID: ${blockId}.`)
  }
  // Insertion order is creation order, which is the ascending chronological
  // order the reference promises.
  const matches = [...store.comments.values()].filter((c) => c.parentId === blockId)
  const pageSize = url.searchParams.get("page_size")
  const { slice, nextCursor, hasMore } = paginate(
    matches.map(serializeComment),
    pageSize === null ? undefined : Number(pageSize),
    url.searchParams.get("start_cursor") ?? undefined,
  )
  return list(slice, nextCursor, hasMore, { type: "comment", comment: {} })
}

function serializeComment(comment: CommentRecord): Record<string, unknown> {
  return {
    object: "comment",
    id: comment.id,
    parent: { type: comment.parentType, [comment.parentType]: comment.parentId },
    discussion_id: comment.discussionId,
    created_time: comment.createdTime,
    last_edited_time: comment.lastEditedTime,
    created_by: { object: "user", id: BOT_ID },
    rich_text: comment.richText,
    display_name: comment.displayName,
    attachments: [],
  }
}

// ---------------------------------------------------------------------------
// File uploads
//
// Three steps, exactly as documented: create the upload (status `pending`,
// carrying an `upload_url`), POST the bytes as `multipart/form-data` to that
// url (status becomes `uploaded`), then reference `{type: "file_upload", id}`
// wherever a file goes. The reference is rewritten on write into the
// `{type: "file", file: {url, expiry_time}}` shape reads hand back — an
// attachment that still says `file_upload` after a round-trip would let a
// verifier pass a solution that never actually uploaded anything.
// ---------------------------------------------------------------------------

/** One hour after creation, derived — never `Date.now()`. */
function expiryOf(created: string): string {
  return new Date(Date.parse(created) + 3600_000).toISOString().replace(/\.\d{3}Z$/, ".000Z")
}

function createFileUpload(body: Record<string, unknown>, store: Store): unknown {
  const mode = typeof body.mode === "string" ? body.mode : "single_part"
  if (mode !== "single_part" && mode !== "external_url") {
    throw badRequest(`file upload mode "${mode}" is not modelled by the fake Notion server`)
  }
  const externalUrl = typeof body.external_url === "string" ? body.external_url : null
  if (mode === "external_url" && !externalUrl) throw badRequest("external_url mode requires external_url")

  const time = store.now()
  const upload: FileUploadRecord = {
    id: store.nextAuxId("c"),
    kind: "file_upload",
    mode,
    filename: typeof body.filename === "string" ? body.filename : null,
    contentType: typeof body.content_type === "string" ? body.content_type : null,
    contentLength: null,
    // An imported URL needs no `send` step, so it lands ready to attach.
    status: mode === "external_url" ? "uploaded" : "pending",
    externalUrl,
    createdTime: time,
    lastEditedTime: time,
  }
  store.fileUploads.set(upload.id, upload)
  return serializeFileUpload(upload, store)
}

/**
 * `POST /v1/file_uploads/{id}/send`.
 *
 * Accepts `multipart/form-data` with a single `file` part (what the reference
 * specifies and what `ntn files create` sends) and, as a courtesy to hand-rolled
 * clients, a raw body.
 */
function sendFileUpload(
  id: string,
  raw: Buffer,
  contentType: string | undefined,
  store: Store,
): unknown {
  const upload = requireFileUpload(id, store)
  if (upload.status === "uploaded") throw badRequest(`file upload ${id} has already been sent`)

  const part = parseMultipart(raw, contentType)
  upload.contentLength = part.content.length
  if (part.filename) upload.filename = part.filename
  if (part.contentType) upload.contentType = part.contentType
  upload.status = "uploaded"
  upload.lastEditedTime = store.now()
  return serializeFileUpload(upload, store)
}

interface MultipartPart {
  content: Buffer
  filename?: string
  contentType?: string
}

function parseMultipart(raw: Buffer, contentType: string | undefined): MultipartPart {
  const boundaryMatch = /boundary="?([^";]+)"?/i.exec(contentType ?? "")
  if (!boundaryMatch) return { content: raw }
  const delimiter = Buffer.from(`--${boundaryMatch[1]}`, "utf8")

  let cursor = raw.indexOf(delimiter)
  while (cursor !== -1) {
    const start = cursor + delimiter.length
    if (raw.slice(start, start + 2).toString("utf8") === "--") break // closing delimiter
    const headerEnd = raw.indexOf("\r\n\r\n", start)
    if (headerEnd === -1) break
    const headers = raw.slice(start, headerEnd).toString("utf8")
    const next = raw.indexOf(delimiter, headerEnd)
    // Content runs up to the CRLF that introduces the next delimiter.
    const contentEnd = next === -1 ? raw.length : next - 2
    const content = raw.slice(headerEnd + 4, Math.max(headerEnd + 4, contentEnd))
    if (/name="?file"?/i.test(headers)) {
      return {
        content,
        filename: /filename="([^"]*)"/i.exec(headers)?.[1] || undefined,
        contentType: /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.trim() || undefined,
      }
    }
    cursor = next
  }
  return { content: raw }
}

function listFileUploads(url: URL, store: Store): unknown {
  const wantStatus = url.searchParams.get("status")
  const matches = [...store.fileUploads.values()].filter((u) => !wantStatus || u.status === wantStatus)
  const pageSize = url.searchParams.get("page_size")
  const { slice, nextCursor, hasMore } = paginate(
    matches.map((u) => serializeFileUpload(u, store)),
    pageSize === null ? undefined : Number(pageSize),
    url.searchParams.get("start_cursor") ?? undefined,
  )
  return list(slice, nextCursor, hasMore, { type: "file_upload", file_upload: {} })
}

function serializeFileUpload(upload: FileUploadRecord, store: Store): Record<string, unknown> {
  return {
    object: "file_upload",
    id: upload.id,
    created_time: upload.createdTime,
    last_edited_time: upload.lastEditedTime,
    created_by: { id: BOT_ID, type: "bot" },
    status: upload.status,
    mode: upload.mode,
    filename: upload.filename,
    content_type: upload.contentType,
    content_length: upload.contentLength,
    expiry_time: upload.status === "pending" ? expiryOf(upload.createdTime) : null,
    ...(upload.status === "pending"
      ? { upload_url: `${store.baseUrl}/v1/file_uploads/${upload.id}/send` }
      : {}),
    number_of_parts: { total: 1, sent: upload.status === "uploaded" ? 1 : 0 },
  }
}

/** The `{name, type: "file", file: {url, expiry_time}}` an attached upload reads back as. */
function fileObjectFor(upload: FileUploadRecord, name: string | undefined, store: Store): Record<string, unknown> {
  const filename = name ?? upload.filename ?? "untitled"
  if (upload.externalUrl) {
    return { name: filename, type: "external", external: { url: upload.externalUrl } }
  }
  const time = store.now()
  return {
    name: filename,
    type: "file",
    file: {
      url: `https://prod-files-secure.s3.us-west-2.amazonaws.com/${upload.id}/${encodeURIComponent(filename)}`,
      expiry_time: expiryOf(time),
    },
  }
}

/** A `files` property value: a list of external links and/or uploaded files. */
function attachFiles(value: unknown, store: Store): unknown {
  if (!Array.isArray(value)) return value
  return value.map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>
    if (e.type !== "file_upload" && !e.file_upload) return entry
    const ref = (e.file_upload ?? {}) as { id?: unknown }
    const uploadId = typeof ref.id === "string" ? ref.id : undefined
    if (!uploadId) throw badRequest("a file_upload attachment needs file_upload.id")
    const upload = requireFileUpload(uploadId, store)
    if (upload.status !== "uploaded") {
      throw badRequest(
        `file upload ${uploadId} is ${upload.status}; only an uploaded file can be attached ` +
          `(send the bytes to /v1/file_uploads/${uploadId}/send first)`,
      )
    }
    return fileObjectFor(upload, typeof e.name === "string" ? e.name : undefined, store)
  })
}

/**
 * Rewrite every `{type: "file_upload", …}` reference anywhere inside a payload.
 * Used for block payloads, page icons and page covers; the `files` property goes
 * through `attachFiles` instead, because a property value is a bare array.
 */
function resolveUploadRefs(value: unknown, store: Store): unknown {
  if (value === undefined) return null
  if (value === null || typeof value !== "object") return value
  // Cheap bail-out: the overwhelming majority of payloads mention no upload at
  // all, and rebuilding every rich-text array on every block append is waste.
  if (!JSON.stringify(value).includes("file_upload")) return value
  if (Array.isArray(value)) return value.map((v) => resolveUploadRefs(v, store))

  const obj = value as Record<string, unknown>
  if (obj.type === "file_upload" && obj.file_upload && typeof obj.file_upload === "object") {
    const uploadId = (obj.file_upload as { id?: unknown }).id
    if (typeof uploadId !== "string") throw badRequest("a file_upload reference needs file_upload.id")
    const upload = requireFileUpload(uploadId, store)
    if (upload.status !== "uploaded") {
      throw badRequest(
        `file upload ${uploadId} is ${upload.status}; only an uploaded file can be attached ` +
          `(send the bytes to /v1/file_uploads/${uploadId}/send first)`,
      )
    }
    const attached = fileObjectFor(upload, typeof obj.name === "string" ? obj.name : undefined, store)
    // Block payloads carry a caption alongside the file; keep it.
    return obj.caption === undefined ? attached : { ...attached, caption: obj.caption }
  }

  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(obj)) out[key] = resolveUploadRefs(inner, store)
  return out
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function renderMarkdown(pageId: string, store: Store): string {
  const page = requirePage(pageId, store)
  // Real Notion does NOT render the page title into the markdown body — a page
  // whose first block is `## Overview` comes back starting at `## Overview`.
  // Emitting a `# <title>` line here made a leading title look normal, which is
  // exactly the round-trip mistake build-pages-001 exists to catch.
  void page
  const lines: string[] = []
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

/**
 * Whole-page replace. Enough to exercise a markdown-clobber task's verifier.
 *
 * The real endpoint takes a discriminated union — `{type: "replace_content",
 * replace_content: {new_str}}` and three siblings — and rejects a bare
 * `{markdown}` with "body.type should be defined". Accepting the loose shape
 * here let an oracle ship that could never run against api.notion.com.
 */
function updateMarkdown(pageId: string, body: Record<string, unknown>, store: Store): unknown {
  const page = requirePage(pageId, store)
  if (typeof body.type !== "string") throw badRequest("body.type should be defined")
  if (body.type !== "replace_content") {
    throw badRequest(`fake-notion implements only type="replace_content", got "${body.type}"`)
  }
  const replace = (body.replace_content ?? {}) as { new_str?: unknown }
  const markdown = typeof replace.new_str === "string" ? replace.new_str : undefined
  if (markdown === undefined) throw badRequest("replace_content.new_str is required")
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
    out[def.name] = def.type === "files" ? attachFiles(inner, _store) : inner
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
