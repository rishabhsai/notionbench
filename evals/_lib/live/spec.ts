/**
 * Fixture-spec format for `fixture: rest` tasks.
 *
 * A live task's starting state is a JSON document at `evals/<id>/fixture/spec.json`.
 * `provision.ts` turns it into real Notion objects under a per-trial root page and
 * hands back `{specKey → notionId}`; `teardownFixture` trashes the root again.
 *
 * Design rules, in order of importance:
 *
 *  1. **Deterministic.** Two provisionings of the same spec produce byte-identical
 *     property values. Generators are index-driven; the only randomness is a seeded
 *     mulberry32 PRNG, so `investigate-db-001`'s 250 rows are the same 250 rows on
 *     every machine, on every trial, forever.
 *  2. **Scalars, not tagged unions.** A spec says `"Amount": 137`, never
 *     `{"number": 137}`. `toPropertyValue` in `notion.ts` does the encoding using
 *     the declared schema, so the spec stays readable and a typo in a property
 *     type is caught at provision time.
 *  3. **Keys are the contract.** Every object may declare a `key`; those keys are
 *     what a verifier looks up in the returned id map. `"root"` is reserved for the
 *     per-trial root page. A database `"foo"` implicitly also registers its initial
 *     data source as `"foo.ds"` — the distinction that matters post-2025-09-03.
 *
 * Worked example (abridged from `investigate-db-001`):
 *
 * ```jsonc
 * {
 *   "version": 1,
 *   "id": "investigate-db-001-aggregate-250-rows",
 *   "seed": 20260731,
 *   "root": { "title": "NotionBench · investigate-db-001" },
 *   "pages": [{ "key": "readme", "title": "Read me", "icon": "📌",
 *               "blocks": [{ "type": "paragraph", "text": "Sandbox." }] }],
 *   "databases": [{
 *     "key": "orders", "title": "Q3 Orders",
 *     "properties": {
 *       "Name":   { "type": "title" },
 *       "Amount": { "type": "number" },
 *       "Region": { "type": "select", "options": [{ "name": "NA", "color": "blue" }] }
 *     },
 *     "rows": {
 *       "count": 250,
 *       "properties": {
 *         "Name":   { "template": "ORD-{i:4}" },
 *         "Amount": { "randint": { "min": 10, "max": 999 } },
 *         "Region": { "cycle": ["NA", "EU", "APAC"] }
 *       }
 *     }
 *   }]
 * }
 * ```
 */
import { promises as fs } from "node:fs"
import type { PropValue } from "./notion.ts"

export const SPEC_VERSION = 1

/** Reserved key of the per-trial root page every fixture hangs off. */
export const ROOT_KEY = "root"

export interface SelectOption {
  name: string
  /** Notion's palette. Omitted means "let Notion pick", which specs should avoid. */
  color?: string
}

export type PropertySpec =
  | { type: "title" }
  | { type: "files" }
  | { type: "rich_text" }
  | { type: "number"; format?: string }
  | { type: "select"; options: SelectOption[] }
  | { type: "status"; options?: SelectOption[] }
  | { type: "multi_select"; options: SelectOption[] }
  | { type: "date" }
  | { type: "checkbox" }
  | { type: "url" }
  | { type: "email" }
  | { type: "phone_number" }

/** Emoji shorthand (`"📌"`) or an explicit icon object. */
export type IconSpec = string | { type: "emoji"; emoji: string } | { type: "external"; url: string }

/**
 * A file the fixture uploads before anything references it.
 *
 * Seeding attachments through the real two-step upload — rather than pasting
 * external URLs — is what makes them indistinguishable from files a person
 * dragged in, and it is the only way `content_length` is a real number an audit
 * task can be graded against.
 */
export interface FileSpec {
  key: string
  /** Uploaded filename, extension included. */
  name: string
  contentType?: string
  /** The file's contents. Literal text, so the byte count is inspectable in the spec. */
  text: string
}

/**
 * One discussion thread: an opening comment and its replies, in order.
 *
 * Threads attached to a *page* and threads attached to a *block inside* it are
 * different queries against `GET /v1/comments`, which is the distinction
 * `investigate-comments-001` grades — so both are expressible.
 */
export interface CommentSpec {
  text: string
  replies?: string[]
}

export interface BlockSpec {
  /** Any block type whose payload is `{rich_text}` — paragraph, heading_1..3, to_do, … */
  type?: string
  text: string
  /** `to_do` only. */
  checked?: boolean
  /** Inline discussions anchored to this block. */
  comments?: CommentSpec[]
}

