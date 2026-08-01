---
id: build-pages-001-markdown-section-edit
title: Rewrite one section of the nightly export runbook
suite: benchmark
family: cli
stage: build
topics: [markdown-api, pages, partial-edit, content-preservation]
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

We changed how the nightly export works and the **Nightly Export Runbook** page
is out of date. Only the steps changed — the rest of the page is still right and
was signed off by compliance, so it has to come through untouched, word for word.

Replace the body of the `## Steps` section with exactly these four bullets, in
this order:

```
- Confirm yesterday's run finished and the warehouse is idle
- Snapshot the orders table row count
- Start the export job
- Check the exported row count against the snapshot
```

The `## Overview` and `## Escalation` sections must be left exactly as they are —
same headings, same wording, same order — and no sections may be added or
removed.

One thing that trips people up on the Markdown API: `GET /v1/pages/{id}/markdown`
renders the page **title** as the leading `# …` line of the document. That line
is the title, not body content. If you write it back as part of the body on the
way out, the page ends up with a duplicate heading block, and that counts as
damage.

The sandbox page that holds the runbook is identified in `notionbench.json` in
this directory; your `ntn` CLI is already authenticated against the workspace it
lives in.
