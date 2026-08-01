/**
 * Canonicalizer for Notion-as-Code build output (`dist/intents.json`).
 *
 * TODO(notionbench): this is a deliberately simplified, task-local stand-in.
 * Replace it with `@notionbench/scoring`'s canonical-intents comparator once
 * `packages/scoring` lands, and delete this file. Keep the exported surface
 * (`canonicalizeIntents`, `canonicalJson`, `firstDifference`) stable so the
 * swap is a one-line import change in each EVAL.ts.
 *
 * ## What "equal" means here
 *
 * Two intent documents are equal *up to resourceId renaming*: the agent may
 * choose any `resourceId` strings it likes, but the structure and every
 * internal cross-reference must line up. We get there by
 *
 *  1. collecting every declared `resourceId` and the object that declares it;
 *  2. giving each one a **label** derived from its content, not its id —
 *     `property:Stage`, `page:Beta invites`, ... — with collisions broken by a
 *     few rounds of colour refinement (a node's fingerprint mixes in its own
 *     content, its declaring ancestor, and everything it points at);
 *  3. rewriting the document with labels in place of ids — including inside
 *     `{{id}}` content templates and `prop("id")` formula tokens;
 *  4. normalizing property values (`notion.text("x")`, `"x"`, and `[["x"]]` all
 *     mean the same thing) and dropping cosmetic fields the task never asked
 *     for; and
 *  5. sorting every order-irrelevant array plus all object keys.
 *
 * Ids that are referenced but never declared (the workspace anchor a project is
 * applied against, files from an upload manifest) are left verbatim — they are
 * shared vocabulary given by the fixture, not the agent's to invent.
 *
 * Known gaps vs. a real graph-isomorphism check: refinement is bounded at three
 * rounds and in-edges only propagate through containment, so two genuinely
 * interchangeable resources collapse onto one label. That is reported via
 * `collisions` rather than silently ignored.
 */
import { createHash } from "node:crypto"

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Intent = { [key: string]: Json }

/** Intent `type` discriminators that name a top-level resource. */
const RESOURCE_INTENT_TYPES = new Set(["space", "teamspace", "database", "page", "custom_agent"])

/** Field paths dropped before comparison. See `CANONICAL_IGNORE`. */
export interface CanonicalizeOptions {
  /**
   * Path suffixes to delete before comparing. A pattern matches a path when it
   * is equal to it or is a trailing `.`-delimited segment run of it, with array
   * indices written as `[]` — e.g. `view.properties` matches
   * `[].view.properties` but not `[].dataSources[].properties`.
   */
  ignore?: string[]
  /**
   * Keep `resourceId` strings verbatim instead of relabelling them. Used by the
   * idempotency tasks, where ids are pinned rather than free.
   */
  pinResourceIds?: boolean
}

/** Cosmetic decoration no task specifies; ignored unless a task opts back in. */
export const CANONICAL_IGNORE = [
  "icon",
  "cover",
  "coverSize",
  "coverAspect",
  "description",
  "wrap",
  "columns",
  "pageLayout",
  "view.properties",
  "views[].properties",
]

/** Arrays whose element order carries no meaning. */
const UNORDERED = [
  "dataSources",
  "dataSources[].properties",
  "options",
  "options.todo",
  "options.inProgress",
  "options.complete",
  "views",
  "filters",
  "members",
  "sharedResources",
]

function matchesSuffix(path: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (path === p || path.endsWith(`.${p}`)) return true
  }
  return false
}

