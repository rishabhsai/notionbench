---
id: investigate-workers-001-runs-log-rootcause
title: Find out why the assignee-load tool keeps failing
suite: benchmark
family: workers
stage: investigate
topics: [logs, debugging, schemas, null-handling]
difficulty: L3
runtime: offline
fixture: none
verify: [static, answer-file, exec-local]
limits: { time: 900, cost: 3.0 }
---

Support triage has been complaining that the agent "forgets how to count" a
couple of times a day — it answers from the conversation instead of from the
ticket list, and nobody can reproduce it on demand. Everything looks healthy in
`ntn workers sync status`, and when I try the tool by hand it works fine.

I dumped yesterday's run history and logs into `logs/runs-2026-07-28.log`
before they roll off. Please work out what's actually going wrong, then fix it.

Two deliverables:

1. `answer.json` in the project root, with exactly these fields:

   - `run_id` — the id of the run where it went wrong
   - `capability` — the capability key that failed
   - `error` — the error class in the log
   - `field` — the input field that caused it
   - `root_cause` — a sentence in your own words explaining why it happened

2. The fix in the worker itself. Tickets that nobody has picked up yet are a
   normal thing around here — they should be counted, grouped together under
   the assignee name `unassigned`, not rejected and not silently dropped.
   Everything else about the tool stays as it is: same key, same output shape,
   one entry per assignee, busiest first by minutes.

`npm run check` should stay clean.
