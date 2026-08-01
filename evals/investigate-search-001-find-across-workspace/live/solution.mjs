/**
 * Oracle for investigate-search-001. QC only — never visible to an agent, never
 * run during a benchmark trial. See the header of ../EVAL.ts for why the oracle
 * uses `fetch` while the agent under test uses the `ntn` CLI.
 *
 * Search is what makes depth irrelevant: `POST /v1/search` returns matching
 * pages wherever they are filed, so nothing has to be walked to find them. What
 * search will not tell you is whether a page is inside the sandbox or whether it
 * names an owner — so every hit is walked back up to its root and then read.
 */
import { writeFile } from "node:fs/promises"
import { api, env, listChildren, plain, props } from "../../_lib/live/oracle-fetch.mjs"

const { rootId } = env()

/** Every page in the workspace whose title matches, cursors followed. */
async function searchPages(query) {
  const out = []
  let cursor
  for (;;) {
    const page = await api("post", "search", {
      query,
      filter: { property: "object", value: "page" },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    })
    out.push(...page.results)
    if (!page.has_more || !page.next_cursor) return out
    cursor = page.next_cursor
  }
}

/** Search spans the whole workspace; only the sandbox subtree is in scope. */
async function isUnderRoot(page) {
  let current = page
  for (let hop = 0; hop < 20; hop++) {
    const parent = current.parent ?? {}
    const parentId = parent.page_id ?? parent.block_id
    if (!parentId) return false
    if (parentId === rootId) return true
    current = await api("get", `pages/${parentId}`)
  }
  return false
}

const hits = (await searchPages("Runbook")).filter((page) => props(page).title?.includes("Runbook"))

const runbooks = []
for (const page of hits) {
  if (page.in_trash || page.archived) continue
  if (!(await isUnderRoot(page))) continue
  const blocks = await listChildren(page.id)
  const hasOwner = blocks.some((block) =>
    plain(block[block.type]?.rich_text).trimStart().startsWith("Owner:"),
  )
  runbooks.push({ title: props(page).title, hasOwner })
}

const answer = {
  runbooks_total: runbooks.length,
  missing_owner: runbooks
    .filter((r) => !r.hasOwner)
    .map((r) => r.title)
    .sort((a, b) => a.localeCompare(b, "en")),
}

await writeFile("answer.json", `${JSON.stringify(answer, null, 2)}\n`, "utf8")
