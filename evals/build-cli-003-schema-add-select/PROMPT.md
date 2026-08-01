---
id: build-cli-003-schema-add-select
title: Add a Channel select property to the content calendar
suite: benchmark
family: cli
stage: build
topics: [schema, select-options, data-sources, colors]
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

We've started publishing the same post to more than one place, and right now
there's no way to tell from the calendar where anything actually went.

Add a property called **Channel** to the **Content Calendar** database. It's a
single-select — one channel per row — with exactly these four options, in this
order, and these colours:

| Option       | Colour   |
| ------------ | -------- |
| `Blog`       | `blue`   |
| `Newsletter` | `yellow` |
| `Social`     | `pink`   |
| `Docs`       | `gray`   |

The colours matter: the calendar gets screenshotted for the weekly update and
I want it to match the rest of our decks.

Then set `Channel` on three rows so I can see it working:

- `Post 01` → `Blog`
- `Post 05` → `Social`
- `Post 12` → `Docs`

Leave the rest blank for now, and don't change any of the properties that are
already there — `Status` in particular keeps its options exactly as they are.

The sandbox page that holds the database is identified in `notionbench.json` in
this directory; your `ntn` CLI is already authenticated against the workspace it
lives in.
