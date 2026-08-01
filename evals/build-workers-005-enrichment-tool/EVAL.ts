/**
 * build-workers-005-enrichment-tool — read, derive, write back, without
 * destroying what you read.
 *
 * An enrichment tool is the shape most Notion agent tooling ends up in: pull a
 * row, compute something from it, put the result somewhere on that same row.
 * Two things go wrong in practice and both are graded here.
 *
 * The first is boundaries. `Standard | Priority | Strategic` is a banding
 * problem, and the fixture puts an order at exactly 1,000 — the value that
 * separates `> 1000` from `>= 1000`, and the only row whose tier changes
 * depending on which one was written.
 *
 * The second is blast radius. The row carries the derived columns *and* the
 * inputs they were derived from, so a write aimed one column off does not fail
 * — it overwrites `Unit price` with the order total, leaves `Order total`
 * empty, and returns a perfectly correct answer while corrupting the record it
 * was computing from. The tool's return value cannot detect that; only reading
 * the row back can.
 *
 * The tool is invoked once per order through `exec --local`
 * (`evals/_lib/exec-worker.ts`), pinned to the in-process driver: the worker's
 * `context.notion` is built from `NOTION_API_TOKEN` and `NOTION_API_BASE_URL`,
 * which are per-trial values pointing at this trial's fixture, and handing
 * those to a child process is something only the driver path can do reliably.
 * The single-shot `ntn workers exec --local` path is covered by the offline
 * Workers tasks.
 *
 * ── Why the QC path and the run path differ ────────────────────────────────
 * At RUN time the agent works in the trial workspace with the real `ntn` CLI
 * and the real worker template, authenticated by a leased token against
 * api.notion.com. It never sees this file, `fixture/spec.json`, or anything
 * under `live/`.
 *
 * At QC time there is no Notion workspace. `evals/_lib/live/qc-live.ts` boots
 * the in-memory `fake-notion.ts`, provisions `fixture/spec.json` against it,
 * and points `NOTION_API_BASE` at it. The stand-ins under `live/` write the
 * worker source an agent would have written; everything after that — install,
 * typecheck, capability inspection, the four invocations and the state
 * assertions — is the same code on both paths.
 */
import { findDatabase, resolveLiveContext } from "../_lib/live/context.ts"
import { pageTitle, readProperties, type NotionPage, type PropValue } from "../_lib/live/notion.ts"
import { NPM, ensureDeps, head, run } from "../_lib/proc.ts"
import { cleanupDriver, execCapability, inspectCapabilities } from "../_lib/exec-worker.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const TOOL = "enrich_order"
const DATABASE_TITLE = "Orders"

/** The banding the prompt specifies, inclusive at the bottom of each band. */
function tierFor(total: number): string {
  if (total >= 10_000) return "Strategic"
  if (total >= 1_000) return "Priority"
  return "Standard"
}

