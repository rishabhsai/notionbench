/**
 * build-workers-003-sync-pagination — one sync cycle, driven page by page.
 *
 * A sync execution is not a one-shot: the platform calls `execute` again with
 * whatever `nextState` the previous call returned, and keeps going until one
 * returns `hasMore: false`. `ntn workers exec ticketsSync --local -d
 * '{"state":<nextUserContext>}'` is exactly that loop done by hand, so this
 * verifier runs it — first call with no state, then feeding each response's
 * `nextUserContext` back in — and asserts on the whole cycle rather than on the
 * first response. The failure this task exists to catch (import the first page,
 * report `hasMore: false`, look fine in testing) is invisible to a single call.
 *
 * `evals/_lib/exec-worker.ts` picks the CLI when it is installed and an
 * in-process `worker.run()` driver otherwise; both return the same
 * `{ changes, hasMore, nextUserContext }` envelope.
 *
 * The vendored `src/deskline.ts` stub and its `data/tickets.json` snapshot are
 * hash-pinned: "paginate the vendor API" stops meaning anything if the vendor
 * is edited to hand back everything at once.
 */
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { NPM, ensureDeps, head, run } from "../_lib/proc.ts"
import { cleanupDriver, execCapability, inspectCapabilities } from "../_lib/exec-worker.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const SYNC = "ticketsSync"

/** sha256 of the fixture files the agent was told to leave alone. */
const PINNED: Record<string, string> = {
  "src/deskline.ts": "337799a832933b07fa8211241778f0eb49fc92be8a2641e424dc2e843833bafe",
  "data/tickets.json": "dfe6418a5d7a877b47092bb39354ddc635bd04588eac759eac6e2814705d60e2",
}

/** The Deskline snapshot, restated here so the check does not read the fixture. */
const TICKETS: Array<{ id: string; subject: string; status: string }> = [
  { id: "DL-1041", subject: "Password reset email never arrives", status: "open" },
  { id: "DL-1042", subject: "Invoice PDF is missing the tax line", status: "pending" },
  { id: "DL-1043", subject: "SSO login loops back to the sign-in page", status: "open" },
  { id: "DL-1044", subject: "Exported CSV has the columns in the wrong order", status: "closed" },
  { id: "DL-1045", subject: "Webhook retries stop after the first failure", status: "open" },
  { id: "DL-1046", subject: "Seat count on the billing page is stale", status: "pending" },
  { id: "DL-1047", subject: "Mobile app crashes when opening attachments", status: "open" },
  { id: "DL-1048", subject: "Search returns archived records", status: "closed" },
  { id: "DL-1049", subject: "Timezone on scheduled reports is off by an hour", status: "pending" },
  { id: "DL-1050", subject: "Bulk import silently drops rows past 500", status: "open" },
  { id: "DL-1051", subject: "Cannot remove a deactivated teammate", status: "closed" },
  { id: "DL-1052", subject: "API key rotation invalidates active sessions", status: "open" },
]

/** Deskline serves 5 per page, so 12 tickets is a three-execution cycle. */
const EXPECTED_PAGE_SIZES = [5, 5, 2]
const MAX_EXECUTIONS = 8

interface SyncResponse {
  changes: Array<Record<string, unknown>>
  hasMore: boolean
  nextState: unknown
}

/** Notion property values are nested text runs; collect the plain text back out. */
function flattenText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(flattenText).join("")
  return ""
}

function parseResponse(output: unknown): SyncResponse | string {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return `expected a sync result object, got ${JSON.stringify(output)?.slice(0, 200)}`
  }
  const got = output as Record<string, unknown>
  if (!Array.isArray(got.changes)) return `changes is ${JSON.stringify(got.changes)?.slice(0, 200)}`
  if (typeof got.hasMore !== "boolean") return `hasMore is ${JSON.stringify(got.hasMore)}`
  return {
    changes: got.changes as Array<Record<string, unknown>>,
    hasMore: got.hasMore,
    nextState: got.nextUserContext,
  }
}

