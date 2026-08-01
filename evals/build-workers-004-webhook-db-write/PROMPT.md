---
id: build-workers-004-webhook-db-write
title: Have PagerDuty alerts close out our Incidents rows
suite: benchmark
family: workers
stage: build
topics: [webhooks, context-notion, data-sources, lookup-by-key, idempotency]
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
  provisions the Notion fixture, runs the webhook handler with a fixed payload
  through `exec --local`, and then reads the database back.
---

Our alerting tool can POST to a URL when an incident changes, and right now a
human copies the change into Notion by hand. Please close that loop.

Add a webhook to this worker called `onIncidentAlert`. Each delivery has a JSON
body shaped like this:

```json
{
  "incident_id": "INC-1042",
  "status": "Resolved",
  "summary": "Reindex finished; results are current again."
}
```

For every event that arrives, find the row in our **Incidents** database whose
`Incident ID` matches `incident_id`, and update it:

- set `Status` to the `status` from the payload,
- put the `summary` into the `Notes` property, replacing whatever is there.

Nothing else on the row changes, and no other row is touched. If no row matches
the `incident_id`, leave the database alone — do not invent a row for it.

Two things to watch:

- **Look the database up at run time.** The worker runs against whichever
  workspace it is deployed into, so its id cannot be baked into the source. Find
  it by its name, `Incidents`.
- **Match on `Incident ID`, not on position.** Rows come back in whatever order
  the query gives them, and "the first result" is not the same thing as "the
  incident this alert is about".

Use `context.notion` — the second argument your handler is given — for the
Notion calls. `npm run check` should stay clean.
