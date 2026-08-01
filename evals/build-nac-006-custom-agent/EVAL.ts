/**
 * build-nac-006-custom-agent — canonical intents comparison over
 * whitespace-normalized agent instructions.
 *
 * The interesting field is `sharedResources`: it holds the resourceIds of the
 * pages and databases the agent may read and write, so the canonicalizer treats
 * its entries as references. An agent that shares the *data source* instead of
 * the database, or shares nothing at all, therefore fails the comparison rather
 * than quietly grading as "close enough" — and that is the whole point of the
 * field, since an agent with no shared resources cannot do its job once applied.
 *
 * `instructions` is a Markdown string. Like page content it is normalized on
 * both sides before diffing (blank lines dropped, internal whitespace runs
 * collapsed, list indentation kept as a depth) so the grade is about the
 * instructions written, not about hard-wrapping. Everything else — the
 * teamspace, the database schema, the seeded rows, the agent's name, icon and
 * model slug — is compared by the normal canonical rules, up to resourceId
 * renaming.
 *
 * `expected/intents.json` is the oracle build output, committed alongside the
 * task; regenerate it by building `fixture/workspace` + `solution/` and copying
 * `dist/intents.json`. QC's `solution` check fails loudly if the two drift.
 */
import * as path from "node:path"
import { diffIntents, intentsOfType, type Json } from "@notionbench/scoring"
import { buildNacProject } from "../_lib/nac.ts"
import { readJson } from "../_lib/proc.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

/** Keep the diagnostic block readable when a solution is wrong in many places. */
const MAX_REPORTED_DIFFS = 8

/** Sonnet 4.6 (Low) — the slug is documented in the template's `types.d.ts`. */
const WANTED_MODEL = "almond-croissant-low"

const LIST_ITEM_RE = /^(?:[-*+]\s|\d+[.)]\s)/

function indentDepth(line: string): number {
  let i = 0
  let depth = 0
  while (i < line.length) {
    if (line[i] === "\t") {
      depth++
      i++
    } else if (line.startsWith("    ", i)) {
      depth++
      i += 4
    } else if (line.startsWith("  ", i)) {
      depth++
      i += 2
    } else break
  }
  return depth
}

/** Formatting-insensitive, structure-preserving form of a Markdown string. */
function normalizeMarkdown(text: string): string {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim().length === 0) continue
    const depth = indentDepth(raw)
    const body = raw.trim().replace(/\s+/g, " ").replace(/^[*+](\s)/, "-$1")
    out.push(LIST_ITEM_RE.test(body) ? `${"\t".repeat(depth)}${body}` : body)
  }
  return out.join("\n")
}

function isObject(v: Json): v is { [key: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Same document, with every agent's `instructions` and page `content` normalized. */
function withNormalizedMarkdown(intents: readonly Json[]): Json[] {
  return intents.map((intent) => {
    if (!isObject(intent)) return intent
    if (intent.type === "custom_agent" && typeof intent.instructions === "string") {
      return { ...intent, instructions: normalizeMarkdown(intent.instructions) }
    }
    if (intent.type === "page" && typeof intent.content === "string") {
      return { ...intent, content: normalizeMarkdown(intent.content) }
    }
    return intent
  })
}

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    build: 0,
    agent: 0,
    icon: 0,
    model: 0,
    instructions: 0,
    shared_resources: 0,
    canonical: 0,
  }

  const build = await buildNacProject(workspaceDir)
  if (!build.ok || !build.intents) {
    diagnostics.push(build.error ?? "build failed")
    return { score: 0, subscores, diagnostics }
  }
  subscores.build = 1
  const intents = build.intents
  diagnostics.push(`build ok — ${intents.length} intents compiled`)

  // ---- diagnostic checks on the agent --------------------------------------
  const agents = intentsOfType(intents, "custom_agent")
  const agent = agents.find((a) => a.name === "Feedback Triage") ?? agents[0]
  if (agents.length === 1 && agent?.name === "Feedback Triage") subscores.agent = 1
  else {
    diagnostics.push(
      `expected exactly one custom agent named "Feedback Triage"; got ${
        agents.map((a) => String(a.name)).join(", ") || "none"
      }`,
    )
  }

  const icon = isObject(agent?.icon as Json) ? (agent?.icon as { [key: string]: Json }) : undefined
  if (icon?.type === "emoji" && icon.emoji === "🛟") subscores.icon = 1
  else diagnostics.push(`agent icon mismatch — expected the 🛟 emoji; got ${JSON.stringify(agent?.icon ?? null)}`)

  if (agent?.model === WANTED_MODEL) subscores.model = 1
  else {
    diagnostics.push(
      `agent model mismatch — expected the slug for Sonnet 4.6 (Low), "${WANTED_MODEL}"; got ${
        agent?.model === undefined ? "no model (the agent would inherit the workspace default)" : `"${String(agent.model)}"`
      }`,
    )
  }

  const instructions = typeof agent?.instructions === "string" ? normalizeMarkdown(agent.instructions) : ""
  if (instructions.split("\n").length >= 5 && instructions.includes("**Account**")) subscores.instructions = 1
  else diagnostics.push(`agent instructions look wrong or missing (${instructions.length} normalized characters)`)

  // The agent must be able to reach the database — and only the database.
  const databases = intentsOfType(intents, "database")
  const feedbackDb = databases.find((d) => d.name === "Customer Feedback") ?? databases[0]
  const shared = Array.isArray(agent?.sharedResources) ? (agent.sharedResources as Json[]) : []
  if (shared.length === 1 && shared[0] === feedbackDb?.resourceId) subscores.shared_resources = 1
  else {
    diagnostics.push(
      `sharedResources mismatch — expected exactly the Customer Feedback database (${String(
        feedbackDb?.resourceId ?? "no database found",
      )}); got ${shared.length === 0 ? "nothing shared with the agent" : JSON.stringify(shared)}`,
    )
  }

  // ---- the score: canonical comparison -------------------------------------
  const taskDir = (ctx?.taskDir as string | undefined) ?? import.meta.dirname
  const expectedIntents = await readJson<Json[]>(path.join(taskDir, "expected", "intents.json"))
  const diff = diffIntents(withNormalizedMarkdown(expectedIntents), withNormalizedMarkdown(intents))

  for (const group of diff.actual.ambiguities) {
    diagnostics.push(
      `note: structurally indistinguishable resources collapsed onto one label: ${group.join(", ")}`,
    )
  }

  if (diff.equal) {
    subscores.canonical = 1
    diagnostics.push("canonical intents match the oracle (up to resourceId renaming and Markdown whitespace)")
    return { score: 1, subscores, diagnostics }
  }

  diagnostics.push(`canonical intents differ from the oracle (${diff.differences.length} difference(s)):`)
  for (const d of diff.differences.slice(0, MAX_REPORTED_DIFFS)) {
    diagnostics.push(`  [${d.kind}] ${d.path}: ${d.message}`)
  }
  if (diff.differences.length > MAX_REPORTED_DIFFS) {
    diagnostics.push(`  … and ${diff.differences.length - MAX_REPORTED_DIFFS} more`)
  }
  return { score: 0, subscores, diagnostics }
}
