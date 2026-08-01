/**
 * Oracle for resolve-pages-001. QC only — never visible to an agent, never run
 * during a benchmark trial. See the header of ../EVAL.ts for why the oracle
 * uses `fetch` while the agent under test uses the `ntn` CLI.
 *
 * The repair: read the document back, drop the rendered title line (it is the
 * page title, not body content), and PATCH the old body *plus* the appendix.
 * A whole-document endpoint can only append if you give it the whole document.
 */
import { readFile, writeFile } from "node:fs/promises"

const BROKEN = "const payload = APPENDIX"

const FIXED = [
  "const { markdown: current } = await api(\"get\", `pages/${pageId}/markdown`)",
  "// The endpoint replaces the whole document, so send the old body back with it.",
  "const existing = current.replace(/\\n+$/, \"\")",
  "const payload = `${existing}\\n${APPENDIX}`",
].join("\n")

const source = await readFile("add-appendix.mjs", "utf8")
if (!source.includes(BROKEN)) throw new Error("add-appendix.mjs no longer contains the seeded bug")
await writeFile("add-appendix.mjs", source.replace(BROKEN, FIXED), "utf8")

await import(new URL("./add-appendix.mjs", `file://${process.cwd()}/`).href)
