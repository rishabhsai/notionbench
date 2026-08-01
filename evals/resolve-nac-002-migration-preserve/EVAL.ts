/**
 * resolve-nac-002-migration-preserve — intents diff with PINNED resourceIds.
 *
 * A migration is the case where the *identity* of a resource and its
 * *definition* come apart: `Notes` has to become `Context` while staying the
 * same column, and the `Stage` options have to change while staying the same
 * property. resourceIds are what carry that identity across an `apply`, so they
 * are pinned here rather than free to rename: renaming `content-notes-prop`
 * while renaming the column is the exact failure this task exists to catch —
 * the next apply would archive the applied column and create an empty one
 * beside it.
 *
 * The score is `diffIntents` against the oracle build with every baseline
 * resourceId pinned, so labels are compared literally on both sides:
 *
 *   - a renamed, dropped, or newly-invented resourceId shows up as a
 *     pinned-id difference;
 *   - the migrated select options (order and colors included), the renamed
 *     column, the untouched properties/view/teamspace and the four preserved
 *     entries all have to match the oracle exactly.
 *
 * `baseline/intents.json` is the build output of `fixture/workspace` as
 * committed (the applied state, and the source of the pinned id list);
 * `expected/intents.json` is the build output of `fixture/workspace` +
 * `solution/`. Regenerate both by building those trees and copying
 * `dist/intents.json`.
 */
import * as path from "node:path"
import {
  collectResources,
  dataSources,
  diffIntents,
  pagesUnder,
  propText,
  propertiesOf,
  type IntentRecord,
  type Json,
} from "@notionbench/scoring"
import { buildNacProject } from "../_lib/nac.ts"
import { readJson } from "../_lib/proc.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

/** Cap on the field-level diff appended to the diagnostics. */
const MAX_REPORTED_DIFFS = 12

const NEW_OPTIONS = [
  { name: "Drafting", color: "blue" },
  { name: "Review", color: "yellow" },
  { name: "Scheduled", color: "purple" },
  { name: "Published", color: "green" },
]

/** The property whose display name changes but whose identity must not. */
const RENAMED_PROPERTY = { resourceId: "content-notes-prop", from: "Notes", to: "Context" }

