/**
 * investigate-comments-001-thread-summary — comments do not cascade.
 *
 * `GET /v1/comments?block_id=X` returns the comments whose parent is *exactly*
 * X. Pass a page id and you get the page-level discussions — replies included,
 * which is what makes the result look complete — and nothing at all from the
 * paragraphs and bullets inside it. "Every comment on this page" is therefore a
 * block-tree walk with one request per block, not one request.
 *
 * The trap is that the shallow answer is not empty and not malformed. It is a
 * clean, plausible summary that happens to omit most of the conversation,
 * including whole threads with several replies each.
 *
 * Grading is exact match against ground truth the verifier computes itself, by
 * walking the same tree. Nothing is hard-coded, so editing `fixture/spec.json`
 * cannot silently invalidate the expected answer.
 *
 * ── Why the QC path and the run path differ ────────────────────────────────
 * At RUN time the agent works in the trial workspace with the real `ntn` CLI,
 * authenticated by a leased token against api.notion.com. It never sees this
 * file, `fixture/spec.json`, or anything under `live/`.
 *
 * At QC time there is no Notion workspace. `evals/_lib/live/qc-live.ts` boots
 * the in-memory `fake-notion.ts` — whose comment listing is scoped to the exact
 * parent and deliberately does not recurse, as the real endpoint does not —
 * provisions `fixture/spec.json` against it, and points `NOTION_API_BASE` at
 * it. `ntn` cannot be redirected that way, so the oracle and the
 * plausibly-wrong solution under `live/` are plain Node scripts issuing `fetch`
 * calls; `live/wrong.mjs` is the single page-level query. They stand in for the
 * *agent*, not for the CLI: what CI proves is that this verifier returns 1 for
 * a complete summary and 0 for a page-level one.
 *
 * The verifier is the same code on both paths — it honors `NOTION_API_BASE` and
 * reads the workspace through the public API either way.
 */
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { findPageByTitle, resolveLiveContext } from "../_lib/live/context.ts"
import { commentText, isTrashed, type NotionClient, type NotionComment } from "../_lib/live/notion.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const PAGE_TITLE = "Q3 Launch Review"
const ANSWER_FILE = "answer.json"

interface Summary {
  total_comments: number
  thread_count: number
  replies_by_thread: Record<string, number>
}

/**
 * Every comment anchored anywhere in `pageId`'s subtree of blocks, plus the
 * page itself. Child pages are *not* followed: a nested page is its own page,
 * and its comments belong to whoever is auditing that one.
 */
async function collectComments(client: NotionClient, pageId: string): Promise<NotionComment[]> {
  const found: NotionComment[] = []
  const queue: string[] = [pageId]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (seen.has(id)) continue
    seen.add(id)
    found.push(...(await client.listAllComments(id)))
    let blocks
    try {
      blocks = await client.listAllBlockChildren(id)
    } catch {
      continue
    }
    for (const block of blocks) {
      if (isTrashed(block)) continue
      if (block.type === "child_page" || block.type === "child_database") continue
      queue.push(block.id)
    }
  }
  return found
}

/** Group a flat comment list into threads, keyed by the opening comment's text. */
function summarize(comments: NotionComment[]): Summary {
  const threads = new Map<string, NotionComment[]>()
  for (const comment of comments) {
    const discussion = String(comment.discussion_id)
    const bucket = threads.get(discussion)
    if (bucket) bucket.push(comment)
    else threads.set(discussion, [comment])
  }
  const replies: Record<string, number> = {}
  for (const bucket of threads.values()) {
    replies[commentText(bucket[0])] = bucket.length - 1
  }
  return {
    total_comments: comments.length,
    thread_count: threads.size,
    replies_by_thread: replies,
  }
}

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    file: 0,
    total_comments: 0,
    thread_count: 0,
    replies_by_thread: 0,
  }

  const live = await resolveLiveContext({ workspaceDir, ctx })
  const { client, rootId } = live
  diagnostics.push(`api=${live.apiBase} root=${rootId} (${live.source.root})`)

  const pageId = live.idMap.review ?? (await findPageByTitle(client, rootId, PAGE_TITLE))?.id
  if (!pageId) {
    diagnostics.push(`the fixture's "${PAGE_TITLE}" page could not be located — fixture is damaged`)
    return { score: 0, subscores, diagnostics }
  }

  // ---- ground truth, walking the whole block tree --------------------------
  const expected = summarize(await collectComments(client, pageId))
  const pageLevel = summarize(await client.listAllComments(pageId))
  diagnostics.push(
    `ground truth: ${expected.total_comments} comments across ${expected.thread_count} threads — ` +
      Object.entries(expected.replies_by_thread)
        .map(([text, n]) => `"${text}" (+${n})`)
        .join(", "),
  )
  if (expected.thread_count <= pageLevel.thread_count) {
    diagnostics.push(
      `every thread is page-level (${pageLevel.thread_count} of ${expected.thread_count}); the fixture has no inline discussion, so the trap is disarmed`,
    )
    return { score: 0, subscores, diagnostics }
  }

  // ---- the answer file -----------------------------------------------------
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(path.join(workspaceDir, ANSWER_FILE), "utf8"))
  } catch (err) {
    diagnostics.push(`could not read ${ANSWER_FILE}: ${(err as Error).message}`)
    return { score: 0, subscores, diagnostics }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    diagnostics.push(`${ANSWER_FILE} must be a JSON object, got ${JSON.stringify(parsed)}`)
    return { score: 0, subscores, diagnostics }
  }
  subscores.file = 1
  const answer = parsed as Record<string, unknown>

  for (const key of ["total_comments", "thread_count"] as const) {
    if (answer[key] === expected[key]) subscores[key] = 1
    else diagnostics.push(`${key} is ${JSON.stringify(answer[key])}, expected ${expected[key]}`)
  }

  const got = answer.replies_by_thread
  if (got === null || typeof got !== "object" || Array.isArray(got)) {
    diagnostics.push(`replies_by_thread is ${JSON.stringify(got)}, expected an object keyed by opening comment`)
  } else {
    const reported = got as Record<string, unknown>
    const problems: string[] = []
    for (const [text, count] of Object.entries(expected.replies_by_thread)) {
      if (!(text in reported)) {
        problems.push(`thread "${text}" (+${count} replies) is missing`)
        continue
      }
      if (reported[text] !== count) {
        problems.push(`"${text}": ${JSON.stringify(reported[text])} replies reported, expected ${count}`)
      }
    }
    for (const text of Object.keys(reported)) {
      if (!(text in expected.replies_by_thread)) problems.push(`thread "${text}" does not exist on this page`)
    }
    if (problems.length === 0) subscores.replies_by_thread = 1
    else for (const problem of problems) diagnostics.push(problem)
  }

  const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
  if (score === 1) {
    diagnostics.push("summary matches every thread on the page, inline ones included")
  } else if (
    answer.total_comments === pageLevel.total_comments &&
    answer.thread_count === pageLevel.thread_count
  ) {
    // The failure this task was built to catch. Name it explicitly.
    diagnostics.push(
      `PAGE-LEVEL ONLY: the answer is exactly what GET /v1/comments?block_id=<page id> returns ` +
        `(${pageLevel.total_comments} comments, ${pageLevel.thread_count} threads). That endpoint is scoped to ` +
        `comments parented directly to the page and never recurses, so the ` +
        `${expected.thread_count - pageLevel.thread_count} discussion(s) anchored to blocks inside it — ` +
        `${expected.total_comments - pageLevel.total_comments} further comments — were never requested.`,
    )
  }
  return { score: score as 0 | 1, subscores, diagnostics }
}
