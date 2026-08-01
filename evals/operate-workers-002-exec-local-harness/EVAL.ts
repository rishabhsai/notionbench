/**
 * operate-workers-002-exec-local-harness — can they drive the loop at all?
 *
 * Nothing is built here. The question is whether the agent can run a capability
 * on this machine and report back faithfully, which is the innermost loop of
 * every Workers task: `ntn workers exec <key> --local -d '<json>'`.
 *
 * The digest is a truncated sha256, so `output` cannot be arrived at by reading
 * the source and doing the arithmetic in your head — it has to have been run.
 * It is compared against a run this verifier does itself, and `src/index.ts` is
 * hash-pinned so "make the tool return what I already wrote down" is not a
 * strategy.
 *
 * `command` is checked for the shape of the invocation, not for a byte-exact
 * string: the capability key, a local flag, and an input flag. `ntn` from PATH,
 * `npx ntn@…`, a wrapper script — all fine, they all reproduce.
 */
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { ensureDeps, head } from "../_lib/proc.ts"
import { cleanupDriver, execCapability } from "../_lib/exec-worker.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const TOOL = "receipt_digest"
const ANSWER = "answer.json"

/** sha256 of the worker as shipped; the task is to run it, not to edit it. */
const PINNED_INDEX = "74f9e0e89ee4e571e9bc146a17e3415b8c75fa9e105b8bc3b86a7be01b355fb9"

const INPUT = {
  lines: [
    { sku: "WH-101", qty: 3, unit_cents: 1299 },
    { sku: "WH-207", qty: 1, unit_cents: 4599 },
    { sku: "WH-101", qty: 2, unit_cents: 1299 },
    { sku: "WH-512", qty: 10, unit_cents: 99 },
  ],
}

/** The tool's own envelope, when someone pastes the whole thing back. */
function unwrap(value: unknown): unknown {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (record._tag === "success" && "value" in record) return record.value
  }
  return value
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }
  if (typeof a !== "object") return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => key in right && deepEqual(left[key], right[key]))
}

export default async function evaluate({ workspaceDir }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    worker_untouched: 0,
    answer_readable: 0,
    command_reproduces: 0,
    output_matches: 0,
  }

  try {
    const install = await ensureDeps(workspaceDir)
    if (install.result && install.result.code !== 0) {
      diagnostics.push(`npm install failed:\n${head(install.result.stderr || install.result.stdout)}`)
      return { score: 0, subscores, diagnostics }
    }

    // ---- the worker is the one we shipped ----------------------------------
    try {
      const actual = createHash("sha256")
        .update(await fs.readFile(path.join(workspaceDir, "src", "index.ts")))
        .digest("hex")
      if (actual === PINNED_INDEX) {
        subscores.worker_untouched = 1
        diagnostics.push("src/index.ts unmodified")
      } else {
        diagnostics.push(`src/index.ts was modified (sha256 ${actual.slice(0, 12)}…)`)
      }
    } catch {
      diagnostics.push("src/index.ts is missing")
    }

    // ---- the answer file ---------------------------------------------------
    let answer: Record<string, unknown> | undefined
    try {
      const raw = await fs.readFile(path.join(workspaceDir, ANSWER), "utf8")
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        diagnostics.push(`${ANSWER} is not a JSON object`)
      } else {
        answer = parsed as Record<string, unknown>
        subscores.answer_readable = 1
      }
    } catch (err) {
      diagnostics.push(`could not read ${ANSWER}: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (answer) {
      const command = typeof answer.command === "string" ? answer.command : ""
      const normalized = command.toLowerCase()
      const missing: string[] = []
      if (!/workers\s+exec/.test(normalized)) missing.push("`workers exec`")
      if (!normalized.includes(TOOL)) missing.push(`the capability key \`${TOOL}\``)
      if (!/(^|\s)(--local|-l)(\s|$|=)/.test(normalized)) missing.push("a local-execution flag")
      if (!/(^|\s)(-d|--data)(\s|=)/.test(normalized) && !normalized.includes("<")) {
        missing.push("an input flag")
      }
      if (missing.length === 0) {
        subscores.command_reproduces = 1
        diagnostics.push(`command: ${command}`)
      } else {
        diagnostics.push(`command ${JSON.stringify(command)} is missing ${missing.join(", ")}`)
      }
    }

    // ---- what the tool actually says ---------------------------------------
    const outcome = await execCapability(workspaceDir, TOOL, INPUT)
    diagnostics.push(`exec path: ${outcome.mode} — ${outcome.command}`)
    if (!outcome.ok) {
      diagnostics.push(`${TOOL} failed here too: ${head(outcome.error ?? "unknown error", 8)}`)
      return { score: 0, subscores, diagnostics }
    }
    diagnostics.push(`${TOOL} → ${JSON.stringify(outcome.output)}`)

    if (answer) {
      const reported = unwrap(answer.output)
      if (deepEqual(reported, outcome.output)) {
        subscores.output_matches = 1
      } else {
        diagnostics.push(
          `answer.output is ${JSON.stringify(reported)?.slice(0, 300)}; the tool returns ${JSON.stringify(outcome.output)}`,
        )
      }
    }

    const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
    return { score: score as 0 | 1, subscores, diagnostics }
  } finally {
    await cleanupDriver(workspaceDir)
  }
}
