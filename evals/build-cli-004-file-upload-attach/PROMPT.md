---
id: build-cli-004-file-upload-attach
title: Attach the 2.4.0 release notes to the release log
suite: benchmark
family: cli
stage: build
topics: [files, file-uploads, attachments, data-sources]
difficulty: L2
runtime: live
fixture: rest
verify: [state]
limits: { time: 900, cost: 3.0 }
notes: >-
  Live task. The oracle and the plausibly-wrong solution live under `live/`
  rather than `solution/`/`wrong/`, so the offline gate (`_lib/qc.ts`) skips
  this directory instead of trying to score a Notion workspace as a folder.
  It is graded by `pnpm --filter @notionbench/evals run qc:live`.
---

Support keeps asking me what changed in 2.4.0 and I keep pasting the same file
into chat. It should live on the release log.

Take `release-notes/v2.4.0.md` from this directory and put it into Notion as a
file called `v2.4.0.md`, then attach it to the **Assets** property of the
**v2.4.0** row in the **Release Log** database.

It has to be the file itself — uploaded into Notion, so it opens from the row
even after this checkout is gone. A link pointing back at somewhere else is not
what I'm after; the whole problem is that the file currently lives everywhere
except Notion.

Just that one row. Don't touch the other releases, don't change any other
property on v2.4.0, and don't add anything to the database schema.

The sandbox page that holds the database is identified in `notionbench.json` in
this directory; your `ntn` CLI is already authenticated against the workspace it
lives in.
