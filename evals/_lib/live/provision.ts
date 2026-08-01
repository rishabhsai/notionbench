/**
 * Fixture provisioning for `fixture: rest` tasks.
 *
 * Given a spec (see `spec.ts`) this creates the whole starting state in a real
 * Notion workspace and returns `{specKey → notionId}`. Teardown trashes the
 * per-trial root page, which takes its entire subtree with it.
 *
 * Two invariants that are not negotiable:
 *
 *  - **Never create at the workspace level.** A workspace-level page cannot be
 *    archived through the public API, so a run that created one would leak an
 *    un-deletable page per trial. Everything hangs off `NOTION_PARENT_PAGE_ID`,
 *    a page the operator shares with the integration once.
 *  - **`database_id` is not `data_source_id`.** Post-2025-09-03 a database is a
 *    container; its schema and rows belong to a data source. This module creates
 *    the database with `initial_data_source`, registers the resulting data source
 *    under `<dbKey>.ds`, and seeds rows with `parent: {type: "data_source_id"}`.
 *    Verifiers that want the schema must read `<dbKey>.ds`, not `<dbKey>`.
 *
 * Everything honors `NOTION_API_BASE`, so the exact same code path provisions
 * against `fake-notion.ts` during QC and against api.notion.com during a run.
 *
 * Usage:
 *
 * ```ts
 * const client = new NotionClient()                       // reads env
 * const spec = await loadSpec(`${taskDir}/fixture/spec.json`)
 * const fixture = await provisionFixture({ client, spec })  // parent from env
 * try { … } finally { await teardownFixture(client, fixture.rootId) }
 * ```
 */
import { promises as fs } from "node:fs"
import * as path from "node:path"
import {
  NotionClient,
  richText,
  toPropertyValue,
  type NotionClientOptions,
  type PropValue,
} from "./notion.ts"
import {
  ROOT_KEY,
  loadSpec,
  materializeRows,
  toIcon,
  validateSpec,
  type DatabaseSpec,
  type FixtureSpec,
  type PageSpec,
  type PropertySpec,
} from "./spec.ts"

/** Filename dropped into the trial workspace so the agent can find its sandbox. */
export const POINTER_FILENAME = "notionbench.json"

export interface ProvisionResult {
  /** Page id of the per-trial fixture root. Teardown target. */
  rootId: string
  /** `{specKey → notionId}`, including `"root"` and every `<dbKey>.ds`. */
  idMap: Record<string, string>
  /** Data-source ids by database spec key — the lookup verifiers actually want. */
  dataSourceIds: Record<string, string>
  /** How many objects were created, for the run log. */
  created: { pages: number; databases: number; rows: number; blocks: number }
  specId: string
}

export interface ProvisionOptions {
  spec: FixtureSpec
  /** Defaults to a client built from `NOTION_API_TOKEN` / `NOTION_API_BASE`. */
  client?: NotionClient
  clientOptions?: NotionClientOptions
  /**
   * Page the fixture root is created under. Defaults to `NOTION_PARENT_PAGE_ID`.
   * Must be a page the integration can write to — never the workspace root.
   */
  parentPageId?: string
  /**
   * Appended to the root page title, e.g. a run/trial id, so a leaked root is
   * traceable. QC leaves it unset to keep titles byte-stable.
   */
  label?: string
  /** How many row creations may be in flight at once. */
  concurrency?: number
}

export class ProvisionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProvisionError"
  }
}

/** Convenience: load `<taskDir>/fixture/spec.json` and provision it. */
export async function provisionTaskFixture(
  taskDir: string,
  opts: Omit<ProvisionOptions, "spec"> = {},
): Promise<ProvisionResult> {
  const spec = await loadSpec(specPathFor(taskDir))
  return provisionFixture({ ...opts, spec })
}

export function specPathFor(taskDir: string): string {
  return path.join(taskDir, "fixture", "spec.json")
}