export interface PageSpec {
  key: string
  title: string
  /** Spec key of the parent page. Defaults to `"root"`. */
  parent?: string
  icon?: IconSpec
  blocks?: BlockSpec[]
  /** Spec keys from `files`, appended to the page as `file` blocks. */
  attachments?: string[]
  /** Page-level discussions. */
  comments?: CommentSpec[]
}

/** Rows written out one by one, with optional keys for the id map. */
export interface ExplicitRowSpec {
  key?: string
  properties: Record<string, PropValue>
  /** `{propertyName → file spec keys}` for `files` properties. */
  files?: Record<string, string[]>
}

/**
 * A saved view on a database.
 *
 * Declarative on purpose: a spec says `groupBy: "Status"`, and provisioning
 * expands it into the `configuration.group_by` the API wants, so a fixture never
 * carries a hand-written view payload that only one reader understands.
 */
export interface ViewSpec {
  key?: string
  name: string
  /** `table` | `board` | `calendar` | `gallery` | `list` | `timeline` … */
  type: string
  /** Property to group by. Board and gallery views want one. */
  groupBy?: string
  /** A single-condition filter, expanded into the API's filter object. */
  filter?: { property: string; equals?: PropValue; isNotEmpty?: boolean }
  sorts?: Array<{ property: string; direction?: "ascending" | "descending" }>
}

/**
 * Index-driven row generation. `i` is 1-based.
 *
 * Recording 250 row ids in the id map would swamp it, so generated rows are
 * only keyed when `keyPrefix` is set (producing `<prefix>1` … `<prefix>N`).
 */
export interface GeneratedRowsSpec {
  count: number
  keyPrefix?: string
  properties: Record<string, ValueGen>
}

export type RowsSpec = ExplicitRowSpec[] | GeneratedRowsSpec

/**
 * How one property's value is produced for generated row `i`.
 *
 * - a bare scalar            → the same value on every row
 * - `{template}`             → `"ORD-{i}"`, `"ORD-{i:4}"` (zero-padded), `"{n}"` = count
 * - `{cycle}`                → `values[(i - 1) % values.length]`
 * - `{seq}`                  → `start + (i - 1) * step`
 * - `{dateSeq}`              → ISO date, `start` advanced by `stepDays` per row
 * - `{randint}` / `{pick}`   → seeded PRNG; deterministic, but not guessable
 */
export type ValueGen =
  | PropValue
  | { template: string }
  | { cycle: PropValue[] }
  | { seq: { start: number; step?: number } }
  | { dateSeq: { start: string; stepDays?: number } }
  | { randint: { min: number; max: number } }
  | { pick: PropValue[] }

export interface DataSourceSpec {
  /** Defaults to `<database key>.ds`. */
  key?: string
  /** Defaults to the database title. */
  name?: string
}

export interface DatabaseSpec {
  key: string
  title: string
  /** Spec key of the parent page. Defaults to `"root"`. */
  parent?: string
  icon?: IconSpec
  dataSource?: DataSourceSpec
  /** Exactly one property must be `{type: "title"}`. */
  properties: Record<string, PropertySpec>
  rows?: RowsSpec
  /**
   * Extra saved views. Every database already has the default table view the
   * API creates for it, so this is what a fixture adds *on top* of that.
   */
  views?: ViewSpec[]
}

export interface FixtureSpec {
  version: number
  /** Task id — folded into the root page title so a stray root is traceable. */
  id: string
  /** PRNG seed. Same seed ⇒ same rows. Defaults to 1. */
  seed?: number
  root?: { title?: string; icon?: IconSpec }
  /** Uploaded before anything else, so pages and rows can reference them by key. */
  files?: FileSpec[]
  pages?: PageSpec[]
  databases?: DatabaseSpec[]
}

export class SpecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SpecError"
  }
}

