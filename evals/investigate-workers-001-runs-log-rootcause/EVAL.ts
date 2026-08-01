/**
 * investigate-workers-001-runs-log-rootcause — read the log, then prove it.
 *
 * Two layers, both required:
 *
 *  1. `answer.json` — the diagnosis. `run_id`, `capability`, `error` and
 *     `field` are exact matches (normalized for case and for the JSON-pointer
 *     spelling of the field, since `/tickets/3/assignee` is a perfectly good
 *     way to name it). `root_cause` is prose, so it is checked the only way
 *     prose can be checked deterministically: it has to name the field and say
 *     something about the value that broke it.
 *  2. `ntn workers exec assignee_load --local` — the fix. A diagnosis that is
 *     right on paper and a tool that still rejects unassigned tickets is not a
 *     fixed worker, and a tool that "fixes" it by dropping those tickets loses
 *     45 minutes of work off the ops team's board.
 *
 * The exec path is `evals/_lib/exec-worker.ts` (CLI when installed, in-process
 * `worker.run()` driver otherwise).
 */
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { NPM, ensureDeps, head, run } from "../_lib/proc.ts"
import { cleanupDriver, execCapability } from "../_lib/exec-worker.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const TOOL = "assignee_load"
const ANSWER = "answer.json"

const EXPECTED = {
  run_id: "run_7c1e9d3a5b",
  capability: "assignee_load",
  error: "invalidtoolinputerror",
  field: "assignee",
}

/** The prose field has to mention the culprit and the shape of the bad value. */
const ROOT_CAUSE_MUST_MENTION = ["assignee"]
const ROOT_CAUSE_MUST_MENTION_ONE_OF = ["null", "unassigned", "nullable", "not assigned", "no assignee"]

interface LoadEntry {
  assignee: string
  open_tickets: number
  minutes: number
}

const CASES: Array<{ name: string; input: unknown; expect: LoadEntry[] }> = [
  {
    name: "mixed_assigned_and_not",
    input: {
      tickets: [
        { id: "DL-1041", assignee: "Dana Whitfield", minutes: 30 },
        { id: "DL-1044", assignee: null, minutes: 45 },
        { id: "DL-1042", assignee: "Ravi Menon", minutes: 20 },
        { id: "DL-1043", assignee: "Dana Whitfield", minutes: 25 },
        { id: "DL-1046", assignee: null, minutes: 5 },
      ],
    },
    expect: [
      { assignee: "Dana Whitfield", open_tickets: 2, minutes: 55 },
      { assignee: "unassigned", open_tickets: 2, minutes: 50 },
      { assignee: "Ravi Menon", open_tickets: 1, minutes: 20 },
    ],
  },
  {
    name: "everything_assigned",
    input: {
      tickets: [
        { id: "DL-1047", assignee: "Ravi Menon", minutes: 10 },
        { id: "DL-1048", assignee: "Dana Whitfield", minutes: 5 },
      ],
    },
    expect: [
      { assignee: "Ravi Menon", open_tickets: 1, minutes: 10 },
      { assignee: "Dana Whitfield", open_tickets: 1, minutes: 5 },
    ],
  },
  {
    name: "nothing_assigned",
    input: { tickets: [{ id: "DL-1050", assignee: null, minutes: 7 }] },
    expect: [{ assignee: "unassigned", open_tickets: 1, minutes: 7 }],
  },
  {
    name: "no_tickets",
    input: { tickets: [] },
    expect: [],
  },
]

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : ""
}

/** `assignee`, `tickets[3].assignee` and `/tickets/3/assignee` all name the same field. */
function fieldName(value: unknown): string {
  const text = normalize(value).replace(/[[\]"']/g, "")
  const parts = text.split(/[./]/).filter((p) => p.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : text
}

function checkLoad(output: unknown, expect: LoadEntry[]): string | undefined {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return `expected an object, got ${JSON.stringify(output)?.slice(0, 200)}`
  }
  const load = (output as Record<string, unknown>).load
  if (!Array.isArray(load)) return `load is ${JSON.stringify(load)?.slice(0, 200)}; expected an array`
  if (load.length !== expect.length) {
    return `load has ${load.length} entr(ies); expected ${expect.length}: ${JSON.stringify(load).slice(0, 300)}`
  }
  for (let i = 0; i < expect.length; i++) {
    const got = load[i] as Record<string, unknown> | undefined
    const want = expect[i]
    if (typeof got !== "object" || got === null) return `entry ${i} is ${JSON.stringify(got)}`
    if (got.assignee !== want.assignee) {
      return `entry ${i} assignee is ${JSON.stringify(got.assignee)}; expected ${JSON.stringify(want.assignee)}`
    }
    if (got.open_tickets !== want.open_tickets) {
      return `${want.assignee} open_tickets is ${JSON.stringify(got.open_tickets)}; expected ${want.open_tickets}`
    }
    if (got.minutes !== want.minutes) {
      return `${want.assignee} minutes is ${JSON.stringify(got.minutes)}; expected ${want.minutes}`
    }
  }
  return undefined
}

export default async function evaluate({ workspaceDir }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    typecheck: 0,
    answer_run_id: 0,
    answer_capability: 0,
    answer_error: 0,
    answer_field: 0,
    answer_root_cause: 0,
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

    // ---- the diagnosis -----------------------------------------------------
    let answer: Record<string, unknown> | undefined
    try {
      const raw = await fs.readFile(path.join(workspaceDir, ANSWER), "utf8")
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        diagnostics.push(`${ANSWER} is not a JSON object`)
      } else {
        answer = parsed as Record<string, unknown>
      }
    } catch (err) {
      diagnostics.push(`could not read ${ANSWER}: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (answer) {
      const runId = normalize(answer.run_id)
      if (runId === EXPECTED.run_id) subscores.answer_run_id = 1
      else diagnostics.push(`run_id is ${JSON.stringify(answer.run_id)}; that is not the run that failed`)

      if (normalize(answer.capability) === EXPECTED.capability) subscores.answer_capability = 1
      else diagnostics.push(`capability is ${JSON.stringify(answer.capability)}`)

      if (normalize(answer.error).replace(/\s+/g, "") === EXPECTED.error) subscores.answer_error = 1
      else diagnostics.push(`error is ${JSON.stringify(answer.error)}`)

      if (fieldName(answer.field) === EXPECTED.field) subscores.answer_field = 1
      else diagnostics.push(`field is ${JSON.stringify(answer.field)}`)

      const prose = normalize(answer.root_cause)
      const namesField = ROOT_CAUSE_MUST_MENTION.every((word) => prose.includes(word))
      const namesValue = ROOT_CAUSE_MUST_MENTION_ONE_OF.some((word) => prose.includes(word))
      if (prose.length >= 20 && namesField && namesValue) subscores.answer_root_cause = 1
      else diagnostics.push(`root_cause does not explain the failure: ${JSON.stringify(answer.root_cause)}`)
    }

    // ---- layer 2: the fix --------------------------------------------------
    let commandLogged = false
    for (const { name, input, expect } of CASES) {
      const outcome = await execCapability(workspaceDir, TOOL, input)
      if (!commandLogged) {
        diagnostics.push(`exec path: ${outcome.mode} — ${outcome.command}`)
        commandLogged = true
      }
      if (!outcome.ok) {
        diagnostics.push(`${name}: ${TOOL} failed: ${head(outcome.error ?? "unknown error", 8)}`)
        continue
      }
      const problem = checkLoad(outcome.output, expect)
      if (problem) {
        diagnostics.push(`${name}: ${problem}`)
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
