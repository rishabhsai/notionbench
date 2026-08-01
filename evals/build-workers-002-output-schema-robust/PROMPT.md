---
id: build-workers-002-output-schema-robust
title: A contact-normalizing tool that survives half-empty records
suite: benchmark
family: workers
stage: build
topics: [tools, schemas, edge-cases, null-handling]
difficulty: L2
runtime: offline
fixture: none
verify: [static, exec-local]
limits: { time: 900, cost: 3.0 }
---

We're wiring our Notion agent up to a pile of scraped contact records, and the
records are a mess — half of them are missing a name, or an email, or both. The
agent currently tries to tidy them up itself and produces different-looking
output every time, which makes the downstream steps a nightmare.

Please add a tool called `normalize_contact` to this worker. It takes one
argument, `record`, holding `name`, `email` and `seats`, and it returns:

- `display_name` — the name, trimmed
- `email` — the email, trimmed and lower-cased
- `seats` — the seat count
- `missing` — the names of the fields we couldn't use (`name`, `email`,
  `seats`), in alphabetical order

The whole point is what happens when the input isn't clean, so be specific
about that. The agent sends `null` for any field it doesn't have, and sends
`record: null` outright when it found nothing at all — the tool has to answer
in all of those cases rather than blow up:

- a name that is missing, or is nothing but whitespace, becomes
  `"Unknown contact"` and counts as missing
- an email that is missing, or is nothing but whitespace, becomes `""` and
  counts as missing
- `seats` is only usable if it's a number of zero or more; anything else
  (missing, negative) becomes `0` and counts as missing. Zero seats is a real
  answer, not a missing one — we have plenty of free-plan accounts.
- `record: null` means all three are missing

Declare the shape of the result as well as the shape of the argument, so the
agent knows what it is getting back.

`npm run check` should stay clean.
