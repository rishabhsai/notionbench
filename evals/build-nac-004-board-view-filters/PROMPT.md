---
id: build-nac-004-board-view-filters
title: Configure a filtered, grouped board view over a support queue
suite: benchmark
family: nac
stage: build
topics: [views, filters, board-groups, schema]
difficulty: L3
runtime: offline
fixture: none
verify: [static, intents]
limits: { time: 900, cost: 3.0 }
---

Support wants their escalation board described in code so the other regions can
copy it instead of re-clicking it. Please write this into `src/main.ts`.

Teamspace **Support**, open access, on the anchor that's already at the top of
the file — the workspace exists already.

A database **Support Queue** in it, one data source of the same name:

| Property    | Type     | Notes                                                              |
| ----------- | -------- | ------------------------------------------------------------------ |
| `Name`      | title    |                                                                    |
| `Priority`  | select   | in this order: `Urgent` (red), `Normal` (blue), `Low` (gray)       |
| `Team`      | select   | in this order: `Platform` (purple), `Billing` (orange), `Mobile` (green) |
| `Escalated` | checkbox |                                                                    |
| `Opened`    | date     |                                                                    |

Two views on it.

The first is a plain table called **All Tickets** — no filters, no sorts, no
column tweaks.

The second is the one that matters: a board called **Platform Escalations**,
grouped by `Priority`, with empty groups hidden.

- Its columns run `Urgent`, `Normal`, `Low`, in that order, and the `Low` column
  is hidden — nobody escalates a Low, but I want the column defined so it's
  there if the definition of Low ever changes.
- It shows only rows that are all three of: escalated, owned by the `Platform`
  team, and opened on or after 2026-07-01 (that's when the new rotation started
  — anything older is somebody else's problem now).
- Cards show `Team` and `Opened`, in that order, and explicitly hide `Escalated`
  (every card on this board is escalated, so the checkbox is just noise).
- Sorted by `Opened`, oldest first.

Seed three tickets so the board isn't empty when I demo it:

| Name                       | Priority | Team     | Escalated | Opened     |
| -------------------------- | -------- | -------- | --------- | ---------- |
| Checkout returning 500s    | Urgent   | Platform | yes       | 2026-07-14 |
| Invoice PDF missing tax line | Normal | Billing  | no        | 2026-06-28 |
| Push notifications delayed | Normal   | Platform | yes       | 2026-07-22 |

Nothing else — no extra properties, views, pages, or databases.

`npm run build` should succeed and `dist/intents.json` should describe exactly
that.
