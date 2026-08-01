/**
 * Minimal Notion REST client for the `live` runtime.
 *
 * Why not `@notionhq/client`? Everything under `evals/_lib/` is deliberately
 * dependency-free (see `proc.ts`) so a verifier can be executed with a bare
 * `node evals/<id>/EVAL.ts` and CI's `pnpm install --frozen-lockfile` never has
 * to be unblocked by a lockfile edit. The surface a live task actually touches
 * is ~15 endpoints, so this file *is* the client: plain `fetch`, no runtime
 * deps, and — crucially — an exact, auditable record of the wire traffic that
 * `fake-notion.ts` has to implement for offline QC.
 *
 * Two things every caller inherits for free:
 *
 *  - **`NOTION_API_BASE`** is honored everywhere (default
 *    `https://api.notion.com`). QC points it at the in-process fake server;
 *    real runs leave it unset.
 *  - **Pacing is base-URL aware.** Against `api.notion.com` requests are
 *    serialized to ~2.5/s (docs/PLAN.md "Fixtures & isolation") and 429/5xx are
 *    retried with backoff. Against anything else — i.e. the fake server — the
 *    interval is 0 and nothing ever sleeps, which is what keeps QC
 *    wall-clock-independent.
 *
 * API version is pinned to 2026-03-11. Note the post-2025-09-03 object split:
 * a *database* is a container whose schema and rows live on one or more
 * *data sources*. Rows are created with `parent: {type: "data_source_id"}`,
 * schema edits go to `PATCH /v1/data_sources/{id}`, and queries go to
 * `POST /v1/data_sources/{id}/query`. `database_id` is not interchangeable.
 */

/** Pinned API version. A version bump is a scoring change, so it is explicit. */
export const NOTION_VERSION = "2026-03-11"

/** Notion's own page cap for every paginated endpoint. */
export const MAX_PAGE_SIZE = 100

/** Resolve the API root, honoring `NOTION_API_BASE`. */
export function resolveApiBase(explicit?: string): string {
  const raw = explicit ?? process.env.NOTION_API_BASE ?? "https://api.notion.com"
  return raw.replace(/\/+$/, "")
}

/** True for the real service — the only place pacing and retries matter. */
function isRealNotion(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.endsWith("notion.com")
  } catch {
    return false
  }
}

export class NotionApiError extends Error {
  readonly status: number
  readonly code: string
  readonly body: unknown
  readonly method: string
  readonly path: string

  constructor(args: {
    status: number
    code: string
    message: string
    body: unknown
    method: string
    path: string
  }) {
    super(`${args.method.toUpperCase()} ${args.path} → ${args.status} ${args.code}: ${args.message}`)
    this.name = "NotionApiError"
    this.status = args.status
    this.code = args.code
    this.body = args.body
    this.method = args.method
    this.path = args.path
  }
}

export interface NotionClientOptions {
  /** Integration token. Defaults to `NOTION_API_TOKEN`. */
  auth?: string
  /** API root. Defaults to `NOTION_API_BASE`, then `https://api.notion.com`. */
  baseUrl?: string
  notionVersion?: string
  /** Minimum gap between requests, ms. Defaults to 400 for api.notion.com, 0 elsewhere. */
  minIntervalMs?: number
  /** Retries for 429/5xx. Defaults to 5 for api.notion.com, 0 elsewhere. */
  maxRetries?: number
  /** Per-request timeout. */
  timeoutMs?: number
  /** Injectable for tests. */
  fetchImpl?: typeof fetch
}

export interface RequestOptions {
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
  /** Do not throw on these HTTP statuses; return the parsed body instead. */
  tolerate?: number[]
}

export interface Paginated<T> {
  object: "list"
  results: T[]
  next_cursor: string | null
  has_more: boolean
}

/** Scalar-ish shapes a fixture/verifier deals in, before/after property encoding. */
export type PropValue = string | number | boolean | null | string[]

export interface NotionPage {
  object: "page"
  id: string
  parent: Record<string, unknown>
  properties: Record<string, unknown>
  icon?: unknown
  cover?: unknown
  archived?: boolean
  in_trash?: boolean
  created_time?: string
  last_edited_time?: string
  url?: string
  [key: string]: unknown
}

