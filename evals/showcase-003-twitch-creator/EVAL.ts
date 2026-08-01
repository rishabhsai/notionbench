/**
 * showcase-003-twitch-creator — an exhibition placard. Always scores 1.
 *
 * This is not a scorer and must never behave like one. The gallery is judged by
 * people looking at screenshots; the job here is to produce the caption that
 * goes underneath one, from the workspace the agent actually built.
 *
 * Two kinds of number come out, and the split is deliberate:
 *
 *   - **subscores** are the element checklist — one 0/1 per part of the
 *     creator's problem (VODs, the pipeline and a board over it, the editor
 *     handoff, scripts, sponsors and what is owed them, a calendar, how videos
 *     did). Objective, and *unscored*: `score` is 1 no matter how many are 0.
 *     They exist so a placard can say "11 of 14 elements" without anyone
 *     having to count.
 *   - **counts** — pages, databases, rows, views, relations — go into a single
 *     machine-readable `PLACARD {…}` diagnostic line rather than into
 *     subscores, because `packages/core`'s results schema constrains every
 *     subscore to [0, 1] and a workspace with 40 blocks is not a fraction.
 *     Parse that line; do not widen the schema for an exhibition.
 *
 * Every check below is generous about naming and shape, on purpose. The prompt
 * prescribes no structure, so the honest question is "did they model this part
 * of the problem at all", not "did they call it what we expected". A VOD
 * database is as likely to be called Streams, Episodes, Content or Videos.
 * Each check documents the shapes it accepts, so a gallery caption that says
 * `editor_handoff ✓` can be trusted to mean something specific.
 *
 * Failure is not a failure state. If there is no token, no root page, or the
 * workspace has been torn down already, the placard says so and the score is
 * still 1 — an exhibition entry that could not be measured is a missing
 * caption, not a lost run.
 */
import { resolveLiveContext } from "../_lib/live/context.ts"
import {
  DATEISH,
  STATEISH,
  describe,
  describeChecklist,
  emptySurvey,
  hasGroupedView,
  hasOptionLike,
  hasPropertyNamed,
  hasPropertyType,
  pick,
  pickByTitleThenShape,
  related,
  survey,
  titleMatches,
  type Survey,
  type SurveyDatabase,
} from "../_lib/live/showcase.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

// ---------------------------------------------------------------------------
// Which database is which
//
// Each finder is title-then-shape: every database is offered the fuzzy title
// test first, and only if none matches does the structural test get a turn.
// That way the obvious answer wins when there is one, and the loose arm only
// decides workspaces where nothing was named recognisably.
// ---------------------------------------------------------------------------

/**
 * The thing that comes out of a stream. Accepts streams/VODs/broadcasts/
 * episodes/shows/sessions/videos/content/uploads by title, or any database
 * with a date-ish property plus a stream-shaped property name (vod, twitch,
 * youtube, game, category, duration, clip, link, url, thumbnail).
 *
 * One database or two — a workspace that keeps streams and finished videos
 * apart is matched on whichever comes first, which is fine for a caption.
 */
function findStreams(databases: SurveyDatabase[]): SurveyDatabase | undefined {
  const streamish = /\bvod\b|twitch|youtube|\bgame\b|categor|duration|clip|link|\burl\b|thumbnail|footage/
  return pickByTitleThenShape(
    databases,
    (db) => titleMatches(db, /stream|vod|broadcast|episode|show|session|video|content|upload/),
    (db) => hasPropertyType(db, DATEISH) && hasPropertyNamed(db, streamish),
  )
}

/**
 * The money side. Accepts sponsors/brands/deals/partnerships/campaigns/ads by
 * title, or any database carrying both a date-ish property and a fee-shaped
 * one (fee, rate, payment, invoice, paid, amount, rate card, budget) — a
 * sponsorship is an obligation with a date and a price however it is named.
 */
