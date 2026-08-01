/**
 * Shared survey for the exhibition entries (`evals/showcase-*`).
 *
 * The three showcase tasks are not benchmark tasks: they always score 1, and
 * what their `EVAL.ts` produces is the *placard* under a screenshot — a count
 * of what the agent built, and a checklist of which information-architecture
 * elements the subject called for. All three need the same raw material (walk
 * the sandbox root, count everything, remember every database's schema, views
 * and title), and none of them needs it to be strict, so the walk lives here
 * and only the taste-specific matching rules live in each task.
 *
 * Nothing in this file is allowed to fail a run. Every API call that can throw
 * is swallowed: a database whose views cannot be listed contributes a zero to
 * the view count and nothing else. An exhibition entry that could not be fully
 * measured is a thin caption, not a lost trial.
 *
 * The matching helpers below (`titleMatches`, `hasPropertyNamed`, `related`,
 * …) are deliberately generous. A showcase check asks "did they solve this part
 * of the problem at all", not "did they name it what we expected" — a supplies
 * database is just as likely to be called Pantry, Stock, Kit or Consumables,
 * and a check that only accepted "Inventory" would be measuring vocabulary
 * rather than architecture. Each task documents, per check, exactly which
 * shapes it accepts, so a gallery caption can be trusted.
 */
import {
  blockText,
  isTrashed,
  pageIconEmoji,
  plainText,
  sameId,
  type NotionBlock,
  type NotionClient,
  type NotionPage,
  type NotionView,
} from "./notion.ts"

// ---------------------------------------------------------------------------
// The placard: raw counts, reported as one machine-readable diagnostic line
// ---------------------------------------------------------------------------

/**
 * Counts only. These never become subscores: `packages/core`'s `ScoreSchema`
 * constrains every subscore to [0, 1] (and a test enforces it), and "14 blocks"
 * is not a fraction. They are emitted as a `PLACARD {…}` JSON line instead —
 * parse that, and do not widen the results schema for an exhibition.
 */
export interface Placard {
  pages: number
  databases: number
  data_sources: number
  rows: number
  /** Content blocks — `child_page`/`child_database` are structure, not content. */
  blocks: number
  views: number
  view_types: string[]
  board_views: number
  calendar_views: number
  timeline_views: number
  /** `relation` properties across every data source. */
  relations: number
  /** `rollup` properties across every data source. */
  rollups: number
  /** Emoji icons on pages and databases. */
  icons: number
  /** Deepest page nesting below the sandbox root; the root itself is 0. */
  max_depth: number
}

export const EMPTY_PLACARD: Placard = {
  pages: 0,
  databases: 0,
  data_sources: 0,
  rows: 0,
  blocks: 0,
  views: 0,
  view_types: [],
  board_views: 0,
  calendar_views: 0,
  timeline_views: 0,
  relations: 0,
  rollups: 0,
  icons: 0,
  max_depth: 0,
}

// ---------------------------------------------------------------------------
// The survey: everything a checklist might want to look at
// ---------------------------------------------------------------------------

export interface SurveyProperty {
  name: string
  type: string
  /** Option names of a `select`/`multi_select`/`status` property. */
  options: string[]
  /** `data_source_id` a `relation` points at, when the API reports one. */
  relationTarget?: string
  /** Rollup/formula body, stringified — searched for `sum`, money words, … */
  detail: string
}

export interface SurveyDataSource {
  id: string
  properties: SurveyProperty[]
  rows: number
}

export interface SurveyDatabase {
  id: string
  title: string
  icon: boolean
  dataSources: SurveyDataSource[]
  /** Every property of every data source, flattened. */
  properties: SurveyProperty[]
  rows: number
  views: NotionView[]
  viewTypes: string[]
}

export interface SurveyPage {
  id: string
  title: string
  icon: boolean
  depth: number
}

