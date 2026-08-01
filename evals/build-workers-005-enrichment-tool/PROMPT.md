---
id: build-workers-005-enrichment-tool
title: A tool that fills in the order total and tier
suite: benchmark
family: workers
stage: build
topics: [tools, context-notion, derived-properties, write-back, boundaries]
difficulty: L3
runtime: live
fixture: rest
verify: [static, exec-local, state]
limits: { time: 1200, cost: 4.0 }
notes: >-
  Live task. The oracle and the plausibly-wrong solution live under `live/`
  rather than `solution/`/`wrong/`, so the offline gate (`_lib/qc.ts`) skips
  this directory instead of trying to score a Notion workspace as a folder.
  It is graded by `pnpm --filter @notionbench/evals run qc:live`, which
  provisions the Notion fixture, runs the tool once per order through
  `exec --local`, and then reads the database back.
---

Sales keep forgetting to fill in the totals on the **Orders** database, and the
tier column is worse — it's meant to follow from the total and instead it
follows from whoever typed it in.

Add a tool to this worker called `enrich_order`. It takes one argument,
`page_id`, which is the id of a row in that database. When it's called it should
read that row and fill in the two columns we keep getting wrong:

- **`Order total`** — `Unit price` × `Quantity`.
- **`Tier`** — from the order total:
  - under 1,000 → `Standard`
  - 1,000 up to but not including 10,000 → `Priority`
  - 10,000 or more → `Strategic`

An order of exactly 1,000 is `Priority`, and exactly 10,000 is `Strategic`. We
have orders that land on both numbers and I don't want to argue about it again.

Write both values back onto that same row, and give back what you worked out so
the agent calling you can say it out loud:

```json
{ "order": "ORD-3002", "order_total": 1680, "tier": "Priority" }
```

`Unit price` and `Quantity` are inputs — whatever else happens, the row must
still say afterwards what it said before about how much one unit costs and how
many were ordered. And only the row you were handed: don't go looking for
others to fix while you're in there.

Use `context.notion` — the second argument your tool is given — for the Notion
calls. `npm run check` should stay clean.
