/**
 * resolve-nac-001-idempotent-extend — intents diff with PINNED resourceIds.
 *
 * Unlike build-nac-001, resourceIds here are *not* free to rename: they are the
 * mapping between this project and the Notion objects a previous `apply`
 * already created. Renaming one makes the next apply create a duplicate instead
 * of updating in place — the failure this task exists to catch.
 *
 * So the check is a literal diff against `baseline/intents.json` (the compiled
 * fixture, before the agent touched it):
 *
 *   - every baseline resourceId still exists, spelled identically;
 *   - each of those resources is otherwise unchanged — same fields, same
 *     values, same containing resource — with additions allowed only in the
 *     containers where the task asked for them;
 *   - the requested Priority property and the fourth entry exist.
 *
 * `baseline/intents.json` is the build output of `fixture/workspace` as
 * committed; regenerate it with `npm install && npm run build` in a copy of the
 * fixture if the fixture ever changes.
 */
import * as path from "node:path"
import {
  collectResources,
  dataSources,
  pagesUnder,
  propDate,
  propText,
  propertiesOf,
  type Intent,
  type Json,
} from "../_lib/intents.ts"
import { buildNacProject } from "../_lib/nac.ts"
import { readJson } from "../_lib/proc.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const NEW_PROPERTY = {
  name: "Priority",
  type: "select",
  options: [
    { name: "High", color: "red" },
    { name: "Medium", color: "yellow" },
    { name: "Low", color: "green" },
  ],
}

const NEW_PAGE = {
  Name: "Draft launch checklist",
  Status: "Not Started",
  Priority: "High",
  Target: "2026-08-19",
  Notes: "Outline the steps for the v1 launch.",
}

