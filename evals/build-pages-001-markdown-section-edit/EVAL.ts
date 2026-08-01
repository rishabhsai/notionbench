/**
 * build-pages-001-markdown-section-edit — a surgical Markdown edit, verified by
 * reading the page back through the Markdown API.
 *
 * `PATCH /v1/pages/{id}/markdown` replaces the *whole* body. That is the trap:
 * the only way to change one section is to fetch the document, splice the one
 * section, and send the rest back byte-identical. So this verifier does not just
 * check that the new steps are there — it checks that the two sections nobody
 * asked about survived character for character, and that the set and order of
 * headings is unchanged.
 *
 * Two supporting details worth spelling out:
 *
 *  - **The leading `# …` line is the page title, not body content.** The
 *    Markdown renderer emits it; an agent that echoes it back on the way out
 *    gains a duplicate heading block. The verifier strips exactly one such line
 *    and then insists the region before the first `## ` is empty, so that
 *    round-trip mistake is caught rather than tolerated.
 *  - **The untouched sections are asserted against literals.** Everywhere else
 *    in the suite ground truth is re-derived from the live workspace; here that
 *    is impossible, because the "before" state is gone by the time the verifier
 *    runs. `EXPECTED_SECTIONS` is therefore the fixture's own text and must be
 *    kept in step with `fixture/spec.json`. Drift is not silent: the oracle only
 *    ever rewrites `## Steps`, so the moment a literal here stops matching the
 *    spec the `solution` variant of `qc:live` scores 0 and the gate goes red.
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
import { findPageByTitle, resolveLiveContext } from "../_lib/live/context.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const PAGE_TITLE = "Nightly Export Runbook"

/** The section the prompt asks for, and the only one allowed to change. */
const EDITED_SECTION = "Steps"

const NEW_STEPS = [
  "- Confirm yesterday's run finished and the warehouse is idle",
  "- Snapshot the orders table row count",
  "- Start the export job",
  "- Check the exported row count against the snapshot",
].join("\n")

/**
 * The document as it must look afterwards. `Overview` and `Escalation` are the
 * fixture's text verbatim (see `fixture/spec.json`); `Steps` is the replacement.
 */
const EXPECTED_SECTIONS: Array<{ heading: string; body: string }> = [
  {
    heading: "Overview",
    body: "The nightly export copies the orders table into the warehouse at 02:00 UTC.",
  },
  { heading: EDITED_SECTION, body: NEW_STEPS },
  {
    heading: "Escalation",
    body: [
      "If the run is still red after two retries, page the on-call data engineer.",
      "Do not restart the job by hand; it is not idempotent.",
    ].join("\n"),
  },
]

interface Section {
  heading: string
  body: string
}

interface Parsed {
  /** Everything before the first `## `, after the rendered title line is removed. */
  preamble: string
  sections: Section[]
  /** True when the document opened with the expected `# <page title>` line. */
  titleLineSeen: boolean
}

/**
 * Split a rendered page into `## ` sections.
 *
 * Trailing blank lines are dropped from each body so that a stray newline at the
 * end of the document is not reported as a content change — the renderer's own
 * terminator is not something an agent controls.
 */
function parseDocument(markdown: string, pageTitleText: string): Parsed {
  const lines = markdown.split("\n")
  const titleLineSeen = lines[0] === `# ${pageTitleText}`
  const rest = titleLineSeen ? lines.slice(1) : lines

  const preamble: string[] = []
  const sections: Section[] = []
  let current: { heading: string; body: string[] } | undefined

  for (const line of rest) {
    if (line.startsWith("## ")) {
      if (current) sections.push({ heading: current.heading, body: trimBlank(current.body).join("\n") })
      current = { heading: line.slice(3), body: [] }
      continue
    }
    if (current) current.body.push(line)
    else preamble.push(line)
  }
  if (current) sections.push({ heading: current.heading, body: trimBlank(current.body).join("\n") })

  return { preamble: trimBlank(preamble).join("\n"), sections, titleLineSeen }
}

function trimBlank(lines: string[]): string[] {
  const out = [...lines]
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop()
  while (out.length > 0 && out[0].trim() === "") out.shift()
  return out
}