function findSponsors(databases: SurveyDatabase[]): SurveyDatabase | undefined {
  const feeish = /\bfee\b|rate|payment|invoice|paid|amount|budget|\bcpm\b|price|value/
  return pickByTitleThenShape(
    databases,
    (db) => titleMatches(db, /sponsor|brand|deal|partner|campaign|\bads?\b|advertis|client/),
    (db) => hasPropertyType(db, DATEISH) && hasPropertyNamed(db, feeish),
  )
}

/** The elements the creator's problem calls for. Reported, never enforced. */
function checklist(s: Survey): Record<string, number> {
  const p = s.placard
  const streams = findStreams(s.databases)
  const sponsors = findSponsors(s.databases)

  // The pipeline itself: a select/status property that models where a piece of
  // content has got to. Passes on the property *name* reading as state
  // (status, stage, pipeline, state, progress, phase) or on its *options*
  // reading as pipeline stages (raw, unedited, editing, edited, scripted,
  // clipped, rendering, uploaded, scheduled, published, live, done). Options
  // are the more honest signal — a "Stage" property with options "A/B" is not
  // a pipeline — but the name arm is kept too, because a status property is a
  // status property even when its options are the show's own vocabulary.
  const stateName = /status|stage|pipeline|state|progress|phase/
  const stageOptions = /raw|unedited|edit|script|clip|render|upload|publish|schedul|\blive\b|done|posted|drafted|review/
  const pipelineStatus = s.databases.some((db) =>
    db.properties.some(
      (prop) =>
        STATEISH.includes(prop.type) &&
        (stateName.test(prop.name.toLowerCase()) ||
          prop.options.some((o) => stageOptions.test(o.toLowerCase()))),
    ),
  )

  // The freelance editor. Deliberately broad, because the handoff is modelled
  // in wildly different ways and all of them are legitimate: a property or
  // option naming the editor or the state of being with them (editor, handoff,
  // sent, delivered, feedback, notes back, revision, round, approval, turnaround,
  // due back), a `people` property (assigning the row to someone is the
  // handoff), or a page or database about the editor. This is the loosest
  // check in the file; it is here because "Status: With editor" and "Assignee:
  // Sam" and a written handoff SOP are the same answer wearing three hats.
  const handoffish = /editor|hand.?off|hand.?over|sent|deliver|feedback|notes back|revision|round|approv|turnaround|due back|with ed/
  const editorHandoff =
    s.databases.some(
      (db) =>
        hasPropertyNamed(db, handoffish) ||
        hasOptionLike(db, handoffish) ||
        hasPropertyType(db, ["people"]),
    ) || s.pages.some((page) => /editor|hand.?off|hand.?over/.test(page.title.toLowerCase()))

  // Scripts. A database or page for them, or a script-shaped property on any
  // database (script, outline, draft, beat sheet, talking points, hook). The
  // word "script" alone is unambiguous here; the rest are the synonyms an
  // agent reaches for when it puts the script inline on the video row.
  const scriptish = /script|outline|beat sheet|talking point|\bhook\b|\bdraft\b/
  const scripts =
    s.databases.some((db) => titleMatches(db, scriptish) || hasPropertyNamed(db, scriptish)) ||
    s.pages.some((page) => scriptish.test(page.title.toLowerCase()))

  // What is owed to a sponsor. Passes on deliverable/deadline vocabulary as a
  // property on the sponsors database itself, or on a separate deliverables
  // database that is related to it — the two normal ways to model "a mid-roll
  // read by the 14th, two clips, a link in the description".
  const deliverableName = /deliverab|deadline|\bdue\b|obligation|requirement|mid.?roll|integration|asset|commit|promised|spot/
  const deliverables = pick(
    s.databases,
    (db) =>
      db.id !== sponsors?.id &&
      titleMatches(db, /deliverab|obligation|commit|asset|promo|placement|\btasks?\b/),
  )
  const sponsorDeliverables =
    (sponsors !== undefined && hasPropertyNamed(sponsors, deliverableName)) ||
    (deliverables !== undefined && related(sponsors, deliverables))

  // How videos did. Any property whose name reads as a metric — views,
  // viewers, watch time, retention, CCV, subscribers, engagement, likes,
  // comments, impressions, CTR, revenue, RPM — or a page or database whose
  // title does (performance, analytics, stats, metrics, numbers). "Views" is
  // word-bounded so the word "Review" cannot pass this check by accident.
  const metricish = /\bviews?\b|viewer|watch|retention|\bccv\b|subscriber|engagement|\blikes?\b|comments|impression|\bctr\b|revenue|\brpm\b|hours|peak|average/
  const titleMetric = /performance|analytic|stats|metric|number|dashboard|report/
  const performance =
    s.databases.some((db) => hasPropertyNamed(db, metricish) || titleMatches(db, titleMetric)) ||
    s.pages.some((page) => titleMetric.test(page.title.toLowerCase()))

  return {
    // Any child page under the sandbox root. The root itself is not counted —
    // an agent that dumped everything onto the root page built no home.
    home_page: p.pages >= 1 ? 1 : 0,
    // See findStreams.
    stream_vod_db: streams ? 1 : 0,
    // See the pipeline comment above.
    video_pipeline_status: pipelineStatus ? 1 : 0,
    // A board view, or any view whose configuration groups rows — a table
    // grouped by stage is the same idea drawn differently.
    pipeline_board_view: p.board_views >= 1 || hasGroupedView(s.views) ? 1 : 0,
    // See the editor comment above.
    editor_handoff: editorHandoff ? 1 : 0,
    // See the scripts comment above.
    scripts_tracking: scripts ? 1 : 0,
    // See findSponsors.
    sponsorships_db: sponsors ? 1 : 0,
    // See the deliverables comment above.
    sponsor_deliverables: sponsorDeliverables ? 1 : 0,
    // A calendar view anywhere. Timeline counts: for "what goes out when" it
    // answers the same question, and refusing it would grade view-picking
    // rather than whether the schedule is legible.
    content_calendar: p.calendar_views + p.timeline_views >= 1 ? 1 : 0,
    // See the metrics comment above.
    performance_tracking: performance ? 1 : 0,
    // Real prose: 300+ characters of block text across 6+ text-bearing blocks,
    // with at least one paragraph-length run. Deliberately not "10 blocks" —
    // ten empty dividers are not writing.
    written_content: s.text.length >= 300 && s.textBlocks >= 6 && s.longestBlock >= 60 ? 1 : 0,
    // Seeded example data, anywhere. Empty databases photograph as abandoned.
    populated_rows: p.rows >= 8 ? 1 : 0,
    // Emoji icons on 3+ pages or databases.
    icons: p.icons >= 3 ? 1 : 0,
    // Something below the home page, i.e. the workspace has a shape.
    nested_structure: p.max_depth >= 2 ? 1 : 0,
  }
}

