---
id: build-nac-002-csv-seeded
title: Seed a database from a CSV export at build time
suite: benchmark
family: nac
stage: build
topics: [workspace-authoring, seed-data, data-driven, schema]
difficulty: L2
runtime: offline
fixture: none
verify: [static, intents]
limits: { time: 900, cost: 3.0 }
---

Finance keeps our hardware count in a spreadsheet and I'm tired of retyping it
into Notion every quarter. I've dropped the current export at `data.csv` in the
root of this project — please describe the Notion side of it in `src/main.ts`.

A teamspace called **IT Ops**, open access, hanging off the anchor that's
already at the top of `src/main.ts` (the workspace itself exists).

Inside it, a database **Hardware Inventory** with one data source of the same
name and exactly these properties:

| Property    | Type     | Notes                                                                            |
| ----------- | -------- | -------------------------------------------------------------------------------- |
| `Asset`     | title    |                                                                                  |
| `Category`  | select   | options, in this order: `Laptop` (blue), `Monitor` (purple), `Phone` (orange), `Accessory` (gray) |
| `Quantity`  | number   |                                                                                  |
| `Purchased` | date     |                                                                                  |
| `Insured`   | checkbox |                                                                                  |

One table view named **All Assets**, no filters or sorts on it.

Then one row per line in the export, with all five properties filled in. The CSV
columns line up with the properties one-for-one; `Insured` is `yes`/`no` in the
export and needs to land as a real checkbox.

The important bit: **the export is the source of truth.** Finance re-exports
this file every quarter and I'll drop the new one in on top of the old one, so
the build has to read `data.csv` when it runs and derive the rows from whatever
is in it. Don't transcribe today's numbers into the script — the whole point is
that next quarter's rebuild picks up the new file without anybody editing
TypeScript.

Nothing beyond the above: no extra properties, views, pages, or databases.

`npm run build` should succeed and `dist/intents.json` should describe exactly
that.
