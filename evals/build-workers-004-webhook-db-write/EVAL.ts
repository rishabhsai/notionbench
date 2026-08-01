/**
 * build-workers-004-webhook-db-write — a webhook, run for real, against a real
 * fixture.
 *
 * This is the first task where the two halves of the harness meet. The agent's
 * deliverable is *source*, so the behavioral layer is `exec --local`
 * (`evals/_lib/exec-worker.ts`): the webhook capability is invoked in-process
 * with a fixed two-event payload, exactly as the hosted runtime would call it.
 * The correctness layer is *state*: the Notion fixture the handler wrote into
 * is read back afterwards and compared to what those two events should have
 * produced.
 *
 * The execution path is pinned to the in-process driver rather than probed for.
 * `context.notion` is built from `NOTION_API_TOKEN` and `NOTION_API_BASE_URL`
 * at handler-construction time, and those are per-trial values pointing at this
 * trial's fixture; handing them to a child process is something only the driver
 * path can do reliably. The single-shot `ntn workers exec --local` path is
 * covered by the offline Workers tasks.
 *
 * Two events are delivered in one call:
 *   1. `INC-1042`, which exists — the row must come back updated;
 *   2. `INC-9999`, which does not — nothing may be created, and no other row
 *      may move.
 *
 * The failure this is shaped around is matching on position instead of on key.
 * `dataSources.query` returns rows in its own order and `results[0]` is a row,
 * not *the* row; a handler that takes it writes a completely plausible update
 * to the wrong incident. Both events land on that same first row, so the
 * verifier can name the mistake precisely.
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
 * typecheck, capability inspection, the webhook invocation and the state
 * assertions — is the same code on both paths.
 */
import { findDatabase, resolveLiveContext } from "../_lib/live/context.ts"
import { pageTitle, readProperties, type NotionPage } from "../_lib/live/notion.ts"
import { NPM, ensureDeps, head, run } from "../_lib/proc.ts"
import { cleanupDriver, execCapability, inspectCapabilities } from "../_lib/exec-worker.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const WEBHOOK = "onIncidentAlert"
const DATABASE_TITLE = "Incidents"

const KNOWN = {
  incident_id: "INC-1042",
  status: "Resolved",
  summary: "Reindex finished; results are current again.",
}
const UNKNOWN = {
  incident_id: "INC-9999",
  status: "Resolved",
  summary: "This incident is not in the database.",
}

function webhookEvent(deliveryId: string, body: Record<string, string>): Record<string, unknown> {
  const rawBody = JSON.stringify(body)
  return {
    deliveryId,
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    rawBody,
  }
}

