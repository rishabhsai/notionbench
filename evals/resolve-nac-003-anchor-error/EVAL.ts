/**
 * resolve-nac-003-anchor-error — the build has to succeed, on the right anchor.
 *
 * The fixture does not compile: it describes two workspace anchors (the
 * existing workspace the applied half is parented to, and a new space created
 * for the Vendors half), and a project is applied against exactly one. There is
 * therefore no `baseline/intents.json` for this task — the starting state has
 * no build output.
 *
 * Getting the build green is necessary but nowhere near sufficient, because
 * there are two ways to end up with one anchor and only one of them is a fix:
 *
 *   - drop the new space and hang Vendors off the existing anchor — everything
 *     already applied keeps resolving to the Notion objects it is mapped to;
 *   - keep the new space and move the applied half under it — also compiles,
 *     also one anchor, and on the next `apply` recreates the entire Operations
 *     section inside a brand-new workspace.
 *
 * So the checks are: the build succeeds; the document declares no `space` and
 * exactly one external anchor, the same one the applied resources were already
 * parented to; and the whole document matches the oracle with **every**
 * resourceId pinned, which catches a resource that was renamed, dropped,
 * reparented or edited while "fixing" the build.
 *
 * `expected/intents.json` is the oracle build output, committed alongside the
 * task; regenerate it by building `fixture/workspace` + `solution/` and copying
 * `dist/intents.json`.
 */
import * as path from "node:path"
import { collectResources, diffIntents, intentsOfType, type Json } from "@notionbench/scoring"
import { buildNacProject } from "../_lib/nac.ts"
import { readJson } from "../_lib/proc.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

/** Cap on the field-level diff appended to the diagnostics. */
const MAX_REPORTED_DIFFS = 12

/** The anchor the applied resources are already mapped onto. */
const APPLIED_ANCHOR = "workspace-root"

/** resourceIds that were live in Notion before the Vendors section was added. */
const APPLIED_RESOURCES = [
  "ops-teamspace",
  "ops-handbook-page",
  "runbooks-db",
  "runbooks-ds",
  "runbook-name-prop",
  "runbook-system-prop",
  "runbook-owner-prop",
  "runbook-reviewed-prop",
  "runbooks-table-view",
  "billing-retry-runbook",
  "search-reindex-runbook",
]

function isObject(v: Json): v is { [key: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * Parent references that point outside the document — the anchors `apply` has
 * to resolve against objects that already exist in Notion.
 */
function externalAnchors(intents: readonly Json[]): string[] {
  const declared = new Set(collectResources(intents).keys())
  const anchors = new Set<string>()
  const walk = (value: Json): void => {
    if (Array.isArray(value)) {
      for (const v of value) walk(v)
      return
    }
    if (!isObject(value)) return
    const parent = value.parent
    if (isObject(parent) && typeof parent.resourceId === "string" && !declared.has(parent.resourceId)) {
      anchors.add(parent.resourceId)
    }
    for (const v of Object.values(value)) walk(v)
  }
  for (const intent of intents) walk(intent)
  return [...anchors]
}

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    build: 0,
    single_anchor: 0,
    applied_anchor: 0,
    applied_resources: 0,
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

  // ---- 1. exactly one anchor ----------------------------------------------
  const spaces = intentsOfType(intents, "space")
  const external = externalAnchors(intents)
  const anchors = [
    ...spaces.map((s) => `new space "${String(s.resourceId)}"`),
    ...external.map((id) => `existing workspace "${id}"`),
  ]
  if (anchors.length === 1) {
    subscores.single_anchor = 1
    diagnostics.push(`one workspace anchor: ${anchors[0]}`)
  } else {
    diagnostics.push(`expected exactly one workspace anchor; got ${anchors.length}: ${anchors.join(", ") || "none"}`)
  }

  // ---- 2. and it is the one the applied resources are mapped onto ----------
  if (spaces.length === 0 && external.length === 1 && external[0] === APPLIED_ANCHOR) {
    subscores.applied_anchor = 1
  } else {
    diagnostics.push(
      `the project no longer attaches to "${APPLIED_ANCHOR}" — it declares ${spaces.length} new space(s) (${
        spaces.map((s) => String(s.resourceId)).join(", ") || "none"
      }) and references ${external.length} existing anchor(s) (${external.join(", ") || "none"}). ` +
        `Anything that was applied against "${APPLIED_ANCHOR}" would be recreated rather than updated.`,
    )
  }

  // ---- 3. nothing already applied was renamed, dropped, or moved -----------
  const after = collectResources(intents)
  const missing = APPLIED_RESOURCES.filter((id) => !after.has(id))
  const moved = APPLIED_RESOURCES.filter((id) => {
    const node = after.get(id)?.node
    if (id !== "ops-teamspace" || node === undefined) return false
    const parent = node.parent as Json | undefined
    return !isObject(parent) || parent.resourceId !== APPLIED_ANCHOR
  })
  if (missing.length === 0 && moved.length === 0) {
    subscores.applied_resources = 1
    diagnostics.push(`all ${APPLIED_RESOURCES.length} applied resourceIds still present and parented as before`)
  } else {
    if (missing.length > 0) diagnostics.push(`applied resourceIds are missing: ${missing.join(", ")}`)
    if (moved.length > 0) diagnostics.push(`applied resources were reparented: ${moved.join(", ")}`)
  }

  // ---- the score: canonical comparison with every resourceId pinned --------
  const taskDir = (ctx?.taskDir as string | undefined) ?? import.meta.dirname
  const expectedIntents = await readJson<Json[]>(path.join(taskDir, "expected", "intents.json"))
  const diff = diffIntents(expectedIntents, intents, {
    pinnedResourceIds: [...collectResources(expectedIntents).keys()],
    maxDifferences: MAX_REPORTED_DIFFS,
  })
  if (diff.equal) {
    subscores.canonical = 1
    diagnostics.push("the repaired project matches the oracle, with every resourceId intact")
    return { score: 1, subscores, diagnostics }
  }

  diagnostics.push(`the repaired project differs from the oracle (${diff.differences.length} difference(s)):`)
  for (const d of diff.differences) diagnostics.push(`  [${d.kind}] ${d.path}: ${d.message}`)
  return { score: 0, subscores, diagnostics }
}
