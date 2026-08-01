---
id: build-cli-001-create-page-with-icon
title: Create an onboarding checklist page under the team handbook
suite: benchmark
family: cli
stage: build
topics: [pages, icons, blocks, parenting]
difficulty: L1
runtime: live
fixture: rest
verify: [state]
limits: { time: 600, cost: 2.0 }
notes: >-
  Live task. The oracle and the plausibly-wrong solution live under `live/`
  rather than `solution/`/`wrong/`, so the offline gate (`_lib/qc.ts`) skips
  this directory instead of trying to score a Notion workspace as a folder.
  It is graded by `pnpm --filter @notionbench/evals run qc:live`.
---

New people keep asking the same four questions in their first week, so I want a
checklist page they can be pointed at.

Add a page called **Onboarding Checklist** inside our **Team Handbook** page —
inside the handbook itself, not next to it, and not in the Archive. Give it the
compass emoji 🧭 as its page icon so it stands out in the sidebar.

The body should be three to-do items, in this order, all left unticked:

1. `Read the team handbook`
2. `Set up the ntn CLI`
3. `Book a 1:1 with your manager`

Nothing else on the page, and please don't touch anything that's already there.

The sandbox page that holds all of this is identified in `notionbench.json` in
this directory; your `ntn` CLI is already authenticated against the workspace it
lives in.
