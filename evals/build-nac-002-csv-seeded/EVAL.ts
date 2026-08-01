/**
 * build-nac-002-csv-seeded — canonical intents comparison + a data-driven check.
 *
 * Two things have to hold, and they are independent:
 *
 *  1. The compiled workspace matches the oracle's up to resourceId renaming
 *     (`@notionbench/scoring`'s `diffIntents`): teamspace, schema, select
 *     options and their order, the table view, and one fully-populated row per
 *     line of `data.csv`. A dropped or duplicated row shows up here.
 *  2. The script actually *reads* `data.csv` at build time. The prompt asks for
 *     a build that survives next quarter's re-export, so a run that transcribes
 *     today's nine rows into TypeScript has not done the task even though it
 *     compiles to the same intents. Any filesystem read has to name the file,
 *     so the check is "some source file the agent owns mentions `data.csv`" —
 *     robust to `fs.readFileSync`, `fs/promises`, a helper module, or a path
 *     built with `node:path`, and not satisfiable by a hardcoded row list.
 *
 * `expected/intents.json` is the oracle build output, committed alongside the
 * task; regenerate it by building `fixture/workspace` + `solution/` and copying
 * `dist/intents.json`. QC's `solution` check fails loudly if the two drift.
 */
import { promises as fs } from "node:fs"
import * as path from "node:path"
import {
  dataSources,
  diffIntents,
  intentsOfType,
  pagesUnder,
  propDate,
  propText,
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

const CSV_FILE = "data.csv"

const CATEGORY_OPTIONS = [
  { name: "Laptop", color: "blue" },
  { name: "Monitor", color: "purple" },
  { name: "Phone", color: "orange" },
  { name: "Accessory", color: "gray" },
]

const WANTED_PROPS: Array<[string, string]> = [
  ["Asset", "title"],
  ["Category", "select"],
  ["Quantity", "number"],
  ["Purchased", "date"],
  ["Insured", "checkbox"],
]

interface CsvRow {
  asset: string
  category: string
  quantity: string
  purchased: string
  insured: string
}

/** The fixture's export, parsed the same way the task description reads it. */
async function readCsv(workspaceDir: string): Promise<CsvRow[]> {
  const text = await fs.readFile(path.join(workspaceDir, CSV_FILE), "utf8")
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  return lines.slice(1).map((line) => {
    const [asset, category, quantity, purchased, insured] = line.split(",")
    return { asset, category, quantity, purchased, insured }
  })
}

/** Every file the agent may have written, i.e. `src/` minus the vendored runtime. */
async function agentSources(workspaceDir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "lib" || entry.name === "node_modules") continue
        await walk(full)
      } else if (/\.(ts|mts|cts|js|mjs|cjs|json)$/.test(entry.name)) {
        out.push(full)
      }
    }
  }
  await walk(path.join(workspaceDir, "src"))
  return out
}

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    build: 0,
    reads_csv: 0,
    teamspace: 0,
    schema: 0,
    table_view: 0,
    seeded_rows: 0,
    canonical: 0,
  }

  // ---- does the script read the export? ------------------------------------
  const sources = await agentSources(workspaceDir)
  const readers: string[] = []
  for (const file of sources) {
    const text = await fs.readFile(file, "utf8")
    if (text.includes(CSV_FILE)) readers.push(path.relative(workspaceDir, file))
  }
  if (readers.length > 0) {
    subscores.reads_csv = 1
    diagnostics.push(`${CSV_FILE} is read by ${readers.join(", ")}`)
  } else {
    diagnostics.push(
      `no source file under src/ references ${CSV_FILE} — the rows have to be derived from the export at ` +
        `build time, not transcribed into the script (checked: ${
          sources.map((f) => path.relative(workspaceDir, f)).join(", ") || "no source files"
        })`,
    )
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
  if (teamspaces.some((t) => t.name === "IT Ops")) subscores.teamspace = 1
  else {
    diagnostics.push(
      `no teamspace named "IT Ops" (found: ${teamspaces.map((t) => String(t.name)).join(", ") || "none"})`,
    )
  }

  const allSources = dataSources(intents)
  const source = allSources.find((ds) => ds.name === "Hardware Inventory") ?? allSources[0]
  const props = source ? propertiesOf(source) : []
  const byName = new Map(props.map((p) => [String(p.name), p]))
  const missing = WANTED_PROPS.filter(([name, type]) => byName.get(name)?.type !== type)
  const category = byName.get("Category")
  const options = Array.isArray(category?.options) ? (category.options as IntentRecord[]) : []
  const optionsOk =
    options.length === CATEGORY_OPTIONS.length &&
    CATEGORY_OPTIONS.every((want, i) => options[i]?.name === want.name && options[i]?.color === want.color)
  if (source && missing.length === 0 && props.length === WANTED_PROPS.length && optionsOk) {
    subscores.schema = 1
  } else {
    diagnostics.push(
      `data source schema mismatch — expected ${WANTED_PROPS.map(([n, t]) => `${n}:${t}`).join(", ")} with ` +
        `Category options ${CATEGORY_OPTIONS.map((o) => `${o.name}/${o.color}`).join(", ")}; got ${
          props.map((p) => `${String(p.name)}:${String(p.type)}`).join(", ") || "nothing"
        }${
          optionsOk
            ? ""
            : ` (Category options: ${
                options.map((o) => `${String(o.name)}/${String(o.color ?? "no color")}`).join(", ") || "none"
              })`
        }`,
    )
  }

  const allViews = views(intents)
  const table = allViews.find((v) => v.type === "table")
  if (allViews.length === 1 && table?.name === "All Assets") subscores.table_view = 1
  else {
    diagnostics.push(
      `view mismatch — expected exactly one table view named "All Assets"; got ${
        allViews.map((v) => `${String(v.name ?? "(unnamed)")}:${String(v.type)}`).join(", ") || "no views"
      }`,
    )
  }

  // ---- every line of the export is a row ------------------------------------
  const csv = await readCsv(workspaceDir)
  const pages = source ? pagesUnder(intents, String(source.resourceId)) : []
  const seen = new Set<string>()
  const wrongRows: string[] = []
  for (const row of csv) {
    const page = pages.find((p) => propText((p.properties as Record<string, Json>)?.Asset) === row.asset)
    if (!page) {
      wrongRows.push(`${row.asset}: no row`)
      continue
    }
    seen.add(String(page.resourceId))
    const v = (page.properties ?? {}) as Record<string, Json>
    const problems: string[] = []
    if (propText(v.Category) !== row.category) problems.push(`Category=${String(propText(v.Category))}`)
    if (propText(v.Quantity) !== row.quantity) problems.push(`Quantity=${String(propText(v.Quantity))}`)
    if (propDate(v.Purchased)?.start !== row.purchased) {
      problems.push(`Purchased=${String(propDate(v.Purchased)?.start)}`)
    }
    const insured = row.insured.toLowerCase() === "yes" ? "Yes" : "No"
    if (propText(v.Insured) !== insured) problems.push(`Insured=${String(propText(v.Insured))}`)
    if (problems.length > 0) wrongRows.push(`${row.asset}: ${problems.join(" ")}`)
  }
  const extras = pages.filter((p) => !seen.has(String(p.resourceId)))
  if (wrongRows.length === 0 && extras.length === 0 && pages.length === csv.length) {
    subscores.seeded_rows = 1
    diagnostics.push(`all ${csv.length} rows of ${CSV_FILE} are seeded`)
  } else {
    diagnostics.push(
      `seeded rows mismatch — ${CSV_FILE} has ${csv.length} lines, the build has ${pages.length} rows` +
        (wrongRows.length > 0 ? `\n  ${wrongRows.slice(0, MAX_REPORTED_DIFFS).join("\n  ")}` : "") +
        (extras.length > 0
          ? `\n  unexpected rows: ${extras
              .map((p) => propText((p.properties as Record<string, Json>)?.Asset) ?? "(untitled)")
              .join(", ")}`
          : ""),
    )
  }

  // ---- the score: canonical comparison + the data-driven requirement --------
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
  } else {
    diagnostics.push(`canonical intents differ from the oracle (${diff.differences.length} difference(s)):`)
    for (const d of diff.differences.slice(0, MAX_REPORTED_DIFFS)) {
      diagnostics.push(`  [${d.kind}] ${d.path}: ${d.message}`)
    }
    if (diff.differences.length > MAX_REPORTED_DIFFS) {
      diagnostics.push(`  … and ${diff.differences.length - MAX_REPORTED_DIFFS} more`)
    }
  }

  const score = subscores.canonical === 1 && subscores.reads_csv === 1 ? 1 : 0
  return { score: score as 0 | 1, subscores, diagnostics }
}
