/**
 * build-nac-004-board-view-filters — canonical intents comparison.
 *
 * The score is `@notionbench/scoring`'s `diffIntents` against the oracle build:
 * isomorphic up to resourceId renaming, so the agent's naming is free but the
 * view configuration is not. That matters here because almost everything in a
 * view is a *reference* to a property resourceId — `groupBy.property`, each
 * board column's `property`, each filter's `propertyId`, each card field's
 * `property`, the sort's `propertyId` — and the canonicalizer resolves those
 * references structurally. Pointing a filter at the wrong property is therefore
 * caught even though the JSON is well-formed.
 *
 * Order is preserved where Notion treats it as semantic: board `columns`, view
 * `properties` (card field order), `sorts` (precedence) and select `options`.
 * `filters` are a flat AND list and are compared order-insensitively.
 *
 * The subscores are diagnostic only.
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
  propertiesOf,
  views,
  type IntentRecord,
  type Json,
} from "@notionbench/scoring"
import { buildNacProject } from "../_lib/nac.ts"
import { readJson } from "../_lib/proc.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

/** Keep the diagnostic block readable when a solution is wrong in many places. */
const MAX_REPORTED_DIFFS = 8

const WANTED_PROPS: Array<[string, string]> = [
  ["Name", "title"],
  ["Priority", "select"],
  ["Team", "select"],
  ["Escalated", "checkbox"],
  ["Opened", "date"],
]

/** Board columns, in order, as `[option value, hidden]`. */
const WANTED_COLUMNS: Array<[string, boolean]> = [
  ["Urgent", false],
  ["Normal", false],
  ["Low", true],
]

