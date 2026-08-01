---
id: operate-workers-002-exec-local-harness
title: Run receipt_digest on my machine and tell me what it says
suite: benchmark
family: ops
stage: operate
topics: [cli, exec-local, tooling, reproducibility]
difficulty: L1
runtime: offline
fixture: none
verify: [answer-file, exec-local]
limits: { time: 600, cost: 2.0 }
---

Finance says our receipt fingerprints don't match theirs and I need a reference
value to argue with. This worker already has the `receipt_digest` tool; it is
deployed nowhere and I don't want to deploy it to find out — run it here,
locally, against this receipt:

```json
{
  "lines": [
    { "sku": "WH-101", "qty": 3, "unit_cents": 1299 },
    { "sku": "WH-207", "qty": 1, "unit_cents": 4599 },
    { "sku": "WH-101", "qty": 2, "unit_cents": 1299 },
    { "sku": "WH-512", "qty": 10, "unit_cents": 99 }
  ]
}
```

Write what you get to `answer.json` in the project root:

- `command` — the exact command line you ran, verbatim
- `output` — the tool's result, exactly as it came back, as JSON (not a string,
  not reformatted numbers, not your own summary of it)

Don't change the worker — the whole point is what the code we have right now
says today. I want the `command` line so the next person can paste it and get
the same answer.
