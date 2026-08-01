---
id: operate-files-001-list-audit
title: Audit every file attached under the sandbox page
suite: benchmark
family: ops
stage: operate
topics: [files, file-uploads, traversal, nesting, audit]
difficulty: L3
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

We're moving this space to a plan with a storage cap and I have no idea how much
we're actually holding, or where it is.

Find **every** file attached anywhere under the sandbox page — attached to a
page, attached to a row of a database, however deep it is buried — and write me
an inventory at `answer.json` in this directory, exactly this shape:

```json
{
  "file_count": 0,
  "total_bytes": 0,
  "files": [
    { "name": "example.md", "size_bytes": 0, "parent": "Some page" }
  ]
}
```

- `name` is the filename as Notion has it.
- `size_bytes` is the file's size in bytes, as an integer.
- `parent` is the **title** of the thing it hangs off — the page it sits on, or
  the row it's attached to.
- `files` is sorted by `name`, ascending.
- `total_bytes` is the sum of every `size_bytes`.

Sub-pages count. Sub-pages of sub-pages count. If it's under the sandbox page,
it's on the bill.

Read-only: don't upload, move, rename or detach anything.

The sandbox page is identified in `notionbench.json` in this directory; your
`ntn` CLI is already authenticated against the workspace it lives in.