function isPlainObject(v: unknown): v is { [key: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * A resource's own fields, minus the arrays that hold *other* declared
 * resources (`dataSources`, `properties`, `views`) and minus the nested `view`
 * of a view intent. Those nested resources are compared individually, which is
 * what lets a data source gain a property without the data source itself
 * counting as modified.
 */
function ownFields(node: { [key: string]: Json }): { [key: string]: Json } {
  const out: { [key: string]: Json } = {}
  for (const [key, value] of Object.entries(node)) {
    const holdsResources =
      (Array.isArray(value) &&
        value.length > 0 &&
        value.every((v) => isPlainObject(v) && typeof v.resourceId === "string" && v.type !== "resourceId")) ||
      (key === "view" && isPlainObject(value) && typeof value.resourceId === "string")
    if (holdsResources) continue
    out[key] = value
  }
  return out
}

function stable(value: Json): string {
  const walk = (v: Json): Json => {
    if (Array.isArray(v)) return v.map(walk)
    if (isPlainObject(v)) {
      const out: { [key: string]: Json } = {}
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k])
      return out
    }
    return v
  }
  return JSON.stringify(walk(value))
}

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    build: 0,
    ids_pinned: 0,
    originals_unchanged: 0,
    new_property: 0,
    new_page: 0,
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
  const before = collectResources(baseline)
  const after = collectResources(intents)

  // ---- 1. every pinned resourceId survives, spelled identically -------------
  const dropped = [...before.keys()].filter((id) => !after.has(id))
  if (dropped.length === 0) {
    subscores.ids_pinned = 1
    diagnostics.push(`all ${before.size} pinned resourceIds still present`)
  } else {
    const added = [...after.keys()].filter((id) => !before.has(id))
    diagnostics.push(
      `resourceIds from the applied project are missing: ${dropped.join(", ")}\n` +
        `  (a renamed resourceId makes the next \`apply\` duplicate the resource instead of updating it)\n` +
        `  new resourceIds in this build: ${added.join(", ") || "none"}`,
    )
  }

  // ---- 2. those resources are otherwise untouched ---------------------------
  const changes: string[] = []
  for (const [id, base] of before) {
    const now = after.get(id)
    if (!now) continue // already reported above
    if (base.ancestor !== now.ancestor) {
      changes.push(`${id}: moved from ${base.ancestor ?? "(top level)"} to ${now.ancestor ?? "(top level)"}`)
      continue
    }
    const a = stable(ownFields(base.node))
    const b = stable(ownFields(now.node))
    if (a !== b) changes.push(`${id}: definition changed\n    before: ${a}\n    after:  ${b}`)
  }
  if (dropped.length === 0 && changes.length === 0) {
    subscores.originals_unchanged = 1
    diagnostics.push("existing resources unchanged")
  } else for (const c of changes) diagnostics.push(c)

  // ---- 3. the new Priority property ----------------------------------------
  const source =
    dataSources(intents).find((ds) => ds.resourceId === "sample-projects-ds") ??
    dataSources(intents).find((ds) => ds.name === "Sample Projects")
  const props = source ? propertiesOf(source) : []
  const priority = props.find((p) => p.name === NEW_PROPERTY.name)
  const options = Array.isArray(priority?.options) ? (priority.options as Intent[]) : []
  const optionsOk =
    options.length === NEW_PROPERTY.options.length &&
    NEW_PROPERTY.options.every((want) => options.some((o) => o.name === want.name && o.color === want.color))
  if (priority?.type === NEW_PROPERTY.type && optionsOk && !before.has(String(priority.resourceId))) {
    subscores.new_property = 1
    diagnostics.push(`Priority select added as "${String(priority.resourceId)}"`)
  } else if (!priority) {
    diagnostics.push(
      `no "Priority" property on the Sample Projects data source (found: ${
        props.map((p) => String(p.name)).join(", ") || "nothing"
      })`,
    )
  } else if (before.has(String(priority.resourceId))) {
    diagnostics.push(`"Priority" reuses the pinned resourceId "${String(priority.resourceId)}" of another resource`)
  } else {
    diagnostics.push(
      `"Priority" is ${String(priority.type)} with options ${
        options.map((o) => `${String(o.name)}/${String(o.color ?? "no color")}`).join(", ") || "none"
      }; expected select with ${NEW_PROPERTY.options.map((o) => `${o.name}/${o.color}`).join(", ")}`,
    )
  }

  // ---- 4. the new seeded entry ---------------------------------------------
  const pages = source ? pagesUnder(intents, String(source.resourceId)) : []
  const baselinePages = source ? pagesUnder(baseline, String(source.resourceId)) : []
  const fresh = pages.filter((p) => !before.has(String(p.resourceId)))
  const match = fresh.find((p) => {
    const v = (p.properties ?? {}) as Record<string, Json>
    return (
      propText(v.Name) === NEW_PAGE.Name &&
      propText(v.Status) === NEW_PAGE.Status &&
      propText(v.Priority) === NEW_PAGE.Priority &&
      propDate(v.Target)?.start === NEW_PAGE.Target &&
      propText(v.Notes) === NEW_PAGE.Notes
    )
  })
  if (match && fresh.length === 1 && pages.length === baselinePages.length + 1) {
    subscores.new_page = 1
    diagnostics.push(`new entry "${NEW_PAGE.Name}" added as "${String(match.resourceId)}"`)
  } else {
    diagnostics.push(
      `expected exactly one new entry (${NEW_PAGE.Name}) under the Sample Projects data source; got ${
        fresh.length
      } new of ${pages.length} total: ${
        fresh
          .map((p) => {
            const v = (p.properties ?? {}) as Record<string, Json>
            return `${propText(v.Name) ?? "(untitled)"}[Status=${propText(v.Status) ?? "-"} Priority=${
              propText(v.Priority) ?? "-"
            } Target=${propDate(v.Target)?.start ?? "-"}]`
          })
          .join(", ") || "none"
      }`,
    )
  }

  const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
  return { score: score as 0 | 1, subscores, diagnostics }
}
