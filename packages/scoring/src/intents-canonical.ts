/**
 * Canonicalization and structural diffing of Notion-as-Code `dist/intents.json`.
 *
 * ## Why
 *
 * A Notion-as-Code project compiles to a flat, ordered JSON array of intents.
 * Every resource declares a `resourceId` and refers to other resources by that
 * id (`parent: {type:"resourceId", resourceId}`, `targetDataSourceResourceId`,
 * `view.dataSourceResourceId`, `{{resource-id}}` mentions inside page content,
 * ...). Those ids are author-chosen labels with no semantics: two solutions to
 * the same task are equivalent when their intent graphs are **isomorphic up to
 * resourceId renaming**. Grading therefore cannot compare JSON literally.
 *
 * `canonicalize()` rewrites every resourceId into a structural label
 * (`#c0`, `#c1`, ...) derived only from the shape of the graph, so isomorphic
 * documents serialize to byte-identical JSON. `diffIntents()` compares two
 * canonicalized documents and reports human-readable differences.
 *
 * ## How the labels are computed
 *
 * A 1-dimensional Weisfeiler-Leman (colour refinement) pass over the reference
 * graph, followed by bounded individualization-refinement:
 *
 * 1. Collect every *symbol* — any string sitting in a resourceId position,
 *    whether it declares a resource or references one.
 * 2. Round 0 colours every symbol `@` (masked). Each round, a symbol's
 *    signature is the sorted multiset, over all of its occurrences, of
 *    `path | render(nearest enclosing object) | render(enclosing intent)`,
 *    where `render` re-serializes with the *previous* round's colours. Rounds
 *    stop as soon as the induced partition is stable (max 10).
 * 3. Symbols that still share a signature are pulled apart by individualizing
 *    one member at a time and keeping the choice that minimizes the (rename
 *    invariant) multiset of resulting signatures. This is bounded; whatever
 *    remains ambiguous is *collapsed* to a shared label and reported in
 *    `ambiguities`. Collapsing is deliberate: it can never reject a correct
 *    solution, it can only accept two structures that colour refinement cannot
 *    tell apart (adversarial regular graphs, which Notion workspaces are not).
 * 4. Classes are sorted by signature and numbered `#c0..#cN`.
 *
 * Pinned ids (`opts.pinnedResourceIds`) are excluded from renaming: they are
 * fixed to the literal label `#!<id>` on both sides, so idempotency/migration
 * tasks can require that specific resourceIds survive verbatim.
 *
 * ## Normalization choices (documented on purpose)
 *
 * - **Inline and separate views are the same thing** (disable with
 *   `normalizeInlineViews: false`). Notion-as-Code offers two spellings for
 *   attaching a view to a database: inline, `notion.database({views:[schema]})`,
 *   which compiles into the database intent's `views?: ViewSchema[]`; and
 *   separate, `db.addView(schema)`, which compiles into a standalone
 *   `{type:"view", databaseResourceId, view}` intent. The SDK itself documents
 *   them as one operation — the separate intent exists only "to allow streaming
 *   output without needing to buffer views until the database is finalized" —
 *   so grading must not care which one the author reached for.
 *
 *   Canonicalization therefore **lifts inline views out** (inline -> separate):
 *   every `views` entry on a `database` intent becomes a synthetic
 *   `{type:"view", databaseResourceId:<that database's resourceId>, view}`
 *   intent appended to the flat array, and the now-redundant `views` key is
 *   dropped (including when it was an empty array, which means the same thing
 *   as its absence).
 *
 *   *Why this direction and not folding separate views back in.* (a) It is
 *   total: a `view` intent may name a `databaseResourceId` that no database in
 *   the document declares, and folding has nowhere to put such a view, whereas
 *   lifting never fails. (b) It only ever *adds* to the reference graph —
 *   `databaseResourceId` is an ordinary `*ResourceId` key, so the containment
 *   edge an inline view relies on is re-expressed as a real reference edge that
 *   colour refinement already knows how to follow; folding would instead delete
 *   that edge from authored separate views. (c) The existing array-order policy
 *   already covers the lifted paths (`$view.view.sorts`, `$view.view.columns`,
 *   `$view.view.properties`), and the lifted intents land in the top-level
 *   array, which is already sorted order-insensitively.
 *
 *   *Ordering.* Views of one database compare as an **unordered set**. This is
 *   not a new relaxation: `$database.views` was already an unordered array
 *   under the policy below, and separate `view` intents were already unordered
 *   because the top-level intent array is. Making it anything else is not even
 *   well defined across the two spellings — the separate form lets views be
 *   interleaved with arbitrary other intents, so there is no position an inline
 *   view could be said to occupy. Order *inside* a view (`sorts` precedence,
 *   board `columns`, displayed `properties`) is untouched and still significant.
 *
 *   Normalization runs before symbol discovery, so synthetic view intents are
 *   indistinguishable from authored ones everywhere downstream: their
 *   `dataSourceResourceId`, `groupBy.property`, filter/sort `propertyId`s and
 *   `defaultTemplate` are labelled, refined and rewritten exactly the same way,
 *   and pinned ids keep working unchanged.
 * - **A view's `groupBy.type` is derived when it is omitted** (disable with
 *   `normalizeGroupByType: false`). `GroupByFormat.type` is optional in the
 *   SDK and its enum is a list of *property types* — it restates the type the
 *   grouped property already declares in its data source schema, so
 *   `groupBy: {property: p}` and `groupBy: {property: p, type: "select"}` say
 *   the same thing when `p` is a select. Omitting it is legal, natural API
 *   usage, so grading must not require it.
 *
 *   This is **derive-and-fill, not ignore**. When (and only when) `type` is
 *   absent, it is resolved the way the SDK documents the reference:
 *   `view.dataSourceResourceId` -> that data source's `properties[]` -> the
 *   entry whose `resourceId` is `groupBy.property` -> its declared `type`.
 *   Consequences, all deliberate:
 *   - a `type` that is *present* is never touched, so an explicit value that
 *     disagrees with the referenced property still produces a difference;
 *   - an unresolvable reference (dangling property, or a view pointing at a
 *     data source this document does not declare) leaves `type` absent rather
 *     than guessing — and two documents that both omit it still compare equal;
 *   - resolution is scoped *through* `dataSourceResourceId` rather than by
 *     property id alone, so a view naming a property that belongs to a
 *     different data source stays unresolved instead of being papered over.
 *
 *   Only `groupBy` needs this. The sibling references `calendarBy`,
 *   `timelineBy` and `timelineByEnd` are bare `ResourceId` strings in the SDK
 *   with no type field to restate, and board `columns[].value.type` describes a
 *   group *value*, not the property, so neither is derivable.
 *
 *   Like the views rule this runs before symbol discovery, and it handles both
 *   spellings (`database.views[]` and `view.view`), so it composes with
 *   `normalizeInlineViews` in either setting.
 * - **Object keys** are always sorted.
 * - **Sibling order is preserved only where it is semantic.** Ordered arrays:
 *   `sorts` (sort precedence), board `columns` (group order), view
 *   `properties`/`tableProperties` (column display order),
 *   `pageLayout.properties` (layout order), select/status `options` (option
 *   display order, including the `todo`/`inProgress`/`complete` buckets).
 *   Page `content` is a string, so its block sequence is preserved verbatim.
 * - **Everything else is order-insensitive and sorted** by `(type, name,
 *   canonical JSON)`: the top-level intent array (emission order is a build
 *   artifact, not a spec), `dataSources`, data-source `properties` (hence "by
 *   (type, name)" as specified), `views`, `filters` (a flat AND list),
 *   space `members`, `sharedResources`, and relation value arrays.
 * - **Unknown fields participate in equality.** The walker is generic over
 *   JSON; it never drops keys it does not recognize.
 * - **Page property values are shape-normalized** (disable with
 *   `normalizePropertyValues: false`), because the authoring API accepts
 *   several inputs that compile to different JSON for the same value:
 *   `[["x"]]` collapses to `"x"`, numbers become strings, and a relation given
 *   as a bare id becomes a one-element array. Grading should reward the value,
 *   not the overload the agent happened to pick.
 *
 * ## Reference detection
 *
 * Structural (key-driven, so new reference fields are picked up automatically):
 * `resourceId`, any `*ResourceId` key, `propertyId`, `property` (except inside
 * a `{type:"property"}` view cover), `defaultTemplate`, `calendarBy`,
 * `timelineBy`, `timelineByEnd`, `sharedResources[]`.
 * Heuristic (only rewritten when the string is a *declared* resourceId, so
 * select/status values, plain text and dangling references are never mangled):
 * page property values that are strings or arrays of strings (relation
 * targets), `relation_*` filter values, `{{resource-id}}` mentions inside page
 * `content`, and `prop("<resource-id>")` tokens inside formula `expression`s.
 */
