---
id: resolve-workers-002-stateless-bug
title: dedupe_emails only works the first time you ask it
suite: benchmark
family: workers
stage: resolve
topics: [tools, runtime-model, statelessness, idempotency]
difficulty: L3
runtime: offline
fixture: none
verify: [static, exec-local]
limits: { time: 900, cost: 3.0 }
---

Something is off with `dedupe_emails`. The first call in a session is perfect.
Ask it again in the same conversation and it insists the entire list is
duplicates and hands back nothing, and the `processed` number keeps climbing
past the number of addresses I actually gave it. Restarting makes it look fine
again, which is why it took us a week to notice.

Please make each call stand on its own. The contract, as it always should have
been:

- `unique` — the distinct addresses **from this call**, normalized (trimmed and
  lower-cased), in the order they first appear in the list I passed
- `duplicates` — how many of the addresses in **this call** were repeats of an
  earlier one in the same list
- `processed` — how many addresses **this call** was handed

Same key, same result shape. Calling the tool twice with the same list should
give the same answer twice, whether or not anything else ran in between.

`npm run check` should stay clean.
