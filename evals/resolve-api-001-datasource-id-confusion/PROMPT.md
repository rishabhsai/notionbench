---
id: resolve-api-001-datasource-id-confusion
title: The owner backfill script stopped working
suite: benchmark
family: cli
stage: resolve
topics: [api-versioning, data-sources, 2025-09-03, debugging]
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

`backfill.mjs` in this directory is the little script we run after planning: it
takes everything still sitting in `Backlog` on the **Release Tracker**, moves it
to `Ready`, and stamps the owner we agreed. It ran fine for months. Now it dies
before it writes anything:

```
$ node backfill.mjs
POST /v1/data_sources/… → 400 validation_error: … is a database id, not a data
source id. Retrieve the database and use one of its data_sources[].id.
```

Nobody touched the script. Work out what changed, fix it, and run it so the
tracker is actually backfilled.

Two things to be careful about:

- There are **two** trackers on the *Release Ops* page — the live **Release
  Tracker** and **Release Tracker (2025)**, which is a frozen archive. The
  archive must come out of this completely unchanged.
- Rows that have already moved past `Backlog` are not yours to touch. The script
  is right about that part; keep it that way.

`NOTION_API_TOKEN` and `NOTION_API_BASE` are already in your environment, which
is where the script picks them up. The sandbox page is identified in
`notionbench.json` in this directory; your `ntn` CLI is authenticated against the
same workspace if you would rather work from the CLI.