import { createHash } from "node:crypto"
import {
  assertIntents,
  IntentsError,
  type Intent,
  type Json,
  type JsonObject,
} from "./intents-types.js"

// ---------------------------------------------------------------------------
// Options and results
// ---------------------------------------------------------------------------

export interface CanonicalizeOptions {
  /**
   * resourceIds that must NOT be renamed (idempotency / migration tasks).
   * They are labelled `#!<id>` literally on both sides of a diff.
   */
  pinnedResourceIds?: string[]
  /** Max colour-refinement rounds (default 10). */
  maxRounds?: number
  /** Max individualization steps used to break ties (default 16). */
  maxIndividualizations?: number
  /**
   * Normalize the interchangeable shapes of page property values
   * (`[["x"]]` / `"x"` / `5`, relation id vs array of ids). Default true.
   */
  normalizePropertyValues?: boolean
  /**
   * Treat a view declared inline on a `database` intent (`views[]`) and the
   * same view attached through a standalone `view` intent (`addView`) as the
   * same thing, by lifting inline views into synthetic `view` intents.
   * Default true. Set to false only when a task deliberately asserts one
   * spelling over the other.
   */
  normalizeInlineViews?: boolean
  /**
   * Fill in a view's optional `groupBy.type` from the declared type of the
   * property `groupBy.property` points at, when the author omitted it.
   * Default true. A `type` that is present is never rewritten, so an explicit
   * value that disagrees with the property is still a difference.
   */
  normalizeGroupByType?: boolean
  /**
   * Rewrite a view property's `visibility` (`"show"` / `"hide"`) into the
   * equivalent `visible` boolean. `PropertyFormat` declares both spellings, so
   * `{visible: false}` and `{visibility: "hide"}` describe the same column.
   * Default true. `"hide_if_empty"` has no boolean equivalent and is left
   * alone, so it still differs from an explicit `visible`.
   */
  normalizePropertyVisibility?: boolean
}

export interface CanonicalDocument {
  /** Canonicalized intents: ids replaced by labels, keys and arrays normalized. */
  intents: Json[]
  /** original resourceId -> canonical label. */
  idMap: Record<string, string>
  /** Groups of resourceIds colour refinement could not tell apart. */
  ambiguities: string[][]
  /** `JSON.stringify(intents)`; byte equality means structural equality. */
  json: string
}

export type DifferenceKind =
  | "missing"
  | "unexpected"
  | "changed"
  | "type-mismatch"
  | "count"
  | "order"
  | "pinned-id-missing"
  | "pinned-id-unexpected"
  | "unclassified"

export interface Difference {
  kind: DifferenceKind
  /** Human-readable path, e.g. `database "Tasks" > dataSources[Tasks] > properties[Status].type`. */
  path: string
  message: string
  expected?: Json
  actual?: Json
}

export interface DiffOptions extends CanonicalizeOptions {
  /** Stop collecting after this many differences (default 50). */
  maxDifferences?: number
}

