---
id: resolve-workers-001-broken-schema
title: Make split_name stop returning errors
suite: benchmark
family: workers
stage: resolve
topics: [tools, schemas, input-validation, edge-cases]
difficulty: L2
runtime: offline
fixture: none
verify: [static, exec-local]
limits: { time: 900, cost: 3.0 }
---

`split_name` is the most-used tool on our agent and it errors out constantly.
Two things show up in the run logs:

```
InvalidToolInputError: ... "missingProperty": "keep_middle" ... must have required property 'keep_middle'
ToolExecutionError: ... "missingProperty": "last" ... must have required property 'last'
```

The first one happens because the agent just sends a name — it has no idea what
`keep_middle` is and neither do I; it was somebody's half-finished idea and
nothing in the product uses it. Feel free to take it out entirely.

The second one is the mononym problem. Plenty of our contacts have one-word
names.

Please fix the tool so the following all hold, keeping the key `split_name` and
the `{ first, last }` result shape it declares today:

| `full_name`                        | `first` | `last`     |
| ---------------------------------- | ------- | ---------- |
| `"Ada Lovelace"`                   | `Ada`   | `Lovelace` |
| `"Prince"`                         | `Prince`| (empty)    |
| `"  Grace   Brewster Murray Hopper  "` | `Grace` | `Hopper` |
| `""`                               | (empty) | (empty)    |

In other words: first word, last word, extra whitespace ignored, and an empty
string rather than a missing field when there is no such word. Nothing it
returns should ever be missing or null.

`npm run check` should stay clean.
