/**
 * operate-batch-001-rate-limited-writes — 50 writes, and all 50 have to land.
 *
 * The discipline under test is pacing: Notion allows ~3 requests/second and
 * answers a burst with `429 rate_limited` plus a `Retry-After`. What makes that
 * a *task* rather than a footnote is the failure mode it produces — a throttled
 * creation that nobody retried leaves the import short, with no error anywhere
 * and a database that looks populated. So the grading question is completeness,
 * asserted exactly: every contact in `contacts.json` present once, with all four
 * fields right, and nothing else in the database.
 *
 * ── On timing ──────────────────────────────────────────────────────────────
 * Timing is deliberately **not** asserted. `fake-notion.ts` models no rate limit
 * and answers instantly, so any wall-clock assertion here would measure the QC
 * harness rather than the agent, and a `sleep` in a verifier is a permanent tax
 * on every CI run. The fake server does keep a request log (`server.requests`),
 * but `qc-live.ts` does not thread it into `ctx`, so a verifier cannot inspect
 * the call pattern either. Pacing is therefore graded where it is real: against
 * api.notion.com, where an unpaced burst produces exactly the short import this
 * verifier catches. `live/wrong.mjs` reproduces that outcome directly.
 *
 * Ground truth is read from `fixture/workspace/contacts.json` — the pristine
 * copy in the task directory, not the trial workspace's, so editing the input
 * file cannot bend the expectation to fit the result.
 *
 * ── Why the QC path and the run path differ ────────────────────────────────
 * At RUN time the agent works in the trial workspace with the real `ntn` CLI,
 * authenticated by a leased token against api.notion.com. It never sees this
 * file, `fixture/spec.json`, or anything under `live/`.
 *
 * At QC time there is no Notion workspace. `evals/_lib/live/qc-live.ts` boots
 * the in-memory `fake-notion.ts`, provisions `fixture/spec.json` against it, and
 * points `NOTION_API_BASE` at it. `ntn` cannot be redirected that way — it is a
 * native binary that talks to the real service — so the oracle and the
 * plausibly-wrong solution under `live/` are plain Node scripts issuing `fetch`
 * calls. They stand in for the *agent*, not for the CLI: what CI proves is that
 * this verifier returns 1 for a complete import and 0 for a short one.
 *
 * The verifier is the same code on both paths — it honors `NOTION_API_BASE` and
 * reads the workspace through the public API either way.
 */
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { readProperties } from "../_lib/live/notion.ts"
import { findDatabase, resolveLiveContext } from "../_lib/live/context.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const DATABASE_TITLE = "Contact Imports"
const DATABASE_KEY = "contacts"
const SOURCE_FILE = "contacts.json"

/** Keep a mismatch report readable when an import went badly wrong. */
const MAX_REPORTED = 8

interface Contact {
  name: string
  email: string
  company: string
  segment: string
}