export interface DiffResult {
  equal: boolean
  differences: Difference[]
  expected: CanonicalDocument
  actual: CanonicalDocument
}

// ---------------------------------------------------------------------------
// Field classification
// ---------------------------------------------------------------------------

type FieldKind =
  | "symbol"
  | "symbol-if-declared"
  | "symbols"
  | "content"
  | "expression"
  | "page-property-value"
  | null

const SINGLE_REF_KEYS = new Set([
  "propertyId",
  "defaultTemplate",
  "calendarBy",
  "timelineBy",
  "timelineByEnd",
])

const PAGE_PROPERTIES_PATH = "$page.properties"

function classifyField(
  key: string,
  value: Json,
  parent: JsonObject,
  parentPath: string,
): FieldKind {
  if (parentPath === PAGE_PROPERTIES_PATH) return "page-property-value"
  if (typeof value === "string") {
    if (key === "resourceId" || key.endsWith("ResourceId")) return "symbol"
    if (SINGLE_REF_KEYS.has(key)) return "symbol"
    // `property` is a resourceId everywhere except a view cover format,
    // `cover: { type: "property", property: "<name>" }`.
    if (key === "property" && parent["type"] !== "property") return "symbol"
    if (key === "content") return "content"
    // formulas reference properties as prop("<resourceId>")
    if (key === "expression") return "expression"
    // relation filters carry a page resourceId in `value`
    if (key === "value" && parent["propertyType"] === "relation") return "symbol-if-declared"
    return null
  }
  if (Array.isArray(value) && key === "sharedResources" && value.every((v) => typeof v === "string")) {
    return "symbols"
  }
  return null
}

/**
 * `resourceId` declares a resource unless the enclosing object is a reference
 * wrapper: `{type:"resourceId", ...}` or a file reference `{type:"file"}`
 * (distinguished from a *file property schema*, which also carries a `name`).
 */
function isDeclarationSite(parent: JsonObject): boolean {
  const t = parent["type"]
  if (t === "resourceId") return false
  if (t === "file" && parent["name"] === undefined) return false
  return true
}

// ---------------------------------------------------------------------------
// Array order policy
// ---------------------------------------------------------------------------

const ORDERED_SUFFIXES = [
  ".sorts",
  ".columns",
  ".options",
  ".options.todo",
  ".options.inProgress",
  ".options.complete",
  ".pageLayout.properties",
  ".tableProperties",
]

