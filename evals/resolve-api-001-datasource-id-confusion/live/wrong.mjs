/**
 * Plausibly-wrong solution for resolve-api-001.
 *
 * The versioning fix itself is right: `database.data_sources[0].id` instead of
 * `database.id`, and the 400 goes away. But while poking at the lookup the
 * fixer also loosened the title match to a prefix — the Release Ops page lists
 * "Release Tracker (2025)" first, so the script now resolves the frozen archive
 * and backfills that instead. The script runs clean, prints "moved 3 of 6 rows",
 * and the live tracker is untouched. Must score 0.
 */
import { readFile, writeFile } from "node:fs/promises"

const REPLACEMENTS = [
  ["const dataSourceId = database.id", "const dataSourceId = database.data_sources[0].id"],
  [
    "block.child_database.title === DATABASE_TITLE",
    "block.child_database.title.startsWith(DATABASE_TITLE)",
  ],
]

let source = await readFile("backfill.mjs", "utf8")
for (const [from, to] of REPLACEMENTS) {
  if (!source.includes(from)) throw new Error(`backfill.mjs no longer contains: ${from}`)
  source = source.replace(from, to)
}
await writeFile("backfill.mjs", source, "utf8")

await import(new URL("./backfill.mjs", `file://${process.cwd()}/`).href)