export async function loadSpec(specPath: string): Promise<FixtureSpec> {
  let raw: string
  try {
    raw = await fs.readFile(specPath, "utf8")
  } catch {
    throw new SpecError(`no fixture spec at ${specPath}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new SpecError(`${specPath} is not valid JSON: ${(err as Error).message}`)
  }
  return validateSpec(parsed, specPath)
}

/**
 * Structural validation. Deliberately strict about the things that silently
 * corrupt a *run* rather than failing it: duplicate keys, a missing title
 * property, a generator referencing a property that is not in the schema.
 */
export function validateSpec(value: unknown, source = "<spec>"): FixtureSpec {
  const spec = value as FixtureSpec
  if (!spec || typeof spec !== "object") throw new SpecError(`${source}: spec must be an object`)
  if (spec.version !== SPEC_VERSION) {
    throw new SpecError(`${source}: unsupported spec version ${String(spec.version)} (expected ${SPEC_VERSION})`)
  }
  if (typeof spec.id !== "string" || spec.id.length === 0) {
    throw new SpecError(`${source}: spec.id is required`)
  }

  const keys = new Set<string>([ROOT_KEY])
  const claim = (key: string, what: string): void => {
    if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(key)) {
      throw new SpecError(`${source}: ${what} key "${key}" must be alphanumeric/._-`)
    }
    if (keys.has(key)) throw new SpecError(`${source}: duplicate spec key "${key}"`)
    keys.add(key)
  }

  const fileKeys = new Set<string>()
  for (const file of spec.files ?? []) {
    if (typeof file.name !== "string" || file.name === "") {
      throw new SpecError(`${source}: file "${file.key}" needs a name`)
    }
    if (typeof file.text !== "string") {
      throw new SpecError(`${source}: file "${file.key}" needs literal \`text\` contents`)
    }
    claim(file.key, "file")
    fileKeys.add(file.key)
  }
  const requireFile = (key: string, what: string): void => {
    if (!fileKeys.has(key)) throw new SpecError(`${source}: ${what} references unknown file "${key}"`)
  }

  for (const page of spec.pages ?? []) {
    if (typeof page.title !== "string") throw new SpecError(`${source}: page "${page.key}" needs a title`)
    claim(page.key, "page")
    for (const key of page.attachments ?? []) requireFile(key, `page "${page.key}"`)
  }
  for (const db of spec.databases ?? []) {
    claim(db.key, "database")
    claim(db.dataSource?.key ?? `${db.key}.ds`, "data source")

    for (const view of db.views ?? []) {
      if (typeof view.name !== "string" || typeof view.type !== "string") {
        throw new SpecError(`${source}: every view of "${db.key}" needs a name and a type`)
      }
      if (view.key) claim(view.key, "view")
      for (const name of [view.groupBy, view.filter?.property, ...(view.sorts ?? []).map((s) => s.property)]) {
        if (name !== undefined && !(name in (db.properties ?? {}))) {
          throw new SpecError(
            `${source}: view "${view.name}" of "${db.key}" references unknown property "${name}"`,
          )
        }
      }
    }

    const props = db.properties ?? {}
    const titles = Object.entries(props).filter(([, p]) => p.type === "title")
    if (titles.length !== 1) {
      throw new SpecError(
        `${source}: database "${db.key}" must declare exactly one title property (found ${titles.length})`,
      )
    }
    for (const [name, prop] of Object.entries(props)) {
      if ((prop.type === "select" || prop.type === "multi_select") && !Array.isArray((prop as { options?: unknown }).options)) {
        throw new SpecError(`${source}: property "${name}" of "${db.key}" is a ${prop.type} without options`)
      }
    }

    const rows = db.rows
    if (rows && !Array.isArray(rows)) {
      if (!Number.isInteger(rows.count) || rows.count < 0) {
        throw new SpecError(`${source}: database "${db.key}" rows.count must be a non-negative integer`)
      }
      for (const name of Object.keys(rows.properties ?? {})) {
        if (!(name in props)) {
          throw new SpecError(`${source}: generated rows of "${db.key}" set unknown property "${name}"`)
        }
      }
    } else if (Array.isArray(rows)) {
      for (const row of rows) {
        if (row.key) claim(row.key, "row")
        for (const name of Object.keys(row.properties ?? {})) {
          if (!(name in props)) {
            throw new SpecError(`${source}: row of "${db.key}" sets unknown property "${name}"`)
          }
        }
        for (const [name, keys] of Object.entries(row.files ?? {})) {
          if (props[name]?.type !== "files") {
            throw new SpecError(
              `${source}: row of "${db.key}" attaches files to "${name}", which is not a files property`,
            )
          }
          for (const key of keys) requireFile(key, `row of "${db.key}"`)
        }
      }
    }
  }

  // Parent references must resolve to a page (or the root).
  const pageKeys = new Set<string>([ROOT_KEY, ...(spec.pages ?? []).map((p) => p.key)])
  for (const item of [...(spec.pages ?? []), ...(spec.databases ?? [])]) {
    const parent = item.parent ?? ROOT_KEY
    if (!pageKeys.has(parent)) {
      throw new SpecError(`${source}: "${item.key}" has parent "${parent}", which is not a page in this spec`)
    }
  }

  return spec
}

