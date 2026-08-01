/**
 * build-nac-003-relations-rollup — canonical intents comparison.
 *
 * The score is `@notionbench/scoring`'s `diffIntents` against the oracle build,
 * i.e. the two intent graphs must be isomorphic up to resourceId renaming. That
 * is exactly the right check for a relation/rollup task: the agent may name its
 * resources anything, but the *cross-references* — which data source each
 * relation targets, which property on the far side it pairs with, which
 * relation each rollup reads through, and which target property it aggregates —
 * have to resolve to structurally equivalent resources. A one-way relation, a
 * rollup hung off the wrong relation, or a `Client` value pointing at the wrong
 * page all show up as a difference here.
 *
 * The subscores are diagnostic only; they exist so a failing run says "the
 * relation is one-way" instead of "documents differ".
 *
 * `expected/intents.json` is the oracle build output, committed alongside the
 * task; regenerate it by building `fixture/workspace` + `solution/` and copying
 * `dist/intents.json`. QC's `solution` check fails loudly if the two drift.
 */
import * as path from "node:path"
import {
  dataSources,
  diffIntents,
  intentsOfType,
  pagesUnder,
  propDate,
  propText,
  propertiesOf,
  type IntentRecord,
  type Json,
} from "@notionbench/scoring"
import { buildNacProject } from "../_lib/nac.ts"
import { readJson } from "../_lib/proc.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

/** Keep the diagnostic block readable when a solution is wrong in many places. */
const MAX_REPORTED_DIFFS = 8

const CLIENTS = [
  { name: "Northwind Traders", lead: "Priya Raman" },
  { name: "Cascade Foods", lead: "Miguel Ortiz" },
]

const ENGAGEMENTS = [
  { name: "Discovery workshop", client: "Northwind Traders", hours: "40", due: "2026-08-07" },
  { name: "Data migration", client: "Northwind Traders", hours: "120", due: "2026-09-18" },
  { name: "Supply chain audit", client: "Cascade Foods", hours: "65", due: "2026-08-28" },
]

