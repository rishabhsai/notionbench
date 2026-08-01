---
id: resolve-nac-001-idempotent-extend
title: Extend an applied Notion-as-Code project without breaking what is live
suite: benchmark
family: nac
stage: resolve
topics: [resource-ids, idempotency, schema-migration]
difficulty: L3
runtime: offline
fixture: none
verify: [static, intents]
limits: { time: 900, cost: 3.0 }
---

This project has already been applied to our workspace — the General teamspace,
the Sample Projects database, and the three seeded entries all exist in Notion
right now, and people have been editing them.

Two additions, please:

1. The Sample Projects data source needs a **Priority** property: a select with
   the options `High` (red), `Medium` (yellow), and `Low` (green).
2. Seed one more entry in that data source:

   | Name                   | Status      | Priority | Target     | Notes                                     |
   | ---------------------- | ----------- | -------- | ---------- | ----------------------------------------- |
   | Draft launch checklist | Not Started | High     | 2026-08-19 | Outline the steps for the v1 launch.      |

The important part: when we re-run `apply` this has to *update* the workspace
we already have, not stand up a second copy of it next to it. The existing
teamspace, page, database, data source, properties, and entries must all still
resolve to the objects they are already mapped to — nobody wants to find a
duplicate "Sample Projects" database tomorrow morning, or to lose the edits
people have made to the three existing rows.

Leave the existing entries' values exactly as they are; the new Priority column
being empty on those three rows is fine.

`npm run build` should succeed when you're done.
