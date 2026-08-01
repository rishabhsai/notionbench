---
id: showcase-002-mobile-grooming-business
title: Operations hub for a two-van mobile dog-grooming business
suite: other
family: cli
stage: build
topics: [exhibition, taste, information-architecture, scheduling, rollups, unscored]
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
  information-architecture problem — a study system (001), a service business
  (this one) and a content pipeline (003, a Twitch creator) — so the gallery
  shows how a config's taste moves with the subject rather than three
  variations of the same page. What makes this one distinct is that it is the
  only entry with a real operational clock: recurring work (every-4-weeks
  regulars, which Notion has no native answer for — a property, a template or a
  written convention are all legitimate), two physical resources to schedule
  against, consumables that run out, an asset that needs servicing, and a money
  question that only a rollup or formula can answer.

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
  and fuzzy titles — a supplies database called "Stock" passes — so the
  captions describe architecture rather than vocabulary.

  `verify: [state]` rather than an empty list: `TaskMetaSchema` requires at
  least one verify layer, and `state` is the honest description — the verifier
  does read the live workspace, it just never fails anything for what it finds.
---

We're a mobile dog-grooming outfit — two vans, me and three groomers, we come
to you. The business runs off my phone: bookings arrive as texts, everything
else is in a paper notebook that lives in van one.

What's killing me is knowing which dog is booked when, and which van is doing
it. A good half of our clients are regulars — every four weeks, same slot — and
if I forget to rebook them they quietly drift away. Supplies, too: we ran out
of oatmeal shampoo halfway through a golden retriever last month, which I'd
like to never repeat. The vans need servicing, which sneaks up on me every
time.

The thing I really can't answer: van two has been on the road five months and I
don't know whether it's paying for itself.

Put it together however makes sense — I've never built anything in Notion. It
has to survive being opened one-handed in a car park.

The page to build it all under is identified in `notionbench.json` in this
directory; your `ntn` CLI is already authenticated against the workspace it
lives in. Build inside that page — don't create anything at the top level of
the workspace.
