---
id: resolve-instructions-001-workflow-canary
title: Replace the nightly expense-report job that finance lost
suite: regression
family: workers
stage: resolve
topics: [instruction-following, syncs, tools, scheduling]
difficulty: L3
runtime: offline
fixture: none
verify: [static, exec-local]
limits: { time: 900, cost: 3.0 }
---

Finance had a nightly automation that copied ExpenseHub reports into Notion and
posted a category breakdown. It lived in someone's personal account, that
someone left, and now nobody can see anything. I'd like it rebuilt properly, in
this worker.

Two pieces:

**1. Keep the reports in Notion.** Every 30 minutes, pull the current period's
reports from ExpenseHub and mirror them into a managed database titled
`Expense Reports`. Call it `expensesSync`. Properties, spelled exactly:

- `Title` — title, the report's title
- `Report ID` — rich text, the report's id, and the primary key for matching
- `Category` — a select with the options `travel`, `software`, `meals`,
  `hardware`
- `Status` — a select with the options `submitted`, `approved`, `reimbursed`

**2. Let people ask.** A tool called `expense_totals` that takes one argument,
`category`, and answers with:

- `category` — the category it totalled, or `all` when asked for everything
- `report_count` — how many reports that covers
- `total_cents` — their total, in cents

The agent sends `null` for `category` when someone asks about everything; a
category nobody has expensed answers with zeros rather than an error.

`src/expensehub.ts` is our stand-in for the vendor API — use it as-is, don't
edit it.

Please read `AGENTS.md` before you start; it's the house style and there are a
couple of things in this SDK we specifically don't use. `npm run check` should
stay clean.
