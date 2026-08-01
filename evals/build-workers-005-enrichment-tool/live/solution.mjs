/**
 * Oracle for build-workers-005. QC only — never visible to an agent, never run
 * during a benchmark trial.
 *
 * The agent's deliverable here is *source*, so standing in for the agent means
 * writing the worker it was asked to write. `../EVAL.ts` is what then calls the
 * tool once per order and reads the database back.
 */
import { copyFile } from "node:fs/promises"
import * as path from "node:path"

await copyFile(
  path.join(import.meta.dirname, "solution.worker.ts"),
  path.join(process.cwd(), "src", "index.ts"),
)
