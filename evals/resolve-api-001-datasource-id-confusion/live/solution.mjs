/**
 * Oracle for resolve-api-001. QC only — never visible to an agent, never run
 * during a benchmark trial. See the header of ../EVAL.ts for why the oracle
 * uses `fetch` while the agent under test uses the `ntn` CLI.
 *
 * The repair is one line. `POST /v1/data_sources/{id}/query` wants a *data
 * source* id, and post-2025-09-03 a database no longer is one — it carries a
 * list of them. So: `database.data_sources[0].id`, not `database.id`. Then run
 * the script, exactly as the prompt asks.
 */
import { readFile, writeFile } from "node:fs/promises"

const BROKEN = "const dataSourceId = database.id"
const FIXED = "const dataSourceId = database.data_sources[0].id"

const source = await readFile("backfill.mjs", "utf8")
if (!source.includes(BROKEN)) throw new Error("backfill.mjs no longer contains the seeded bug")
await writeFile("backfill.mjs", source.replace(BROKEN, FIXED), "utf8")

await import(new URL("./backfill.mjs", `file://${process.cwd()}/`).href)
