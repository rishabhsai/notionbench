/**
 * Read-only selectors over a built `dist/intents.json`.
 *
 * `canonicalize()`/`diffIntents()` decide *whether* two intent documents agree.
 * These helpers are the other half a Notion-as-Code verifier needs: pulling the
 * individual resources back out so a task can say *why* it disagrees ("Stage is
 * a `multi_select`, expected `select`") instead of only "canonical documents
 * differ at line 412".
 *
 * They are deliberately total and defensive — an agent's build output is
 * arbitrary JSON, so every accessor narrows rather than asserts, and anything
 * unrecognized comes back as `undefined` / `[]` rather than throwing.
 */
import type { Json, JsonObject } from "./intents-types.js"

/** An intent (or a nested resource inside one) as raw JSON. */
export type IntentRecord = JsonObject

/** Intent `type` discriminators that name a top-level resource. */
const RESOURCE_INTENT_TYPES = new Set(["space", "teamspace", "database", "page", "custom_agent"])

function isPlainObject(v: unknown): v is IntentRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** Top-level intents whose `type` is `type`. */
export function intentsOfType(intents: readonly Json[], type: string): IntentRecord[] {
  return intents.filter((i): i is IntentRecord => isPlainObject(i) && i.type === type)
}

/** Every data source across every `database` intent, in document order. */
export function dataSources(intents: readonly Json[]): IntentRecord[] {
  const out: IntentRecord[] = []
  for (const db of intentsOfType(intents, "database")) {
    const list = db.dataSources
    if (Array.isArray(list)) {
      for (const ds of list) if (isPlainObject(ds)) out.push(ds)
    }
  }
  return out
}

/** Property schemas declared on a data source. */
export function propertiesOf(dataSource: IntentRecord): IntentRecord[] {
  return Array.isArray(dataSource.properties) ? dataSource.properties.filter(isPlainObject) : []
}

/**
 * Every view schema, whether declared inline on a `database` intent (`views[]`)
 * or attached afterwards through a standalone `view` intent (`addView`).
 */
export function views(intents: readonly Json[]): IntentRecord[] {
  const out: IntentRecord[] = []
  for (const db of intentsOfType(intents, "database")) {
    if (Array.isArray(db.views)) for (const v of db.views) if (isPlainObject(v)) out.push(v)
  }
  for (const vi of intentsOfType(intents, "view")) {
    if (isPlainObject(vi.view)) out.push(vi.view)
  }
  return out
}

/** `page` intents whose parent reference points at `resourceId`. */
export function pagesUnder(intents: readonly Json[], resourceId: string): IntentRecord[] {
  return intentsOfType(intents, "page").filter((p) => {
    const parent = p.parent
    return isPlainObject(parent) && parent.resourceId === resourceId
  })
}

/** Page property values keyed by property NAME, or `{}` when absent. */
export function propertyValues(page: IntentRecord): Record<string, Json> {
  return isPlainObject(page.properties) ? (page.properties as Record<string, Json>) : {}
}

// ---------------------------------------------------------------------------
// Property value readers
// ---------------------------------------------------------------------------

/**
 * Flatten the interchangeable text shapes a property value can take —
 * `notion.text("x")` compiles to `[["x"]]`, a bare string stays a string, a
 * checkbox is a boolean — into the plain text a task spec is written in.
 * Returns `undefined` when the value is not textual.
 */
export function propText(value: Json | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value)
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (Array.isArray(value) && value.every((t) => Array.isArray(t))) {
    return value
      .map((t) => (typeof (t as Json[])[0] === "string" ? ((t as Json[])[0] as string) : ""))
      .join("")
  }
  return undefined
}

/**
 * Extract `{ start, end }` from a `notion.date()` token array — the date lives
 * in a `["d", {start_date, end_date}]` annotation on one of the tokens.
 */
export function propDate(value: Json | undefined): { start: string; end?: string } | undefined {
  if (!Array.isArray(value)) return undefined
  for (const token of value) {
    if (!Array.isArray(token)) continue
    const annotations = token[1]
    if (!Array.isArray(annotations)) continue
    for (const ann of annotations) {
      if (Array.isArray(ann) && ann[0] === "d" && isPlainObject(ann[1] as Json)) {
        const d = ann[1] as IntentRecord
        const start = d.start_date
        const end = d.end_date
        if (typeof start === "string") {
          return typeof end === "string" ? { start, end } : { start }
        }
      }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Declared resources
// ---------------------------------------------------------------------------

export interface DeclaredResource {
  id: string
  /** The object literal that declares the id (intent, data source, property, view…). */
  node: IntentRecord
  /** Nearest enclosing declared id, if any. */
  ancestor?: string
  /** Coarse kind, for readable diagnostics. */
  kind: string
}

/**
 * `{ type: "resourceId", resourceId }` (a parent link) and a bare
 * `{ type: "file", resourceId }` (a manifest reference) *point at* a resource;
 * they do not declare one. A file *property schema* also carries a `name`, so
 * the two-key check keeps it out of this exclusion.
 */
function isReferenceObject(o: IntentRecord): boolean {
  if (o.type === "resourceId") return true
  if (o.type === "file" && Object.keys(o).length === 2) return true
  return false
}

function kindOf(node: IntentRecord, containerKey: string | undefined): string {
  const t = typeof node.type === "string" ? node.type : undefined
  if (t && RESOURCE_INTENT_TYPES.has(t) && containerKey === undefined) return t
  if (containerKey === "dataSources") return "dataSource"
  if (containerKey === "properties") return "property"
  if (containerKey === "views" || containerKey === "view") return "view"
  return t ?? "resource"
}

/**
 * Walk the document collecting every object that *declares* a resourceId,
 * keyed by that id. Used by the idempotency tasks, where resourceIds are the
 * mapping to already-applied Notion objects and must survive verbatim.
 */
export function collectResources(intents: readonly Json[]): Map<string, DeclaredResource> {
  const out = new Map<string, DeclaredResource>()
  const walk = (value: Json, ancestor: string | undefined, containerKey: string | undefined): void => {
    if (Array.isArray(value)) {
      for (const v of value) walk(v, ancestor, containerKey)
      return
    }
    if (!isPlainObject(value)) return
    let nextAncestor = ancestor
    if (typeof value.resourceId === "string" && !isReferenceObject(value)) {
      const id = value.resourceId
      if (!out.has(id)) {
        out.set(id, { id, node: value, ancestor, kind: kindOf(value, containerKey) })
      }
      nextAncestor = id
    }
    for (const [k, v] of Object.entries(value)) walk(v, nextAncestor, k)
  }
  for (const intent of intents) walk(intent, undefined, undefined)
  return out
}
