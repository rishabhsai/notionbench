---
id: investigate-search-001-find-across-workspace
title: Find the runbooks that have no owner
suite: benchmark
family: cli
stage: investigate
topics: [search, traversal, nesting, audit]
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

We agreed every runbook names an owner on the page, and I'm fairly sure some of
them don't. Before I chase people about it I want the list.

A **runbook** is any page under our sandbox whose title contains the word
`Runbook`. A runbook **has an owner** when one of the lines on the page starts
with `Owner:` — that's the convention, so a page without such a line is what I'm
after.

They are not all in one place. Teams filed them wherever made sense at the time,
so some sit several levels down inside other pages. I want all of them, however
deep they are, and only the ones under the sandbox page — the rest of the
workspace is not mine to audit.

Write the result to `answer.json` in this directory, exactly this shape:

```json
{
  "runbooks_total": 0,
  "missing_owner": ["Some Runbook", "Another Runbook"]
}
```

`runbooks_total` counts every runbook you found, owned or not. `missing_owner`
holds the exact page titles of the ones with no `Owner:` line, sorted
alphabetically. Titles only — no ids, no URLs.

Don't change anything in Notion; this is read-only.

The sandbox page is identified in `notionbench.json` in this directory; your
`ntn` CLI is already authenticated against the workspace it lives in.
