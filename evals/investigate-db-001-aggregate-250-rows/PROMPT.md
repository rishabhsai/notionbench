---
id: investigate-db-001-aggregate-250-rows
title: Total up the Q3 orders database
suite: regression
family: cli
stage: investigate
topics: [pagination, aggregation, silent-truncation, data-sources]
difficulty: L2
runtime: live
fixture: rest
verify: [state, answer-file]
limits: { time: 900, cost: 3.0 }
notes: >-
  Live task. The oracle and the plausibly-wrong solution live under `live/`
  rather than `solution/`/`wrong/`, so the offline gate (`_lib/qc.ts`) skips
  this directory instead of trying to score a Notion workspace as a folder.
  It is graded by `pnpm --filter @notionbench/evals run qc:live`.
---

Finance wants the Q3 numbers off the **Q3 Orders** database and I'd rather not
open a spreadsheet.

Work out, across **every** order in that database:

- how many orders there are,
- the total of the `Amount` column,
- the total of `Amount` for the orders whose `Status` is `Paid`,
- and the total of `Amount` broken down by `Region`.

Write the result to `answer.json` in this directory, exactly this shape:

```json
{
  "row_count": 0,
  "total_amount": 0,
  "paid_amount": 0,
  "region_totals": { "NA": 0, "EU": 0, "APAC": 0 }
}
```

All five numbers are plain integers — no currency symbols, no strings, no
rounding. Every region key must be present even if its total happens to be zero.

Don't modify anything in Notion; this is a read-only exercise.

The sandbox page that holds the database is identified in `notionbench.json` in
this directory; your `ntn` CLI is already authenticated against the workspace it
lives in.