export interface Survey {
  placard: Placard
  pages: SurveyPage[]
  databases: SurveyDatabase[]
  views: NotionView[]
  /** Plain text of every non-structural block, joined — the prose corpus. */
  text: string
  /** Number of blocks that carried any text at all. */
  textBlocks: number
  /** Longest single run of prose, in characters. */
  longestBlock: number
  /** Titles of every page and database, lowercased — cheap "is X mentioned". */
  titles: string[]
}

/** A survey of nothing — what an unmeasurable entry gets graded against. */
export function emptySurvey(): Survey {
  return {
    placard: { ...EMPTY_PLACARD, view_types: [] },
    pages: [],
    databases: [],
    views: [],
    text: "",
    textBlocks: 0,
    longestBlock: 0,
    titles: [],
  }
}

function readSchema(raw: Record<string, unknown>): SurveyProperty[] {
  const out: SurveyProperty[] = []
  for (const [name, value] of Object.entries(raw ?? {})) {
    const prop = (value ?? {}) as Record<string, unknown>
    const type = String(prop.type ?? "")
    const payload = (prop[type] ?? {}) as Record<string, unknown>
    const options = Array.isArray((payload as { options?: unknown }).options)
      ? ((payload as { options: Array<{ name?: string }> }).options ?? [])
          .map((o) => String(o?.name ?? ""))
          .filter(Boolean)
      : []
    // A relation reports its target as `data_source_id` (2025-09-03+) or
    // `database_id` (older deployments); accept either.
    const target =
      type === "relation"
        ? ((payload.data_source_id as string | undefined) ??
          (payload.database_id as string | undefined))
        : undefined
    out.push({
      name: String((prop.name as string | undefined) ?? name),
      type,
      options,
      relationTarget: target,
      detail: safeJson(payload),
    })
  }
  return out
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? ""
  } catch {
    return ""
  }
}

/**
 * Walk everything the agent left under the sandbox root: pages, databases,
 * data sources, rows, views and prose. Bounded at depth 8, cycle-safe, and
 * incapable of throwing — every call site that can fail degrades to a zero.
 */
export async function survey(client: NotionClient, rootId: string): Promise<Survey> {
  const result = emptySurvey()
  const placard = result.placard
  const viewTypes = new Set<string>()
  const textParts: string[] = []
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }]
  const seen = new Set<string>()

  while (queue.length > 0) {
    const next = queue.shift()
    if (!next) break
    const { id, depth } = next
    if (seen.has(id) || depth > 8) continue
    seen.add(id)
    placard.max_depth = Math.max(placard.max_depth, depth)

    let blocks: NotionBlock[]
    try {
      blocks = await client.listAllBlockChildren(id)
    } catch {
      continue
    }

    for (const block of blocks) {
      if (isTrashed(block)) continue

      if (block.type === "child_page") {
        placard.pages++
        const title = String((block.child_page as { title?: string } | undefined)?.title ?? "")
        let icon = false
        try {
          icon = pageIconEmoji(await client.getPage(block.id)) !== null
        } catch {
          /* an icon we cannot read is not worth failing a placard over */
        }
        if (icon) placard.icons++
        result.pages.push({ id: block.id, title, icon, depth: depth + 1 })
        result.titles.push(title.toLowerCase())
        queue.push({ id: block.id, depth: depth + 1 })
        continue
      }

      if (block.type === "child_database") {
        placard.databases++
        const inline = String(
          (block.child_database as { title?: string } | undefined)?.title ?? "",
        )
        const entry = await surveyDatabase(client, block.id, inline)
        result.databases.push(entry)
        result.titles.push(entry.title.toLowerCase())
        if (entry.icon) placard.icons++
        placard.data_sources += entry.dataSources.length
        placard.rows += entry.rows
        placard.views += entry.views.length
        result.views.push(...entry.views)
        for (const view of entry.views) {
          viewTypes.add(view.type)
          if (view.type === "board") placard.board_views++
          if (view.type === "calendar") placard.calendar_views++
          if (view.type === "timeline") placard.timeline_views++
        }
        for (const prop of entry.properties) {
          if (prop.type === "relation") placard.relations++
          if (prop.type === "rollup") placard.rollups++
        }
        continue
      }

      placard.blocks++
      const text = blockText(block).trim()
      if (text) {
        textParts.push(text)
        result.textBlocks++
        result.longestBlock = Math.max(result.longestBlock, text.length)
      }
      // Toggles, columns, callouts and quotes nest their prose one level down;
      // a workspace whose writing lives inside a toggle is still written.
      if (block.has_children) queue.push({ id: block.id, depth })
    }
  }

  placard.view_types = [...viewTypes].sort()
  result.text = textParts.join("\n")
  return result
}

