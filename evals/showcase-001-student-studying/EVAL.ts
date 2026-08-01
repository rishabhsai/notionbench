/**
 * showcase-001-student-studying — an exhibition placard. Always scores 1.
 *
 * This is not a scorer and must never behave like one. The gallery is judged by
 * people looking at screenshots; the job here is to produce the caption that
 * goes underneath one, from the workspace the agent actually built.
 *
 * Two kinds of number come out, and the split is deliberate:
 *
 *   - **subscores** are the element checklist — one 0/1 per part of the
 *     student's problem (a review schedule, something that says what is due
 *     now, the calendar, courses, notes, weak spots, reading). Objective, and
 *     *unscored*: `score` is 1 no matter how many are 0. They exist so a
 *     placard can say "10 of 13 elements" without anyone having to count.
 *   - **counts** — pages, databases, rows, views, relations — go into a single
 *     machine-readable `PLACARD {…}` diagnostic line rather than into
 *     subscores, because `packages/core`'s results schema constrains every
 *     subscore to [0, 1] and a workspace with 40 blocks is not a fraction.
 *     Parse that line; do not widen the schema for an exhibition.
 *
 * Every check below is generous about naming and shape, on purpose. The prompt
 * prescribes no structure, so the honest question is "did they model this part
 * of the problem at all", not "did they call it what we expected". A review
 * database is as likely to be called Flashcards, Deck, Recall or Queue as
 * Review. Each check documents the shapes it accepts, so a gallery caption
 * that says `weak_topics_tracking ✓` can be trusted to mean something specific.
 *
 * Failure is not a failure state. If there is no token, no root page, or the
 * workspace has been torn down already, the placard says so and the score is
 * still 1 — an exhibition entry that could not be measured is a missing
 * caption, not a lost run.
 */
