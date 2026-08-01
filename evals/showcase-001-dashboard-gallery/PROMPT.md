---
id: showcase-001-dashboard-gallery
title: Build me a workspace worth showing off
suite: other
family: cli
stage: build
topics: [exhibition, taste, views, information-architecture, unscored]
difficulty: L4
runtime: live
fixture: none
verify: [state]
limits: { time: 2400, cost: 8.0 }
holdout: false
notes: >-
  EXHIBITION, NOT A BENCHMARK TASK. This is the gallery piece: the same prompt
  goes to every agent configuration, each result is screenshotted from the
  logged-in browser at a fixed viewport in light mode, and the screenshots are
  published side by side with a placard under each. Nothing here contributes to
  any published number — `suite: other`, and there is deliberately no oracle.

  Both gates skip it, by construction and not by special case. `_lib/qc.ts`
  skips any task with no `solution/`, and this one has none because "the best
  Notion workspace" has no reference answer. `_lib/live/qc-live.ts` only picks
  up tasks with a `fixture/spec.json`, and this one starts from an empty page
  on purpose — the workspace *is* the deliverable, so seeding it would be
  handing over the answer.

  `EVAL.ts` therefore always returns 1. What it actually does is measure the
  placard: the objective element checklist as subscores, and the raw
  pages/databases/views/blocks/rows counts as a machine-readable diagnostic
  line. Judging is a human poll, not a scorer.

  `verify: [state]` rather than the empty list the design sketch called for:
  `TaskMetaSchema` requires at least one verify layer, and `state` is the honest
  description — the verifier does read the live workspace, it just never fails
  anything for what it finds.

  Two candidate prompts were written for this. The Life OS one is active; the
  bakery one is kept below in a comment as the alternate, so a re-run can swap
  the subject without re-deriving the structure.
---

I want to move my whole life into Notion and I keep bouncing off it, because
every time I start I end up with three empty pages called "Untitled" and I give
up. Please just build the thing for me.

It's for me and my dog. His name is Biscuit, he is a large and opinionated
mutt, and a surprising amount of my week is organised around him.

Here's what I need it to have:

- **A home page** I actually want to land on. Everything else reachable from it.
- **A task database**, with a **board view grouped by status** — that's the one
  thing I'm specific about, because the board is how I think.
- **A second database** that connects to the first somehow. Habits, reading,
  vet appointments, groceries, whatever you think a life actually needs.
- **Something written** — at least one real page with real structure, not a
  placeholder. A weekly review template, a house manual, a Biscuit dossier.
- **Enough content to look alive.** Empty databases look like abandoned ones.

Beyond that: your call. Pick the structure, pick the properties, pick the
emojis, name things how you'd want them named. I'd rather have something with a
point of view that I disagree with in one place than something beige I agree
with everywhere.

The page to build it all under is identified in `notionbench.json` in this
directory; your `ntn` CLI is already authenticated against the workspace it
lives in. Build inside that page — don't create anything at the top level of
the workspace.

<!--
ALTERNATE PROMPT — "Moonbase Bakery". Not active. Swap this block with the one
above to run the exhibition on a small-business subject instead of a personal
one; it anchors the same comparable element (a board view) and leaves the same
amount to taste.

We're a two-person bakery — Moonbase, we do sourdough and one absurd cake a
week — and we currently run on a whiteboard, a shared notes app and a lot of
shouting. I'd like to run it out of Notion instead.

Here's what I need it to have:

- **A home page** that someone opening the laptop at 5am can actually use.
- **An orders database**, with a **board view grouped by status** — that's the
  one thing I'm specific about, because the board is how the day works.
- **A second database** that connects to the first somehow. Recipes, bakes,
  suppliers, the standing wholesale accounts, whatever a bakery actually needs.
- **Something written** — at least one real page with real structure, not a
  placeholder. An opening checklist, a sourdough schedule, the cake rota.
- **Enough content to look alive.** Empty databases look like abandoned ones.

Beyond that: your call. Pick the structure, pick the properties, pick the
emojis, name things how you'd want them named. I'd rather have something with a
point of view that I disagree with in one place than something beige I agree
with everywhere.

The page to build it all under is identified in `notionbench.json` in this
directory; your `ntn` CLI is already authenticated against the workspace it
lives in. Build inside that page — don't create anything at the top level of
the workspace.
-->