export default async function evaluate({ workspaceDir }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    typecheck: 0,
    registered: 0,
    stub_untouched: 0,
    first_page: 0,
    cycle_terminates: 0,
    page_sizes: 0,
    records_complete: 0,
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

    // ---- the vendor stub must be the one we shipped ------------------------
    let untouched = true
    for (const [relative, expected] of Object.entries(PINNED)) {
      let actual: string
      try {
        actual = createHash("sha256").update(await fs.readFile(path.join(workspaceDir, relative))).digest("hex")
      } catch {
        diagnostics.push(`${relative} is missing`)
        untouched = false
        continue
      }
      if (actual !== expected) {
        diagnostics.push(`${relative} was modified (sha256 ${actual.slice(0, 12)}…, expected ${expected.slice(0, 12)}…)`)
        untouched = false
      }
    }
    if (untouched) {
      subscores.stub_untouched = 1
      diagnostics.push("vendor stub and snapshot unmodified")
    }

    // ---- registration ------------------------------------------------------
    const inspection = await inspectCapabilities(workspaceDir)
    if (!inspection.ok) {
      diagnostics.push(`could not load the worker (${inspection.command}):\n${head(inspection.error ?? "", 15)}`)
      return { score: 0, subscores, diagnostics }
    }
    const sync = inspection.capabilities.find((c) => c.key === SYNC)
    if (!sync) {
      diagnostics.push(
        `no capability named "${SYNC}" (registered: ${
          inspection.capabilities.map((c) => `${c.key}:${c.tag}`).join(", ") || "none"
        })`,
      )
      return { score: 0, subscores, diagnostics }
    }
    if (sync.tag !== "sync") {
      diagnostics.push(`"${SYNC}" is registered as a ${sync.tag}, not a sync`)
      return { score: 0, subscores, diagnostics }
    }
    subscores.registered = 1

    // ---- layer 2: drive one full sync cycle --------------------------------
    const responses: SyncResponse[] = []
    let state: unknown
    let commandLogged = false
    let broke: string | undefined

    for (let i = 0; i < MAX_EXECUTIONS; i++) {
      const input = i === 0 ? {} : { state }
      const outcome = await execCapability(workspaceDir, SYNC, input)
      if (!commandLogged) {
        diagnostics.push(`exec path: ${outcome.mode} — ${outcome.command}`)
        commandLogged = true
      }
      if (!outcome.ok) {
        broke = `execution ${i + 1} failed: ${head(outcome.error ?? "unknown error", 8)}`
        break
      }
      const parsed = parseResponse(outcome.output)
      if (typeof parsed === "string") {
        broke = `execution ${i + 1}: ${parsed}`
        break
      }
      responses.push(parsed)
      diagnostics.push(
        `execution ${i + 1}: ${parsed.changes.length} change(s), hasMore=${parsed.hasMore}, nextState=${JSON.stringify(parsed.nextState) ?? "undefined"}`,
      )
      if (!parsed.hasMore) break
      if (parsed.nextState === undefined || parsed.nextState === null) {
        broke = `execution ${i + 1} returned hasMore: true with no nextState — the cycle cannot continue`
        break
      }
      state = parsed.nextState
    }
    if (broke) diagnostics.push(broke)

    if (responses.length === 0) return { score: 0, subscores, diagnostics }

    // first execution: one page, more to come
    const first = responses[0]
    if (first.changes.length === EXPECTED_PAGE_SIZES[0] && first.hasMore && first.nextState !== undefined) {
      subscores.first_page = 1
    } else {
      diagnostics.push(
        `first execution returned ${first.changes.length} change(s) with hasMore=${first.hasMore}; expected ${EXPECTED_PAGE_SIZES[0]} and more to come`,
      )
    }

    const last = responses[responses.length - 1]
    if (!broke && last.hasMore === false) {
      subscores.cycle_terminates = 1
    } else {
      diagnostics.push(`the cycle did not finish cleanly after ${responses.length} execution(s)`)
    }

    const sizes = responses.map((r) => r.changes.length)
    if (sizes.length === EXPECTED_PAGE_SIZES.length && sizes.every((n, i) => n === EXPECTED_PAGE_SIZES[i])) {
      subscores.page_sizes = 1
    } else {
      diagnostics.push(`page sizes were [${sizes.join(", ")}]; expected [${EXPECTED_PAGE_SIZES.join(", ")}]`)
    }

    // ---- every ticket, exactly once, with the right properties -------------
    const seen = new Map<string, Record<string, unknown>>()
    const problems: string[] = []
    for (const response of responses) {
      for (const change of response.changes) {
        if (change.type !== "upsert") {
          problems.push(`change for ${JSON.stringify(change.key)} has type ${JSON.stringify(change.type)}`)
          continue
        }
        const key = change.key
        if (typeof key !== "string") {
          problems.push(`change with a non-string key: ${JSON.stringify(key)?.slice(0, 120)}`)
          continue
        }
        if (seen.has(key)) problems.push(`${key} was upserted twice in one cycle`)
        seen.set(key, (change.properties ?? {}) as Record<string, unknown>)
      }
    }
    for (const ticket of TICKETS) {
      const properties = seen.get(ticket.id)
      if (!properties) {
        problems.push(`${ticket.id} never reached the database`)
        continue
      }
      const subject = flattenText(properties["Subject"])
      const id = flattenText(properties["Ticket ID"])
      const status = flattenText(properties["Status"])
      if (subject !== ticket.subject) {
        problems.push(`${ticket.id} Subject is ${JSON.stringify(subject)}; expected ${JSON.stringify(ticket.subject)}`)
      }
      if (id !== ticket.id) problems.push(`${ticket.id} Ticket ID is ${JSON.stringify(id)}`)
      if (status !== ticket.status) {
        problems.push(`${ticket.id} Status is ${JSON.stringify(status)}; expected ${JSON.stringify(ticket.status)}`)
      }
    }
    const extra = [...seen.keys()].filter((key) => !TICKETS.some((t) => t.id === key))
    if (extra.length > 0) problems.push(`unexpected keys: ${extra.join(", ")}`)

    if (problems.length === 0) {
      subscores.records_complete = 1
      diagnostics.push(`all ${TICKETS.length} tickets upserted with the requested properties`)
    } else {
      for (const problem of problems.slice(0, 10)) diagnostics.push(problem)
      if (problems.length > 10) diagnostics.push(`… (+${problems.length - 10} more)`)
    }

    const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
    return { score: score as 0 | 1, subscores, diagnostics }
  } finally {
    await cleanupDriver(workspaceDir)
  }
}
