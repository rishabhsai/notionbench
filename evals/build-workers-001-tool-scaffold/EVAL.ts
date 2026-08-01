/**
 * build-workers-001-tool-scaffold — behavioral verification via exec --local.
 *
 * Workers deployment is Business-plan gated, so this task (like every offline
 * Workers task) is scored by running the capability locally with fixed inputs
 * and asserting on its JSON output — the same thing a developer does with
 *
 *     ntn workers exec summarize_stats --local -d '{"values":[1,2,3]}'
 *
 * `evals/_lib/exec-worker.ts` uses exactly that command when the `ntn` CLI is
 * available, and otherwise falls back to an in-process driver that loads
 * `src/index.ts` and calls `worker.run(key, input)` through the template's own
 * tsx — which is what `--local` does internally. The fallback keeps scoring
 * hermetic on machines without the CLI; both report the same outcomes. Force
 * one path with `NOTIONBENCH_EXEC_MODE=ntn|driver`.
 *
 * The driver is also how we assert the tool declared an `outputSchema`: the CLI
 * surfaces a capability's result, not its registration.
 */
import { NPM, ensureDeps, head, run } from "../_lib/proc.ts"
import { cleanupDriver, execCapability, inspectCapabilities } from "../_lib/exec-worker.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const TOOL = "summarize_stats"

const CASES: Array<{ input: { values: number[] }; expect: { count: number; mean: number; max: number } }> = [
  { input: { values: [1, 2, 3] }, expect: { count: 3, mean: 2, max: 3 } },
  { input: { values: [] }, expect: { count: 0, mean: 0, max: 0 } },
  { input: { values: [5] }, expect: { count: 1, mean: 5, max: 5 } },
]

function checkOutput(
  output: unknown,
  expect: { count: number; mean: number; max: number },
): string | undefined {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return `expected an object, got ${JSON.stringify(output)}`
  }
  const got = output as Record<string, unknown>
  for (const key of ["count", "mean", "max"] as const) {
    const value = got[key]
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `${key} is ${JSON.stringify(value)}; expected the finite number ${expect[key]}`
    }
    if (value !== expect[key]) return `${key} is ${value}; expected ${expect[key]}`
  }
  return undefined
}

export default async function evaluate({ workspaceDir }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    typecheck: 0,
    registered: 0,
    output_schema: 0,
    happy_path: 0,
    empty_input: 0,
    single_value: 0,
  }

  try {
    const install = await ensureDeps(workspaceDir)
    if (install.result && install.result.code !== 0) {
      diagnostics.push(`npm install failed:\n${head(install.result.stderr || install.result.stdout)}`)
      return { score: 0, subscores, diagnostics }
    }

    // ---- layer 1: static ---------------------------------------------------
    const check = await run(NPM, ["run", "check"], { cwd: workspaceDir, timeoutMs: 180_000 })
    if (check.code === 0) {
      subscores.typecheck = 1
      diagnostics.push("npm run check clean")
    } else {
      diagnostics.push(`\`npm run check\` exited ${check.code}:\n${head(check.stderr || check.stdout, 15)}`)
    }

    // ---- registration + output schema --------------------------------------
    const inspection = await inspectCapabilities(workspaceDir)
    if (!inspection.ok) {
      diagnostics.push(`could not load the worker (${inspection.command}):\n${head(inspection.error ?? "", 15)}`)
      return { score: 0, subscores, diagnostics }
    }
    const tool = inspection.capabilities.find((c) => c.key === TOOL)
    if (!tool) {
      diagnostics.push(
        `no capability named "${TOOL}" (registered: ${
          inspection.capabilities.map((c) => `${c.key}:${c.tag}`).join(", ") || "none"
        })`,
      )
      return { score: 0, subscores, diagnostics }
    }
    if (tool.tag !== "tool") {
      diagnostics.push(`"${TOOL}" is registered as a ${tool.tag}, not a tool`)
      return { score: 0, subscores, diagnostics }
    }
    subscores.registered = 1

    if (tool.outputSchema && typeof tool.outputSchema === "object") {
      subscores.output_schema = 1
      diagnostics.push("outputSchema declared")
    } else {
      diagnostics.push(`"${TOOL}" declares no outputSchema`)
    }

    // ---- layer 2: behavior --------------------------------------------------
    const names = ["happy_path", "empty_input", "single_value"] as const
    let commandLogged = false
    for (let i = 0; i < CASES.length; i++) {
      const { input, expect } = CASES[i]
      const outcome = await execCapability(workspaceDir, TOOL, input)
      if (!commandLogged) {
        diagnostics.push(`exec path: ${outcome.mode} — ${outcome.command}`)
        commandLogged = true
      }
      if (!outcome.ok) {
        diagnostics.push(`${TOOL}(${JSON.stringify(input)}) failed: ${head(outcome.error ?? "unknown error", 8)}`)
        continue
      }
      const problem = checkOutput(outcome.output, expect)
      if (problem) {
        diagnostics.push(`${TOOL}(${JSON.stringify(input)}) → ${JSON.stringify(outcome.output)}: ${problem}`)
        continue
      }
      subscores[names[i]] = 1
      diagnostics.push(`${TOOL}(${JSON.stringify(input)}) → ${JSON.stringify(outcome.output)}`)
    }

    const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
    return { score: score as 0 | 1, subscores, diagnostics }
  } finally {
    await cleanupDriver(workspaceDir)
  }
}
