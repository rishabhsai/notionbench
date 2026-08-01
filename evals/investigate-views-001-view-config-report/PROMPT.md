---
id: investigate-views-001-view-config-report
title: Inventory the saved views on the Product Roadmap
suite: benchmark
family: cli
stage: investigate
topics: [views, list-stubs, board-grouping, filters, audit]
difficulty: L2
runtime: live
fixture: rest
verify: [answer-file]
limits: { time: 900, cost: 3.0 }
notes: >-
  Live task. The oracle and the plausibly-wrong solution live under `live/`
  rather than `solution/`/`wrong/`, so the offline gate (`_lib/qc.ts`) skips
  this directory instead of trying to score a Notion workspace as a folder.
  It is graded by `pnpm --filter @notionbench/evals run qc:live`.
---

Half the team keeps making their own view of the roadmap and I've lost track of
what's actually saved on it. Before I start deleting things I want a written
inventory.

For the **Product Roadmap** database, list **every** saved view — including the
plain one it came with — and for each one tell me:

- what kind of view it is (`table`, `board`, `calendar`, `gallery`, …),
- which property it groups by, if it groups at all,
- which property it filters on, if it filters at all.

Write it to `answer.json` in this directory, exactly this shape:

```json
{
  "view_count": 0,
  "views": {
    "<view name>": {
      "type": "board",
      "group_by": "Status",
      "filter_property": "Quarter"
    }
  }
}
```

One entry per view, keyed by the view's name. `group_by` and `filter_property`
are the **property names** — `"Status"`, not a property id — and both are
`null` when the view doesn't group or doesn't filter. `view_count` is how many
views there are in total, which should equal the number of entries.

Don't change anything — no new views, no edits to the ones that exist. This is
a read-only inventory.

The sandbox page that holds the database is identified in `notionbench.json` in
this directory; your `ntn` CLI is already authenticated against the workspace it
lives in.