/** True when the order of an array at `path` carries meaning. */
export function isOrderedArray(path: string): boolean {
  for (const suffix of ORDERED_SUFFIXES) {
    if (path.endsWith(suffix)) return true
  }
  if (path.endsWith(".properties")) {
    // View column display order. `$view.view.properties` is what inline views
    // look like once `liftInlineViews` has run; `$database.views[].properties`
    // only survives under `normalizeInlineViews: false`.
    if (path.includes(".views[].") || path.startsWith("$view.view.")) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Transform (shared by occurrence collection, rendering and final output)
// ---------------------------------------------------------------------------

interface Frame {
  node: JsonObject
  path: string
}

interface TransformCtx {
  declared: Set<string>
  label: (symbol: string) => string
  collect?: (symbol: string, path: string, stack: Frame[]) => void
  stack: Frame[]
  /** Normalize the interchangeable shapes of page property values. */
  normalizeValues: boolean
}

const MENTION_RE = /\{\{([^{}]*)\}\}/g
const PROP_RE = /prop\((["'])([^"']*)\1\)/g

function transformValue(value: Json, path: string, ctx: TransformCtx): Json {
  if (Array.isArray(value)) {
    const items = value.map((v) => transformValue(v, `${path}[]`, ctx))
    if (!isOrderedArray(path)) sortValues(items)
    return items
  }
  if (value !== null && typeof value === "object") {
    const obj = value as JsonObject
    ctx.stack.push({ node: obj, path })
    const out: JsonObject = {}
    for (const key of Object.keys(obj).sort()) {
      const child = obj[key]
      const childPath = `${path}.${key}`
      out[key] = transformField(classifyField(key, child, obj, path), child, childPath, ctx)
    }
    ctx.stack.pop()
    return out
  }
  return value
}

function transformField(kind: FieldKind, value: Json, path: string, ctx: TransformCtx): Json {
  switch (kind) {
    case "symbol":
      return mapSymbol(value as string, path, ctx)
    case "symbol-if-declared":
      return ctx.declared.has(value as string) ? mapSymbol(value as string, path, ctx) : value
    case "symbols": {
      const items = (value as string[]).map((s) => mapSymbol(s, path, ctx))
      if (!isOrderedArray(path)) items.sort(compareStrings)
      return items
    }
    case "content":
      return (value as string).replace(MENTION_RE, (whole, raw: string) => {
        const id = raw.trim()
        if (!ctx.declared.has(id)) return whole
        return `{{${mapSymbol(id, `${path}{{}}`, ctx)}}}`
      })
    case "expression":
      return (value as string).replace(PROP_RE, (whole, quote: string, raw: string) => {
        if (!ctx.declared.has(raw)) return whole
        return `prop(${quote}${mapSymbol(raw, `${path}prop()`, ctx)}${quote})`
      })
    case "page-property-value":
      return transformPropertyValue(value, path, ctx)
    default:
      return transformValue(value, path, ctx)
  }
}

/**
 * Page property values are the one place where the same value has several
 * equally valid emitted shapes, because the authoring API accepts several input
 * shapes for one property (`notion.text("x")` -> `[["x"]]`, but a bare `"x"` or
 * `5` is accepted too, and a relation takes an id or an array of ids). They are
 * normalized so that a task is graded on the value, not on which overload the
 * agent used:
 *
 * - `[["x"]]` (a single plain text token) collapses to `"x"`
 * - numbers become their string form
 * - a bare string that is a *declared* resourceId becomes a one-element
 *   relation array (select/status values, which are never declared ids, are
 *   left alone)
 * - arrays of plain strings are relation targets: mapped to labels and sorted
 */
function transformPropertyValue(value: Json, path: string, ctx: TransformCtx): Json {
  if (!ctx.normalizeValues) {
    if (typeof value === "string") {
      return ctx.declared.has(value) ? mapSymbol(value, path, ctx) : value
    }
    if (isStringArray(value)) {
      const items = value.map((s) => (ctx.declared.has(s) ? mapSymbol(s, path, ctx) : s))
      items.sort(compareStrings)
      return items
    }
    return transformValue(value, path, ctx)
  }

  if (typeof value === "number") return String(value)
  if (typeof value === "string") {
    return ctx.declared.has(value) ? [mapSymbol(value, path, ctx)] : value
  }
  if (isStringArray(value)) {
    const items = value.map((s) => (ctx.declared.has(s) ? mapSymbol(s, path, ctx) : s))
    items.sort(compareStrings)
    return items
  }
  if (
    Array.isArray(value) &&
    value.length === 1 &&
    Array.isArray(value[0]) &&
    value[0].length === 1 &&
    typeof value[0][0] === "string"
  ) {
    return value[0][0]
  }
  return transformValue(value, path, ctx)
}

function isStringArray(value: Json): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string")
}

function mapSymbol(symbol: string, path: string, ctx: TransformCtx): string {
  ctx.collect?.(symbol, path, ctx.stack)
  return ctx.label(symbol)
}

function sortValues(items: Json[]): void {
  const keys = new Map<Json, string>()
  for (const item of items) keys.set(item, sortKey(item))
  items.sort((a, b) => compareStrings(keys.get(a)!, keys.get(b)!))
}

function sortKey(value: Json): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as JsonObject
    return `${scalar(obj["type"])} ${scalar(obj["name"])} ${JSON.stringify(value)}`
  }
  return `  ${JSON.stringify(value)}`
}

function scalar(value: Json | undefined): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : ""
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function intentPath(intent: Intent): string {
  return `$${typeof intent.type === "string" ? intent.type : "unknown"}`
}

// ---------------------------------------------------------------------------
// Spelling normalization: inline views -> standalone view intents
// ---------------------------------------------------------------------------

/**
 * Rewrite `database.views[]` into standalone `{type:"view",
 * databaseResourceId, view}` intents so that the two equivalent spellings of
 * "attach this view to this database" converge. See the module docblock for
 * why the normalization runs in this direction.
 *
 * Runs *before* symbol discovery, so the synthetic intents are ordinary
 * intents to everything downstream — including `databaseResourceId`, which is
 * picked up as a reference by the usual `*ResourceId` rule.
 *
 * Defensive: a `database` whose `views` is not an array, or that has no string
 * `resourceId` to point the synthetic intent at, is passed through untouched
 * rather than mangled (unknown shapes still participate in equality).
 */
function liftInlineViews(intents: Intent[]): Intent[] {
  let lifted = false
  const out: Intent[] = []
  for (const intent of intents) {
    const obj = intent as unknown as JsonObject
    const views = obj["views"]
    const databaseResourceId = obj["resourceId"]
    if (
      obj["type"] !== "database" ||
      !Array.isArray(views) ||
      typeof databaseResourceId !== "string"
    ) {
      out.push(intent)
      continue
    }
    lifted = true
    const rest: JsonObject = {}
    for (const key of Object.keys(obj)) {
      if (key !== "views") rest[key] = obj[key]
    }
    out.push(rest as unknown as Intent)
    for (const view of views) {
      out.push({ type: "view", databaseResourceId, view } as unknown as Intent)
    }
  }
  return lifted ? out : intents
}

// ---------------------------------------------------------------------------
// Derived field normalization: view groupBy.type
// ---------------------------------------------------------------------------

/**
 * `dataSource resourceId -> (property resourceId -> declared property type)`,
 * read from `database.dataSources[].properties[]`. Scoping the index by data
 * source (rather than flattening every property id) is what lets an
 * unresolvable `groupBy.property` stay unresolved instead of being papered
 * over by a same-named property on another data source.
 */
function collectPropertyTypes(intents: Intent[]): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>()
  for (const intent of intents) {
    const sources = (intent as unknown as JsonObject)["dataSources"]
    if (!Array.isArray(sources)) continue
    for (const source of sources) {
      if (source === null || typeof source !== "object" || Array.isArray(source)) continue
      const ds = source as JsonObject
      const id = ds["resourceId"]
      const properties = ds["properties"]
      if (typeof id !== "string" || !Array.isArray(properties)) continue
      const byProperty = out.get(id) ?? new Map<string, string>()
      for (const property of properties) {
        if (property === null || typeof property !== "object" || Array.isArray(property)) continue
        const p = property as JsonObject
        if (typeof p["resourceId"] === "string" && typeof p["type"] === "string") {
          byProperty.set(p["resourceId"], p["type"])
        }
      }
      if (byProperty.size > 0) out.set(id, byProperty)
    }
  }
  return out
}

/**
 * Fill an omitted `groupBy.type` from the grouped property's declared type.
 * Returns the input unchanged (by reference) when there is nothing to add, so
 * callers can copy-on-write and never mutate the caller's document.
 */
function fillViewGroupByType(view: Json, propertyTypes: Map<string, Map<string, string>>): Json {
  if (view === null || typeof view !== "object" || Array.isArray(view)) return view
  const schema = view as JsonObject
  const groupBy = schema["groupBy"]
  if (groupBy === null || typeof groupBy !== "object" || Array.isArray(groupBy)) return view
  const group = groupBy as JsonObject
  // An explicit `type` — right or wrong — is the author's, and stays.
  if (group["type"] !== undefined) return view
  const property = group["property"]
  const dataSource = schema["dataSourceResourceId"]
  if (typeof property !== "string" || typeof dataSource !== "string") return view
  const declared = propertyTypes.get(dataSource)?.get(property)
  // Dangling property, or a view pointing at a data source this document does
  // not declare: leave it absent rather than guess. Two documents that both
  // omit it still agree.
  if (declared === undefined) return view
  return { ...schema, groupBy: { ...group, type: declared } }
}

/**
 * Apply {@link fillViewGroupByType} to every view schema in the document, in
 * either spelling — `view` intents (`intent.view`) and views still declared
 * inline on a `database` intent (`intent.views[]`, reachable when
 * `normalizeInlineViews` is off). See the module docblock for the rationale.
 */
/** `visibility` → the equivalent `visible` boolean, on one property entry. */
function foldVisibility(entry: Json): Json {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry
  const obj = entry as JsonObject
  const visibility = obj["visibility"]
  if (typeof visibility !== "string") return entry
  // Only the two spellings that mean the same thing. "hide_if_empty" is a
  // third state with no boolean equivalent, and an explicit `visible` already
  // present is the author's — neither is rewritten.
  if (obj["visible"] !== undefined) return entry
  if (visibility !== "show" && visibility !== "hide") return entry
  const { visibility: _dropped, ...rest } = obj
  return { ...rest, visible: visibility === "show" }
}

/** Apply {@link foldVisibility} to every `properties[]` entry in a view. */
function foldViewVisibility(view: Json): Json {
  if (view === null || typeof view !== "object" || Array.isArray(view)) return view
  const schema = view as JsonObject
  const properties = schema["properties"]
  if (!Array.isArray(properties)) return view
  let changed = false
  const next = properties.map((entry) => {
    const folded = foldVisibility(entry)
    if (folded !== entry) changed = true
    return folded
  })
  return changed ? { ...schema, properties: next } : view
}

/** Apply {@link foldViewVisibility} to every view schema, in either spelling. */
function foldPropertyVisibility(intents: Intent[]): Intent[] {
  let folded = false
  const out = intents.map((intent) => {
    const obj = intent as unknown as JsonObject
    if (obj["type"] === "view" && obj["view"] !== undefined) {
      const view = foldViewVisibility(obj["view"])
      if (view === obj["view"]) return intent
      folded = true
      return { ...obj, view } as unknown as Intent
    }
    if (obj["type"] === "database" && Array.isArray(obj["views"])) {
      let any = false
      const views = obj["views"].map((view) => {
        const next = foldViewVisibility(view)
        if (next !== view) any = true
        return next
      })
      if (!any) return intent
      folded = true
      return { ...obj, views } as unknown as Intent
    }
    return intent
  })
  return folded ? out : intents
}

function fillGroupByTypes(intents: Intent[]): Intent[] {
  const propertyTypes = collectPropertyTypes(intents)
  if (propertyTypes.size === 0) return intents
  let filled = false
  const out = intents.map((intent) => {
    const obj = intent as unknown as JsonObject
    if (obj["type"] === "view" && obj["view"] !== undefined) {
      const view = fillViewGroupByType(obj["view"], propertyTypes)
      if (view === obj["view"]) return intent
      filled = true
      return { ...obj, view } as unknown as Intent
    }
    if (obj["type"] === "database" && Array.isArray(obj["views"])) {
      let any = false
      const views = obj["views"].map((view) => {
        const next = fillViewGroupByType(view, propertyTypes)
        if (next !== view) any = true
        return next
      })
      if (!any) return intent
      filled = true
      return { ...obj, views } as unknown as Intent
    }
    return intent
  })
  return filled ? out : intents
}

// ---------------------------------------------------------------------------
// Symbol discovery
// ---------------------------------------------------------------------------

interface Occurrence {
  path: string
  nearest: JsonObject
  nearestPath: string
  root: JsonObject
  rootPath: string
}

function collectDeclared(intents: Intent[]): Set<string> {
  const declared = new Set<string>()
  const walk = (value: Json): void => {
    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }
    if (value === null || typeof value !== "object") return
    const obj = value as JsonObject
    const id = obj["resourceId"]
    if (typeof id === "string" && isDeclarationSite(obj)) declared.add(id)
    for (const key of Object.keys(obj)) walk(obj[key])
  }
  for (const intent of intents) walk(intent as unknown as Json)
  return declared
}

