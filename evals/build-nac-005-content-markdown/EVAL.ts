/**
 * build-nac-005-content-markdown — canonical intents comparison over
 * whitespace-normalized page content.
 *
 * Page content is a single Notion-flavored Markdown string, so comparing it
 * byte-for-byte would grade formatting habits rather than the page: whether the
 * body of a `<callout>` is indented with a tab, two spaces or not at all is not
 * something the spec pins down, and a blank line between blocks is stripped by
 * Notion anyway. Comparing it *loosely* is no better — "does the string contain
 * `<callout`" passes for a page whose blocks are in the wrong order.
 *
 * So the content of every page intent is put through `normalizeContent()` on
 * both sides before the usual `diffIntents` comparison:
 *
 *   - trailing whitespace and blank lines are dropped (Notion strips them);
 *   - runs of internal whitespace collapse to one space;
 *   - `*`/`+` bullet markers become `-`;
 *   - indentation is normalized to a depth (a tab, four spaces or two spaces
 *     each count as one level) and is **kept only on list items**, where it is
 *     what makes a sub-list a sub-list. Indentation inside container blocks
 *     (`<callout>`, `<details>`, `<table>`) carries no meaning — the tags
 *     already say what contains what — so it is flattened.
 *
 * What survives normalization is exactly what the task is about: which blocks,
 * in which order, with which text, and which list nesting. Everything else in
 * the document (the teamspace, the page title and icon) is compared by the
 * normal canonical rules, up to resourceId renaming.
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
const MAX_REPORTED_DIFFS = 10

const LIST_ITEM_RE = /^(?:[-*+]\s|\d+[.)]\s)/

/**
 * Leading-whitespace depth: a tab, four spaces or two spaces each count as one
 * level, so tab-indented and space-indented content compare equal.
 */
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

/** See the module comment: structure-preserving, formatting-insensitive. */
export function normalizeContent(content: string): string {
  const out: string[] = []
  for (const raw of content.split(/\r?\n/)) {
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

/** Same document, with every page's `content` normalized. */
function withNormalizedContent(intents: readonly Json[]): Json[] {
  return intents.map((intent) => {
    if (!isObject(intent) || intent.type !== "page" || typeof intent.content !== "string") return intent
    return { ...intent, content: normalizeContent(intent.content) }
  })
}

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    build: 0,
    page: 0,
    callouts: 0,
    table: 0,
    nested_list: 0,
    toggles: 0,
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

  // ---- diagnostic block-level checks ---------------------------------------
  const pages = intentsOfType(intents, "page")
  const page = pages.find((p) => typeof p.content === "string" && p.content.length > 0) ?? pages[0]
  const content = typeof page?.content === "string" ? normalizeContent(page.content) : ""
  if (pages.length === 1 && content.length > 0) subscores.page = 1
  else diagnostics.push(`expected exactly one page carrying content; got ${pages.length} page intent(s)`)

  const lines = content.split("\n")
  const callouts = lines.filter((l) => l.startsWith("<callout")).length
  if (callouts === 2 && content.includes('<callout icon="🚨">') && content.includes('<callout icon="📝">')) {
    subscores.callouts = 1
  } else {
    diagnostics.push(
      `expected two callout blocks (🚨 and 📝); found ${callouts}. A paragraph that starts with an emoji is ` +
        `not a callout block.`,
    )
  }

  const rows = lines.filter((l) => l.startsWith("<tr")).length
  if (content.includes("<table") && rows === 4) subscores.table = 1
  else {
    diagnostics.push(
      `expected a table block with a header row and four rows; found ${
        content.includes("<table") ? `${rows} <tr> row(s)` : "no table block"
      }. A pipe table is plain text in Notion-flavored Markdown.`,
    )
  }

  const nested = lines.filter((l) => l.startsWith("\t") && LIST_ITEM_RE.test(l.trimStart())).length
  if (nested === 5) subscores.nested_list = 1
  else diagnostics.push(`expected 5 nested (indented) bullets; found ${nested}`)

  const toggles = lines.filter((l) => l.startsWith("<details")).length
  const summaries = lines.filter((l) => l.startsWith("<summary")).length
  if (toggles === 2 && summaries === 2) subscores.toggles = 1
  else diagnostics.push(`expected two toggle blocks with summaries; found ${toggles} <details> / ${summaries} <summary>`)

  // ---- the score: canonical comparison over normalized content -------------
  const taskDir = (ctx?.taskDir as string | undefined) ?? import.meta.dirname
  const expectedIntents = await readJson<Json[]>(path.join(taskDir, "expected", "intents.json"))
  const diff = diffIntents(withNormalizedContent(expectedIntents), withNormalizedContent(intents))

  for (const group of diff.actual.ambiguities) {
    diagnostics.push(
      `note: structurally indistinguishable resources collapsed onto one label: ${group.join(", ")}`,
    )
  }

  if (diff.equal) {
    subscores.canonical = 1
    diagnostics.push("canonical intents match the oracle (up to resourceId renaming and content whitespace)")
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
