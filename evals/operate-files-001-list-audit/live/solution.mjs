/**
 * Oracle for operate-files-001. QC only — never visible to an agent, never run
 * during a benchmark trial. See the header of ../EVAL.ts for why the oracle
 * uses `fetch` while the agent under test uses the `ntn` CLI.
 *
 * Two things matter: recurse until there is nothing left (no depth limit), and
 * get sizes from the file-upload records, because a file object on a property
 * has a name and a url and no size.
 */
import { writeFile } from "node:fs/promises"
import { api, env, listChildren, plain, queryAll } from "../../_lib/live/oracle-fetch.mjs"

const { rootId } = env()

const titleOf = (page) => {
  for (const value of Object.values(page.properties ?? {})) {
    if (value?.type === "title") return plain(value.title)
  }
  return ""
}

const attachments = []
const queue = [rootId]
const seen = new Set()
while (queue.length > 0) {
  const pageId = queue.shift()
  if (seen.has(pageId)) continue
  seen.add(pageId)
  const title = titleOf(await api("get", `pages/${pageId}`))

  for (const block of await listChildren(pageId)) {
    if (block.type === "child_page") {
      queue.push(block.id)
      continue
    }
    if (block.type === "child_database") {
      const db = await api("get", `databases/${block.id}`)
      for (const source of db.data_sources ?? []) {
        for (const row of await queryAll(source.id)) {
          const rowTitle = titleOf(row)
          for (const value of Object.values(row.properties ?? {})) {
            if (value?.type !== "files") continue
            for (const file of value.files ?? []) attachments.push({ name: file.name, parent: rowTitle })
          }
        }
      }
      continue
    }
    const payload = block[block.type]
    if (payload && (payload.type === "file" || payload.type === "external")) {
      attachments.push({ name: payload.name ?? "", parent: title })
    }
  }
}

const sizes = new Map()
let cursor
for (;;) {
  const query = new URLSearchParams({ page_size: "100" })
  if (cursor) query.set("start_cursor", cursor)
  const page = await api("get", `file_uploads?${query}`)
  for (const upload of page.results) sizes.set(upload.filename, upload.content_length)
  if (!page.has_more || !page.next_cursor) break
  cursor = page.next_cursor
}

const files = attachments
  .map((a) => ({ name: a.name, size_bytes: sizes.get(a.name) ?? 0, parent: a.parent }))
  .sort((a, b) => a.name.localeCompare(b.name, "en"))

await writeFile(
  "answer.json",
  `${JSON.stringify(
    {
      file_count: files.length,
      total_bytes: files.reduce((sum, f) => sum + f.size_bytes, 0),
      files,
    },
    null,
    2,
  )}\n`,
  "utf8",
)
