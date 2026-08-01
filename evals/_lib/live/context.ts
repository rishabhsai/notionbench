/**
 * How a live verifier gets its hands on the workspace it must inspect.
 *
 * An `EVAL.ts` for a live task needs four things: an API base, a token, the id
 * of the per-trial fixture root, and (optionally) the fixture's id map. They are
 * resolved in this order, first hit wins:
 *
 *   1. `ctx` — what `qc-live.ts` passes today and what the runner should pass
 *      once it grows a fixture-provisioning hook (see the note in each task's
 *      EVAL.ts header);
 *   2. environment — `NOTION_API_BASE`, `NOTION_API_TOKEN`, `NOTIONBENCH_ROOT_ID`,
 *      `NOTIONBENCH_ID_MAP`;
 *   3. the trial workspace's `notionbench.json`, for the root id.
 *
 * The fallbacks are not decoration: a verifier that can find the fixture from the
 * workspace alone still grades correctly if the caller forgets to thread ctx
 * through, which is the difference between "one cell is unscored" and "the run
 * is silently zeroed".
 */
import {
  NotionClient,
  isTrashed,
  pageTitle,
  sameId,
  type NotionBlock,
  type NotionClientOptions,
} from "./notion.ts"
import { readWorkspacePointer } from "./provision.ts"

export interface LiveContext {
  client: NotionClient
  apiBase: string
  rootId: string
  idMap: Record<string, string>
  /** How each field was resolved — always echoed into diagnostics. */
  source: { root: string; token: string; idMap: string }
}

export interface ResolveOptions {
  workspaceDir: string
  ctx?: Record<string, unknown>
  clientOptions?: NotionClientOptions
}

export class LiveContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LiveContextError"
  }
}

export async function resolveLiveContext(opts: ResolveOptions): Promise<LiveContext> {
  const ctx = opts.ctx ?? {}

  const apiBase =
    str(ctx.apiBase) ?? str(ctx.notionApiBase) ?? process.env.NOTION_API_BASE ?? "https://api.notion.com"

  let tokenSource = "ctx.token"
  let token = str(ctx.token) ?? str(ctx.notionApiToken)
  if (!token) {
    token = process.env.NOTION_API_TOKEN
    tokenSource = "env.NOTION_API_TOKEN"
  }
  if (!token) {
    throw new LiveContextError(
      "no Notion token — pass ctx.token or set NOTION_API_TOKEN; a live verifier cannot read the workspace without one",
    )
  }

  let rootSource = "ctx.rootId"
  let rootId = str(ctx.rootId) ?? str(ctx.rootPageId)
  if (!rootId) {
    rootId = process.env.NOTIONBENCH_ROOT_ID
    rootSource = "env.NOTIONBENCH_ROOT_ID"
  }
  if (!rootId) {
    const pointer = await readWorkspacePointer(opts.workspaceDir)
    rootId = pointer?.root_page_id
    rootSource = "workspace/notionbench.json"
  }
  if (!rootId) {
    throw new LiveContextError(
      "no fixture root id — pass ctx.rootId, set NOTIONBENCH_ROOT_ID, or leave notionbench.json in the trial workspace",
    )
  }

  let idMapSource = "ctx.idMap"
  let idMap = (ctx.idMap as Record<string, string> | undefined) ?? undefined
  if (!idMap && process.env.NOTIONBENCH_ID_MAP) {
    try {
      idMap = JSON.parse(process.env.NOTIONBENCH_ID_MAP) as Record<string, string>
      idMapSource = "env.NOTIONBENCH_ID_MAP"
    } catch {
      idMap = undefined
    }
  }
  if (!idMap) {
    idMap = { root: rootId }
    idMapSource = "none (root only)"
  }

  return {
    client: new NotionClient({ auth: token, baseUrl: apiBase, ...opts.clientOptions }),
    apiBase,
    rootId,
    idMap,
    source: { root: rootSource, token: tokenSource, idMap: idMapSource },
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

// ---------------------------------------------------------------------------
// Discovery helpers
//
// Verifiers prefer the id map, but they must also work when only the root is
// known — and, more importantly, they have to *find what the agent created*,
// which by definition has no entry in the id map.
// ---------------------------------------------------------------------------

export interface ChildSummary {
  id: string
  type: "child_page" | "child_database" | "block"
  title: string
}

/** Direct children of a page, with titles, skipping trashed ones. */
export async function childrenOf(client: NotionClient, pageId: string): Promise<ChildSummary[]> {
  const blocks = await client.listAllBlockChildren(pageId)
  return blocks
    .filter((block) => !isTrashed(block))
    .map((block) => {
      const type = block.type
      if (type === "child_page" || type === "child_database") {
        const payload = block[type] as { title?: string }
        return { id: block.id, type, title: payload?.title ?? "" }
      }
      return { id: block.id, type: "block" as const, title: "" }
    })
}

/** Child pages of `pageId`, as full page objects. */
export async function childPages(client: NotionClient, pageId: string) {
  const children = await childrenOf(client, pageId)
  const pages = []
  for (const child of children.filter((c) => c.type === "child_page")) {
    pages.push(await client.getPage(child.id))
  }
  return pages
}

/**
 * Find a database under `rootId` (any depth) by title, and return its id
 * together with its first data source id.
 *
 * This is deliberately not "look it up in the id map": several verifiers need
 * to resolve a database the same way the agent had to, and doing so proves the
 * fixture really is discoverable from the root alone.
 */
export async function findDatabase(
  client: NotionClient,
  rootId: string,
  title: string,
  maxDepth = 4,
): Promise<{ databaseId: string; dataSourceId: string } | undefined> {
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const { id, depth } = queue.shift() as { id: string; depth: number }
    if (seen.has(id) || depth > maxDepth) continue
    seen.add(id)
    let blocks: NotionBlock[]
    try {
      blocks = await client.listAllBlockChildren(id)
    } catch {
      continue
    }
    for (const block of blocks) {
      if (block.type === "child_database") {
        const payload = block.child_database as { title?: string }
        if (payload?.title === title) {
          const db = await client.getDatabase(block.id)
          const dataSourceId = db.data_sources?.[0]?.id
          if (dataSourceId) return { databaseId: db.id, dataSourceId }
        }
      } else if (block.type === "child_page") {
        queue.push({ id: block.id, depth: depth + 1 })
      }
    }
  }
  return undefined
}

/** Depth-first search under `rootId` for a page with an exact title. */
export async function findPageByTitle(
  client: NotionClient,
  rootId: string,
  title: string,
  maxDepth = 4,
): Promise<{ id: string; parentId: string } | undefined> {
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const { id, depth } = queue.shift() as { id: string; depth: number }
    if (seen.has(id) || depth > maxDepth) continue
    seen.add(id)
    let blocks: NotionBlock[]
    try {
      blocks = await client.listAllBlockChildren(id)
    } catch {
      continue
    }
    for (const block of blocks) {
      if (block.type !== "child_page") continue
      const payload = block.child_page as { title?: string }
      if (payload?.title === title) return { id: block.id, parentId: id }
      queue.push({ id: block.id, depth: depth + 1 })
    }
  }
  return undefined
}

/** True when `page` sits directly under `parentId`. */
export function isChildOf(page: { parent?: Record<string, unknown> }, parentId: string): boolean {
  const parent = page.parent ?? {}
  return sameId(parent.page_id, parentId) || sameId(parent.block_id, parentId)
}

export { pageTitle }