function asRecords(value: Json | undefined): IntentRecord[] {
  return Array.isArray(value)
    ? value.filter((v): v is IntentRecord => typeof v === "object" && v !== null && !Array.isArray(v))
    : []
}

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    build: 0,
    schema: 0,
    board_group_by: 0,
    board_columns: 0,
    board_filters: 0,
    card_properties: 0,
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
  if (!teamspaces.some((t) => t.name === "Support")) {
    diagnostics.push(
      `no teamspace named "Support" (found: ${teamspaces.map((t) => String(t.name)).join(", ") || "none"})`,
    )
  }

  const sources = dataSources(intents)
  const source = sources.find((ds) => ds.name === "Support Queue") ?? sources[0]
  const props = source ? propertiesOf(source) : []
  const byName = new Map(props.map((p) => [String(p.name), p]))
  const idOf = (name: string): string | undefined => {
    const id = byName.get(name)?.resourceId
    return typeof id === "string" ? id : undefined
  }
  if (props.length === WANTED_PROPS.length && WANTED_PROPS.every(([n, t]) => byName.get(n)?.type === t)) {
    subscores.schema = 1
  } else {
    diagnostics.push(
      `data source schema mismatch — expected ${WANTED_PROPS.map(([n, t]) => `${n}:${t}`).join(", ")}; got ${
        props.map((p) => `${String(p.name)}:${String(p.type)}`).join(", ") || "nothing"
      }`,
    )
  }

  const allViews = views(intents)
  const board = allViews.find((v) => v.type === "board")
  const table = allViews.find((v) => v.type === "table")
  if (allViews.length !== 2 || table?.name !== "All Tickets" || board?.name !== "Platform Escalations") {
    diagnostics.push(
      `view set mismatch — expected a table "All Tickets" and a board "Platform Escalations"; got ${
        allViews.map((v) => `${String(v.name ?? "(unnamed)")}:${String(v.type)}`).join(", ") || "no views"
      }`,
    )
  }

  const groupBy =
    board && typeof board.groupBy === "object" && board.groupBy !== null
      ? (board.groupBy as IntentRecord)
      : undefined
  if (groupBy?.property === idOf("Priority") && groupBy?.emptyGroupVisibility === "hide") {
    subscores.board_group_by = 1
  } else {
    diagnostics.push(
      `board grouping mismatch — expected groupBy Priority with empty groups hidden; got property ${
        String(groupBy?.property ?? "none")
      } (Priority is ${String(idOf("Priority"))}), emptyGroupVisibility ${
        String(groupBy?.emptyGroupVisibility ?? "unset")
      }`,
    )
  }

  const columns = asRecords(board?.columns)
  const columnsOk =
    columns.length === WANTED_COLUMNS.length &&
    WANTED_COLUMNS.every(([value, hidden], i) => {
      const col = columns[i]
      const colValue =
        typeof col?.value === "object" && col.value !== null ? (col.value as IntentRecord).value : undefined
      return col?.property === idOf("Priority") && colValue === value && Boolean(col?.hidden) === hidden
    })
  if (columnsOk) subscores.board_columns = 1
  else {
    diagnostics.push(
      `board column mismatch — expected ${WANTED_COLUMNS.map(([v, h]) => `${v}${h ? " (hidden)" : ""}`).join(
        ", ",
      )} in that order on Priority; got ${
        columns
          .map((c) => {
            const v = typeof c.value === "object" && c.value !== null ? (c.value as IntentRecord).value : undefined
            return `${String(v ?? "?")}${c.hidden ? " (hidden)" : ""}`
          })
          .join(", ") || "no columns"
      }`,
    )
  }

  const filters = asRecords(board?.filters)
  const wantedFilters = [
    { propertyId: idOf("Escalated"), propertyType: "checkbox", operator: "checkbox_is", value: true },
    { propertyId: idOf("Team"), propertyType: "select", operator: "enum_is", value: "Platform" },
    { propertyId: idOf("Opened"), propertyType: "date", operator: "date_is_on_or_after", value: "2026-07-01" },
  ]
  const filtersOk =
    filters.length === wantedFilters.length &&
    wantedFilters.every((want) =>
      filters.some(
        (f) =>
          f.propertyId === want.propertyId &&
          f.propertyType === want.propertyType &&
          f.operator === want.operator &&
          f.value === want.value,
      ),
    )
  if (filtersOk) subscores.board_filters = 1
  else {
    diagnostics.push(
      `board filter mismatch — expected Escalated is true AND Team is Platform AND Opened on or after ` +
        `2026-07-01; got ${
          filters
            .map((f) => {
              const name =
                props.find((p) => p.resourceId === f.propertyId)?.name ?? String(f.propertyId ?? "(no property)")
              return `${String(name)} ${String(f.operator)} ${JSON.stringify(f.value)}`
            })
            .join(" AND ") || "no filters"
        }`,
    )
  }

  const cardProps = asRecords(board?.properties)
  const wantedCards: Array<[string, boolean]> = [
    ["Team", true],
    ["Opened", true],
    ["Escalated", false],
  ]
  const cardsOk =
    cardProps.length === wantedCards.length &&
    wantedCards.every(([name, visible], i) => {
      const entry = cardProps[i]
      return entry?.property === idOf(name) && entry?.visible === visible
    })
  const sorts = asRecords(board?.sorts)
  const sortOk =
    sorts.length === 1 && sorts[0]?.propertyId === idOf("Opened") && sorts[0]?.direction === "ascending"
  if (cardsOk && sortOk) subscores.card_properties = 1
  else {
    diagnostics.push(
      `card configuration mismatch — expected visible Team, visible Opened, hidden Escalated (in that order) ` +
        `and a single ascending sort on Opened; got card fields ${
          cardProps
            .map((c) => {
              const name = props.find((p) => p.resourceId === c.property)?.name ?? String(c.property)
              return `${String(name)}:${c.visible === false ? "hidden" : "visible"}`
            })
            .join(", ") || "none"
        } and sorts ${
          sorts
            .map((s) => {
              const name = props.find((p) => p.resourceId === s.propertyId)?.name ?? String(s.propertyId)
              return `${String(name)} ${String(s.direction)}`
            })
            .join(", ") || "none"
        }`,
    )
  }

  const pages = source ? pagesUnder(intents, String(source.resourceId)) : []
  if (pages.length !== 3) diagnostics.push(`expected 3 seeded tickets, got ${pages.length}`)

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