const describe = (c: Omit<Contact, "name">): string => `${c.email} | ${c.company} | ${c.segment}`

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = { count: 0, contents: 0, no_extras: 0 }

  const live = await resolveLiveContext({ workspaceDir, ctx })
  const { client, rootId } = live
  diagnostics.push(`api=${live.apiBase} root=${rootId} (${live.source.root})`)

  // ---- ground truth: the pristine input, not the trial copy ----------------
  const taskDir = typeof ctx?.taskDir === "string" ? ctx.taskDir : import.meta.dirname
  const sourcePath = path.join(taskDir, "fixture", "workspace", SOURCE_FILE)
  let contacts: Contact[]
  try {
    contacts = JSON.parse(await fs.readFile(sourcePath, "utf8")) as Contact[]
  } catch (err) {
    diagnostics.push(`could not read the fixture's ${SOURCE_FILE}: ${(err as Error).message}`)
    return { score: 0, subscores, diagnostics }
  }
  if (!Array.isArray(contacts) || contacts.length === 0) {
    diagnostics.push(`the fixture's ${SOURCE_FILE} is not a non-empty array — fixture is damaged`)
    return { score: 0, subscores, diagnostics }
  }
  const expected = new Map(contacts.map((c) => [c.name, c]))
  if (expected.size !== contacts.length) {
    diagnostics.push(`${SOURCE_FILE} has duplicate names — the fixture cannot be graded by name`)
    return { score: 0, subscores, diagnostics }
  }
  diagnostics.push(`ground truth: ${contacts.length} contacts in ${SOURCE_FILE}`)

  // ---- what actually landed ------------------------------------------------
  const dataSourceId =
    live.idMap[`${DATABASE_KEY}.ds`] ?? (await findDatabase(client, rootId, DATABASE_TITLE))?.dataSourceId
  if (!dataSourceId) {
    diagnostics.push(`the fixture's "${DATABASE_TITLE}" database could not be located — fixture is damaged`)
    return { score: 0, subscores, diagnostics }
  }

  const rows = await client.queryAllRows(dataSourceId)
  const byName = new Map<string, Array<Omit<Contact, "name">>>()
  for (const row of rows) {
    const props = readProperties(row)
    const name = String(props.Name ?? "")
    const entry = {
      email: String(props.Email ?? ""),
      company: String(props.Company ?? ""),
      segment: String(props.Segment ?? ""),
    }
    byName.set(name, [...(byName.get(name) ?? []), entry])
  }
  diagnostics.push(`${rows.length} row(s) in "${DATABASE_TITLE}"`)

  // ---- 1. the count --------------------------------------------------------
  if (rows.length === contacts.length) {
    subscores.count = 1
  } else {
    diagnostics.push(`row count is ${rows.length}, expected ${contacts.length} (off by ${rows.length - contacts.length})`)
  }

  // ---- 2. every contact, once, with the right fields -----------------------
  const missing: string[] = []
  const wrongFields: string[] = []
  const duplicated: string[] = []
  for (const [name, want] of expected) {
    const entries = byName.get(name)
    if (!entries || entries.length === 0) {
      missing.push(name)
      continue
    }
    if (entries.length > 1) duplicated.push(`${name} ×${entries.length}`)
    const got = entries[0]
    if (got.email !== want.email || got.company !== want.company || got.segment !== want.segment) {
      wrongFields.push(`"${name}": expected ${describe(want)}, got ${describe(got)}`)
    }
  }

  if (missing.length === 0 && wrongFields.length === 0 && duplicated.length === 0) {
    subscores.contents = 1
    diagnostics.push(`all ${contacts.length} contacts are present exactly once, with all four fields correct`)
  } else {
    if (missing.length > 0) {
      // The failure this task exists to catch: writes that were throttled,
      // dropped, and never noticed.
      diagnostics.push(
        `SHORT IMPORT — ${missing.length} of ${contacts.length} contact(s) never made it into the database: ` +
          missing.slice(0, MAX_REPORTED).join(", ") +
          (missing.length > MAX_REPORTED ? ` … and ${missing.length - MAX_REPORTED} more` : ""),
      )
    }
    for (const problem of wrongFields.slice(0, MAX_REPORTED)) diagnostics.push(problem)
    if (wrongFields.length > MAX_REPORTED) {
      diagnostics.push(`… and ${wrongFields.length - MAX_REPORTED} more field mismatch(es)`)
    }
    if (duplicated.length > 0) {
      diagnostics.push(
        `written more than once: ${duplicated.slice(0, MAX_REPORTED).join(", ")}` +
          (duplicated.length > MAX_REPORTED ? ` … and ${duplicated.length - MAX_REPORTED} more` : ""),
      )
    }
  }

  // ---- 3. nothing that was not in the file ---------------------------------
  const extras = [...byName.keys()].filter((name) => !expected.has(name))
  if (extras.length === 0) {
    subscores.no_extras = 1
  } else {
    diagnostics.push(
      `rows that are not in ${SOURCE_FILE}: ${extras.slice(0, MAX_REPORTED).join(", ")}` +
        (extras.length > MAX_REPORTED ? ` … and ${extras.length - MAX_REPORTED} more` : ""),
    )
  }

  const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
  return { score: score as 0 | 1, subscores, diagnostics }
}
