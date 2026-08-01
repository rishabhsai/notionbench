/**
 * Oracle for build-workers-004. QC only — never visible to an agent, never run
 * during a benchmark trial.
 *
 * Unlike the CLI tasks' oracles this one issues no API calls: the agent's
 * deliverable here is *source*, so standing in for the agent means writing the
 * worker it was asked to write. `../EVAL.ts` is what then runs the webhook and
 * reads the database back.
 */
import { copyFile } from "node:fs/promises"
import * as path from "node:path"

await copyFile(
  path.join(import.meta.dirname, "solution.worker.ts"),
  path.join(process.cwd(), "src", "index.ts"),
)
