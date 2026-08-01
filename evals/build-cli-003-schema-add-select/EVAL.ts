/**
 * build-cli-003-schema-add-select — live state verification of a schema edit.
 *
 * Four things are asserted, and all four have to hold:
 *   1. `Channel` exists on the **data source** (not the database — post-2025-09-03
 *      a database has no properties at all) and is a `select`, not a `multi_select`;
 *   2. its options are exactly Blog/blue, Newsletter/yellow, Social/pink, Docs/gray,
 *      in that order — colours included, which is where a `ntn`-driven schema edit
 *      most often drifts, since Notion assigns a colour when you omit one;
 *   3. the three named rows carry the right values and every other row is blank;
 *   4. the pre-existing schema is untouched: same properties, same types, same
 *      `Status` options, same row count.
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
 * this verifier returns 1 for a correct end state and 0 for a wrong one.
 *
 * The verifier is the same code on both paths — it honors `NOTION_API_BASE` and
 * reads the workspace through the public API either way.
 */
import { readProperties } from "../_lib/live/notion.ts"
import { findDatabase, resolveLiveContext } from "../_lib/live/context.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const DATABASE_TITLE = "Content Calendar"
const PROPERTY = "Channel"

const EXPECTED_OPTIONS = [
  { name: "Blog", color: "blue" },
  { name: "Newsletter", color: "yellow" },
  { name: "Social", color: "pink" },
  { name: "Docs", color: "gray" },
]

const EXPECTED_ASSIGNMENTS: Record<string, string> = {
  "Post 01": "Blog",
  "Post 05": "Social",
  "Post 12": "Docs",
}

/** The fixture's schema, which must survive the edit unchanged. */
const PRESERVED: Array<[string, string]> = [
  ["Name", "title"],
  ["Owner", "rich_text"],
  ["Publish Date", "date"],
  ["Status", "select"],
]

const STATUS_OPTIONS = [
  { name: "Draft", color: "gray" },
  { name: "Scheduled", color: "blue" },
  { name: "Published", color: "green" },
]

