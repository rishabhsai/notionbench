---
id: investigate-db-002-relation-25cap
title: Size up the Platform Modernization program
suite: regression
family: cli
stage: investigate
topics: [page-properties, reference-truncation, joins, silent-truncation]
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

Planning wants a size on **Platform Modernization** before Thursday. It's the
big row in the **Programs** database, and its `Linked Initiatives` property lists
everything rolled up under it; each of those maps to a row in the **Initiatives**
database next to it.

Tell me, across **every** initiative linked to that program:

- how many there are,
- how many are `At risk`,
- and the total of `Effort (points)`.

Write the result to `answer.json` in this directory, exactly this shape:

```json
{
  "linked_count": 0,
  "at_risk_count": 0,
  "total_effort": 0
}
```

All three are plain integers.

Be careful with the first number. A page read gives you at most **25** of a
property's references — beyond that the API truncates and tells you so rather
than erroring. If you take what the page object hands you at face value, all
three numbers come out wrong and none of them look wrong.

Don't change anything in Notion; this is read-only.

The sandbox page that holds both databases is identified in `notionbench.json` in
this directory; your `ntn` CLI is already authenticated against the workspace it
lives in.