// ---------------------------------------------------------------------------
// Deterministic generation
// ---------------------------------------------------------------------------

/**
 * mulberry32 — 32-bit, seedable, and stable across Node versions (unlike
 * `Math.random`, which has no reproducibility guarantee at all). Good enough for
 * "plausible-looking fixture data", which is the entire requirement.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Per-(database, property) PRNG streams.
 *
 * A single stream shared by every generator would make row values depend on
 * property *iteration order*; deriving one stream per property from the spec
 * seed keeps a spec edit in one column from shifting the values in another.
 */
function streamSeed(seed: number, ...parts: string[]): number {
  let h = seed >>> 0
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      h = (Math.imul(h ^ part.charCodeAt(i), 0x01000193) + 0x9e3779b9) >>> 0
    }
  }
  return h >>> 0
}

/** `"ORD-{i:4}"` with i=7, n=250 → `"ORD-0007"`. `{n}` interpolates the count. */
export function renderTemplate(template: string, index: number, count: number): string {
  return template.replace(/\{(i|n)(?::(\d+))?\}/g, (_match, token: string, pad?: string) => {
    const value = token === "i" ? index : count
    return pad ? String(value).padStart(Number(pad), "0") : String(value)
  })
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) throw new SpecError(`dateSeq.start "${iso}" is not an ISO date`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function generateValue(gen: ValueGen, index: number, count: number, rand: () => number): PropValue {
  if (gen === null || typeof gen !== "object" || Array.isArray(gen)) return gen as PropValue
  const g = gen as Record<string, unknown>
  if (typeof g.template === "string") return renderTemplate(g.template, index, count)
  if (Array.isArray(g.cycle)) {
    const values = g.cycle as PropValue[]
    if (values.length === 0) throw new SpecError("cycle generator needs at least one value")
    return values[(index - 1) % values.length]
  }
  if (g.seq && typeof g.seq === "object") {
    const { start, step = 1 } = g.seq as { start: number; step?: number }
    return start + (index - 1) * step
  }
  if (g.dateSeq && typeof g.dateSeq === "object") {
    const { start, stepDays = 1 } = g.dateSeq as { start: string; stepDays?: number }
    return addDays(start, (index - 1) * stepDays)
  }
  if (g.randint && typeof g.randint === "object") {
    const { min, max } = g.randint as { min: number; max: number }
    if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
      throw new SpecError(`randint needs min <= max (got ${String(min)}..${String(max)})`)
    }
    return min + Math.floor(rand() * (max - min + 1))
  }
  if (Array.isArray(g.pick)) {
    const values = g.pick as PropValue[]
    if (values.length === 0) throw new SpecError("pick generator needs at least one value")
    return values[Math.floor(rand() * values.length)]
  }
  throw new SpecError(`unrecognized value generator: ${JSON.stringify(gen)}`)
}

export interface MaterializedRow {
  key?: string
  properties: Record<string, PropValue>
}

/**
 * Turn a database's `rows` into the concrete list that gets written.
 *
 * Pure: no clock, no network, no `Math.random`. Verifiers may call this to
 * predict the fixture, though they generally shouldn't — reading the workspace
 * back is the stronger ground truth.
 */
export function materializeRows(db: DatabaseSpec, seed: number): MaterializedRow[] {
  const rows = db.rows
  if (!rows) return []
  if (Array.isArray(rows)) return rows.map((row) => ({ key: row.key, properties: { ...row.properties } }))

  const count = rows.count
  // One PRNG per (database, property), advanced once per row so a value at row
  // i never depends on how many other columns are random.
  const streams = new Map<string, () => number>()
  for (const name of Object.keys(rows.properties ?? {})) {
    streams.set(name, mulberry32(streamSeed(seed, db.key, name)))
  }

  const out: MaterializedRow[] = []
  for (let i = 1; i <= count; i++) {
    const properties: Record<string, PropValue> = {}
    for (const [name, gen] of Object.entries(rows.properties ?? {})) {
      properties[name] = generateValue(gen, i, count, streams.get(name) as () => number)
    }
    out.push({ key: rows.keyPrefix ? `${rows.keyPrefix}${i}` : undefined, properties })
  }
  return out
}

/** Normalize the icon shorthand into the API's icon object. */
export function toIcon(icon: IconSpec | undefined): Record<string, unknown> | undefined {
  if (icon === undefined) return undefined
  if (typeof icon === "string") return { type: "emoji", emoji: icon }
  if (icon.type === "emoji") return { type: "emoji", emoji: icon.emoji }
  return { type: "external", external: { url: icon.url } }
}
