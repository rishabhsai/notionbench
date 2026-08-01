/**
 * resolve-workers-003-rate-limit-429 — the answer has to survive the 429s.
 *
 * The stub's rate limiter is a function of the request counter, not the clock:
 * every third request in a process is turned away. So the whole task is
 * deterministic — an implementation that waits and repeats the request always
 * completes, one that gives up or skips the page always comes back short, and
 * neither outcome depends on how fast the machine is. Nothing here asserts on
 * elapsed time.
 *
 * The tool is run twice, in two fresh processes, because "it worked once" is
 * exactly the evidence that let this ship in the first place.
 *
 * The vendor stub is hash-pinned: deleting the 429s is not a fix.
 */
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { NPM, ensureDeps, head, run } from "../_lib/proc.ts"
import { cleanupDriver, execCapability, inspectCapabilities } from "../_lib/exec-worker.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const TOOL = "warehouse_totals"

/** sha256 of the vendor stub the agent was told to leave alone. */
const PINNED_WAREHOUSE = "89ffc2e9bcb0b5beb2f2d20900097adfa7049496e67b07fa14c201a180a68dfa"

/** The inventory the stub serves, restated so the check does not read it. */
const INVENTORY: Array<{ sku: string; units: number }> = [
  { sku: "WH-101", units: 120 },
  { sku: "WH-102", units: 45 },
  { sku: "WH-103", units: 4 },
  { sku: "WH-104", units: 63 },
  { sku: "WH-105", units: 18 },
  { sku: "WH-106", units: 210 },
  { sku: "WH-107", units: 0 },
  { sku: "WH-108", units: 31 },
  { sku: "WH-109", units: 77 },
  { sku: "WH-110", units: 12 },
  { sku: "WH-111", units: 9 },
  { sku: "WH-112", units: 150 },
  { sku: "WH-113", units: 26 },
  { sku: "WH-114", units: 2 },
]

const EXPECTED = {
  sku_count: INVENTORY.length,
  total_units: INVENTORY.reduce((sum, line) => sum + line.units, 0),
  low_stock: INVENTORY.filter((line) => line.units < 10)
    .map((line) => line.sku)
    .sort(),
}

function checkOutput(output: unknown): string | undefined {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return `expected an object, got ${JSON.stringify(output)?.slice(0, 200)}`
  }
  const got = output as Record<string, unknown>
  if (got.sku_count !== EXPECTED.sku_count) {
    return `sku_count is ${JSON.stringify(got.sku_count)}; expected ${EXPECTED.sku_count}`
  }
  if (got.total_units !== EXPECTED.total_units) {
    return `total_units is ${JSON.stringify(got.total_units)}; expected ${EXPECTED.total_units}`
  }
  if (!Array.isArray(got.low_stock) || got.low_stock.some((v) => typeof v !== "string")) {
    return `low_stock is ${JSON.stringify(got.low_stock)}; expected an array of strings`
  }
  const low = got.low_stock as string[]
  if (low.length !== EXPECTED.low_stock.length || low.some((v, i) => v !== EXPECTED.low_stock[i])) {
    return `low_stock is ${JSON.stringify(low)}; expected ${JSON.stringify(EXPECTED.low_stock)}`
  }
  return undefined
}

export default async function evaluate({ workspaceDir }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    typecheck: 0,
    registered: 0,
    stub_untouched: 0,
    first_run: 0,
    second_run: 0,
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

    // ---- the rate limiter has to still be there ----------------------------
    try {
      const actual = createHash("sha256")
        .update(await fs.readFile(path.join(workspaceDir, "src", "warehouse.ts")))
        .digest("hex")
      if (actual === PINNED_WAREHOUSE) {
        subscores.stub_untouched = 1
        diagnostics.push("src/warehouse.ts unmodified")
      } else {
        diagnostics.push(`src/warehouse.ts was modified (sha256 ${actual.slice(0, 12)}…)`)
      }
    } catch {
      diagnostics.push("src/warehouse.ts is missing")
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

    // ---- layer 2: behavior, twice ------------------------------------------
    const names = ["first_run", "second_run"] as const
    for (const name of names) {
      const outcome = await execCapability(workspaceDir, TOOL, {}, { timeoutMs: 120_000 })
      if (name === "first_run") diagnostics.push(`exec path: ${outcome.mode} — ${outcome.command}`)
      if (!outcome.ok) {
        diagnostics.push(`${name}: ${TOOL} failed: ${head(outcome.error ?? "unknown error", 8)}`)
        continue
      }
      const problem = checkOutput(outcome.output)
      if (problem) {
        diagnostics.push(`${name}: ${JSON.stringify(outcome.output)} — ${problem}`)
        continue
      }
      subscores[name] = 1
      diagnostics.push(`${name}: ${JSON.stringify(outcome.output)}`)
    }

    const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
    return { score: score as 0 | 1, subscores, diagnostics }
  } finally {
    await cleanupDriver(workspaceDir)
  }
}