export interface NotionDataSource {
  object: "data_source"
  id: string
  name?: unknown
  title?: unknown
  properties: Record<string, { id?: string; name?: string; type: string; [key: string]: unknown }>
  parent: Record<string, unknown>
  [key: string]: unknown
}

export interface NotionDatabase {
  object: "database"
  id: string
  title?: unknown
  parent: Record<string, unknown>
  data_sources: Array<{ id: string; name: string }>
  [key: string]: unknown
}

export interface NotionBlock {
  object: "block"
  id: string
  type: string
  has_children?: boolean
  [key: string]: unknown
}

/** `GET /v1/views` hands back `{object, id}` and nothing else — retrieve for the rest. */
export interface NotionViewStub {
  object: "view"
  id: string
}

export interface NotionView extends NotionViewStub {
  name: string
  /** `table` | `board` | `calendar` | `timeline` | `gallery` | `list` | … */
  type: string
  data_source_id: string | null
  filter: unknown
  sorts: unknown
  configuration: unknown
  parent?: Record<string, unknown>
  [key: string]: unknown
}

export interface NotionComment {
  object: "comment"
  id: string
  parent: Record<string, unknown>
  discussion_id: string
  rich_text: unknown[]
  created_time?: string
  created_by?: { id?: string }
  [key: string]: unknown
}

export interface NotionUser {
  object: "user"
  id: string
  name?: string
  type?: "person" | "bot"
  person?: { email?: string | null }
  bot?: {
    owner?: { type?: string; workspace?: boolean }
    workspace_name?: string
    workspace_id?: string
  }
  [key: string]: unknown
}

export interface NotionFileUpload {
  object: "file_upload"
  id: string
  status: "pending" | "uploaded" | "expired" | "failed"
  filename: string | null
  content_type: string | null
  content_length: number | null
  upload_url?: string
  [key: string]: unknown
}

export class NotionClient {
  readonly baseUrl: string
  readonly notionVersion: string
  #auth: string
  #minIntervalMs: number
  #maxRetries: number
  #timeoutMs: number
  #fetch: typeof fetch
  /** Serializes requests so the pacer is a real token bucket, not a suggestion. */
  #chain: Promise<unknown> = Promise.resolve()
  #lastRequestAt = 0
  /** Request counter — surfaced in diagnostics ("did the oracle paginate?"). */
  requestCount = 0

  constructor(opts: NotionClientOptions = {}) {
    this.baseUrl = resolveApiBase(opts.baseUrl)
    const real = isRealNotion(this.baseUrl)
    const auth = opts.auth ?? process.env.NOTION_API_TOKEN
    if (!auth) {
      throw new Error(
        "no Notion token: pass `auth` or set NOTION_API_TOKEN (live tasks lease one per trial)",
      )
    }
    this.#auth = auth
    this.notionVersion = opts.notionVersion ?? NOTION_VERSION
    this.#minIntervalMs = opts.minIntervalMs ?? (real ? 400 : 0)
    this.#maxRetries = opts.maxRetries ?? (real ? 5 : 0)
    this.#timeoutMs = opts.timeoutMs ?? 60_000
    this.#fetch = opts.fetchImpl ?? globalThis.fetch
  }

  /** One raw request, paced and retried. `path` is relative to `/v1`. */
  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    // Chain onto the previous request so `minIntervalMs` actually holds under
    // concurrent callers (e.g. Promise.all over 250 row creations). Unpaced
    // clients — i.e. QC against the fake server — skip the chain entirely, so
    // provisioning a 250-row fixture is as parallel as the caller asks for.
    if (this.#minIntervalMs <= 0) return this.#execute<T>(method, path, opts)
    const run = this.#chain.then(() => this.#execute<T>(method, path, opts))
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async #execute<T>(method: string, path: string, opts: RequestOptions): Promise<T> {
    const url = new URL(`${this.baseUrl}/v1/${path.replace(/^\/+/, "")}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    let attempt = 0
    for (;;) {
      await this.#pace()
      this.requestCount++
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
      let response: Response
      try {
        response = await this.#fetch(url.toString(), {
          method: method.toUpperCase(),
          headers: {
            Authorization: `Bearer ${this.#auth}`,
            "Notion-Version": this.notionVersion,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }

      const text = await response.text()
      let parsed: unknown = undefined
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = text
        }
      }

