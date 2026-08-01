---
id: build-cli-002-filtered-export
title: Export the high-effort open tickets to JSON
suite: benchmark
family: cli
stage: build
topics: [data-sources, query, filters, sorting, export]
difficulty: L2
runtime: live
fixture: rest
verify: [state, artifact]
limits: { time: 900, cost: 3.0 }
notes: >-
  Live task. The oracle and the plausibly-wrong solution live under `live/`
  rather than `solution/`/`wrong/`, so the offline gate (`_lib/qc.ts`) skips
  this directory instead of trying to score a Notion workspace as a folder.
  It is graded by `pnpm --filter @notionbench/evals run qc:live`.
---

I'm putting together the triage agenda for Monday and I want the list as a file
I can paste into the doc, not a screenshot.

From the **Support Tickets** database, take every ticket that is both

- `Status` = **Open**, and
- `Points` of **5 or more**,

and write them to a file called `export.json` in this directory.

It should be a JSON array, one object per ticket, with exactly these three
fields and nothing else:

```json
{ "name": "TCK-001", "priority": "High", "points": 8 }
```

`points` must be a number, not a string.

Order matters — I read it top to bottom in the meeting. Sort by `points`,
highest first; where two tickets have the same points, put them in alphabetical
order by `name`.

Don't change anything in Notion; this one is read-only.

The sandbox page that holds the database is identified in `notionbench.json` in
this directory; your `ntn` CLI is already authenticated against the workspace it
lives in.