/** Every entry, by resourceId, with the text that has to survive the rename. */
const PRESERVED_ROWS: Array<{ id: string; title: string; stage: string; context: string }> = [
  {
    id: "q3-launch-announcement",
    title: "Q3 launch announcement",
    stage: "Drafting",
    context: "Hold until legal signs off on the pricing claim.",
  },
  {
    id: "customer-story-helio",
    title: "Customer story: Helio Labs",
    stage: "Review",
    context: "Quotes approved; screenshots still need a refresh.",
  },
  {
    id: "changelog-july",
    title: "July changelog",
    stage: "Published",
    context: "Cross-posted to the community forum.",
  },
  {
    id: "webinar-followup",
    title: "Webinar follow-up sequence",
    stage: "Drafting",
    context: "Three emails; the third one is still an outline.",
  },
]

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    build: 0,
    ids_pinned: 0,
    no_new_resources: 0,
    options_migrated: 0,
    property_renamed: 0,
    rows_preserved: 0,
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

  const taskDir = (ctx?.taskDir as string | undefined) ?? import.meta.dirname
  const baseline = await readJson<Json[]>(path.join(taskDir, "baseline", "intents.json"))
  const expectedIntents = await readJson<Json[]>(path.join(taskDir, "expected", "intents.json"))
  const before = collectResources(baseline)
  const after = collectResources(intents)

  // ---- 1. every applied resourceId survives, spelled identically -----------
  const dropped = [...before.keys()].filter((id) => !after.has(id))
  const added = [...after.keys()].filter((id) => !before.has(id))
  if (dropped.length === 0) {
    subscores.ids_pinned = 1
    diagnostics.push(`all ${before.size} applied resourceIds still present`)
  } else {
    diagnostics.push(
      `resourceIds from the applied project are missing: ${dropped.join(", ")}\n` +
        `  (a renamed resourceId makes the next \`apply\` recreate the resource instead of updating it, ` +
        `so whatever was in it is lost)\n` +
        `  new resourceIds in this build: ${added.join(", ") || "none"}`,
    )
  }

  // A rename is not an addition: this migration introduces no new resources.
  if (added.length === 0) subscores.no_new_resources = 1
  else diagnostics.push(`unexpected new resources: ${added.join(", ")} — nothing new was asked for`)

  // ---- 2. the Stage options were migrated ---------------------------------
  const source =
    dataSources(intents).find((ds) => ds.resourceId === "content-calendar-ds") ??
    dataSources(intents).find((ds) => ds.name === "Content Calendar")
  const props = source ? propertiesOf(source) : []
  const stage = props.find((p) => p.resourceId === "content-stage-prop") ?? props.find((p) => p.name === "Stage")
  const options = Array.isArray(stage?.options) ? (stage.options as IntentRecord[]) : []
  const optionsOk =
    options.length === NEW_OPTIONS.length &&
    NEW_OPTIONS.every((want, i) => options[i]?.name === want.name && options[i]?.color === want.color)
  if (optionsOk && stage?.resourceId === "content-stage-prop") subscores.options_migrated = 1
  else {
    diagnostics.push(
      `Stage options mismatch — expected ${NEW_OPTIONS.map((o) => `${o.name}/${o.color}`).join(", ")} in that ` +
        `order on "content-stage-prop"; got ${
          options.map((o) => `${String(o.name)}/${String(o.color ?? "no color")}`).join(", ") || "none"
        } on "${String(stage?.resourceId ?? "no Stage property")}"`,
    )
  }

  // ---- 3. Notes was renamed in place --------------------------------------
  const renamed = props.find((p) => p.resourceId === RENAMED_PROPERTY.resourceId)
  const strays = props.filter((p) => p.name === RENAMED_PROPERTY.to && p.resourceId !== RENAMED_PROPERTY.resourceId)
  if (renamed?.name === RENAMED_PROPERTY.to && renamed.type === "text" && strays.length === 0) {
    subscores.property_renamed = 1
    diagnostics.push(`"${RENAMED_PROPERTY.from}" renamed to "${RENAMED_PROPERTY.to}" in place`)
  } else if (!renamed) {
    diagnostics.push(
      `the applied column "${RENAMED_PROPERTY.resourceId}" is gone; the data source now has ${
        props.map((p) => `${String(p.name)}(${String(p.resourceId)})`).join(", ") || "nothing"
      }`,
    )
  } else if (strays.length > 0) {
    diagnostics.push(
      `"${RENAMED_PROPERTY.to}" was added as a new property (${strays
        .map((p) => String(p.resourceId))
        .join(", ")}) instead of renaming the applied one`,
    )
  } else {
    diagnostics.push(
      `"${RENAMED_PROPERTY.resourceId}" is named "${String(renamed.name)}" of type "${String(renamed.type)}"; ` +
        `expected "${RENAMED_PROPERTY.to}" of type "text"`,
    )
  }

  // ---- 4. the four entries and their text survived -------------------------
  const pages = source ? pagesUnder(intents, String(source.resourceId)) : []
  const missingRows: string[] = []
  for (const want of PRESERVED_ROWS) {
    const page = pages.find((p) => p.resourceId === want.id)
    if (!page) {
      missingRows.push(`${want.id}: gone`)
      continue
    }
    const v = (page.properties ?? {}) as Record<string, Json>
    const problems: string[] = []
    if (propText(v.Title) !== want.title) problems.push(`Title=${String(propText(v.Title))}`)
    if (propText(v.Stage) !== want.stage) problems.push(`Stage=${String(propText(v.Stage))}`)
    if (propText(v[RENAMED_PROPERTY.to]) !== want.context) {
      problems.push(`${RENAMED_PROPERTY.to}=${String(propText(v[RENAMED_PROPERTY.to]))}`)
    }
    if (problems.length > 0) missingRows.push(`${want.id}: ${problems.join(" ")}`)
  }
  if (missingRows.length === 0 && pages.length === PRESERVED_ROWS.length) {
    subscores.rows_preserved = 1
    diagnostics.push(`all ${PRESERVED_ROWS.length} entries preserved, with their text under "${RENAMED_PROPERTY.to}"`)
  } else {
    diagnostics.push(
      `entry preservation mismatch (${pages.length} entries in the build, expected ${PRESERVED_ROWS.length})` +
        (missingRows.length > 0 ? `\n  ${missingRows.join("\n  ")}` : ""),
    )
  }

  // ---- the score: canonical comparison with every applied id pinned --------
  const diff = diffIntents(expectedIntents, intents, {
    pinnedResourceIds: [...before.keys()],
    maxDifferences: MAX_REPORTED_DIFFS,
  })
  if (diff.equal) {
    subscores.canonical = 1
    diagnostics.push("migrated intents match the oracle, with every applied resourceId intact")
    return { score: 1, subscores, diagnostics }
  }

  diagnostics.push(`migrated intents differ from the oracle (${diff.differences.length} difference(s)):`)
  for (const d of diff.differences) diagnostics.push(`  [${d.kind}] ${d.path}: ${d.message}`)
  return { score: 0, subscores, diagnostics }
}