function collectOccurrences(
  intents: Intent[],
  declared: Set<string>,
  normalizeValues: boolean,
): Map<string, Occurrence[]> {
  const bySymbol = new Map<string, Occurrence[]>()
  const ctx: TransformCtx = {
    declared,
    label: () => "@",
    stack: [],
    normalizeValues,
    collect: (symbol, path, stack) => {
      const nearest = stack[stack.length - 1]
      const root = stack[0]
      const list = bySymbol.get(symbol) ?? []
      list.push({
        path,
        nearest: nearest.node,
        nearestPath: nearest.path,
        root: root.node,
        rootPath: root.path,
      })
      bySymbol.set(symbol, list)
    },
  }
  for (const intent of intents) {
    ctx.stack = []
    transformValue(intent as unknown as Json, intentPath(intent), ctx)
  }
  return bySymbol
}

// ---------------------------------------------------------------------------
// Colour refinement
// ---------------------------------------------------------------------------

function hash(text: string): string {
  return createHash("sha1").update(text).digest("base64url").slice(0, 16)
}

/**
 * Run colour refinement and return each symbol's final signature.
 * `fixed` pins chosen symbols to a constant colour (pinned ids, individualized
 * symbols) so they can never be confused with anything else.
 */
function refine(
  symbols: string[],
  occurrences: Map<string, Occurrence[]>,
  declared: Set<string>,
  fixed: Map<string, string>,
  maxRounds: number,
  normalizeValues: boolean,
): Map<string, string> {
  let colours = new Map<string, string>()
  for (const s of symbols) colours.set(s, fixed.get(s) ?? "@")
  let signatures = new Map<string, string>(colours)
  let previousPartition = ""

  for (let round = 0; round < maxRounds; round++) {
    const renderCache = new Map<JsonObject, string>()
    const ctx: TransformCtx = {
      declared,
      label: (s) => colours.get(s) ?? "@",
      stack: [],
      normalizeValues,
    }
    const render = (node: JsonObject, path: string): string => {
      const cached = renderCache.get(node)
      if (cached !== undefined) return cached
      ctx.stack = []
      const text = hash(JSON.stringify(transformValue(node as Json, path, ctx)))
      renderCache.set(node, text)
      return text
    }

    const next = new Map<string, string>()
    for (const symbol of symbols) {
      const occ = occurrences.get(symbol) ?? []
      const contexts = occ
        .map(
          (o) =>
            `${o.path}${render(o.nearest, o.nearestPath)}${render(o.root, o.rootPath)}`,
        )
        .sort(compareStrings)
      next.set(symbol, `${fixed.get(symbol) ?? ""}${contexts.join("")}`)
    }

    signatures = next
    const newColours = new Map<string, string>()
    for (const symbol of symbols) {
      newColours.set(symbol, fixed.get(symbol) ?? `S${hash(next.get(symbol)!)}`)
    }
    const partition = partitionKey(symbols, newColours)
    colours = newColours
    if (partition === previousPartition) break
    previousPartition = partition
  }
  return signatures
}

