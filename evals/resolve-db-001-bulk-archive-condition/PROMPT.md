---
id: resolve-db-001-bulk-archive-condition
title: Clear the duplicate requests out of the support inbox
suite: benchmark
family: cli
stage: resolve
topics: [bulk-operations, archiving, filters, blast-radius]
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

Our intake form double-posted for a couple of weeks and support triage has been
marking the copies as `Duplicate` ever since. The board is now unusable — half of
what people see is noise.

In the **Inbox Requests** database, archive every request whose `Status` is
`Duplicate`. Move them to the trash; don't just relabel them.

Everything else stays exactly where it is. `Closed` requests in particular are
**not** duplicates — they're finished work and the team still reports off them,
so they have to survive this untouched, as do `New` and `Triaged`. Don't edit any
property on any row that isn't being archived.

The sandbox page that holds the database is identified in `notionbench.json` in
this directory; your `ntn` CLI is already authenticated against the workspace it
lives in.
