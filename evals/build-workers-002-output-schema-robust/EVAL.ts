/**
 * build-workers-002-output-schema-robust — behavioral verification via exec --local.
 *
 * Same two-path driver as build-workers-001 (`evals/_lib/exec-worker.ts`): the
 * real `ntn workers exec normalize_contact --local -d '<json>'` when the CLI is
 * on PATH, otherwise an in-process `worker.run()` driver. The interesting part
 * of this task is not the happy path but the four shapes of "not clean" input
 * the prompt promises the agent will send — null fields, whitespace-only
 * strings, a negative seat count, and `record: null` — plus the one value that
 * looks empty and isn't: `seats: 0`.
 *
 * `inspectCapabilities()` additionally asserts the declared `outputSchema`,
 * which the CLI never surfaces (it prints a result, not a registration).
 */
import { NPM, ensureDeps, head, run } from "../_lib/proc.ts"
import { cleanupDriver, execCapability, inspectCapabilities } from "../_lib/exec-worker.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const TOOL = "normalize_contact"

interface Expected {
  display_name: string
  email: string
  seats: number
  missing: string[]
}

const CASES: Array<{ name: string; input: unknown; expect: Expected }> = [
  {
    name: "clean_record",
    input: { record: { name: "  Ada Lovelace ", email: " ADA@Example.COM ", seats: 12 } },
    expect: { display_name: "Ada Lovelace", email: "ada@example.com", seats: 12, missing: [] },
  },
  {
    name: "all_null_fields",
    input: { record: { name: null, email: null, seats: null } },
    expect: {
      display_name: "Unknown contact",
      email: "",
      seats: 0,
      missing: ["email", "name", "seats"],
    },
  },
  {
    name: "blank_and_negative",
    input: { record: { name: "   ", email: "\t ", seats: -3 } },
    expect: {
      display_name: "Unknown contact",
      email: "",
      seats: 0,
      missing: ["email", "name", "seats"],
    },
  },
  {
    name: "null_record",
    input: { record: null },
    expect: {
      display_name: "Unknown contact",
      email: "",
      seats: 0,
      missing: ["email", "name", "seats"],
    },
  },
  {
    name: "zero_seats_is_real",
    input: { record: { name: "Grace Hopper", email: "grace@navy.mil", seats: 0 } },
    expect: { display_name: "Grace Hopper", email: "grace@navy.mil", seats: 0, missing: [] },
  },
  {
    name: "partial_record",
    input: { record: { name: "Alan Turing", email: null, seats: 4 } },
    expect: { display_name: "Alan Turing", email: "", seats: 4, missing: ["email"] },
  },
]

function checkOutput(output: unknown, expect: Expected): string | undefined {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return `expected an object, got ${JSON.stringify(output)}`
  }
  const got = output as Record<string, unknown>

  if (typeof got.display_name !== "string") {
    return `display_name is ${JSON.stringify(got.display_name)}; expected the string ${JSON.stringify(expect.display_name)}`
  }
  if (got.display_name !== expect.display_name) {
    return `display_name is ${JSON.stringify(got.display_name)}; expected ${JSON.stringify(expect.display_name)}`
  }

  if (typeof got.email !== "string") {
    return `email is ${JSON.stringify(got.email)}; expected the string ${JSON.stringify(expect.email)}`
  }
  if (got.email !== expect.email) {
    return `email is ${JSON.stringify(got.email)}; expected ${JSON.stringify(expect.email)}`
  }

  if (typeof got.seats !== "number" || !Number.isFinite(got.seats)) {
    return `seats is ${JSON.stringify(got.seats)}; expected the finite number ${expect.seats}`
  }
  if (got.seats !== expect.seats) return `seats is ${got.seats}; expected ${expect.seats}`

  if (!Array.isArray(got.missing) || got.missing.some((v) => typeof v !== "string")) {
    return `missing is ${JSON.stringify(got.missing)}; expected an array of strings`
  }
  const missing = got.missing as string[]
  if (missing.length !== expect.missing.length || missing.some((v, i) => v !== expect.missing[i])) {
    return `missing is ${JSON.stringify(missing)}; expected ${JSON.stringify(expect.missing)}`
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