/** Rename-invariant description of the partition induced by `colours`. */
function partitionKey(symbols: string[], colours: Map<string, string>): string {
  const classes = new Map<string, number>()
  const ids: number[] = []
  for (const s of symbols) {
    const c = colours.get(s)!
    let idx = classes.get(c)
    if (idx === undefined) {
      idx = classes.size
      classes.set(c, idx)
    }
    ids.push(idx)
  }
  return ids.join(",")
}

function groupBySignature(
  symbols: string[],
  signatures: Map<string, string>,
): Array<{ signature: string; members: string[] }> {
  const groups = new Map<string, string[]>()
  for (const s of symbols) {
    const sig = signatures.get(s)!
    const list = groups.get(sig) ?? []
    list.push(s)
    groups.set(sig, list)
  }
  return [...groups.entries()]
    .map(([signature, members]) => ({ signature, members: [...members].sort(compareStrings) }))
    .sort((a, b) => compareStrings(a.signature, b.signature))
}

/** Rename-invariant fingerprint of a whole refinement result. */
function signatureMultiset(signatures: Map<string, string>): string {
  return [...signatures.values()].sort(compareStrings).join("")
}

interface Labelling {
  labels: Map<string, string>
  ambiguities: string[][]
}

function assignLabels(
  symbols: string[],
  occurrences: Map<string, Occurrence[]>,
  declared: Set<string>,
  pinned: Set<string>,
  maxRounds: number,
  maxIndividualizations: number,
  normalizeValues: boolean,
): Labelling {
  const fixed = new Map<string, string>()
  for (const id of pinned) if (symbols.includes(id)) fixed.set(id, `P${id}`)

  let signatures = refine(symbols, occurrences, declared, fixed, maxRounds, normalizeValues)
  let groups = groupBySignature(symbols, signatures)

  for (let step = 0; step < maxIndividualizations; step++) {
    const ambiguous = groups.find((g) => g.members.length > 1 && g.members.length <= 6)
    if (!ambiguous) break
    let best: { member: string; key: string } | undefined
    for (const member of ambiguous.members) {
      const trial = new Map(fixed)
      trial.set(member, `I${step}`)
      const trialSignatures = refine(
        symbols,
        occurrences,
        declared,
        trial,
        maxRounds,
        normalizeValues,
      )
      const key = signatureMultiset(trialSignatures)
      if (best === undefined || compareStrings(key, best.key) < 0) best = { member, key }
    }
    if (!best) break
    fixed.set(best.member, `I${step}`)
    signatures = refine(symbols, occurrences, declared, fixed, maxRounds, normalizeValues)
    groups = groupBySignature(symbols, signatures)
  }

  const labels = new Map<string, string>()
  const ambiguities: string[][] = []
  let index = 0
  for (const group of groups) {
    // Members that survive refinement together are structurally
    // indistinguishable: give them one shared label rather than an
    // order-dependent (and therefore rename-sensitive) tie-break.
    const pinnedMembers = group.members.filter((m) => pinned.has(m))
    const free = group.members.filter((m) => !pinned.has(m))
    for (const m of pinnedMembers) labels.set(m, `#!${m}`)
    if (free.length > 0) {
      const label = `#c${index++}`
      for (const m of free) labels.set(m, label)
      if (free.length > 1) ambiguities.push(free)
    }
  }
  return { labels, ambiguities }
}

// ---------------------------------------------------------------------------
// canonicalize
// ---------------------------------------------------------------------------

/**
 * Normalize an intents array so that isomorphic documents become byte-identical.
 * See the module docblock for the exact normalization rules.
 */
export function canonicalize(intents: unknown, opts: CanonicalizeOptions = {}): CanonicalDocument {
  let list = assertIntents(intents)
  if (opts.normalizeInlineViews ?? true) list = liftInlineViews(list)
  if (opts.normalizeGroupByType ?? true) list = fillGroupByTypes(list)
  if (opts.normalizePropertyVisibility ?? true) list = foldPropertyVisibility(list)
  const normalizeValues = opts.normalizePropertyValues ?? true
  const declared = collectDeclared(list)
  const occurrences = collectOccurrences(list, declared, normalizeValues)
  const symbols = [...occurrences.keys()].sort(compareStrings)
  const pinned = new Set(opts.pinnedResourceIds ?? [])

  const { labels, ambiguities } = assignLabels(
    symbols,
    occurrences,
    declared,
    pinned,
    opts.maxRounds ?? 10,
    opts.maxIndividualizations ?? 16,
    normalizeValues,
  )

  const ctx: TransformCtx = {
    declared,
    label: (s) => labels.get(s) ?? `#?${s}`,
    stack: [],
    normalizeValues,
  }
  const out = list.map((intent) => {
    ctx.stack = []
    return transformValue(intent as unknown as Json, intentPath(intent), ctx)
  })
  sortValues(out)

  const idMap: Record<string, string> = {}
  for (const symbol of symbols) idMap[symbol] = labels.get(symbol)!

  return { intents: out, idMap, ambiguities, json: JSON.stringify(out) }
}

