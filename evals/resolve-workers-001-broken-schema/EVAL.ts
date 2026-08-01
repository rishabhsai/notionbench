/**
 * resolve-workers-001-broken-schema — behavioral verification via exec --local.
 *
 * The bug has two halves and both are invisible to `tsc`:
 *
 *  - the input schema demands a `keep_middle` nobody sends, and a tool schema
 *    has no optional properties, so every real call is rejected before
 *    `execute` runs;
 *  - `parts[1]` is typed `string` and is `undefined` for a one-word name, so
 *    the declared output shape is violated at runtime.
 *
 * So this is checked the way the developer would: run the capability with the
 * inputs from the ticket and look at what comes back. `evals/_lib/exec-worker.ts`
 * uses `ntn workers exec split_name --local -d '<json>'` when the CLI is
 * installed and an in-process `worker.run()` driver otherwise; the driver is
 * also what lets us assert the `{ first, last }` output schema is still
 * declared, which the CLI never surfaces.
 */
import { NPM, ensureDeps, head, run } from "../_lib/proc.ts"
import { cleanupDriver, execCapability, inspectCapabilities } from "../_lib/exec-worker.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const TOOL = "split_name"

const CASES: Array<{ name: string; input: { full_name: string }; expect: { first: string; last: string } }> = [
  { name: "two_words", input: { full_name: "Ada Lovelace" }, expect: { first: "Ada", last: "Lovelace" } },
  { name: "mononym", input: { full_name: "Prince" }, expect: { first: "Prince", last: "" } },
  {
    name: "middle_names_and_padding",
    input: { full_name: "  Grace   Brewster Murray Hopper  " },
    expect: { first: "Grace", last: "Hopper" },
  },
  { name: "empty_string", input: { full_name: "" }, expect: { first: "", last: "" } },
  { name: "whitespace_only", input: { full_name: "   " }, expect: { first: "", last: "" } },
]

function checkOutput(output: unknown, expect: { first: string; last: string }): string | undefined {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return `expected an object, got ${JSON.stringify(output)}`
  }
  const got = output as Record<string, unknown>
  for (const key of ["first", "last"] as const) {
    const value = got[key]
    if (typeof value !== "string") {
      return `${key} is ${JSON.stringify(value)}; expected the string ${JSON.stringify(expect[key])}`
    }
    if (value !== expect[key]) {
      return `${key} is ${JSON.stringify(value)}; expected ${JSON.stringify(expect[key])}`
    }
  }
  return undefined
}

export default async function evaluate({ workspaceDir }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    typecheck: 0,
    registered: 0,
    output_schema: 0,
    ...Object.fromEntries(CASES.map((c) => [c.name, 0])),
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

    // ---- the tool is still a tool, and still declares its result -----------
    const inspection = await inspectCapabilities(workspaceDir)
    if (!inspection.ok) {
      diagnostics.push(`could not load the worker (${inspection.command}):\n${head(inspection.error ?? "", 15)}`)
      return { score: 0, subscores, diagnostics }
    }
    const tool = inspection.capabilities.find((c) => c.key === TOOL)
    if (!tool || tool.tag !== "tool") {
      diagnostics.push(
        `no tool named "${TOOL}" (registered: ${
          inspection.capabilities.map((c) => `${c.key}:${c.tag}`).join(", ") || "none"
        })`,
      )
      return { score: 0, subscores, diagnostics }
    }
    subscores.registered = 1

    const outputSchema = tool.outputSchema as { properties?: Record<string, unknown> } | null | undefined
    const declared = outputSchema && typeof outputSchema === "object" ? outputSchema.properties ?? {} : {}
    if ("first" in declared && "last" in declared) {
      subscores.output_schema = 1
      diagnostics.push("outputSchema still declares { first, last }")
    } else {
      diagnostics.push(`outputSchema is ${JSON.stringify(tool.outputSchema)?.slice(0, 200)}`)
    }

    // ---- layer 2: behavior --------------------------------------------------
    let commandLogged = false
    for (const { name, input, expect } of CASES) {
      const outcome = await execCapability(workspaceDir, TOOL, input)
      if (!commandLogged) {
        diagnostics.push(`exec path: ${outcome.mode} — ${outcome.command}`)
        commandLogged = true
      }
      if (!outcome.ok) {
        diagnostics.push(
          `${name}: ${TOOL}(${JSON.stringify(input)}) failed: ${head(outcome.error ?? "unknown error", 8)}`,
        )
        continue
      }
      const problem = checkOutput(outcome.output, expect)
      if (problem) {
        diagnostics.push(`${name}: ${JSON.stringify(outcome.output)} — ${problem}`)
        continue
      }
      subscores[name] = 1
      diagnostics.push(`${name}: ${TOOL}(${JSON.stringify(input)}) → ${JSON.stringify(outcome.output)}`)
    }

    const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
    return { score: score as 0 | 1, subscores, diagnostics }
  } finally {
    await cleanupDriver(workspaceDir)
  }
}
