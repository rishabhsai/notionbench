---
id: build-workers-001-tool-scaffold
title: Add a summarize_stats tool to a Notion worker
suite: benchmark
family: workers
stage: build
topics: [tools, schemas, edge-cases]
difficulty: L2
runtime: offline
fixture: none
verify: [static, exec-local]
limits: { time: 900, cost: 3.0 }
---

Our Notion agent keeps getting handed lists of numbers — response times, deal
sizes, that kind of thing — and then does the arithmetic itself, badly. I'd
rather give it a tool.

Add a tool called `summarize_stats` to this worker. It takes a single argument,
`values`, which is a list of numbers, and it gives back three fields:

- `count` — how many numbers there were
- `mean` — their average
- `max` — the largest of them

Declare the shape of what comes back as well as what goes in, so the agent knows
what it is getting.

One thing I specifically care about: the agent will absolutely call this with an
empty list at some point. When it does, the tool has to answer `0`, `0`, `0` —
not `NaN`, not an error, not `-Infinity`. Anything that isn't a real number
coming out of this tool is worse than useless to the model reading it.

`npm run check` should stay clean.
