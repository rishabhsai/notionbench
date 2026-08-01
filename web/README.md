# NotionBench web UI

Pure static, no build step: vanilla HTML/CSS/JS, system fonts, hand-rolled SVG charts,
zero external requests. Open `index.html` directly or serve the directory.

## Deploy

```bash
wrangler pages deploy web
```

## Modes (auto-detected from URL hash)

- **Static** (default): loads `./data/results.json` — the public results site.
  Replace that file with real runner output at build time; `data/results.js` is the
  same payload as a script global, used only as a `file://` fallback (regenerate it
  alongside, or delete it when deploying — hosted pages never need it).
- **Live**: `index.html#api=https://host:8377&key=<token>` — polls
  `${api}/api/status` every 10s with `Authorization: Bearer <token>`, and shows the
  run hero, per-config lanes, and the failures feed. Used as a private monitoring
  dashboard while a run executes.

## Layout

- `js/schema.js` — the data contract (typed) + adapter. **The only file to touch
  when the real runner schema changes.**
- `js/stats.js` — Wilson intervals, pass^3, aggregations, formatters.
- `js/charts.js` — inline-SVG Pareto scatter + per-family bars, tooltip.
- `js/views.js` — page/live/database-card/chart rendering.
- `js/main.js` — mode detection, loading, 10s polling.
- `data/` — fixtures (mock for now; deterministic via `dev/make-fixtures.mjs`).
- `dev/mock-server.mjs` — local mock of `/api/status` for testing live mode.

Schema note: the UI reads one field beyond the runner contract — an optional
top-level `startedAt` (ISO time), used only to compute the live ETA.