/** Row lookup by the fixture's business key, which is what the handler must use too. */
function rowByIncidentId(rows: NotionPage[], incidentId: string): NotionPage | undefined {
  return rows.find((row) => readProperties(row)["Incident ID"] === incidentId)
}

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    typecheck: 0,
    registered: 0,
    delivered: 0,
    target_updated: 0,
    others_untouched: 0,
    unknown_ignored: 0,
  }

  const live = await resolveLiveContext({ workspaceDir, ctx })
  const { client, rootId } = live
  diagnostics.push(`api=${live.apiBase} root=${rootId} (${live.source.root})`)

  const dataSourceId =
    live.idMap["incidents.ds"] ?? (await findDatabase(client, rootId, DATABASE_TITLE))?.dataSourceId
  if (!dataSourceId) {
    diagnostics.push(`the fixture's "${DATABASE_TITLE}" database could not be located — fixture is damaged`)
    return { score: 0, subscores, diagnostics }
  }

  const before = await client.queryAllRows(dataSourceId)
  diagnostics.push(`fixture holds ${before.length} incident(s): ${before.map(pageTitle).join(", ")}`)

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
    const capability = inspection.capabilities.find((c) => c.key === WEBHOOK)
    if (!capability) {
      diagnostics.push(
        `no capability named "${WEBHOOK}" (registered: ${
          inspection.capabilities.map((c) => `${c.key}:${c.tag}`).join(", ") || "none"
        })`,
      )
      return { score: 0, subscores, diagnostics }
    }
    if (capability.tag !== "webhook") {
      diagnostics.push(`"${WEBHOOK}" is registered as a ${capability.tag}, not a webhook`)
      return { score: 0, subscores, diagnostics }
    }
    subscores.registered = 1

    // ---- layer 2: deliver the payload --------------------------------------
    const outcome = await execCapability(
      workspaceDir,
      WEBHOOK,
      [webhookEvent("nb-delivery-1", KNOWN), webhookEvent("nb-delivery-2", UNKNOWN)],
      {
        mode: "driver",
        // `createCapabilityContext` reads exactly these two, and NOTION_API_BASE_URL
        // is the spelling the SDK uses — not NOTION_API_BASE.
        env: { NOTION_API_TOKEN: live.token, NOTION_API_BASE_URL: live.apiBase },
      },
    )
    // The command line carries the whole base64 payload; the payload is right
    // here in the source, so the mode is the only part worth echoing.
    diagnostics.push(`exec path: ${outcome.mode} — ${WEBHOOK} with 2 events`)
    if (!outcome.ok) {
      diagnostics.push(`${WEBHOOK} threw on delivery: ${head(outcome.error ?? "unknown error", 10)}`)
      return { score: 0, subscores, diagnostics }
    }
    subscores.delivered = 1
  } finally {
    await cleanupDriver(workspaceDir)
  }

  // ---- layer 3: what the handler actually wrote ----------------------------
  const after = await client.queryAllRows(dataSourceId)

  const target = rowByIncidentId(after, KNOWN.incident_id)
  if (!target) {
    diagnostics.push(`the ${KNOWN.incident_id} row no longer exists`)
    return { score: 0, subscores, diagnostics }
  }
  const targetProps = readProperties(target)
  if (targetProps.Status === KNOWN.status && targetProps.Notes === KNOWN.summary) {
    subscores.target_updated = 1
    diagnostics.push(`${KNOWN.incident_id} is now ${KNOWN.status} with the alert's summary in Notes`)
  } else {
    diagnostics.push(
      `${KNOWN.incident_id}: Status=${JSON.stringify(targetProps.Status)} Notes=${JSON.stringify(targetProps.Notes)}, ` +
        `expected ${JSON.stringify(KNOWN.status)} / ${JSON.stringify(KNOWN.summary)}`,
    )
  }

  const beforeById = new Map(
    before.map((row) => [String(readProperties(row)["Incident ID"]), readProperties(row)]),
  )
  const changed: string[] = []
  for (const row of after) {
    const props = readProperties(row)
    const id = String(props["Incident ID"])
    if (id === KNOWN.incident_id) continue
    const was = beforeById.get(id)
    if (!was) {
      changed.push(`${id} is new`)
      continue
    }
    if (was.Status !== props.Status || was.Notes !== props.Notes) {
      changed.push(
        `${id}: Status ${JSON.stringify(was.Status)}→${JSON.stringify(props.Status)}, ` +
          `Notes ${JSON.stringify(was.Notes)}→${JSON.stringify(props.Notes)}`,
      )
    }
  }
  if (changed.length === 0) {
    subscores.others_untouched = 1
    diagnostics.push(`the other ${after.length - 1} incident(s) are unchanged`)
  } else {
    for (const line of changed) diagnostics.push(`collateral change — ${line}`)
    // The failure this task was built to catch. Name it explicitly.
    const firstRowId = String(readProperties(before[0])["Incident ID"])
    if (changed.some((line) => line.startsWith(`${firstRowId}:`)) && targetProps.Notes !== KNOWN.summary) {
      diagnostics.push(
        `MATCHED BY POSITION: ${firstRowId} is the first row the query returns, and it received the update ` +
          `meant for ${KNOWN.incident_id}. \`results[0]\` is a row, not the row — the payload's Incident ID has ` +
          `to select it.`,
      )
    }
  }

  const invented = after.length - before.length
  const landed = after.filter((row) => readProperties(row).Notes === UNKNOWN.summary).map(pageTitle)
  if (invented === 0 && landed.length === 0) {
    subscores.unknown_ignored = 1
    diagnostics.push(`the unmatched alert for ${UNKNOWN.incident_id} left the database alone`)
  } else {
    if (invented !== 0) {
      diagnostics.push(
        `the unmatched alert for ${UNKNOWN.incident_id} changed the row count: ` +
          `${before.length} before, ${after.length} after`,
      )
    }
    if (landed.length > 0) {
      diagnostics.push(
        `the unmatched alert for ${UNKNOWN.incident_id} was written onto ${landed.join(", ")} — ` +
          `an alert with no matching Incident ID must not update anything`,
      )
    }
  }

  const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
  return { score: score as 0 | 1, subscores, diagnostics }
}
