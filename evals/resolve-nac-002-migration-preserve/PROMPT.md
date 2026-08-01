---
id: resolve-nac-002-migration-preserve
title: Migrate a live database's options and column name without losing data
suite: benchmark
family: nac
stage: resolve
topics: [schema-migration, resource-ids, idempotency, seed-data]
difficulty: L3
runtime: offline
fixture: none
verify: [static, intents]
limits: { time: 900, cost: 3.0 }
---

This project is already applied — the Marketing teamspace, the Content Calendar
database and the four entries in it are live in Notion right now, and the team
has been working in them all quarter.

Two changes to the Content Calendar data source, please:

1. **The `Stage` options are out of date.** We never used `Idea` (nothing has
   ever sat in it) and we've added a scheduling step between review and
   publishing. The options should end up as, in this order:

   | Option      | Color  |
   | ----------- | ------ |
   | `Drafting`  | blue   |
   | `Review`    | yellow |
   | `Scheduled` | purple |
   | `Published` | green  |

2. **`Notes` should be called `Context`.** Same column, same text in it, just a
   better name — people kept reading "Notes" as "meeting notes" and putting the
   wrong thing in it.

What I care about more than the changes themselves: this has to land as an
*update* to what's already in Notion when we re-run `apply`. Renaming the column
must rename the column people have been writing in, not retire it and stand up
an empty one next to it — there's a quarter of context in there. Same for
everything else: the teamspace, the database, the data source, the other
properties, the board view and the four entries all have to keep resolving to
the objects they're already mapped to.

Leave the entries' values alone; nothing in them needs to change beyond
following the column to its new name.

`npm run build` should succeed when you're done.