      if (response.ok) return parsed as T
      if (opts.tolerate?.includes(response.status)) return parsed as T

      const retryable = response.status === 429 || response.status >= 500
      if (retryable && attempt < this.#maxRetries) {
        const headerDelay = Number(response.headers.get("retry-after"))
        const delay = Number.isFinite(headerDelay) && headerDelay > 0
          ? headerDelay * 1000
          : Math.min(30_000, 500 * 2 ** attempt)
        attempt++
        await sleep(delay)
        continue
      }

      const bodyObj = (parsed ?? {}) as { code?: string; message?: string }
      throw new NotionApiError({
        status: response.status,
        code: bodyObj.code ?? `http_${response.status}`,
        message: bodyObj.message ?? String(text).slice(0, 400),
        body: parsed,
        method,
        path,
      })
    }
  }

  async #pace(): Promise<void> {
    if (this.#minIntervalMs <= 0) return
    const wait = this.#lastRequestAt + this.#minIntervalMs - Date.now()
    if (wait > 0) await sleep(wait)
    this.#lastRequestAt = Date.now()
  }

  // ---- pages ---------------------------------------------------------------

  createPage(body: Record<string, unknown>): Promise<NotionPage> {
    return this.request<NotionPage>("post", "pages", { body })
  }

  getPage(pageId: string): Promise<NotionPage> {
    return this.request<NotionPage>("get", `pages/${pageId}`)
  }

  updatePage(pageId: string, body: Record<string, unknown>): Promise<NotionPage> {
    return this.request<NotionPage>("patch", `pages/${pageId}`, { body })
  }

  /**
   * Move a page (and everything under it) to the trash.
   *
   * This is the whole teardown story: archiving the per-trial fixture *root*
   * trashes its subtree. Workspace-level pages cannot be archived through the
   * API at all, which is exactly why provisioning always creates the root under
   * `NOTION_PARENT_PAGE_ID` and never at the workspace level.
   *
   * `in_trash` is the 2025-09-03+ spelling; `archived` is the older one. Older
   * deployments reject the former, so fall back once rather than leaving
   * garbage in a real workspace.
   */
  async archivePage(pageId: string): Promise<NotionPage> {
    try {
      return await this.updatePage(pageId, { in_trash: true })
    } catch (err) {
      if (err instanceof NotionApiError && err.status === 400) {
        return this.updatePage(pageId, { archived: true })
      }
      throw err
    }
  }

  getPageMarkdown(pageId: string): Promise<{ markdown?: string; [key: string]: unknown }> {
    return this.request("get", `pages/${pageId}/markdown`)
  }

  updatePageMarkdown(
    pageId: string,
    body: Record<string, unknown>,
  ): Promise<{ markdown?: string; [key: string]: unknown }> {
    return this.request("patch", `pages/${pageId}/markdown`, { body })
  }

  // ---- databases & data sources --------------------------------------------

  /**
   * Create a database *and* its first data source in one call — the
   * 2025-09-03+ shape, where the schema is carried by `initial_data_source`
   * rather than by a top-level `properties`.
   */
  createDatabase(body: Record<string, unknown>): Promise<NotionDatabase> {
    return this.request<NotionDatabase>("post", "databases", { body })
  }

  getDatabase(databaseId: string): Promise<NotionDatabase> {
    return this.request<NotionDatabase>("get", `databases/${databaseId}`)
  }

  updateDatabase(databaseId: string, body: Record<string, unknown>): Promise<NotionDatabase> {
    return this.request<NotionDatabase>("patch", `databases/${databaseId}`, { body })
  }

  getDataSource(dataSourceId: string): Promise<NotionDataSource> {
    return this.request<NotionDataSource>("get", `data_sources/${dataSourceId}`)
  }

  updateDataSource(dataSourceId: string, body: Record<string, unknown>): Promise<NotionDataSource> {
    return this.request<NotionDataSource>("patch", `data_sources/${dataSourceId}`, { body })
  }

  queryDataSource(
    dataSourceId: string,
    body: Record<string, unknown> = {},
  ): Promise<Paginated<NotionPage>> {
    return this.request<Paginated<NotionPage>>("post", `data_sources/${dataSourceId}/query`, { body })
  }

  /**
   * Every row, following cursors to exhaustion.
   *
   * The reason `investigate-db-001` exists: a single `query` call returns at
   * most 100 rows and says so only via `has_more`. Verifiers must never use
   * `queryDataSource` directly for aggregates.
   */
  async queryAllRows(
    dataSourceId: string,
    body: Record<string, unknown> = {},
  ): Promise<NotionPage[]> {
    const all: NotionPage[] = []
    let cursor: string | undefined
    // Bounded so a server that never clears `has_more` fails loudly.
    for (let page = 0; page < 500; page++) {
      const res = await this.queryDataSource(dataSourceId, {
        ...body,
        page_size: MAX_PAGE_SIZE,
        ...(cursor ? { start_cursor: cursor } : {}),
      })
      all.push(...res.results)
      if (!res.has_more || !res.next_cursor) return all
      cursor = res.next_cursor
    }
    throw new Error(`queryAllRows(${dataSourceId}): pagination did not terminate after 500 pages`)
  }

  // ---- blocks --------------------------------------------------------------

  listBlockChildren(
    blockId: string,
    query: { start_cursor?: string; page_size?: number } = {},
  ): Promise<Paginated<NotionBlock>> {
    return this.request<Paginated<NotionBlock>>("get", `blocks/${blockId}/children`, { query })
  }

  async listAllBlockChildren(blockId: string): Promise<NotionBlock[]> {
    const all: NotionBlock[] = []
    let cursor: string | undefined
    for (let page = 0; page < 500; page++) {
      const res = await this.listBlockChildren(blockId, {
        page_size: MAX_PAGE_SIZE,
        ...(cursor ? { start_cursor: cursor } : {}),
      })
      all.push(...res.results)
      if (!res.has_more || !res.next_cursor) return all
      cursor = res.next_cursor
    }
    throw new Error(`listAllBlockChildren(${blockId}): pagination did not terminate`)
  }

  appendBlockChildren(blockId: string, children: unknown[]): Promise<Paginated<NotionBlock>> {
    return this.request<Paginated<NotionBlock>>("patch", `blocks/${blockId}/children`, {
      body: { children },
    })
  }

  // ---- views ---------------------------------------------------------------

  /**
   * `GET /v1/views?database_id=…`.
   *
   * Returns **stubs** — `{object: "view", id}` — not view objects. Reporting on
   * a database's views is therefore always list-then-retrieve; see `getView`
   * and, for the whole job in one call, `listAllViewsFor`.
   */
  listViews(
    query: { database_id?: string; data_source_id?: string; start_cursor?: string; page_size?: number },
  ): Promise<Paginated<NotionViewStub>> {
    return this.request<Paginated<NotionViewStub>>("get", "views", { query })
  }

  getView(viewId: string): Promise<NotionView> {
    return this.request<NotionView>("get", `views/${viewId}`)
  }

  /** Create a view. Not part of the public reference — provisioning only. */
  createView(body: Record<string, unknown>): Promise<NotionView> {
    return this.request<NotionView>("post", "views", { body })
  }

  /** Every view of a database or data source, resolved from stubs to objects. */
  async listAllViewsFor(
    scope: { database_id?: string; data_source_id?: string },
  ): Promise<NotionView[]> {
    const stubs: NotionViewStub[] = []
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const res = await this.listViews({
        ...scope,
        page_size: MAX_PAGE_SIZE,
        ...(cursor ? { start_cursor: cursor } : {}),
      })
      stubs.push(...res.results)
      if (!res.has_more || !res.next_cursor) break
      cursor = res.next_cursor
    }
    const views: NotionView[] = []
    for (const stub of stubs) views.push(await this.getView(stub.id))
    return views
  }

  // ---- comments ------------------------------------------------------------

  createComment(body: Record<string, unknown>): Promise<NotionComment> {
    return this.request<NotionComment>("post", "comments", { body })
  }

  /**
   * `GET /v1/comments?block_id=…`.
   *
   * Scoped to comments whose parent is *exactly* `blockId`: page-level
   * discussions when it is a page id, inline ones when it is a block id. It
   * does not recurse, so "every comment on this page" means walking the block
   * tree and asking once per block.
   */
  listComments(
    blockId: string,
    query: { start_cursor?: string; page_size?: number } = {},
  ): Promise<Paginated<NotionComment>> {
    return this.request<Paginated<NotionComment>>("get", "comments", {
      query: { block_id: blockId, ...query },
    })
  }

  async listAllComments(blockId: string): Promise<NotionComment[]> {
    const all: NotionComment[] = []
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const res = await this.listComments(blockId, {
        page_size: MAX_PAGE_SIZE,
        ...(cursor ? { start_cursor: cursor } : {}),
      })
      all.push(...res.results)
      if (!res.has_more || !res.next_cursor) return all
      cursor = res.next_cursor
    }
    throw new Error(`listAllComments(${blockId}): pagination did not terminate`)
  }

  // ---- users ---------------------------------------------------------------

  listUsers(query: { start_cursor?: string; page_size?: number } = {}): Promise<Paginated<NotionUser>> {
    return this.request<Paginated<NotionUser>>("get", "users", { query })
  }

  async listAllUsers(): Promise<NotionUser[]> {
    const all: NotionUser[] = []
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const res = await this.listUsers({
        page_size: MAX_PAGE_SIZE,
        ...(cursor ? { start_cursor: cursor } : {}),
      })
      all.push(...res.results)
      if (!res.has_more || !res.next_cursor) return all
      cursor = res.next_cursor
    }
    throw new Error("listAllUsers: pagination did not terminate")
  }

  getUser(userId: string): Promise<NotionUser> {
    return this.request<NotionUser>("get", `users/${userId}`)
  }

  // ---- file uploads --------------------------------------------------------

  /**
   * Step 1 of 2. Returns a `pending` upload carrying an `upload_url`; the bytes
   * go there next, and only an `uploaded` upload can be attached to anything.
   */
  createFileUpload(body: Record<string, unknown> = {}): Promise<NotionFileUpload> {
    return this.request<NotionFileUpload>("post", "file_uploads", { body })
  }

  /**
   * Step 2 of 2: `POST /v1/file_uploads/{id}/send` as `multipart/form-data`.
   *
   * The only non-JSON request in the whole client, hence `#multipart` rather
   * than `request` — `Content-Type` must carry the boundary `FormData` picked,
   * so it is deliberately *not* set by hand.
   */
  sendFileUpload(
    fileUploadId: string,
    file: { data: Uint8Array | string; filename: string; contentType?: string },
  ): Promise<NotionFileUpload> {
    const form = new FormData()
    const bytes = typeof file.data === "string" ? new TextEncoder().encode(file.data) : file.data
    form.append(
      "file",
      new Blob([bytes as BlobPart], { type: file.contentType ?? "application/octet-stream" }),
      file.filename,
    )
    return this.#multipart<NotionFileUpload>(`file_uploads/${fileUploadId}/send`, form)
  }

  /** Create + send in one step, for a small in-memory payload. */
  async uploadFile(file: {
    data: Uint8Array | string
    filename: string
    contentType?: string
  }): Promise<NotionFileUpload> {
    const created = await this.createFileUpload({
      filename: file.filename,
      ...(file.contentType ? { content_type: file.contentType } : {}),
    })
    return this.sendFileUpload(created.id, file)
  }

  getFileUpload(fileUploadId: string): Promise<NotionFileUpload> {
    return this.request<NotionFileUpload>("get", `file_uploads/${fileUploadId}`)
  }

  listFileUploads(
    query: { status?: string; start_cursor?: string; page_size?: number } = {},
  ): Promise<Paginated<NotionFileUpload>> {
    return this.request<Paginated<NotionFileUpload>>("get", "file_uploads", { query })
  }

  async listAllFileUploads(): Promise<NotionFileUpload[]> {
    const all: NotionFileUpload[] = []
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const res = await this.listFileUploads({
        page_size: MAX_PAGE_SIZE,
        ...(cursor ? { start_cursor: cursor } : {}),
      })
      all.push(...res.results)
      if (!res.has_more || !res.next_cursor) return all
      cursor = res.next_cursor
    }
    throw new Error("listAllFileUploads: pagination did not terminate")
  }

  async #multipart<T>(path: string, form: FormData): Promise<T> {
    const url = `${this.baseUrl}/v1/${path.replace(/^\/+/, "")}`
    await this.#pace()
    this.requestCount++
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    let response: Response
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#auth}`,
          "Notion-Version": this.notionVersion,
          Accept: "application/json",
        },
        body: form,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    const text = await response.text()
    let parsed: unknown = undefined
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }
    if (response.ok) return parsed as T
    const bodyObj = (parsed ?? {}) as { code?: string; message?: string }
    throw new NotionApiError({
      status: response.status,
      code: bodyObj.code ?? `http_${response.status}`,
      message: bodyObj.message ?? String(text).slice(0, 400),
      body: parsed,
      method: "post",
      path,
    })
  }

  // ---- misc ----------------------------------------------------------------

  search(body: Record<string, unknown> = {}): Promise<Paginated<NotionPage | NotionDataSource>> {
    return this.request("post", "search", { body })
  }

  me(): Promise<NotionUser> {
    return this.request<NotionUser>("get", "users/me")
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Property encoding / decoding
//
// Fixture specs and verifiers speak in scalars ("Open", 42, true); the API
// speaks in tagged objects. These two functions are the only place that
// translation happens, so a spec author never writes `{"select":{"name":…}}`.
// ---------------------------------------------------------------------------

export function richText(text: string): Array<Record<string, unknown>> {
  if (text === "") return []
  return [{ type: "text", text: { content: text }, plain_text: text }]
}

export function plainText(value: unknown): string {
  if (!Array.isArray(value)) return ""
  return value
    .map((part) => {
      const p = part as { plain_text?: unknown; text?: { content?: unknown } }
      if (typeof p.plain_text === "string") return p.plain_text
      if (typeof p.text?.content === "string") return p.text.content
      return ""
    })
    .join("")
}

/** Encode a scalar for `properties` on page create/update, given its declared type. */
export function toPropertyValue(type: string, value: PropValue): Record<string, unknown> {
  switch (type) {
    case "title":
      return { title: richText(value === null ? "" : String(value)) }
    case "rich_text":
      return { rich_text: richText(value === null ? "" : String(value)) }
    case "number":
      return { number: value === null || value === "" ? null : Number(value) }
    case "select":
      return { select: value === null || value === "" ? null : { name: String(value) } }
    case "status":
      return { status: value === null || value === "" ? null : { name: String(value) } }
    case "multi_select": {
      const names = Array.isArray(value)
        ? value
        : value === null || value === ""
          ? []
          : String(value)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
      return { multi_select: names.map((name) => ({ name })) }
    }
    case "date":
      return { date: value === null || value === "" ? null : { start: String(value), end: null } }
    case "checkbox":
      return { checkbox: Boolean(value) }
    case "url":
    case "email":
    case "phone_number":
      return { [type]: value === null || value === "" ? null : String(value) }
    default:
      throw new Error(`fixture specs cannot seed a "${type}" property`)
  }
}

/** Decode an API property value back to the scalar a verifier compares on. */
export function readPropertyValue(prop: unknown): PropValue {
  if (prop === null || typeof prop !== "object") return null
  const p = prop as Record<string, unknown>
  switch (p.type) {
    case "title":
      return plainText(p.title)
    case "rich_text":
      return plainText(p.rich_text)
    case "number":
      return typeof p.number === "number" ? p.number : null
    case "select":
      return (p.select as { name?: string } | null)?.name ?? null
    case "status":
      return (p.status as { name?: string } | null)?.name ?? null
    case "multi_select":
      return ((p.multi_select as Array<{ name?: string }>) ?? []).map((o) => o.name ?? "")
    case "date":
      return (p.date as { start?: string } | null)?.start ?? null
    case "checkbox":
      return Boolean(p.checkbox)
    case "url":
    case "email":
    case "phone_number":
      return (p[p.type as string] as string | null) ?? null
    case "files":
      // Names only; `readFilesProperty` is the one that keeps kind and url.
      return readFilesProperty(p).map((f) => f.name)
    default:
      return null
  }
}

/** All of a page's properties as scalars, keyed by property name. */
export function readProperties(page: NotionPage): Record<string, PropValue> {
  const out: Record<string, PropValue> = {}
  for (const [name, value] of Object.entries(page.properties ?? {})) {
    out[name] = readPropertyValue(value)
  }
  return out
}

/** A page's title text, whichever property carries it. */
export function pageTitle(page: NotionPage): string {
  for (const value of Object.values(page.properties ?? {})) {
    const p = value as { type?: string; title?: unknown }
    if (p?.type === "title") return plainText(p.title)
  }
  return ""
}

/** The emoji on a page's icon, or `null` when it has none / is a file icon. */
export function pageIconEmoji(page: NotionPage): string | null {
  const icon = page.icon as { type?: string; emoji?: string } | null | undefined
  if (!icon || icon.type !== "emoji") return null
  return icon.emoji ?? null
}

/** The visible text of a comment. */
export function commentText(comment: { rich_text?: unknown }): string {
  return plainText(comment.rich_text)
}

export interface FileAttachment {
  name: string
  /** `file` = uploaded to Notion, `external` = a link Notion never stored. */
  kind: "file" | "external"
  url: string
}

/**
 * Decode one file object — a `files` property entry, or the payload of a
 * `file`/`image`/`pdf` block.
 *
 * The `kind` matters more than it looks: a solution that pastes a public URL
 * instead of performing the two-step upload produces a perfectly plausible
 * attachment that is `external`, and the difference is the only thing that
 * distinguishes the two on read-back.
 */
export function readFileObject(value: unknown): FileAttachment | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as Record<string, unknown>
  const name = typeof v.name === "string" ? v.name : ""
  if (v.type === "external" || v.external) {
    const url = (v.external as { url?: string } | undefined)?.url ?? ""
    return { name, kind: "external", url }
  }
  if (v.type === "file" || v.file) {
    const url = (v.file as { url?: string } | undefined)?.url ?? ""
    return { name, kind: "file", url }
  }
  return undefined
}

