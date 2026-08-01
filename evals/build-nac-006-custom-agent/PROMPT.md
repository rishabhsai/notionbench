---
id: build-nac-006-custom-agent
title: Declare a custom agent alongside the database it works in
suite: benchmark
family: nac
stage: build
topics: [custom-agents, permissions, workspace-authoring]
difficulty: L2
runtime: offline
fixture: none
verify: [static, intents]
limits: { time: 900, cost: 3.0 }
---

We're rolling out a feedback-triage agent to each regional CS team and I'd
rather define it here than recreate it by hand in every workspace. Please write
this into `src/main.ts`.

A teamspace **Customer Success**, open access, on the anchor that's already at
the top of the file — the workspace exists.

A database **Customer Feedback** in it, one data source of the same name:

| Property   | Type   | Notes                                                                    |
| ---------- | ------ | ------------------------------------------------------------------------ |
| `Summary`  | title  |                                                                          |
| `Account`  | text   |                                                                          |
| `Theme`    | select | in this order: `Onboarding` (blue), `Reliability` (red), `Pricing` (yellow) |
| `Received` | date   |                                                                          |

Two rows to start it off:

| Summary                             | Account    | Theme       | Received   |
| ----------------------------------- | ---------- | ----------- | ---------- |
| SSO setup took three calls          | Acme Corp  | Onboarding  | 2026-07-09 |
| Exports time out on large workspaces | Helio Labs | Reliability | 2026-07-17 |

Then the agent itself, called **Feedback Triage**, with the 🛟 emoji as its
icon. Run it on **Sonnet 4.6 (Low)** — it's doing routing, not writing, and the
cheap model is plenty. It needs access to the Customer Feedback database; that's
the only thing it should be able to see.

Its instructions, as Markdown:

> You triage incoming customer feedback for the Customer Success team.
>
> When someone gives you a piece of feedback:
>
> 1. Search the Customer Feedback database for an existing entry about the same
>    problem before creating a new one.
> 2. Fill in **Account**, **Theme** and **Received** on every entry you create.
>    Never leave Theme empty.
> 3. If the feedback does not fit an existing Theme, say so in your reply
>    instead of inventing a new option.
>
> Always quote the customer's own words in the Summary. Do not paraphrase
> complaints into something softer than what was said.

Keep that wording exactly — the numbered list and the bold property names are
deliberate, and the intro line, the "When someone gives you a piece of feedback:"
line, the three numbered steps and the closing paragraph are each their own
paragraph.

Nothing else: no views, no extra properties, no other pages or databases.

`npm run build` should succeed and `dist/intents.json` should describe exactly
that.
