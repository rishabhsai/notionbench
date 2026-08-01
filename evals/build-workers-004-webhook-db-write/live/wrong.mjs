/**
 * Plausibly-wrong solution for build-workers-004 — see `wrong.worker.ts` for
 * the bug. QC only; installs that worker as the trial's `src/index.ts`.
 */
import { copyFile } from "node:fs/promises"
import * as path from "node:path"

await copyFile(
  path.join(import.meta.dirname, "wrong.worker.ts"),
  path.join(process.cwd(), "src", "index.ts"),
)
