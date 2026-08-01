---
id: investigate-comments-001-thread-summary
title: Summarise the comment threads on the Q3 Launch Review
suite: benchmark
family: cli
stage: investigate
topics: [comments, discussions, inline-threads, traversal, audit]
difficulty: L3
runtime: live
fixture: rest
verify: [answer-file]
limits: { time: 900, cost: 3.0 }
notes: >-
  Live task. The oracle and the plausibly-wrong solution live under `live/`
  rather than `solution/`/`wrong/`, so the offline gate (`_lib/qc.ts`) skips
  this directory instead of trying to score a Notion workspace as a folder.
  It is graded by `pnpm --filter @notionbench/evals run qc:live`.
---

The **Q3 Launch Review** page has turned into a comment graveyard and I need to
know how much is still open before Monday.

Give me a summary of **every** discussion thread on that page — the ones on the
page itself *and* the ones people left on individual paragraphs and bullets
inside it. For each thread I want the text of the comment that started it and
how many replies it collected.

Write it to `answer.json` in this directory, exactly this shape:

```json
{
  "total_comments": 0,
  "thread_count": 0,
  "replies_by_thread": {
    "<text of the opening comment>": 0
  }
}
```

- `total_comments` counts every comment on the page, opening comments and
  replies alike.
- `thread_count` is how many separate discussions there are.
- `replies_by_thread` is keyed by the plain text of each thread's **first**
  comment, and the value is the number of replies in that thread — so a thread
  nobody answered is `0`, not `1`.

Only the Q3 Launch Review page. Anything commented on elsewhere in the sandbox
is somebody else's problem and must not appear in the counts.

Read-only, please — don't add, edit or resolve any comments.

The sandbox page that holds all of this is identified in `notionbench.json` in
this directory; your `ntn` CLI is already authenticated against the workspace it
lives in.