/** Extra colour for the caption — never a check, just something to read. */
function flavour(s: Survey): string {
  const bits: string[] = []
  const streams = findStreams(s.databases)
  if (streams) bits.push(`content: "${streams.title}" (${streams.rows} row(s))`)
  const sponsors = findSponsors(s.databases)
  if (sponsors) bits.push(`sponsors: "${sponsors.title}" (${sponsors.rows} row(s))`)
  if (s.databases.length > 0) {
    bits.push(`databases: ${s.databases.map((db) => `"${db.title}"`).join(", ")}`)
  }
  return bits.join(" · ") || "nothing found under the sandbox root"
}

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  let s = emptySurvey()

  try {
    const live = await resolveLiveContext({ workspaceDir, ctx })
    diagnostics.push(`api=${live.apiBase} root=${live.rootId} (${live.source.root})`)
    s = await survey(live.client, live.rootId)
  } catch (err) {
    diagnostics.push(
      `placard not measured: ${(err as Error).message} — the exhibition entry still stands, it just has no caption`,
    )
  }

  const checks = checklist(s)
  diagnostics.push(`PLACARD ${JSON.stringify(s.placard)}`)
  diagnostics.push(describe(s.placard))
  diagnostics.push(flavour(s))
  diagnostics.push(describeChecklist(checks))
  diagnostics.push("exhibition entry: unscored by construction, judged by people")

  return { score: 1, subscores: checks, diagnostics }
}
