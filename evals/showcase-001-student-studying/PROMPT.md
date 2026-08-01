---
id: showcase-001-student-studying
title: Study system for a junior taking five classes
suite: other
family: cli
stage: build
topics: [exhibition, taste, information-architecture, spaced-repetition, relations, unscored]
difficulty: L4
runtime: live
fixture: none
verify: [state]
limits: { time: 2400, cost: 8.0 }
holdout: false
notes: >-
  EXHIBITION, NOT A BENCHMARK TASK — one of three. The same prompt goes to every
  agent configuration, each result is screenshotted from the logged-in browser at
  a fixed viewport in light mode, and the screenshots are published side by side
  with a placard under each. Nothing here contributes to any published number:
  `suite: other`, no oracle, and `EVAL.ts` returns 1 unconditionally.

  Three showcases exist, not three attempts at one. Each poses a *different*
  information-architecture problem — a study system (this one), a service
  business (002, mobile dog grooming) and a content pipeline (003, a Twitch
  creator) — so the gallery shows how a config's taste moves with the subject
  rather than three variations of the same page. What makes this one distinct
  is that the hard part is an algorithm, not a schema: spaced repetition is a
  scheduling rule hiding inside a database, and "tell me what to review today"
  is a view problem before it is a table problem. Everything else here
  (courses, notes, reading, weak spots) has to hang off that without burying it.

  Both gates skip it, by construction and not by special case. `_lib/qc.ts`
  skips any task with no `solution/`, and this one has none because "the best
  Notion workspace" has no reference answer. `_lib/live/qc-live.ts` only grades
  tasks with a `fixture/spec.json`, and names-and-skips the `runtime: live`
  tasks without one — this starts from an empty page on purpose, because the
  workspace *is* the deliverable and seeding it would be handing over the
  answer.

  `EVAL.ts` measures the placard, not the entry. The requested-element
  checklist becomes subscores (each 0/1, never aggregated); the raw counts go
  into one machine-readable `PLACARD {…}` diagnostic line, because
  `packages/core`'s results schema constrains every subscore to [0, 1] and a
  workspace with 40 blocks is not a fraction. Every check matches on structure
  and fuzzy titles — a review database called "Flashcards" passes — so the
  captions describe architecture rather than vocabulary.

  `verify: [state]` rather than an empty list: `TaskMetaSchema` requires at
  least one verify layer, and `state` is the honest description — the verifier
  does read the live workspace, it just never fails anything for what it finds.
---

I'm a junior, I'm taking five classes, and I am drowning in material.

My entire study method is: reread my notes the night before and hope. It does
not work. I've heard of spaced repetition and it sounds like the right idea,
but I don't want to be the one deciding what to go over — I want to be told.

My exam and assignment dates are spread across five syllabi and I look at none
of them. My lecture notes are Google Docs and photos of whiteboards, one folder
per class on a good week. And there are topics I know I'm shaky on, except I
only find out which ones during the exam itself.

There's also assigned reading. I have never once been on top of the assigned
reading.

Build it however you think it should work — I need to still open it on a
Tuesday when I'm tired.

The page to build it all under is identified in `notionbench.json` in this
directory; your `ntn` CLI is already authenticated against the workspace it
lives in. Build inside that page — don't create anything at the top level of
the workspace.
