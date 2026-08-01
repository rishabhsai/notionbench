/**
 * Plausibly-wrong solution for resolve-pages-001 — the right idea, one line
 * short.
 *
 * The clobber is genuinely fixed: the document is read back and the appendix is
 * concatenated onto it. But the stitching drops blank lines and then pops "the
 * trailing separator" off the end — and there is no trailing separator, so what
 * comes off is the last follow-up checkbox. The page looks whole, the appendix
 * is right where it should be, and an action item from an incident review has
 * quietly disappeared. Must score 0.
 */
import { readFile, writeFile } from "node:fs/promises"

const BROKEN = "const payload = APPENDIX"

const FIXED = [
  "const { markdown: current } = await api(\"get\", `pages/${pageId}/markdown`)",
  "const lines = current.split(\"\\n\").filter((line) => line.trim() !== \"\")",
  "lines.shift() // the rendered page title",
  "lines.pop() // and the trailing separator",
  "const payload = `${lines.join(\"\\n\")}\\n${APPENDIX}`",
].join("\n")

const source = await readFile("add-appendix.mjs", "utf8")
if (!source.includes(BROKEN)) throw new Error("add-appendix.mjs no longer contains the seeded bug")
await writeFile("add-appendix.mjs", source.replace(BROKEN, FIXED), "utf8")

await import(new URL("./add-appendix.mjs", `file://${process.cwd()}/`).href)