/** `"a\nb"` → `"a ⏎ b"`, so a multi-line mismatch stays on one diagnostic line. */
function oneLine(text: string): string {
  return text === "" ? "(empty)" : text.split("\n").join(" ⏎ ")
}

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    page_found: 0,
    structure: 0,
    edited_section: 0,
    untouched_sections: 0,
  }

  const live = await resolveLiveContext({ workspaceDir, ctx })
  const { client, rootId } = live
  diagnostics.push(`api=${live.apiBase} root=${rootId} (${live.source.root})`)

  const found = live.idMap.runbook
    ? { id: live.idMap.runbook }
    : await findPageByTitle(client, rootId, PAGE_TITLE)
  if (!found) {
    diagnostics.push(`no page titled "${PAGE_TITLE}" under the sandbox root — was it renamed or deleted?`)
    return { score: 0, subscores, diagnostics }
  }
  subscores.page_found = 1

  const rendered = await client.getPageMarkdown(found.id)
  const markdown = typeof rendered.markdown === "string" ? rendered.markdown : ""
  if (markdown === "") {
    diagnostics.push("GET /v1/pages/{id}/markdown returned no markdown — the page body is gone")
    return { score: 0, subscores, diagnostics }
  }

  const doc = parseDocument(markdown, PAGE_TITLE)
  if (!doc.titleLineSeen) {
    diagnostics.push(
      `the rendered document does not start with "# ${PAGE_TITLE}" — the page title changed, which the task did not ask for`,
    )
  }

  // ---- structure: the same three headings, in the same order ---------------
  const wantHeadings = EXPECTED_SECTIONS.map((s) => s.heading)
  const gotHeadings = doc.sections.map((s) => s.heading)
  const headingsOk =
    gotHeadings.length === wantHeadings.length && wantHeadings.every((h, i) => gotHeadings[i] === h)
  const preambleOk = doc.preamble === ""

  if (headingsOk && preambleOk && doc.titleLineSeen) {
    subscores.structure = 1
    diagnostics.push(`sections present and in order: ${gotHeadings.join(", ")}`)
  } else {
    if (!headingsOk) {
      diagnostics.push(
        `section headings changed — expected [${wantHeadings.join(", ")}], got [${gotHeadings.join(", ") || "(none)"}]`,
      )
    }
    if (!preambleOk) {
      // Almost always the round-trip mistake the prompt warns about.
      diagnostics.push(
        `content appeared above the first section: ${oneLine(doc.preamble)} — ` +
          `the rendered "# ${PAGE_TITLE}" line is the page title and must not be written back into the body`,
      )
    }
  }

  const bySection = new Map(doc.sections.map((s) => [s.heading, s.body]))

  // ---- the one section that was supposed to change -------------------------
  const editedWant = EXPECTED_SECTIONS.find((s) => s.heading === EDITED_SECTION) as Section
  const editedGot = bySection.get(EDITED_SECTION)
  if (editedGot === editedWant.body) {
    subscores.edited_section = 1
    diagnostics.push(`"## ${EDITED_SECTION}" holds the four new bullets, in order`)
  } else if (editedGot === undefined) {
    diagnostics.push(`"## ${EDITED_SECTION}" is missing from the page`)
  } else {
    diagnostics.push(
      `"## ${EDITED_SECTION}" mismatch — expected: ${oneLine(editedWant.body)} | got: ${oneLine(editedGot)}`,
    )
  }

  // ---- everything else, byte for byte --------------------------------------
  const damage: string[] = []
  for (const want of EXPECTED_SECTIONS) {
    if (want.heading === EDITED_SECTION) continue
    const got = bySection.get(want.heading)
    if (got === undefined) {
      damage.push(`"## ${want.heading}" was removed`)
      continue
    }
    if (got !== want.body) {
      damage.push(`"## ${want.heading}" was modified — expected: ${oneLine(want.body)} | got: ${oneLine(got)}`)
    }
  }
  const extras = gotHeadings.filter((h) => !wantHeadings.includes(h))
  if (extras.length > 0) damage.push(`sections that did not exist before: ${extras.join(", ")}`)

  if (damage.length === 0) {
    subscores.untouched_sections = 1
    diagnostics.push("Overview and Escalation are byte-identical to the original")
  } else {
    // The failure this task exists to catch: a whole-page PATCH that took the
    // untouched sections with it.
    diagnostics.push("COLLATERAL DAMAGE — sections that were not part of the request changed:")
    for (const line of damage) diagnostics.push(`  ${line}`)
  }

  const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
  return { score: score as 0 | 1, subscores, diagnostics }
}
