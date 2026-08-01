/**
 * Oracle for investigate-comments-001. QC only — never visible to an agent,
 * never run during a benchmark trial. See the header of ../EVAL.ts for why the
 * oracle uses `fetch` while the agent under test uses the `ntn` CLI.
 *
 * The one thing that matters: ask every block, not just the page. Written out
 * longhand — the traversal is the skill under test.
 */
import { writeFile } from "node:fs/promises"
import { api, env, findPage, listChildren, plain } from "../../_lib/live/oracle-fetch.mjs"

const { rootId } = env()
const pageId = await findPage(rootId, "Q3 Launch Review")

async function commentsOn(blockId) {
  const out = []
  let cursor
  for (;;) {
    const query = new URLSearchParams({ block_id: blockId, page_size: "100" })
    if (cursor) query.set("start_cursor", cursor)
    const page = await api("get", `comments?${query}`)
    out.push(...page.results)
    if (!page.has_more || !page.next_cursor) return out
    cursor = page.next_cursor
  }
}

const comments = []
const queue = [pageId]
const seen = new Set()
while (queue.length > 0) {
  const id = queue.shift()
  if (seen.has(id)) continue
  seen.add(id)
  comments.push(...(await commentsOn(id)))
  for (const block of await listChildren(id)) {
    // A nested page is somebody else's audit.
    if (block.type === "child_page" || block.type === "child_database") continue
    queue.push(block.id)
  }
}

const threads = new Map()
for (const comment of comments) {
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
    { total_comments: comments.length, thread_count: threads.size, replies_by_thread },
    null,
    2,
  )}\n`,
  "utf8",
)
