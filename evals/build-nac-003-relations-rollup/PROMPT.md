---
id: build-nac-003-relations-rollup
title: Wire two databases together with a two-way relation and rollups
suite: benchmark
family: nac
stage: build
topics: [relations, rollups, schema, cross-references]
difficulty: L3
runtime: offline
fixture: none
verify: [static, intents]
limits: { time: 900, cost: 3.0 }
---

I want our consulting side described in this Notion as Code project so we stop
rebuilding it by hand for every new practice. Please write it into
`src/main.ts`.

A teamspace **Consulting**, open access, on the anchor that's already at the top
of the file — the workspace itself exists.

Two databases in it, each with a single data source of the same name.

**Clients**

| Property         | Type     | Notes                                                      |
| ---------------- | -------- | ---------------------------------------------------------- |
| `Name`           | title    |                                                            |
| `Account Lead`   | text     |                                                            |
| `Engagements`    | relation | points at the Engagements data source                      |
| `Billable Hours` | rollup   | sums `Hours` on the related engagements                    |
| `Next Milestone` | rollup   | the earliest `Due` date across the related engagements     |

**Engagements**

| Property | Type     | Notes                            |
| -------- | -------- | -------------------------------- |
| `Name`   | title    |                                  |
| `Client` | relation | points at the Clients data source |
| `Hours`  | number   |                                  |
| `Due`    | date     |                                  |

`Clients.Engagements` and `Engagements.Client` are the **two sides of the same
relation**, not two separate ones: when someone sets the Client on an
engagement, that engagement has to show up on the client's Engagements property
immediately, and vice versa. Account managers work from the Clients database and
delivery works from Engagements, so if those two lists ever drift apart we'll be
reconciling spreadsheets again.

Both rollups read through `Clients.Engagements`.

Seed it so I can sanity-check the rollups on a demo call — two clients:

| Name              | Account Lead |
| ----------------- | ------------ |
| Northwind Traders | Priya Raman  |
| Cascade Foods     | Miguel Ortiz |

and three engagements, each already linked to its client:

| Name                | Client            | Hours | Due        |
| ------------------- | ----------------- | ----- | ---------- |
| Discovery workshop  | Northwind Traders | 40    | 2026-08-07 |
| Data migration      | Northwind Traders | 120   | 2026-09-18 |
| Supply chain audit  | Cascade Foods     | 65    | 2026-08-28 |

No views, no extra properties, no other pages — just the two databases and those
five rows.

`npm run build` should succeed and `dist/intents.json` should describe exactly
that.
