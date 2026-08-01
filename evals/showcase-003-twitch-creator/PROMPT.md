---
id: showcase-003-twitch-creator
title: Content pipeline for a Twitch streamer turning VODs into videos
suite: other
family: cli
stage: build
topics: [exhibition, taste, information-architecture, pipeline, relations, unscored]
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
  (002, mobile dog grooming) and a content pipeline (this one) — so the gallery
  shows how a config's taste moves with the subject rather than three
  variations of the same page. What makes this one distinct is that the
  workspace has to model *flow*: one artefact changes state and identity as it
  moves (stream → VOD → clips → script → published video), a second party owns
  part of that flow, and a separate obligation calendar (sponsor deliverables)
  cuts across it with hard deadlines.

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
  and fuzzy titles — a VOD database called "Episodes" passes — so the captions
  describe architecture rather than vocabulary.

  `verify: [state]` rather than an empty list: `TaskMetaSchema` requires at
  least one verify layer, and `state` is the honest description — the verifier
  does read the live workspace, it just never fails anything for what it finds.
---

I stream three or four times a week and I've grown past the point where memory
works.

Every stream is supposed to become clips and eventually a YouTube video. What
actually happens is VODs pile up unedited and I lose track of what's been cut,
what's with my editor, and what actually went out. He's a freelancer — files go
out, notes come back, and it all lives in Discord DMs I can never find again.

The YouTube videos need scripts, which currently exist in about six states of
half-written.

The scary part is sponsorships. Each deal has specific things I owe — a
mid-roll read by the 14th, two clips, a link in the description — and I nearly
missed one last month.

I'd also like some sense of which videos actually did well, without opening
four dashboards.

Set it up however someone who does this properly would. I want to stop running
this off my memory.

The page to build it all under is identified in `notionbench.json` in this
directory; your `ntn` CLI is already authenticated against the workspace it
lives in. Build inside that page — don't create anything at the top level of
the workspace.
