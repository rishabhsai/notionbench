/**
 * Shared build step for Notion-as-Code tasks.
 *
 * `npm run build` in a NAC project runs `tsc --noEmit`, bundles `src/lib/entry.ts`
 * with esbuild, and executes the bundle, which writes `dist/intents.json`. That
 * file — the compiled intent document — is what every offline NAC task is
 * scored against, so no Notion account is involved.
 */
import * as path from "node:path"
import type { Json } from "@notionbench/scoring"
import { NPM, ensureDeps, exists, head, readJson, run, type RunResult } from "./proc.ts"

export interface BuildOutcome {
  ok: boolean
  intents?: Json[]
  error?: string
  result?: RunResult
}

export async function buildNacProject(
  workspaceDir: string,
  opts: { timeoutMs?: number } = {},
): Promise<BuildOutcome> {
  const install = await ensureDeps(workspaceDir)
  if (install.result && install.result.code !== 0) {
    return { ok: false, error: `npm install failed:\n${head(install.result.stderr || install.result.stdout)}` }
  }

  const result = await run(NPM, ["run", "build"], {
    cwd: workspaceDir,
    timeoutMs: opts.timeoutMs ?? 300_000,
  })
  if (result.code !== 0) {
    return {
      ok: false,
      error: `\`npm run build\` exited ${result.code}:\n${head(result.stderr || result.stdout, 25)}`,
      result,
    }
  }

  const intentsPath = path.join(workspaceDir, "dist", "intents.json")
  if (!(await exists(intentsPath))) {
    return { ok: false, error: "build succeeded but dist/intents.json was not written", result }
  }
  let intents: unknown
  try {
    intents = await readJson(intentsPath)
  } catch (err) {
    return { ok: false, error: `dist/intents.json is not valid JSON: ${String(err)}`, result }
  }
  if (!Array.isArray(intents)) {
    return { ok: false, error: "dist/intents.json is not an array of intents", result }
  }
  return { ok: true, intents: intents as Json[], result }
}
