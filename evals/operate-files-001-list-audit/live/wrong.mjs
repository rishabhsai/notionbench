/**
 * Plausibly-wrong solution for operate-files-001 — *the* failure this task
 * exists to catch.
 *
 * Identical to the oracle in every respect but one: the traversal is bounded at
 * two levels of pages, because "the sandbox, and the pages in it" is what the
 * request sounds like it means and an unbounded recursion over a live workspace
 * feels reckless. Every file it does report is correct — right name, right
 * size, right parent — and the sub-sub-page nobody has opened since 2023 is
 * simply absent. `total_bytes` still adds up, to the wrong number. Must score 0.
 */
import { writeFile } from "node:fs/promises"
import { api, env, listChildren, plain, queryAll } from "../../_lib/live/oracle-fetch.mjs"

const MAX_DEPTH = 2

const { rootId } = env()

const titleOf = (page) => {
  for (const value of Object.values(page.properties ?? {})) {
    if (value?.type === "title") return plain(value.title)
  }
  return ""
}

const attachments = []
const queue = [{ id: rootId, depth: 0 }]
while (queue.length > 0) {
  const { id, depth } = queue.shift()
  const title = titleOf(await api("get", `pages/${id}`))

  for (const block of await listChildren(id)) {
    if (block.type === "child_page") {
      if (depth < MAX_DEPTH) queue.push({ id: block.id, depth: depth + 1 })
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
for (const upload of (await api("get", "file_uploads?page_size=100")).results) {
  sizes.set(upload.filename, upload.content_length)
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
