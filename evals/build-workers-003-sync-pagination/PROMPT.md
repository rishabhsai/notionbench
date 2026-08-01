---
id: build-workers-003-sync-pagination
title: Sync Deskline tickets into Notion, all of them
suite: benchmark
family: workers
stage: build
topics: [syncs, pagination, cursors, databases]
difficulty: L3
runtime: offline
fixture: none
verify: [static, exec-local]
limits: { time: 900, cost: 3.0 }
---

Support lives in Deskline and everyone else lives in Notion, so support is
invisible. I'd like a sync that mirrors our Deskline tickets into a Notion
database once an hour.

`src/deskline.ts` is our local stand-in for the vendor API — same shapes, same
cursor behavior, reading a snapshot instead of the network. Use it as-is;
please don't edit it or reach into `data/` directly, because the whole point is
that this code still works when we swap it for the hosted client.

Call the sync `ticketsSync`, and have it write to a managed database titled
`Support Tickets` with these properties, spelled exactly like this:

- `Subject` — title, the ticket's subject
- `Ticket ID` — rich text, the ticket's id, and the primary key for matching
- `Status` — a select with the options `open`, `pending`, `closed`

Every ticket in Deskline should end up in the database. Note that Deskline
hands back a page at a time with a `next_cursor`, and it is not a big page —
we've been bitten before by an integration that only ever imported the first
screenful and looked fine in testing. A sync execution should hand back the
page it just fetched and say whether there's more to come, rather than trying
to drain the whole vendor API in one go.

`npm run check` should stay clean.
