---
id: investigate-users-001-bot-identity
title: Write down which integration this token actually is
suite: benchmark
family: cli
stage: investigate
topics: [users, auth, bot-vs-person, workspace-identity, ntn-api]
difficulty: L1
runtime: live
fixture: rest
verify: [answer-file]
limits: { time: 600, cost: 2.0 }
notes: >-
  Live task. The oracle and the plausibly-wrong solution live under `live/`
  rather than `solution/`/`wrong/`, so the offline gate (`_lib/qc.ts`) skips
  this directory instead of trying to score a Notion workspace as a folder.
  It is graded by `pnpm --filter @notionbench/evals run qc:live`.
---

Access review time. I have a token wired into this machine and no record of
what it is or where it points, and I'd rather not guess.

Using `ntn api`, work out and write down:

- the id of the integration the token authenticates as, and its name,
- what that integration is owned by — a workspace, or a single user,
- the id and the name of the workspace it is connected to,
- how many actual **people** are members of that workspace (humans only — don't
  count integrations).

Put it in `answer.json` in this directory, exactly this shape:

```json
{
  "bot_id": "",
  "bot_name": "",
  "owner_type": "",
  "workspace_id": "",
  "workspace_name": "",
  "person_count": 0
}
```

`bot_id` is the id of the *integration itself*, not of any person in the member
list — those are different objects and mixing them up is the whole reason I'm
asking someone to check. Ids go in exactly as the API returns them, dashes and
all. `person_count` is a plain integer.

Read-only: don't create, edit or archive anything.

The sandbox page for this task is identified in `notionbench.json` in this
directory; your `ntn` CLI is already authenticated against the workspace it
lives in.