/** Every attachment in a `files` property value. */
export function readFilesProperty(prop: unknown): FileAttachment[] {
  if (!prop || typeof prop !== "object") return []
  const files = (prop as { files?: unknown }).files
  if (!Array.isArray(files)) return []
  return files.map(readFileObject).filter((f): f is FileAttachment => f !== undefined)
}

/** The attachment carried by a `file` / `image` / `pdf` / `audio` / `video` block. */
export function readFileBlock(block: NotionBlock): FileAttachment | undefined {
  const payload = block[block.type]
  return readFileObject(payload)
}

/** Plain text of a block's rich-text payload, whatever its type. */
export function blockText(block: NotionBlock): string {
  const payload = block[block.type] as { rich_text?: unknown } | undefined
  return plainText(payload?.rich_text)
}

/**
 * True when the object is in the trash under either spelling.
 *
 * Takes `unknown` so it can be pointed at a page, a block, a database or a raw
 * API payload without a cast at every call site.
 */
export function isTrashed(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false
  const o = obj as { archived?: unknown; in_trash?: unknown }
  return o.archived === true || o.in_trash === true
}

/** Normalize both dashed and undashed Notion ids for comparison. */
export function sameId(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false
  return a.replace(/-/g, "").toLowerCase() === b.replace(/-/g, "").toLowerCase()
}

/** The parent object id of a page/database, regardless of parent flavour. */
export function parentId(obj: { parent?: Record<string, unknown> }): string | undefined {
  const parent = obj.parent ?? {}
  for (const key of ["page_id", "data_source_id", "database_id", "block_id"]) {
    const value = parent[key]
    if (typeof value === "string") return value
  }
  return undefined
}