export async function provisionFixture(opts: ProvisionOptions): Promise<ProvisionResult> {
  const spec = validateSpec(opts.spec)
  const client = opts.client ?? new NotionClient(opts.clientOptions)
  const parentPageId = opts.parentPageId ?? process.env.NOTION_PARENT_PAGE_ID
  if (!parentPageId) {
    throw new ProvisionError(
      "no parent page: set NOTION_PARENT_PAGE_ID to a page shared with the integration. " +
        "Fixtures are never created at the workspace level — such pages cannot be archived via the API.",
    )
  }

  const seed = spec.seed ?? 1
  const idMap: Record<string, string> = {}
  const dataSourceIds: Record<string, string> = {}
  const created = { pages: 0, databases: 0, rows: 0, blocks: 0 }

  // ---- root ----------------------------------------------------------------
  const rootTitle = `${spec.root?.title ?? `NotionBench · ${spec.id}`}${opts.label ? ` · ${opts.label}` : ""}`
  const root = await client.createPage({
    parent: { type: "page_id", page_id: parentPageId },
    properties: { title: { title: richText(rootTitle) } },
    ...(toIcon(spec.root?.icon) ? { icon: toIcon(spec.root?.icon) } : {}),
  })
  if (typeof root.id !== "string") throw new ProvisionError("root page creation returned no id")
  idMap[ROOT_KEY] = root.id
  created.pages++

  // ---- pages, parents before children --------------------------------------
  for (const page of orderPages(spec.pages ?? [])) {
    const parent = idMap[page.parent ?? ROOT_KEY]
    if (!parent) throw new ProvisionError(`page "${page.key}": parent "${page.parent}" was not provisioned`)
    const blocks = (page.blocks ?? []).map(toBlock)
    const result = await client.createPage({
      parent: { type: "page_id", page_id: parent },
      properties: { title: { title: richText(page.title) } },
      ...(toIcon(page.icon) ? { icon: toIcon(page.icon) } : {}),
      ...(blocks.length > 0 ? { children: blocks } : {}),
    })
    idMap[page.key] = result.id
    created.pages++
    created.blocks += blocks.length
  }

  // ---- databases + rows ----------------------------------------------------
  for (const db of spec.databases ?? []) {
    const parent = idMap[db.parent ?? ROOT_KEY]
    if (!parent) throw new ProvisionError(`database "${db.key}": parent "${db.parent}" was not provisioned`)

    const database = await client.createDatabase({
      parent: { type: "page_id", page_id: parent },
      title: richText(db.title),
      ...(toIcon(db.icon) ? { icon: toIcon(db.icon) } : {}),
      // 2025-09-03+: the schema belongs to the data source, not the database.
      initial_data_source: {
        name: db.dataSource?.name ?? db.title,
        properties: toSchema(db.properties),
      },
    })
    idMap[db.key] = database.id
    created.databases++

    const dataSourceId = database.data_sources?.[0]?.id
    if (!dataSourceId) {
      throw new ProvisionError(
        `database "${db.key}" came back without a data source — is NOTION_API_BASE pointing at a pre-2025-09-03 API?`,
      )
    }
    const dsKey = db.dataSource?.key ?? `${db.key}.ds`
    idMap[dsKey] = dataSourceId
    dataSourceIds[db.key] = dataSourceId

    const rows = materializeRows(db, seed)
    const limit = Math.max(1, opts.concurrency ?? 8)
    for (let start = 0; start < rows.length; start += limit) {
      const batch = rows.slice(start, start + limit)
      const results = await Promise.all(
        batch.map((row) =>
          client.createPage({
            parent: { type: "data_source_id", data_source_id: dataSourceId },
            properties: encodeRow(db.properties, row.properties, db.key),
          }),
        ),
      )
      results.forEach((page, offset) => {
        const key = batch[offset].key
        if (key) idMap[key] = page.id
      })
      created.rows += batch.length
    }
  }

  return { rootId: root.id, idMap, dataSourceIds, created, specId: spec.id }
}