async function surveyDatabase(
  client: NotionClient,
  databaseId: string,
  inlineTitle: string,
): Promise<SurveyDatabase> {
  const entry: SurveyDatabase = {
    id: databaseId,
    title: inlineTitle,
    icon: false,
    dataSources: [],
    properties: [],
    rows: 0,
    views: [],
    viewTypes: [],
  }

  let database
  try {
    database = await client.getDatabase(databaseId)
  } catch {
    return entry
  }
  const apiTitle = plainText(database.title).trim()
  if (apiTitle) entry.title = apiTitle
  entry.icon = (database.icon as { type?: string } | null | undefined)?.type === "emoji"

  for (const source of database.data_sources ?? []) {
    const ds: SurveyDataSource = { id: source.id, properties: [], rows: 0 }
    try {
      const full = await client.getDataSource(source.id)
      ds.properties = readSchema(full.properties as Record<string, unknown>)
    } catch {
      /* a data source we cannot read still counts as a data source */
    }
    try {
      const rows = await client.queryAllRows(source.id)
      ds.rows = rows.filter((row: NotionPage) => !isTrashed(row)).length
    } catch {
      /* likewise for rows */
    }
    entry.dataSources.push(ds)
    entry.properties.push(...ds.properties)
    entry.rows += ds.rows
  }

  try {
    entry.views = await client.listAllViewsFor({ database_id: databaseId })
  } catch {
    /* pre-2026-03-11 deployments have no view endpoint; leave the list empty */
  }
  entry.viewTypes = [...new Set(entry.views.map((v) => String(v.type)))].sort()
  return entry
}

// ---------------------------------------------------------------------------
// Generous matchers
// ---------------------------------------------------------------------------

/** Fuzzy title match. Substring, case-insensitive, never an equality test. */
export function titleMatches(db: SurveyDatabase, pattern: RegExp): boolean {
  return pattern.test(db.title.toLowerCase())
}

/** True when any property's *name* matches — naming is the agent's choice. */
export function hasPropertyNamed(db: SurveyDatabase, pattern: RegExp): boolean {
  return db.properties.some((p) => pattern.test(p.name.toLowerCase()))
}

/** True when any property has one of these Notion types. */
export function hasPropertyType(db: SurveyDatabase, types: string[]): boolean {
  return db.properties.some((p) => types.includes(p.type))
}

/**
 * A property that could drive "what is due today": a real `date`, or a
 * formula/created/edited stamp standing in for one. Rollups count too — a
 * next-review date rolled up from somewhere else is still a schedule.
 */
export const DATEISH = ["date", "formula", "created_time", "last_edited_time", "rollup"]

/** A single-choice state property, whatever the agent called the type. */
export const STATEISH = ["select", "status"]

/** True when any select/status/multi-select option name matches. */
export function hasOptionLike(db: SurveyDatabase, pattern: RegExp): boolean {
  return db.properties.some((p) => p.options.some((o) => pattern.test(o.toLowerCase())))
}

/**
 * Do these two databases know about each other?
 *
 * Preferred evidence is a `relation` on one whose target data source belongs to
 * the other. Deployments that omit the target id, and rollups (which reach
 * through a relation by definition), fall back to "one of the two carries a
 * relation or a rollup at all" — weaker, but a false negative here would
 * caption a workspace as unconnected when a human can see the link.
 */