// ---------------------------------------------------------------------------
// diffIntents
// ---------------------------------------------------------------------------

/**
 * Structural diff of two intent arrays after canonicalization.
 * `equal` is decided by canonical byte equality; `differences` is the
 * human-readable explanation produced by aligning the two documents.
 */
export function diffIntents(
  expected: unknown,
  actual: unknown,
  opts: DiffOptions = {},
): DiffResult {
  const expectedDoc = canonicalize(expected, opts)
  const actualDoc = canonicalize(actual, opts)
  const equal = expectedDoc.json === actualDoc.json

  const limit = opts.maxDifferences ?? 50
  const out: Difference[] = []
  const push = (d: Difference): void => {
    if (out.length < limit) out.push(d)
  }

  for (const id of opts.pinnedResourceIds ?? []) {
    const inExpected = id in expectedDoc.idMap
    const inActual = id in actualDoc.idMap
    if (inExpected && !inActual) {
      push({
        kind: "pinned-id-missing",
        path: "intents",
        message: `pinned resourceId "${id}" is missing from the actual intents`,
      })
    } else if (!inExpected && inActual) {
      push({
        kind: "pinned-id-unexpected",
        path: "intents",
        message: `pinned resourceId "${id}" appears in the actual intents but not in the expected intents`,
      })
    }
  }

  if (!equal) {
    diffIntentArrays(expectedDoc.intents, actualDoc.intents, {
      push,
      forward: new Map(),
      backward: new Map(),
    })
    if (out.length === 0) {
      push({
        kind: "unclassified",
        path: "intents",
        message:
          "canonical documents differ but no field-level difference could be attributed " +
          "(check `ambiguities` — structurally indistinguishable resourceIds were collapsed)",
      })
    }
  }

  return {
    equal,
    differences: equal ? [] : out,
    expected: expectedDoc,
    actual: actualDoc,
  }
}

type Push = (d: Difference) => void

/**
 * Diff walking state.
 *
 * Canonical labels are *positions in a sorted list of structural signatures*, so
 * one real change renumbers unrelated labels. Comparing them literally would
 * bury the actual difference under dozens of `#c18 != #c19` lines. The diff
 * therefore treats labels as symbols again and maintains a bijection between
 * the two documents' labels: a reference only counts as different when it is
 * inconsistent with bindings established elsewhere. Equality itself is still
 * decided by canonical byte equality, never by this heuristic. Pinned labels
 * (`#!id`) are compared literally.
 */
interface DiffState {
  push: Push
  forward: Map<string, string>
  backward: Map<string, string>
}

const LABEL_RE = /#c\d+/g

/**
 * Compare two strings treating `#cN` labels as bindable symbols (this also
 * covers `{{#cN}}` mentions embedded in page content).
 */
function refAwareEqual(expected: string, actual: string, state: DiffState): boolean {
  if (expected === actual) return true
  const expectedTokens = expected.match(LABEL_RE)
  const actualTokens = actual.match(LABEL_RE)
  if (!expectedTokens || !actualTokens || expectedTokens.length !== actualTokens.length) return false
  if (expected.split(LABEL_RE).join(" ") !== actual.split(LABEL_RE).join(" ")) return false
  for (let i = 0; i < expectedTokens.length; i++) {
    const e = expectedTokens[i]
    const a = actualTokens[i]
    const bound = state.forward.get(e)
    const boundBack = state.backward.get(a)
    if ((bound !== undefined && bound !== a) || (boundBack !== undefined && boundBack !== e)) {
      return false
    }
  }
  for (let i = 0; i < expectedTokens.length; i++) {
    state.forward.set(expectedTokens[i], actualTokens[i])
    state.backward.set(actualTokens[i], expectedTokens[i])
  }
  return true
}

function intentLabel(intent: Json): string {
  if (intent === null || typeof intent !== "object" || Array.isArray(intent)) return "intent"
  const obj = intent as JsonObject
  const type = scalar(obj["type"]) || "intent"
  const name = scalar(obj["name"])
  if (name) return `${type} "${name}"`
  const nested = obj["view"]
  if (nested !== undefined && nested !== null && typeof nested === "object") {
    const viewName = scalar((nested as JsonObject)["name"])
    if (viewName) return `${type} "${viewName}"`
  }
  return type
}

function diffIntentArrays(expected: Json[], actual: Json[], state: DiffState): void {
  const push = state.push
  const remaining = new Set(actual.keys())
  const pairs: Array<{ score: number; e: number; a: number }> = []
  const expectedLeaves = expected.map((v) => leafSet(v))
  const actualLeaves = actual.map((v) => leafSet(v))

  for (let e = 0; e < expected.length; e++) {
    for (let a = 0; a < actual.length; a++) {
      if (typeName(expected[e]) !== typeName(actual[a])) continue
      pairs.push({ score: jaccard(expectedLeaves[e], actualLeaves[a]), e, a })
    }
  }
  pairs.sort((x, y) => y.score - x.score || x.e - y.e || x.a - y.a)

  const matchedExpected = new Map<number, number>()
  for (const pair of pairs) {
    if (matchedExpected.has(pair.e) || !remaining.has(pair.a)) continue
    matchedExpected.set(pair.e, pair.a)
    remaining.delete(pair.a)
  }

  for (let e = 0; e < expected.length; e++) {
    const a = matchedExpected.get(e)
    if (a === undefined) {
      push({
        kind: "missing",
        path: `intents[${intentLabel(expected[e])}]`,
        message: `expected ${intentLabel(expected[e])} intent is missing`,
        expected: expected[e],
      })
      continue
    }
    diffValue(
      expected[e],
      actual[a],
      `intents[${intentLabel(expected[e])}]`,
      intentPathOf(expected[e]),
      state,
    )
  }
  for (const a of [...remaining].sort((x, y) => x - y)) {
    push({
      kind: "unexpected",
      path: `intents[${intentLabel(actual[a])}]`,
      message: `unexpected ${intentLabel(actual[a])} intent`,
      actual: actual[a],
    })
  }
}