import { resolveLiveContext } from "../_lib/live/context.ts"
import {
  DATEISH,
  describe,
  describeChecklist,
  emptySurvey,
  hasNarrowedView,
  hasOptionLike,
  hasPropertyNamed,
  hasPropertyType,
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
 * The spaced-repetition engine. Accepts any database that has a date-ish
 * property — a real `date`, or a formula/rollup/timestamp standing in for one,
 * which is what "what is due today" has to be computed from — and either reads
 * as study material by title (review, study, flashcard, deck, card, recall,
 * spaced, queue, revision, quiz, concept, topic) or carries a
 * scheduling-shaped property name (next review, interval, ease, box, streak,
 * repetitions, last reviewed, level).
 *
 * The date-ish half is the part that matters. A deck with no schedule is a
 * pile of notes, which is exactly what the student already has.
 */
function findReviewSystem(databases: SurveyDatabase[]): SurveyDatabase | undefined {
  const scheduling = /review|recall|interval|ease|\bbox\b|streak|repetition|last studied|next|strength/
  const named = /review|stud|flash|card|deck|recall|spaced|queue|revis|quiz|concept|topic|prompt/
  const scheduled = (db: SurveyDatabase) => hasPropertyType(db, DATEISH)
  return pickByTitleThenShape(
    databases,
    (db) => scheduled(db) && titleMatches(db, named),
    (db) => scheduled(db) && hasPropertyNamed(db, scheduling),
  )
}

/**
 * The five classes. Accepts courses/classes/subjects/modules/semester/term by
 * title, or any database carrying course-shaped properties (professor,
 * instructor, credits, course code, room, syllabus, meeting time).
 */
function findCourses(databases: SurveyDatabase[]): SurveyDatabase | undefined {
  const courseish = /professor|instructor|lecturer|credit|course code|\bcode\b|room|syllab|semester|term\b/
  return pickByTitleThenShape(
    databases,
    (db) => titleMatches(db, /course|class|subject|module|semester|term|schedule of|major/),
    (db) => hasPropertyNamed(db, courseish),
  )
}

/**
 * Somewhere for the lecture notes. Accepts notes/lectures/materials/
 * resources/handouts/summaries by title, or — for an agent that named it
 * something else — any database that both links to another database and has a
 * rich-text body property, which is what "notes filed under a course" looks
 * like structurally. Never the review or courses database.
 */
function findNotes(
  databases: SurveyDatabase[],
  used: Array<SurveyDatabase | undefined>,
): SurveyDatabase | undefined {
  const taken = new Set(used.filter(Boolean).map((db) => (db as SurveyDatabase).id))
  const free = (db: SurveyDatabase) => !taken.has(db.id)
  const named = /note|lecture|material|resource|handout|summar|knowledge|source|doc/
  return pickByTitleThenShape(
    databases,
    (db) => free(db) && titleMatches(db, named),
    (db) =>
      free(db) && hasPropertyType(db, ["relation"]) && hasPropertyType(db, ["rich_text", "files"]),
  )
}

/** The elements the student's problem calls for. Reported, never enforced. */
function checklist(s: Survey): Record<string, number> {
  const p = s.placard
  const review = findReviewSystem(s.databases)
  const courses = findCourses(s.databases)
  const notes = findNotes(s.databases, [review, courses])

  // "Tell me what to go over today." Passes on a view that narrows rather than
  // just displays — one carrying a filter or a sort — preferring the review
  // database's own views, or on any view anywhere whose name says what it is
  // for. The name arm matters because a filter lands in different places in the
  // view payload depending on API version, and a renamed, date-sorted table
  // called "Due today" is a perfectly good answer.
  const dueName = /due|today|now|next|up ?next|this week|queue|to review|to study|focus|priorit/
  const dueToday = review
    ? hasNarrowedView(review.views, dueName) || hasNarrowedView(s.views, dueName)
    : hasNarrowedView(s.views, dueName)

  // Weak spots. Any property whose name reads as a self-assessment
  // (confidence, mastery, difficulty, weak, strength, struggling, comfort,
  // rating, grade, score, level, ease, priority) or any select option that
  // does (weak, shaky, struggling, solid, strong, confident, easy, hard,
  // needs work). Type-agnostic: a number 1-5, a select, or a formula are all
  // legitimate ways to say "I am shaky on this".
  const weakName = /confiden|master|difficult|weak|strength|struggl|comfort|rating|grade|score|\blevel\b|ease|priorit/
  const weakOption = /weak|shaky|struggl|solid|strong|confident|easy|hard|need|rusty|unsure/
  const weakTopics = s.databases.some(
    (db) => hasPropertyNamed(db, weakName) || hasOptionLike(db, weakOption),
  )

  // Assigned reading. A database or page for it, or a reading-shaped property
  // on any database (read, reading, pages, chapter, textbook, article) — a
  // "Read?" checkbox on the course materials table is a real answer.
  const readingish = /read|book|textbook|article|chapter|\bpages?\b|journal|paper\b/
  const reading =
    s.databases.some((db) => titleMatches(db, readingish) || hasPropertyNamed(db, readingish)) ||
    s.pages.some((page) => readingish.test(page.title.toLowerCase()))

  return {
    // Any child page under the sandbox root. The root itself is not counted —
    // an agent that dumped everything onto the root page built no home.
    home_page: p.pages >= 1 ? 1 : 0,
    // See findReviewSystem.
    review_system: review ? 1 : 0,
    // See the "what to go over today" comment above.
    due_today_view: dueToday ? 1 : 0,
    // A calendar view anywhere. Timeline counts: it answers "when is the exam"
    // the same way, and refusing it would grade view-picking rather than
    // whether the dates are somewhere the student will look.
    exam_calendar: p.calendar_views + p.timeline_views >= 1 ? 1 : 0,
    // See findCourses.
    courses_db: courses ? 1 : 0,
    // See findNotes.
    notes_db: notes ? 1 : 0,
    // Material tied to the class it belongs to: a relation whose target is the
    // other database, or — where the API omits the relation target — either
    // database carrying any relation or rollup. The review queue counts as
    // material, so a workspace that hangs cards off courses rather than notes
    // passes too.
    notes_courses_related: related(notes, courses) || related(review, courses) ? 1 : 0,
    // See the weak-spots comment above.
    weak_topics_tracking: weakTopics ? 1 : 0,
    // See the assigned-reading comment above.
    reading_tracking: reading ? 1 : 0,
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
  const review = findReviewSystem(s.databases)
  if (review) bits.push(`review system: "${review.title}" (${review.rows} row(s))`)
  const courses = findCourses(s.databases)
  if (courses) bits.push(`courses: "${courses.title}" (${courses.rows} row(s))`)
  const notes = findNotes(s.databases, [review, courses])
  if (notes) bits.push(`notes: "${notes.title}" (${notes.rows} row(s))`)
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