export function related(a: SurveyDatabase | undefined, b: SurveyDatabase | undefined): boolean {
  if (!a || !b || a.id === b.id) return false
  const ids = (db: SurveyDatabase) => [db.id, ...db.dataSources.map((d) => d.id)]
  const aIds = ids(a)
  const bIds = ids(b)
  const points = (from: SurveyDatabase, to: string[]) =>
    from.properties.some(
      (p) => p.type === "relation" && to.some((id) => sameId(p.relationTarget, id)),
    )
  if (points(a, bIds) || points(b, aIds)) return true
  const linky = (db: SurveyDatabase) =>
    db.properties.some((p) => p.type === "relation" || p.type === "rollup")
  return linky(a) || linky(b)
}

/** First database matching a predicate, in workspace order. */
export function pick(
  databases: SurveyDatabase[],
  predicate: (db: SurveyDatabase) => boolean,
): SurveyDatabase | undefined {
  return databases.find(predicate)
}

/**
 * Two-pass find: every database is offered the *title* test before any of them
 * is offered the structural one.
 *
 * Order matters more than it looks. Both arms are deliberately loose, so in a
 * workspace with several databases the structural arm will often match one the
 * author did not mean — a servicing log has a date and a "Next service"
 * column, which is appointment-shaped if you squint. Trying titles first means
 * the obvious answer wins whenever there is an obvious answer, and the loose
 * arm only decides the cases where nothing was named recognisably.
 */
export function pickByTitleThenShape(
  databases: SurveyDatabase[],
  byTitle: (db: SurveyDatabase) => boolean,
  byShape: (db: SurveyDatabase) => boolean,
): SurveyDatabase | undefined {
  return databases.find(byTitle) ?? databases.find(byShape)
}

/**
 * Any view that groups its rows — a board always does, and a table or list
 * grouped by a status property is the same idea drawn differently. The check
 * is a string search of the view's configuration because the grouping key has
 * moved around between API versions and an exhibition should not care.
 */
export function hasGroupedView(views: NotionView[]): boolean {
  return views.some(
    (v) => v.type === "board" || /"group|group_by|groupBy/i.test(safeJson(v.configuration)),
  )
}

/** `null`, `[]` and `{}` all mean "the agent left this alone". */
function isEmptyish(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === "object") return Object.keys(value as object).length === 0
  return false
}

/**
 * A view that *narrows* rather than just displays: it carries a filter or a
 * sort, or its name says what it is for ("Due today", "This week", "Up next").
 *
 * The name arm exists because a filter can be expressed in the view
 * configuration in more than one place depending on API version, and because a
 * default table renamed "Due today" with a sort on a date is a perfectly good
 * answer to "tell me what to study now".
 */
export function hasNarrowedView(views: NotionView[], namePattern?: RegExp): boolean {
  return views.some(
    (v) =>
      !isEmptyish(v.filter) ||
      !isEmptyish(v.sorts) ||
      (namePattern !== undefined && namePattern.test(String(v.name ?? "").toLowerCase())),
  )
}

/** Case-insensitive search of the workspace's prose and titles at once. */
export function mentions(survey: Survey, pattern: RegExp): boolean {
  return pattern.test(survey.text.toLowerCase()) || survey.titles.some((t) => pattern.test(t))
}

/** Human summary of the counts, for the diagnostic line under `PLACARD`. */
export function describe(placard: Placard): string {
  return (
    `${placard.pages} page(s), ${placard.databases} database(s) with ${placard.rows} row(s), ` +
    `${placard.views} view(s) (${placard.view_types.join("/") || "none"}), ` +
    `${placard.relations} relation(s), ${placard.rollups} rollup(s), ` +
    `${placard.blocks} content block(s), nested ${placard.max_depth} deep`
  )
}

/** The `requested elements: n/m — ✓ a, ✗ b` line every showcase prints. */
export function describeChecklist(checks: Record<string, number>): string {
  const met = Object.values(checks).filter((v) => v === 1).length
  const entries = Object.entries(checks)
    .map(([name, ok]) => `${ok ? "✓" : "✗"} ${name}`)
    .join(", ")
  return `requested elements: ${met}/${Object.keys(checks).length} — ${entries}`
}