function isPlainObject(v: unknown): v is { [key: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function sha(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 12)
}

// ---------------------------------------------------------------------------
// 1. Declared resources
// ---------------------------------------------------------------------------

export interface DeclaredResource {
  id: string
  /** The object literal that declares the id (intent, data source, property…). */
  node: { [key: string]: Json }
  /** Nearest enclosing declared id, if any. */
  ancestor?: string
  /** Coarse kind used for readable labels. */
  kind: string
}

/**
 * A `{ type: "resourceId", resourceId }` parent link or a `notion.file()`
 * reference points at a resource; it does not declare one.
 */
function isReferenceObject(o: { [key: string]: Json }): boolean {
  if (o.type === "resourceId") return true
  if (o.type === "file" && Object.keys(o).length === 2) return true
  return false
}

function kindOf(node: { [key: string]: Json }, containerKey: string | undefined): string {
  const t = typeof node.type === "string" ? node.type : undefined
  if (t && RESOURCE_INTENT_TYPES.has(t) && containerKey === undefined) return t
  if (containerKey === "dataSources") return "dataSource"
  if (containerKey === "properties") return "property"
  if (containerKey === "views" || containerKey === "view") return "view"
  return t ?? "resource"
}

/** Walk the document collecting every declaring object. */
export function collectResources(intents: Json[]): Map<string, DeclaredResource> {
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

// ---------------------------------------------------------------------------
// 2. Labels
// ---------------------------------------------------------------------------

/** Flatten a `SimpleTextValue` (`[["a"], ["b"]]`) into plain text. */
export function propText(value: Json | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value)
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (Array.isArray(value) && value.every((t) => Array.isArray(t))) {
    return value.map((t) => (typeof (t as Json[])[0] === "string" ? ((t as Json[])[0] as string) : "")).join("")
  }
  return undefined
}

/** Extract `{ start, end }` from a `notion.date()` token array. */
export function propDate(value: Json | undefined): { start: string; end?: string } | undefined {
  if (!Array.isArray(value)) return undefined
  for (const token of value) {
    if (!Array.isArray(token)) continue
    const annotations = token[1]
    if (!Array.isArray(annotations)) continue
    for (const ann of annotations) {
      if (Array.isArray(ann) && ann[0] === "d" && isPlainObject(ann[1] as Json)) {
        const d = ann[1] as { [key: string]: Json }
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

/** Best-effort human title of a page intent, used only for label readability. */
function pageTitle(node: { [key: string]: Json }): string {
  const props = isPlainObject(node.properties) ? node.properties : undefined
  if (!props) return "untitled"
  for (const key of ["title", "Name", "name"]) {
    const t = propText(props[key])
    if (t) return t
  }
  for (const v of Object.values(props)) {
    const t = propText(v)
    if (t) return t
  }
  return "untitled"
}

function readablePrefix(res: DeclaredResource): string {
  const { node, kind } = res
  if (kind === "page") return `page:${pageTitle(node)}`
  const name = typeof node.name === "string" ? node.name : undefined
  if (kind === "view") return `view:${name ?? (typeof node.type === "string" ? node.type : "view")}`
  return `${kind}:${name ?? "unnamed"}`
}

/**
 * Serialize one declaring object with ids replaced by their labels from the
 * previous refinement round. The node's own id is dropped so that the
 * fingerprint depends on content and neighbours only.
 */
function fingerprint(res: DeclaredResource, labels: Map<string, string>): string {
  const seen = new WeakSet<object>()
  const strip = (value: Json, isSelf: boolean): Json => {
    if (Array.isArray(value)) return value.map((v) => strip(v, false))
    if (isPlainObject(value)) {
      if (seen.has(value)) return "<cycle>"
      seen.add(value)
      const out: { [key: string]: Json } = {}
      for (const key of Object.keys(value).sort()) {
        if (isSelf && key === "resourceId") continue
        out[key] = strip(value[key], false)
      }
      return out
    }
    if (typeof value === "string") return substitute(value, labels)
    return value
  }
  const ancestorLabel = res.ancestor ? (labels.get(res.ancestor) ?? "?") : "-"
  return sha(`${res.kind}|${ancestorLabel}|${JSON.stringify(strip(res.node, true))}`)
}

/** Replace declared ids inside a string, including `{{id}}` and `prop("id")`. */
function substitute(value: string, labels: Map<string, string>): string {
  const direct = labels.get(value)
  if (direct !== undefined) return direct
  if (!value.includes("{{") && !value.includes("prop(")) return value
  let out = value
  for (const [id, label] of labels) {
    if (!out.includes(id)) continue
    out = out.split(`{{${id}}}`).join(`{{${label}}}`)
    out = out.split(`prop("${id}")`).join(`prop("${label}")`)
  }
  return out
}

export interface LabelResult {
  labels: Map<string, string>
  /** Labels shared by more than one resource (an isomorphism we cannot split). */
  collisions: string[]
}

/** Assign a rename-invariant label to every declared resourceId. */
export function labelResources(resources: Map<string, DeclaredResource>, rounds = 3): LabelResult {
  const ids = [...resources.keys()]
  let labels = new Map<string, string>(ids.map((id) => [id, "?"]))
  for (let round = 0; round < rounds; round++) {
    const next = new Map<string, string>()
    for (const id of ids) next.set(id, fingerprint(resources.get(id)!, labels))
    labels = next
  }

  // Readable labels: content-derived prefix, disambiguated by the refinement
  // fingerprint so that two same-named resources still get distinct labels.
  const byPrefix = new Map<string, string[]>()
  for (const id of ids) {
    const prefix = readablePrefix(resources.get(id)!)
    const bucket = byPrefix.get(prefix)
    if (bucket) bucket.push(id)
    else byPrefix.set(prefix, [id])
  }
  const final = new Map<string, string>()
  const collisions: string[] = []
  for (const [prefix, bucket] of byPrefix) {
    if (bucket.length === 1) {
      final.set(bucket[0], prefix)
      continue
    }
    const sorted = [...bucket].sort((a, b) => {
      const fa = labels.get(a)!
      const fb = labels.get(b)!
      return fa < fb ? -1 : fa > fb ? 1 : 0
    })
    const fingerprints = new Set(sorted.map((id) => labels.get(id)!))
    if (fingerprints.size < sorted.length) collisions.push(prefix)
    sorted.forEach((id, i) => final.set(id, i === 0 ? prefix : `${prefix}~${i}`))
  }
  return { labels: final, collisions }
}

// ---------------------------------------------------------------------------
// 3. Canonical document
// ---------------------------------------------------------------------------

/** Normalize one page property value into a comparable shape. */
function normalizeValue(value: Json, labels: Map<string, string>): Json {
  if (typeof value === "string") {
    const label = labels.get(value)
    // A bare string is either a relation target or a select/status/text value.
    return label !== undefined ? { rel: [label] } : { text: value }
  }
  if (typeof value === "number") return { text: String(value) }
  if (typeof value === "boolean") return { text: value ? "Yes" : "No" }
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((v) => typeof v === "string")) {
      return { rel: (value as string[]).map((v) => labels.get(v) ?? v) }
    }
    if (value.every((v) => isPlainObject(v) && (v as { [k: string]: Json }).type === "file")) {
      return {
        files: value.map((v) => {
          const id = (v as { [k: string]: Json }).resourceId
          return typeof id === "string" ? (labels.get(id) ?? id) : null
        }),
      }
    }
    const date = propDate(value)
    if (date) return { date: date.end ? [date.start, date.end] : [date.start] }
    const text = propText(value)
    if (text !== undefined) return { text }
  }
  return value
}

function transform(
  value: Json,
  path: string,
  labels: Map<string, string>,
  opts: Required<Pick<CanonicalizeOptions, "ignore" | "pinResourceIds">>,
): Json {
  if (Array.isArray(value)) {
    const items = value.map((v) => transform(v, `[]`, labels, opts))
    if (path === "" || matchesSuffix(path, UNORDERED)) {
      items.sort((a, b) => {
        const sa = JSON.stringify(a)
        const sb = JSON.stringify(b)
        return sa < sb ? -1 : sa > sb ? 1 : 0
      })
    }
    return items
  }
  if (isPlainObject(value)) {
    const out: { [key: string]: Json } = {}
    const isPage = value.type === "page"
    for (const key of Object.keys(value).sort()) {
      const childPath = path === "" ? key : `${path}.${key}`
      if (matchesSuffix(childPath, opts.ignore)) continue
      if (isPage && key === "properties" && isPlainObject(value[key])) {
        const props = value[key] as { [key: string]: Json }
        const norm: { [key: string]: Json } = {}
        for (const pk of Object.keys(props).sort()) {
          if (props[pk] === undefined || props[pk] === null) continue
          norm[pk] = normalizeValue(props[pk], labels)
        }
        out[key] = norm
        continue
      }
      out[key] = transform(value[key], childPath, labels, opts)
    }
    return out
  }
  if (typeof value === "string" && !opts.pinResourceIds) return substitute(value, labels)
  return value
}

export interface CanonicalResult {
  doc: Json[]
  labels: Map<string, string>
  collisions: string[]
}

/** Canonicalize a parsed `dist/intents.json`. */
export function canonicalizeIntents(intents: Json[], options: CanonicalizeOptions = {}): CanonicalResult {
  const opts = {
    ignore: options.ignore ?? CANONICAL_IGNORE,
    pinResourceIds: options.pinResourceIds ?? false,
  }
  const resources = collectResources(intents)
  const { labels, collisions } = opts.pinResourceIds
    ? { labels: new Map<string, string>(), collisions: [] as string[] }
    : labelResources(resources)
  const doc = transform(intents as unknown as Json, "", labels, opts) as Json[]
  return { doc, labels, collisions }
}

/** Canonical, stable, pretty-printed form — the thing tasks compare. */
export function canonicalJson(intents: Json[], options: CanonicalizeOptions = {}): string {
  return JSON.stringify(canonicalizeIntents(intents, options).doc, null, 2)
}

/** First differing line of two canonical documents, for diagnostics. */
export function firstDifference(expected: string, actual: string): string | undefined {
  if (expected === actual) return undefined
  const a = expected.split("\n")
  const b = actual.split("\n")
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      const context = a.slice(Math.max(0, i - 3), i).map((l) => `    ${l.trim()}`)
      return [
        `canonical intents differ at line ${i + 1}:`,
        ...context,
        `  expected: ${a[i] === undefined ? "<end of document>" : a[i].trim()}`,
        `  actual:   ${b[i] === undefined ? "<end of document>" : b[i].trim()}`,
      ].join("\n")
    }
  }
  return "canonical intents differ"
}

// ---------------------------------------------------------------------------
// Convenience selectors used by the NAC verifiers
// ---------------------------------------------------------------------------

export function intentsOfType(intents: Json[], type: string): Intent[] {
  return intents.filter((i): i is Intent => isPlainObject(i) && i.type === type)
}

/** Every data source across every database intent. */
export function dataSources(intents: Json[]): Intent[] {
  const out: Intent[] = []
  for (const db of intentsOfType(intents, "database")) {
    const list = db.dataSources
    if (Array.isArray(list)) {
      for (const ds of list) if (isPlainObject(ds)) out.push(ds)
    }
  }
  return out
}

export function propertiesOf(ds: Intent): Intent[] {
  return Array.isArray(ds.properties) ? ds.properties.filter(isPlainObject) : []
}

/** All view schemas, whether inline on a database or added via `addView`. */
export function views(intents: Json[]): Intent[] {
  const out: Intent[] = []
  for (const db of intentsOfType(intents, "database")) {
    if (Array.isArray(db.views)) for (const v of db.views) if (isPlainObject(v)) out.push(v)
  }
  for (const vi of intentsOfType(intents, "view")) {
    if (isPlainObject(vi.view)) out.push(vi.view)
  }
  return out
}

/** Page intents parented to `resourceId`. */
export function pagesUnder(intents: Json[], resourceId: string): Intent[] {
  return intentsOfType(intents, "page").filter((p) => {
    const parent = p.parent
    return isPlainObject(parent) && parent.resourceId === resourceId
  })
}
