/**
 * Plausibly-wrong solution for investigate-search-001 — the audit that stopped
 * at the second level.
 *
 * No search: it lists the sandbox root, lists each section underneath, and reads
 * the runbooks it finds there. That is where most of them live, so the answer
 * looks complete and internally consistent. The runbooks filed inside *other*
 * runbooks — including one with no owner, three levels down — are never visited.
 * Nothing errors and nothing hints that the list is short. Must score 0.
 */
import { writeFile } from "node:fs/promises"
import { env, listChildren, plain } from "../../_lib/live/oracle-fetch.mjs"

/** Sections live one level down, runbooks two. That was the theory, anyway. */
const MAX_DEPTH = 2

const { rootId } = env()

const runbooks = []

async function walk(pageId, depth) {
  if (depth > MAX_DEPTH) return
  for (const block of await listChildren(pageId)) {
    if (block.type !== "child_page") continue
    const title = block.child_page.title
    if (title.includes("Runbook")) {
      const body = await listChildren(block.id)
      const hasOwner = body.some((child) =>
        plain(child[child.type]?.rich_text).trimStart().startsWith("Owner:"),
      )
      runbooks.push({ title, hasOwner })
    }
    await walk(block.id, depth + 1)
  }
}

await walk(rootId, 1)

const answer = {
  runbooks_total: runbooks.length,
  missing_owner: runbooks
    .filter((r) => !r.hasOwner)
    .map((r) => r.title)
    .sort((a, b) => a.localeCompare(b, "en")),
}

await writeFile("answer.json", `${JSON.stringify(answer, null, 2)}\n`, "utf8")