function relationTargets(value: Json | undefined): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[]
  return []
}

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    build: 0,
    teamspace: 0,
    schema: 0,
    two_way_relation: 0,
    rollups: 0,
    seeded_links: 0,
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

  // ---- diagnostic structure checks -----------------------------------------
  const teamspaces = intentsOfType(intents, "teamspace")
  if (teamspaces.some((t) => t.name === "Consulting")) subscores.teamspace = 1
  else {
    diagnostics.push(
      `no teamspace named "Consulting" (found: ${teamspaces.map((t) => String(t.name)).join(", ") || "none"})`,
    )
  }

  const sources = dataSources(intents)
  const clientsDs = sources.find((ds) => ds.name === "Clients")
  const engagementsDs = sources.find((ds) => ds.name === "Engagements")
  const clientProps = clientsDs ? propertiesOf(clientsDs) : []
  const engagementProps = engagementsDs ? propertiesOf(engagementsDs) : []
  const clientByName = new Map(clientProps.map((p) => [String(p.name), p]))
  const engagementByName = new Map(engagementProps.map((p) => [String(p.name), p]))

  const wantedClient: Array<[string, string]> = [
    ["Name", "title"],
    ["Account Lead", "text"],
    ["Engagements", "relation"],
    ["Billable Hours", "rollup"],
    ["Next Milestone", "rollup"],
  ]
  const wantedEngagement: Array<[string, string]> = [
    ["Name", "title"],
    ["Client", "relation"],
    ["Hours", "number"],
    ["Due", "date"],
  ]
  const schemaOk =
    clientProps.length === wantedClient.length &&
    engagementProps.length === wantedEngagement.length &&
    wantedClient.every(([n, t]) => clientByName.get(n)?.type === t) &&
    wantedEngagement.every(([n, t]) => engagementByName.get(n)?.type === t)
  if (schemaOk) subscores.schema = 1
  else {
    diagnostics.push(
      `schema mismatch — Clients: ${
        clientProps.map((p) => `${String(p.name)}:${String(p.type)}`).join(", ") || "nothing"
      }; Engagements: ${
        engagementProps.map((p) => `${String(p.name)}:${String(p.type)}`).join(", ") || "nothing"
      }`,
    )
  }

  const engagementsRel = clientByName.get("Engagements")
  const clientRel = engagementByName.get("Client")
  const twoWay =
    engagementsRel !== undefined &&
    clientRel !== undefined &&
    engagementsDs !== undefined &&
    clientsDs !== undefined &&
    engagementsRel?.targetDataSourceResourceId === engagementsDs?.resourceId &&
    clientRel?.targetDataSourceResourceId === clientsDs?.resourceId &&
    engagementsRel?.targetDataSourcePropertyResourceId === clientRel?.resourceId &&
    clientRel?.targetDataSourcePropertyResourceId === engagementsRel?.resourceId
  if (twoWay) subscores.two_way_relation = 1
  else {
    diagnostics.push(
      `the relation is not two-way — Clients.Engagements targets ${
        String(engagementsRel?.targetDataSourceResourceId ?? "nothing")
      } paired with ${String(engagementsRel?.targetDataSourcePropertyResourceId ?? "(no far side)")}; ` +
        `Engagements.Client targets ${String(clientRel?.targetDataSourceResourceId ?? "nothing")} paired with ${
          String(clientRel?.targetDataSourcePropertyResourceId ?? "(no far side)")
        }. Each side must name the property on the other side.`,
    )
  }

  const hoursRollup = clientByName.get("Billable Hours")
  const milestoneRollup = clientByName.get("Next Milestone")
  const rollupsOk =
    hoursRollup?.relationPropertyResourceId === engagementsRel?.resourceId &&
    hoursRollup?.targetPropertyResourceId === engagementByName.get("Hours")?.resourceId &&
    hoursRollup?.targetPropertyType === "number" &&
    hoursRollup?.aggregation === "sum" &&
    milestoneRollup?.relationPropertyResourceId === engagementsRel?.resourceId &&
    milestoneRollup?.targetPropertyResourceId === engagementByName.get("Due")?.resourceId &&
    milestoneRollup?.targetPropertyType === "date" &&
    milestoneRollup?.aggregation === "earliest_date"
  if (rollupsOk) subscores.rollups = 1
  else {
    const describe = (r: IntentRecord | undefined): string =>
      r
        ? `via ${String(r.relationPropertyResourceId)} → ${String(r.targetPropertyResourceId)} (${String(
            r.targetPropertyType,
          )}, ${String(r.aggregation ?? "no aggregation")})`
        : "missing"
    diagnostics.push(
      `rollup mismatch — Billable Hours ${describe(hoursRollup)}; Next Milestone ${describe(milestoneRollup)}. ` +
        `Both must read through Clients.Engagements and aggregate Hours (sum) / Due (earliest_date).`,
    )
  }

  // ---- seeded rows and the links between them ------------------------------
  const clientPages = clientsDs ? pagesUnder(intents, String(clientsDs.resourceId)) : []
  const engagementPages = engagementsDs ? pagesUnder(intents, String(engagementsDs.resourceId)) : []
  const clientIdByName = new Map(
    clientPages.map((p) => [propText((p.properties as Record<string, Json>)?.Name) ?? "", String(p.resourceId)]),
  )
  const clientsSeeded = CLIENTS.every((want) =>
    clientPages.some((p) => {
      const v = (p.properties ?? {}) as Record<string, Json>
      return propText(v.Name) === want.name && propText(v["Account Lead"]) === want.lead
    }),
  )
  const engagementsSeeded = ENGAGEMENTS.every((want) =>
    engagementPages.some((p) => {
      const v = (p.properties ?? {}) as Record<string, Json>
      const links = relationTargets(v.Client)
      return (
        propText(v.Name) === want.name &&
        propText(v.Hours) === want.hours &&
        propDate(v.Due)?.start === want.due &&
        links.length === 1 &&
        links[0] === clientIdByName.get(want.client)
      )
    }),
  )
  if (
    clientsSeeded &&
    engagementsSeeded &&
    clientPages.length === CLIENTS.length &&
    engagementPages.length === ENGAGEMENTS.length
  ) {
    subscores.seeded_links = 1
  } else {
    diagnostics.push(
      `seeded rows mismatch — expected ${CLIENTS.length} clients and ${ENGAGEMENTS.length} engagements each ` +
        `linked to its client; got ${clientPages.length} client row(s) (${
          clientPages.map((p) => propText((p.properties as Record<string, Json>)?.Name) ?? "(untitled)").join(", ") ||
          "none"
        }) and ${engagementPages.length} engagement row(s) (${
          engagementPages
            .map((p) => {
              const v = (p.properties as Record<string, Json>) ?? {}
              return `${propText(v.Name) ?? "(untitled)"}→${relationTargets(v.Client).join("+") || "(unlinked)"}`
            })
            .join(", ") || "none"
        })`,
    )
  }

  // ---- the score: canonical comparison -------------------------------------
  const taskDir = (ctx?.taskDir as string | undefined) ?? import.meta.dirname
  const expectedIntents = await readJson<Json[]>(path.join(taskDir, "expected", "intents.json"))
  const diff = diffIntents(expectedIntents, intents)

  for (const group of diff.actual.ambiguities) {
    diagnostics.push(
      `note: structurally indistinguishable resources collapsed onto one label: ${group.join(", ")}`,
    )
  }

  if (diff.equal) {
    subscores.canonical = 1
    diagnostics.push("canonical intents match the oracle (up to resourceId renaming)")
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