const ROW_COUNT = 12

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    property_added: 0,
    option_names: 0,
    option_colors: 0,
    assignments: 0,
    schema_preserved: 0,
  }

  const live = await resolveLiveContext({ workspaceDir, ctx })
  const { client, rootId } = live
  diagnostics.push(`api=${live.apiBase} root=${rootId} (${live.source.root})`)

  const dataSourceId =
    live.idMap["calendar.ds"] ?? (await findDatabase(client, rootId, DATABASE_TITLE))?.dataSourceId
  if (!dataSourceId) {
    diagnostics.push(`the fixture's "${DATABASE_TITLE}" database could not be located — fixture is damaged`)
    return { score: 0, subscores, diagnostics }
  }

  const dataSource = await client.getDataSource(dataSourceId)
  const properties = dataSource.properties ?? {}
  const names = Object.keys(properties)
  diagnostics.push(`data source ${dataSourceId} properties: ${names.join(", ")}`)

  // ---- 1. the property exists and is a select ------------------------------
  const channel = properties[PROPERTY]
  if (!channel) {
    diagnostics.push(`no property named "${PROPERTY}" on the data source`)
    return { score: 0, subscores, diagnostics }
  }
  if (channel.type !== "select") {
    diagnostics.push(`"${PROPERTY}" is a ${channel.type}; the calendar needs a single-select`)
    return { score: 0, subscores, diagnostics }
  }
  subscores.property_added = 1

  // ---- 2. options, names then colours --------------------------------------
  const options = ((channel.select as { options?: Array<{ name?: string; color?: string }> })?.options ??
    []) as Array<{ name?: string; color?: string }>
  const actualNames = options.map((o) => o.name ?? "")
  const wantNames = EXPECTED_OPTIONS.map((o) => o.name)
  if (actualNames.length === wantNames.length && wantNames.every((n, i) => actualNames[i] === n)) {
    subscores.option_names = 1
  } else {
    diagnostics.push(`option names/order mismatch — expected [${wantNames.join(", ")}], got [${actualNames.join(", ")}]`)
  }

  const colorProblems = EXPECTED_OPTIONS.flatMap((want) => {
    const got = options.find((o) => o.name === want.name)
    if (!got) return []
    return got.color === want.color ? [] : [`${want.name}: expected ${want.color}, got ${got.color ?? "(none)"}`]
  })
  if (subscores.option_names === 1 && colorProblems.length === 0) {
    subscores.option_colors = 1
    diagnostics.push(`options are ${EXPECTED_OPTIONS.map((o) => `${o.name}/${o.color}`).join(", ")}`)
  } else if (colorProblems.length > 0) {
    diagnostics.push(`option colour mismatch — ${colorProblems.join("; ")}`)
  }

  // ---- 3. the three assignments, and nothing else --------------------------
  const rows = await client.queryAllRows(dataSourceId)
  const byName = new Map(rows.map((row) => [String(readProperties(row).Name ?? ""), readProperties(row)]))

  const assignmentProblems: string[] = []
  for (const [rowName, wanted] of Object.entries(EXPECTED_ASSIGNMENTS)) {
    const row = byName.get(rowName)
    if (!row) {
      assignmentProblems.push(`row "${rowName}" is missing`)
      continue
    }
    if (row[PROPERTY] !== wanted) {
      assignmentProblems.push(`"${rowName}".${PROPERTY} is ${JSON.stringify(row[PROPERTY])}, expected "${wanted}"`)
    }
  }
  const strays = [...byName.entries()]
    .filter(([name, row]) => !(name in EXPECTED_ASSIGNMENTS) && row[PROPERTY] !== null && row[PROPERTY] !== "")
    .map(([name, row]) => `${name}=${JSON.stringify(row[PROPERTY])}`)
  if (strays.length > 0) {
    assignmentProblems.push(`rows that should have stayed blank: ${strays.join(", ")}`)
  }
  if (assignmentProblems.length === 0) {
    subscores.assignments = 1
    diagnostics.push(
      `assignments correct: ${Object.entries(EXPECTED_ASSIGNMENTS).map(([k, v]) => `${k}→${v}`).join(", ")}`,
    )
  } else {
    for (const problem of assignmentProblems) diagnostics.push(problem)
  }

  // ---- 4. nothing else moved ----------------------------------------------
  const preserveProblems: string[] = []
  for (const [name, type] of PRESERVED) {
    const prop = properties[name]
    if (!prop) preserveProblems.push(`property "${name}" was removed`)
    else if (prop.type !== type) preserveProblems.push(`property "${name}" changed type to ${prop.type}`)
  }
  const unexpected = names.filter((n) => n !== PROPERTY && !PRESERVED.some(([p]) => p === n))
  if (unexpected.length > 0) preserveProblems.push(`extra properties added: ${unexpected.join(", ")}`)

  const statusOptions = ((properties.Status?.select as { options?: Array<{ name?: string; color?: string }> })
    ?.options ?? []) as Array<{ name?: string; color?: string }>
  const statusOk =
    statusOptions.length === STATUS_OPTIONS.length &&
    STATUS_OPTIONS.every((want, i) => statusOptions[i]?.name === want.name && statusOptions[i]?.color === want.color)
  if (!statusOk) {
    preserveProblems.push(
      `Status options changed — expected ${STATUS_OPTIONS.map((o) => `${o.name}/${o.color}`).join(", ")}, got ${
        statusOptions.map((o) => `${o.name}/${o.color ?? "(none)"}`).join(", ") || "none"
      }`,
    )
  }
  if (rows.length !== ROW_COUNT) preserveProblems.push(`row count is ${rows.length}, expected ${ROW_COUNT}`)

  if (preserveProblems.length === 0) {
    subscores.schema_preserved = 1
    diagnostics.push("existing schema and rows untouched")
  } else {
    for (const problem of preserveProblems) diagnostics.push(problem)
  }

  const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
  return { score: score as 0 | 1, subscores, diagnostics }
}
