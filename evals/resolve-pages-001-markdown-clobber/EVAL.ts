/**
 * resolve-pages-001-markdown-clobber — an append that must not become a replace.
 *
 * `PATCH /v1/pages/{id}/markdown` stores the document you hand it, in full. The
 * seeded script hands it the appendix alone, so the postmortem it was meant to
 * extend is overwritten. A repair is only a repair if the three original
 * sections come back byte-identical *and* the appendix is on the end.
 *
 * Grading is a whole-document comparison, section by section, so the two ways of
 * getting this half-right are both caught:
 *
 *   - appendix present, original gone      → the bug, unfixed;
 *   - original mostly there, one line lost → an off-by-one while stitching the
 *     old document back together, which is the subtler and more common outcome.
 *
 * The original text is asserted against literals, because by the time the
 * verifier runs the "before" state is only recoverable from the fixture. They
 * are the fixture's own strings (`fixture/spec.json`) and the appendix the
 * seeded script already defines (`fixture/workspace/add-appendix.mjs`); if any
 * of them drift the `solution` variant of `qc:live` scores 0 and the gate goes
 * red.
 *
 * ── Why the QC path and the run path differ ────────────────────────────────
 * At RUN time the agent works in the trial workspace with the real `ntn` CLI,
 * authenticated by a leased token against api.notion.com. It never sees this
 * file, `fixture/spec.json`, or anything under `live/`.
 *
 * At QC time there is no Notion workspace. `evals/_lib/live/qc-live.ts` boots
 * the in-memory `fake-notion.ts` — whose markdown PATCH replaces the whole body,
 * exactly as the real one does — provisions `fixture/spec.json` against it, and
 * points `NOTION_API_BASE` at it. The oracle and the plausibly-wrong solution
 * under `live/` are plain Node scripts: each edits `add-appendix.mjs` the way an
 * agent would and then runs it, so what CI proves is that this verifier returns
 * 1 for a true append and 0 for a lossy one.
 *
 * The verifier is the same code on both paths — it honors `NOTION_API_BASE` and
 * reads the workspace through the public API either way.
 */
import { findPageByTitle, resolveLiveContext } from "../_lib/live/context.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const PAGE_TITLE = "Incident 2026-07-12 · Postmortem"
const APPENDIX_HEADING = "Appendix · Customer impact"

/** The fixture's write-up. Not one character of this may change. */
const ORIGINAL_SECTIONS: Array<{ heading: string; body: string }> = [
  {
    heading: "Summary",
    body: "The orders API returned 502s for 41 minutes starting at 09:14 UTC.",
  },
  {
    heading: "Timeline",
    body: [
      "- 09:14 — first alert fires",
      "- 09:31 — on-call identifies the bad deploy",
      "- 09:55 — rollback completes",
    ].join("\n"),
  },
  {
    heading: "Follow-ups",
    body: ["- [ ] Add a canary step to the deploy pipeline", "- [ ] Alert on 5xx rate, not just latency"].join(
      "\n",
    ),
  },
]

/** What the seeded script adds, verbatim. */
const APPENDIX = {
  heading: APPENDIX_HEADING,
  body: ["- 412 orders failed to submit", "- 3 enterprise accounts opened tickets", "- No data loss"].join("\n"),
}

const EXPECTED = [...ORIGINAL_SECTIONS, APPENDIX]

interface Section {
  heading: string
  body: string
}

function parseSections(markdown: string, pageTitleText: string): { preamble: string; sections: Section[] } {
  const lines = markdown.split("\n")
  const rest = lines[0] === `# ${pageTitleText}` ? lines.slice(1) : lines

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
  return { preamble: trimBlank(preamble).join("\n"), sections }
}

function trimBlank(lines: string[]): string[] {
  const out = [...lines]
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop()
  while (out.length > 0 && out[0].trim() === "") out.shift()
  return out
}

const oneLine = (text: string): string => (text === "" ? "(empty)" : text.split("\n").join(" ⏎ "))

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = { page_found: 0, original_preserved: 0, appendix_added: 0, order: 0 }

  const live = await resolveLiveContext({ workspaceDir, ctx })
  const { client, rootId } = live
  diagnostics.push(`api=${live.apiBase} root=${rootId} (${live.source.root})`)

  const found = live.idMap.postmortem
    ? { id: live.idMap.postmortem }
    : await findPageByTitle(client, rootId, PAGE_TITLE)
  if (!found) {
    diagnostics.push(`no page titled "${PAGE_TITLE}" under the sandbox root — was it renamed or deleted?`)
    return { score: 0, subscores, diagnostics }
  }
  subscores.page_found = 1

  const rendered = await client.getPageMarkdown(found.id)
  const markdown = typeof rendered.markdown === "string" ? rendered.markdown : ""
  const { preamble, sections } = parseSections(markdown, PAGE_TITLE)
  const bySection = new Map(sections.map((s) => [s.heading, s.body]))
  diagnostics.push(`page now holds ${sections.length} section(s): ${sections.map((s) => s.heading).join(", ") || "(none)"}`)

  // ---- the original write-up, byte for byte --------------------------------
  const losses: string[] = []
  for (const want of ORIGINAL_SECTIONS) {
    const got = bySection.get(want.heading)
    if (got === undefined) {
      losses.push(`"## ${want.heading}" is gone`)
      continue
    }
    if (got !== want.body) {
      losses.push(`"## ${want.heading}" changed — expected: ${oneLine(want.body)} | got: ${oneLine(got)}`)
    }
  }
  if (preamble !== "") {
    losses.push(
      `content appeared above the first section: ${oneLine(preamble)} — the rendered "# ${PAGE_TITLE}" line is the page title, not body content`,
    )
  }
  if (losses.length === 0) {
    subscores.original_preserved = 1
    diagnostics.push("Summary, Timeline and Follow-ups survived byte-identical")
  } else {
    diagnostics.push("CLOBBERED — the write-up the appendix was supposed to extend did not survive:")
    for (const loss of losses) diagnostics.push(`  ${loss}`)
  }

  // ---- the appendix --------------------------------------------------------
  const appendix = bySection.get(APPENDIX.heading)
  if (appendix === APPENDIX.body) {
    subscores.appendix_added = 1
    diagnostics.push(`"## ${APPENDIX.heading}" is present and complete`)
  } else if (appendix === undefined) {
    diagnostics.push(`"## ${APPENDIX.heading}" is missing — the script never ran, or ran and failed`)
  } else {
    diagnostics.push(
      `"## ${APPENDIX.heading}" mismatch — expected: ${oneLine(APPENDIX.body)} | got: ${oneLine(appendix)}`,
    )
  }

  // ---- order: appended, not interleaved ------------------------------------
  const wantHeadings = EXPECTED.map((s) => s.heading)
  const gotHeadings = sections.map((s) => s.heading)
  if (gotHeadings.length === wantHeadings.length && wantHeadings.every((h, i) => gotHeadings[i] === h)) {
    subscores.order = 1
    diagnostics.push("the appendix sits at the bottom, after the original sections")
  } else {
    diagnostics.push(
      `section order — expected [${wantHeadings.join(", ")}], got [${gotHeadings.join(", ") || "(none)"}]`,
    )
  }

  const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
  return { score: score as 0 | 1, subscores, diagnostics }
}
