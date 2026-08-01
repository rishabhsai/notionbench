---
id: resolve-workers-003-rate-limit-429
title: warehouse_totals falls over whenever Northgate rate-limits us
suite: regression
family: workers
stage: resolve
topics: [rate-limits, retries, backoff, tools]
difficulty: L3
runtime: offline
fixture: none
verify: [static, exec-local]
limits: { time: 900, cost: 3.0 }
---

`warehouse_totals` works when I run it and then doesn't when the ops channel
runs it, and the difference is Northgate. They cap the burst rate per account,
and when you go over they hand back a `429` with a `Retry-After` instead of a
page. Our tool treats that as the end of the world:

```
ToolExecutionError: Northgate responded 429 Too Many Requests; retry after 25ms
```

A 429 is not an error, it's the vendor asking us to wait. Please make the tool
ride them out and still come back with the full inventory — every SKU, correct
totals — instead of throwing or quietly returning a partial answer. Their
`Retry-After` is short; honoring it is enough.

`src/warehouse.ts` is the vendor stub we develop against — same shapes, same
rate-limit behavior as the hosted API. Leave it alone; the fix belongs on our
side of the call.

Keep the key `warehouse_totals` and the `{ sku_count, total_units, low_stock }`
result shape. `npm run check` should stay clean.