function num(value: PropValue): number {
  return typeof value === "number" ? value : Number.NaN
}

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    typecheck: 0,
    registered: 0,
    returned_values: 0,
    totals_written: 0,
    tiers_written: 0,
    inputs_preserved: 0,
  }

  const live = await resolveLiveContext({ workspaceDir, ctx })
  const { client, rootId } = live
  diagnostics.push(`api=${live.apiBase} root=${rootId} (${live.source.root})`)

  const dataSourceId =
    live.idMap["orders.ds"] ?? (await findDatabase(client, rootId, DATABASE_TITLE))?.dataSourceId
  if (!dataSourceId) {
    diagnostics.push(`the fixture's "${DATABASE_TITLE}" database could not be located — fixture is damaged`)
    return { score: 0, subscores, diagnostics }
  }

  // ---- ground truth, from the inputs as they stand before anything runs ----
  const before = await client.queryAllRows(dataSourceId)
  const expected = before.map((row: NotionPage) => {
    const props = readProperties(row)
    const total = num(props["Unit price"]) * num(props.Quantity)
    return {
      id: row.id,
      order: pageTitle(row),
      unitPrice: num(props["Unit price"]),
      quantity: num(props.Quantity),
      total,
      tier: tierFor(total),
    }
  })
  diagnostics.push(
    `ground truth: ${expected.map((e) => `${e.order}=${e.total}/${e.tier}`).join(", ")}`,
  )
  if (!expected.some((e) => e.total === 1_000 || e.total === 10_000)) {
    diagnostics.push("no order sits on a tier boundary — the banding cannot be got subtly wrong, trap disarmed")
    return { score: 0, subscores, diagnostics }
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

    // ---- layer 2: one call per order ---------------------------------------
    const returnProblems: string[] = []
    let modeLogged = false
    for (const want of expected) {
      const outcome = await execCapability(
        workspaceDir,
        TOOL,
        { page_id: want.id },
        {
          // `createCapabilityContext` reads exactly these two, and
          // NOTION_API_BASE_URL is the spelling the SDK uses.
          mode: "driver",
          env: { NOTION_API_TOKEN: live.token, NOTION_API_BASE_URL: live.apiBase },
        },
      )
      if (!modeLogged) {
        diagnostics.push(`exec path: ${outcome.mode} — ${TOOL}, once per order`)
        modeLogged = true
      }
      if (!outcome.ok) {
        returnProblems.push(`${want.order}: ${head(outcome.error ?? "unknown error", 6)}`)
        continue
      }
      const output = outcome.output
      if (output === null || typeof output !== "object" || Array.isArray(output)) {
        returnProblems.push(`${want.order}: returned ${JSON.stringify(output)}, expected an object`)
        continue
      }
      const got = output as Record<string, unknown>
      if (got.order_total !== want.total || got.tier !== want.tier) {
        returnProblems.push(
          `${want.order}: returned total=${JSON.stringify(got.order_total)} tier=${JSON.stringify(got.tier)}, ` +
            `expected ${want.total} / ${want.tier}`,
        )
      }
    }
    if (returnProblems.length === 0) {
      subscores.returned_values = 1
      diagnostics.push(`${TOOL} returned the right total and tier for all ${expected.length} orders`)
    } else {
      for (const problem of returnProblems) diagnostics.push(problem)
    }
  } finally {
    await cleanupDriver(workspaceDir)
  }

  // ---- layer 3: what ended up on the rows ----------------------------------
  const after = await client.queryAllRows(dataSourceId)
  const byId = new Map(after.map((row) => [row.id, readProperties(row)]))

  const totalProblems: string[] = []
  const tierProblems: string[] = []
  const inputProblems: string[] = []
  for (const want of expected) {
    const props = byId.get(want.id)
    if (!props) {
      totalProblems.push(`${want.order} is gone from the database`)
      continue
    }
    if (props["Order total"] !== want.total) {
      totalProblems.push(
        `${want.order}: Order total is ${JSON.stringify(props["Order total"])}, expected ${want.total}`,
      )
    }
    if (props.Tier !== want.tier) {
      tierProblems.push(`${want.order}: Tier is ${JSON.stringify(props.Tier)}, expected ${want.tier}`)
    }
    if (props["Unit price"] !== want.unitPrice || props.Quantity !== want.quantity) {
      inputProblems.push(
        `${want.order}: Unit price ${want.unitPrice}→${JSON.stringify(props["Unit price"])}, ` +
          `Quantity ${want.quantity}→${JSON.stringify(props.Quantity)}`,
      )
    }
  }

  if (totalProblems.length === 0) subscores.totals_written = 1
  else for (const problem of totalProblems) diagnostics.push(problem)

  if (tierProblems.length === 0) {
    subscores.tiers_written = 1
  } else {
    for (const problem of tierProblems) diagnostics.push(problem)
    const boundary = expected.filter((e) => e.total === 1_000 || e.total === 10_000)
    if (
      boundary.length > 0 &&
      tierProblems.length === boundary.length &&
      boundary.every((e) => tierProblems.some((p) => p.startsWith(`${e.order}:`)))
    ) {
      diagnostics.push(
        `BOUNDARY ONLY: every order is tiered correctly except the ${boundary
          .map((e) => `${e.order} (${e.total})`)
          .join(" and ")} — the banding was written with a strict \`>\` where the spec says "or more".`,
      )
    }
  }

  if (inputProblems.length === 0) {
    subscores.inputs_preserved = 1
    diagnostics.push("Unit price and Quantity are untouched on every row")
  } else {
    for (const problem of inputProblems) diagnostics.push(problem)
    // The failure this task was built to catch. Name it explicitly.
    if (totalProblems.length > 0) {
      diagnostics.push(
        `WROTE OVER THE INPUT: the arithmetic was right and it landed on the wrong column — ` +
          `Order total is still empty and Unit price now holds the figure computed from it. ` +
          `The tool's return value is correct, so nothing short of re-reading the row can see this.`,
      )
    }
  }

  const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
  return { score: score as 0 | 1, subscores, diagnostics }
}
