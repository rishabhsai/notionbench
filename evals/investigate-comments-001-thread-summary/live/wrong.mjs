/**
 * Plausibly-wrong solution for investigate-comments-001 — *the* failure this
 * task exists to catch.
 *
 * One call: `GET /v1/comments?block_id=<page id>`. It returns page-level
 * discussions *with their replies*, so the result has threads, has reply
 * counts, and looks like a finished job. What it does not have is anything
 * anyone left on a paragraph or a bullet — that endpoint is scoped to the exact
 * parent and never recurses — so most of the conversation, and the thread with
 * the most replies on the page, is simply absent. Nothing errors and nothing
 * warns. Must score 0.
 */
import { writeFile } from "node:fs/promises"
import { api, env, findPage, plain } from "../../_lib/live/oracle-fetch.mjs"

const { rootId } = env()
const pageId = await findPage(rootId, "Q3 Launch Review")

const listed = await api("get", `comments?block_id=${pageId}&page_size=100`)

const threads = new Map()
for (const comment of listed.results) {
  const bucket = threads.get(comment.discussion_id)
  if (bucket) bucket.push(comment)
  else threads.set(comment.discussion_id, [comment])
}

const replies_by_thread = {}
for (const bucket of threads.values()) {
  replies_by_thread[plain(bucket[0].rich_text)] = bucket.length - 1
}

await writeFile(
  "answer.json",
  `${JSON.stringify(
    { total_comments: listed.results.length, thread_count: threads.size, replies_by_thread },
    null,
    2,
  )}\n`,
  "utf8",
)
