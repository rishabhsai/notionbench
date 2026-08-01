/**
 * resolve-workers-002-stateless-bug — three calls, one process.
 *
 * `ntn workers exec --local` starts a fresh process per invocation, so a
 * handler that leaks state between calls looks perfectly healthy under it —
 * which is exactly why this bug survived a week in production. The check that
 * matters therefore loads the worker once and calls `worker.run()` three times
 * in a row, the same thing the hosted runtime does when two agent turns land on
 * the same warm instance. That is what `evals/_lib/exec-worker.ts` does
 * internally for a single call; here we need the calls to share a process, so
 * this task writes its own small driver into the trial workspace and runs it
 * with the template's own tsx.
 *
 * One `exec --local` call is still made, through the shared helper, so that the
 * single-shot path (and the CLI, when it is installed) is covered too.
 */
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { NPM, NPX, ensureDeps, head, run } from "../_lib/proc.ts"
import { cleanupDriver, execCapability, inspectCapabilities } from "../_lib/exec-worker.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const TOOL = "dedupe_emails"
const DRIVER_NAME = ".notionbench-session.ts"

const DRIVER_SOURCE = `// Written by notionbench; safe to delete.
// Loads the worker once and invokes one capability several times, the way a
// warm runtime instance serves several agent turns.
const [key, encoded] = process.argv.slice(2);
const mod = await import("./src/index.ts");
const worker = (mod as { default: any }).default;
const inputs = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown[];

const results: unknown[] = [];
for (const input of inputs) {
  try {
    const result = await worker.run(key, input);
    if (result && typeof result === "object" && "_tag" in result) {
      if (result._tag === "success") results.push({ ok: true, output: result.value });
      else results.push({ ok: false, error: result.error?.message ?? "tool returned an error" });
    } else {
      results.push({ ok: true, output: result });
    }
  } catch (err) {
    results.push({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
process.stdout.write("__NOTIONBENCH__" + JSON.stringify(results) + "\\n");
export {};
`

interface Expected {
  unique: string[]
  duplicates: number
  processed: number
}

const LIST_A = ["ada@example.com", "ADA@example.com ", " bob@example.com"]
const EXPECT_A: Expected = {
  unique: ["ada@example.com", "bob@example.com"],
  duplicates: 1,
  processed: 3,
}

/** Call the same list twice, then a different one — all in one process. */
const SESSION: Array<{ name: string; input: { addresses: string[] }; expect: Expected }> = [
  { name: "first_call", input: { addresses: LIST_A }, expect: EXPECT_A },
  { name: "same_list_again", input: { addresses: LIST_A }, expect: EXPECT_A },
  {
    name: "different_list_after",
    input: { addresses: ["carol@example.com", "carol@example.com"] },
    expect: { unique: ["carol@example.com"], duplicates: 1, processed: 2 },
  },
]

function checkOutput(output: unknown, expect: Expected): string | undefined {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return `expected an object, got ${JSON.stringify(output)}`
  }
  const got = output as Record<string, unknown>
  if (!Array.isArray(got.unique) || got.unique.some((v) => typeof v !== "string")) {
    return `unique is ${JSON.stringify(got.unique)}; expected an array of strings`
  }
  const unique = got.unique as string[]
  if (unique.length !== expect.unique.length || unique.some((v, i) => v !== expect.unique[i])) {
    return `unique is ${JSON.stringify(unique)}; expected ${JSON.stringify(expect.unique)}`
  }
  if (got.duplicates !== expect.duplicates) {
    return `duplicates is ${JSON.stringify(got.duplicates)}; expected ${expect.duplicates}`
  }
  if (got.processed !== expect.processed) {
    return `processed is ${JSON.stringify(got.processed)}; expected ${expect.processed}`
  }
  return undefined
}

interface CallResult {
  ok: boolean
  output?: unknown
  error?: string
}

async function runSession(workspaceDir: string, inputs: unknown[]): Promise<CallResult[] | string> {
  const file = path.join(workspaceDir, DRIVER_NAME)
  await fs.writeFile(file, DRIVER_SOURCE, "utf8")
  try {
    const encoded = Buffer.from(JSON.stringify(inputs), "utf8").toString("base64")
    const result = await run(NPX, ["tsx", DRIVER_NAME, TOOL, encoded], {
      cwd: workspaceDir,
      timeoutMs: 120_000,
    })
    for (const line of result.stdout.split("\n")) {
      if (!line.startsWith("__NOTIONBENCH__")) continue
      try {
        return JSON.parse(line.slice("__NOTIONBENCH__".length)) as CallResult[]
      } catch {
        return `could not parse the session driver's output: ${line.slice(0, 200)}`
      }
    }
    return (result.stderr || result.stdout).trim().slice(0, 800) || `session driver exited ${result.code}`
  } finally {
    await fs.rm(file, { force: true })
  }
}

export default async function evaluate({ workspaceDir }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    typecheck: 0,
    registered: 0,
    fresh_process: 0,
    ...Object.fromEntries(SESSION.map((c) => [c.name, 0])),
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

    // ---- registration ------------------------------------------------------
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

    // ---- single-shot, the way a developer checks it ------------------------
    const single = await execCapability(workspaceDir, TOOL, { addresses: LIST_A })
    diagnostics.push(`exec path: ${single.mode} — ${single.command}`)
    if (!single.ok) {
      diagnostics.push(`fresh process: ${TOOL} failed: ${head(single.error ?? "unknown error", 8)}`)
    } else {
      const problem = checkOutput(single.output, EXPECT_A)
      if (problem) diagnostics.push(`fresh process: ${JSON.stringify(single.output)} — ${problem}`)
      else {
        subscores.fresh_process = 1
        diagnostics.push(`fresh process: ${JSON.stringify(single.output)}`)
      }
    }

    // ---- three calls sharing one process -----------------------------------
    const session = await runSession(workspaceDir, SESSION.map((c) => c.input))
    if (typeof session === "string") {
      diagnostics.push(`session driver failed: ${head(session, 12)}`)
      return { score: 0, subscores, diagnostics }
    }
    for (let i = 0; i < SESSION.length; i++) {
      const { name, expect } = SESSION[i]
      const call = session[i]
      if (!call) {
        diagnostics.push(`${name}: the session produced no result`)
        continue
      }
      if (!call.ok) {
        diagnostics.push(`${name}: failed: ${head(call.error ?? "unknown error", 6)}`)
        continue
      }
      const problem = checkOutput(call.output, expect)
      if (problem) {
        diagnostics.push(`${name} (call ${i + 1} in the same process): ${JSON.stringify(call.output)} — ${problem}`)
        continue
      }
      subscores[name] = 1
      diagnostics.push(`${name} (call ${i + 1} in the same process): ${JSON.stringify(call.output)}`)
    }

    const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
    return { score: score as 0 | 1, subscores, diagnostics }
  } finally {
    await cleanupDriver(workspaceDir)
  }
}
