---
id: operate-batch-001-rate-limited-writes
title: Load the conference contacts into Notion
suite: benchmark
family: ops
stage: operate
topics: [batch-writes, rate-limits, pacing, completeness]
difficulty: L2
runtime: live
fixture: rest
verify: [state]
limits: { time: 1200, cost: 3.0 }
notes: >-
  Live task. The oracle and the plausibly-wrong solution live under `live/`
  rather than `solution/`/`wrong/`, so the offline gate (`_lib/qc.ts`) skips
  this directory instead of trying to score a Notion workspace as a folder.
  It is graded by `pnpm --filter @notionbench/evals run qc:live`.
---

We came back from the conference with a scanner export. It's in `contacts.json`
in this directory — 50 people, each with a name, email, company and segment.

Load all 50 into the **Contact Imports** database, one row per contact:

| JSON field | Property  |
| ---------- | --------- |
| `name`     | `Name`    |
| `email`    | `Email`   |
| `company`  | `Company` |
| `segment`  | `Segment` |

`Segment` is a single-select and every value in the file is already one of its
options, so nothing new needs adding to the schema.

Please pace the writes. Notion's API allows roughly **three requests per second**
on average and starts returning `429 rate_limited` when you go over — with a
`Retry-After` header saying how long to wait. Fifty creations fired off at once
will get throttled, and the failure mode we keep hitting is that the throttled
ones are dropped silently and the import comes out short. Stay under the limit,
honour `Retry-After` if you do get a 429, and make sure every one of the 50 rows
is actually there when you're done.

No duplicates, and don't invent rows that aren't in the file.

The sandbox page that holds the database is identified in `notionbench.json` in
this directory; your `ntn` CLI is already authenticated against the workspace it
lives in.
