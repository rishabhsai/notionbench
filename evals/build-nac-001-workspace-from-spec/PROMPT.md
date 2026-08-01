---
id: build-nac-001-workspace-from-spec
title: Author a project-tracker workspace from a written spec
suite: benchmark
family: nac
stage: build
topics: [workspace-authoring, schema, views, seed-data]
difficulty: L2
runtime: offline
fixture: none
verify: [static, intents]
limits: { time: 900, cost: 3.0 }
---

We're standardising how our teams spin up launch tracking, and I want the whole
thing described in this Notion as Code project instead of clicked together by
hand. Here's the setup I need — please write it into `src/main.ts`.

Everything hangs off a teamspace called **Product Ops**, with open access, in
the workspace this project already targets.

Inside it, a database called **Launch Tracker** with a single data source, also
named **Launch Tracker**, with exactly these four properties:

| Property      | Type     | Notes                                                    |
| ------------- | -------- | -------------------------------------------------------- |
| `Name`        | title    |                                                          |
| `Stage`       | select   | options `Planning` (blue), `Building` (yellow), `Shipped` (green) |
| `Target Date` | date     |                                                          |
| `Blocked`     | checkbox |                                                          |

The team lives in a board, so the database needs a board view named **By Stage**
that groups by `Stage`.

Seed it with these three launches. Every row sets all four properties — I don't
want half-filled rows in the screenshot I'm sending round:

| Name                  | Stage    | Target Date | Blocked |
| --------------------- | -------- | ----------- | ------- |
| Beta invites          | Planning | 2026-08-14  | no      |
| Pricing page refresh  | Building | 2026-08-21  | yes     |
| Docs revamp           | Shipped  | 2026-07-31  | no      |

Two things to keep in mind:

- The workspace itself already exists — attach the teamspace to the anchor
  that's already at the top of `src/main.ts` rather than declaring a new one.
- Nothing beyond what's described above: no extra properties, views, pages, or
  databases. This is the template every team will copy, so it stays minimal.

`npm run build` should succeed and the compiled `dist/intents.json` should
describe exactly that workspace.