function intentPathOf(intent: Json): string {
  if (intent !== null && typeof intent === "object" && !Array.isArray(intent)) {
    return `$${scalar((intent as JsonObject)["type"]) || "unknown"}`
  }
  return "$unknown"
}

function typeName(value: Json): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (typeof value === "object") return scalar((value as JsonObject)["type"]) || "object"
  return typeof value
}

function kindOf(value: Json): "array" | "object" | "primitive" {
  if (Array.isArray(value)) return "array"
  if (value !== null && typeof value === "object") return "object"
  return "primitive"
}

function diffValue(expected: Json, actual: Json, path: string, tpath: string, state: DiffState): void {
  const push = state.push
  const ek = kindOf(expected)
  const ak = kindOf(actual)
  if (ek !== ak) {
    push({
      kind: "type-mismatch",
      path,
      message: `expected ${ek} but found ${ak}`,
      expected,
      actual,
    })
    return
  }
  if (ek === "primitive") {
    const same =
      typeof expected === "string" && typeof actual === "string"
        ? refAwareEqual(expected, actual, state)
        : expected === actual
    if (!same) {
      push({
        kind: "changed",
        path,
        message: `expected ${JSON.stringify(expected)} but found ${JSON.stringify(actual)}`,
        expected,
        actual,
      })
    }
    return
  }
  if (ek === "object") {
    const e = expected as JsonObject
    const a = actual as JsonObject
    for (const key of Object.keys(e).sort()) {
      if (!(key in a)) {
        push({
          kind: "missing",
          path: `${path}.${key}`,
          message: `missing field \`${key}\``,
          expected: e[key],
        })
        continue
      }
      diffValue(e[key], a[key], `${path}.${key}`, `${tpath}.${key}`, state)
    }
    for (const key of Object.keys(a).sort()) {
      if (!(key in e)) {
        push({
          kind: "unexpected",
          path: `${path}.${key}`,
          message: `unexpected field \`${key}\``,
          actual: a[key],
        })
      }
    }
    return
  }
  diffArray(expected as Json[], actual as Json[], path, tpath, state)
}

function diffArray(
  expected: Json[],
  actual: Json[],
  path: string,
  tpath: string,
  state: DiffState,
): void {
  const push = state.push
  const ordered = isOrderedArray(tpath)
  const expectedKeys = identityKeys(expected)
  const actualKeys = identityKeys(actual)

  if (!ordered && expectedKeys && actualKeys) {
    const actualByKey = new Map(actualKeys.map((k, i) => [k, i]))
    const seen = new Set<string>()
    for (let i = 0; i < expected.length; i++) {
      const key = expectedKeys[i]
      const j = actualByKey.get(key)
      if (j === undefined) {
        push({
          kind: "missing",
          path: `${path}[${key}]`,
          message: `missing entry \`${key}\``,
          expected: expected[i],
        })
        continue
      }
      seen.add(key)
      diffValue(expected[i], actual[j], `${path}[${key}]`, `${tpath}[]`, state)
    }
    for (let j = 0; j < actual.length; j++) {
      if (!seen.has(actualKeys[j])) {
        push({
          kind: "unexpected",
          path: `${path}[${actualKeys[j]}]`,
          message: `unexpected entry \`${actualKeys[j]}\``,
          actual: actual[j],
        })
      }
    }
    return
  }

  if (expected.length !== actual.length) {
    push({
      kind: "count",
      path,
      message: `expected ${expected.length} entr${expected.length === 1 ? "y" : "ies"} but found ${actual.length}`,
      expected: expected.length,
      actual: actual.length,
    })
  }
  const n = Math.min(expected.length, actual.length)
  for (let i = 0; i < n; i++) {
    diffValue(expected[i], actual[i], `${path}[${i}]`, `${tpath}[]`, state)
  }
  if (ordered && expectedKeys && actualKeys && expected.length === actual.length) {
    const sameSet =
      [...expectedKeys].sort(compareStrings).join(" ") ===
      [...actualKeys].sort(compareStrings).join(" ")
    if (sameSet && expectedKeys.join(" ") !== actualKeys.join(" ")) {
      push({
        kind: "order",
        path,
        message: `entries are in a different order: expected [${expectedKeys.join(", ")}] but found [${actualKeys.join(", ")}]`,
      })
    }
  }
}

/** Stable per-element identity keys, or undefined when the array cannot be keyed. */
function identityKeys(items: Json[]): string[] | undefined {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined
    const obj = item as JsonObject
    const raw = obj["name"] ?? obj["property"] ?? obj["propertyId"] ?? obj["type"]
    if (typeof raw !== "string" || raw.length === 0) return undefined
    // Canonical labels (`resourceId`, `property`, `propertyId`, ...) are
    // renumbered by any structural change, so they cannot align two documents;
    // fall back to positional comparison instead.
    if (/^#c\d+$/.test(raw)) return undefined
    if (seen.has(raw)) return undefined
    seen.add(raw)
    keys.push(raw)
  }
  return keys
}

function leafSet(value: Json, path = "", out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((v, i) => leafSet(v, `${path}[${i}]`, out))
    return out
  }
  if (value !== null && typeof value === "object") {
    const obj = value as JsonObject
    for (const key of Object.keys(obj)) leafSet(obj[key], `${path}.${key}`, out)
    return out
  }
  // Labels are renumbered by unrelated changes, so they must not drive matching.
  out.add(`${path}=${JSON.stringify(value).replace(LABEL_RE, "#c")}`)
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let shared = 0
  for (const v of a) if (b.has(v)) shared++
  return shared / (a.size + b.size - shared)
}

export { IntentsError }
