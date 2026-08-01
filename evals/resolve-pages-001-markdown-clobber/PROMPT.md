---
id: resolve-pages-001-markdown-clobber
title: The appendix script is eating the postmortem
suite: benchmark
family: cli
stage: resolve
topics: [markdown-api, destructive-write, append, content-preservation]
difficulty: L2
runtime: live
fixture: rest
verify: [state]
limits: { time: 900, cost: 3.0 }
notes: >-
  Live task. The oracle and the plausibly-wrong solution live under `live/`
  rather than `solution/`/`wrong/`, so the offline gate (`_lib/qc.ts`) skips
  this directory instead of trying to score a Notion workspace as a folder.
  It is graded by `pnpm --filter @notionbench/evals run qc:live`.
---

We ran `add-appendix.mjs` against last month's postmortem in a staging workspace
and it deleted the entire write-up — summary, timeline, follow-ups, all of it —
leaving nothing but the appendix. We got that page back from version history, but
I'm not running it again until it's fixed.

Fix the script so it **adds** the appendix to the bottom of the page and leaves
everything already on the page exactly as it is, then run it here against
**Incident 2026-07-12 · Postmortem**.

Afterwards the page should read: the existing Summary, Timeline and Follow-ups
sections, word for word and in that order, followed by the appendix the script
already defines. The two follow-up checkboxes stay unticked.

Two notes that will save you time:

- `PATCH /v1/pages/{id}/markdown` replaces the *whole* page body. That is not a
  bug in the API; it's the thing the script has to work around.
- `GET /v1/pages/{id}/markdown` renders the page **title** as the leading `# …`
  line of the document. That line is the title, not body content — writing it
  back into the body leaves a duplicate heading behind.

`NOTION_API_TOKEN` and `NOTION_API_BASE` are already in your environment, which
is where the script picks them up. The sandbox page is identified in
`notionbench.json` in this directory; your `ntn` CLI is authenticated against the
same workspace if you would rather work from the CLI.