/**
 * Trash the fixture root, taking its subtree with it.
 *
 * Never throws: teardown runs in a `finally`, and a failed cleanup must not
 * mask the failure that got us there. The (recoverable) error is returned.
 */
export async function teardownFixture(
  client: NotionClient,
  rootId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await client.archivePage(rootId)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Write the sandbox pointer into a trial workspace.
 *
 * Live PROMPT.md files are static, so they cannot name a per-trial page id. The
 * agent is told to read `notionbench.json`; the *root id only* goes in it, so
 * discovering the fixture's databases (and their data sources) stays part of
 * the task rather than being handed over.
 */
export async function writeWorkspacePointer(
  workspaceDir: string,
  fixture: Pick<ProvisionResult, "rootId">,
): Promise<string> {
  const file = path.join(workspaceDir, POINTER_FILENAME)
  const payload = {
    root_page_id: fixture.rootId,
    note:
      "Everything this task refers to lives under this page, in the Notion workspace your `ntn` CLI is already authenticated against.",
  }
  await fs.mkdir(workspaceDir, { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
  return file
}

/** Read the pointer back — the verifier's fallback when ctx carries no rootId. */
export async function readWorkspacePointer(
  workspaceDir: string,
): Promise<{ root_page_id?: string } | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(workspaceDir, POINTER_FILENAME), "utf8")) as {
      root_page_id?: string
    }
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------

/** Depth-first order so a page is always created after its parent. */
function orderPages(pages: PageSpec[]): PageSpec[] {
  const byKey = new Map(pages.map((p) => [p.key, p]))
  const out: PageSpec[] = []
  const seen = new Set<string>()
  const visit = (page: PageSpec, trail: string[]): void => {
    if (seen.has(page.key)) return
    if (trail.includes(page.key)) {
      throw new ProvisionError(`page parent cycle: ${[...trail, page.key].join(" → ")}`)
    }
    const parentKey = page.parent ?? ROOT_KEY
    const parent = byKey.get(parentKey)
    if (parent) visit(parent, [...trail, page.key])
    seen.add(page.key)
    out.push(page)
  }
  for (const page of pages) visit(page, [])
  return out
}

/** Spec property declarations → the API's schema shape. */
export function toSchema(properties: Record<string, PropertySpec>): Record<string, unknown> {
  const schema: Record<string, unknown> = {}
  for (const [name, prop] of Object.entries(properties)) {
    switch (prop.type) {
      case "title":
        schema[name] = { title: {} }
        break
      case "rich_text":
        schema[name] = { rich_text: {} }
        break
      case "number":
        schema[name] = { number: { format: prop.format ?? "number" } }
        break
      case "select":
        schema[name] = { select: { options: prop.options } }
        break
      case "status":
        schema[name] = { status: prop.options ? { options: prop.options } : {} }
        break
      case "multi_select":
        schema[name] = { multi_select: { options: prop.options } }
        break
      case "date":
        schema[name] = { date: {} }
        break
      case "checkbox":
        schema[name] = { checkbox: {} }
        break
      case "url":
      case "email":
      case "phone_number":
        schema[name] = { [prop.type]: {} }
        break
      default:
        throw new ProvisionError(`unsupported property type "${(prop as { type: string }).type}" for "${name}"`)
    }
  }
  return schema
}

function encodeRow(
  schema: Record<string, PropertySpec>,
  values: Record<string, PropValue>,
  dbKey: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(values)) {
    const prop = schema[name]
    if (!prop) throw new ProvisionError(`database "${dbKey}": row sets unknown property "${name}"`)
    out[name] = toPropertyValue(prop.type, value)
  }
  return out
}

function toBlock(block: { type?: string; text: string; checked?: boolean }): Record<string, unknown> {
  const type = block.type ?? "paragraph"
  const payload: Record<string, unknown> = { rich_text: richText(block.text) }
  if (type === "to_do") payload.checked = Boolean(block.checked)
  return { object: "block", type, [type]: payload }
}
