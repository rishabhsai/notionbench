---
id: resolve-nac-003-anchor-error
title: Make a project that no longer builds apply-able again
suite: regression
family: nac
stage: resolve
topics: [anchors, build-errors, resource-ids, idempotency]
difficulty: L3
runtime: offline
fixture: none
verify: [static, intents]
limits: { time: 900, cost: 3.0 }
---

`npm run build` on this project stopped working after last week's change and now
nobody can ship anything from it.

The Operations half of `src/main.ts` — the teamspace, the handbook page, the
Runbooks database and the two runbooks in it — was applied last quarter and is
live in Notion right now. Someone on procurement then added the Vendors section
underneath it, and that's when the build broke.

Please get it building again. The Vendors teamspace, its database and its two
rows all need to survive the fix — procurement is waiting on it — and so does
everything that's already applied: when we run `apply` after this, it has to
recognise the Operations teamspace, the handbook, the Runbooks database and the
runbooks as the objects they're already mapped to and update them in place. If
that mapping breaks we'll wake up to a duplicate of the whole Operations
section, which is a worse outcome than the broken build.

Don't change any of the names, schemas, or seeded values — the only thing that
should be different afterwards is whatever it takes to make the project
apply-able.

`npm run build` should succeed when you're done.
