# Task suite v1 — 38 tasks, 4 stages, full surface coverage

This file is the matrix — one line per task. For the long form of any row (the plain-English ask, the subscores its verifier reports, what the fixture provisions, the foil's failure mode), see [TASKS.md](TASKS.md), generated from `evals/` by `node scripts/gen-task-docs.mjs`.

Naming follows `<stage>-<area>-<nnn>-<slug>` (Supabase Evals convention).
Stages: **build** (create something new, 16), **investigate** (diagnose from real state/logs, 8), **resolve** (fix something broken, 10), **operate** (run the platform correctly, 4).
Runtime: `offline` tasks need no Notion account (pure build / `exec --local` / intents comparison); `live` tasks run against a leased workspace fixture.

## Build (16)

| id | surface | runtime | verified by |
|---|---|---|---|
| build-cli-001-create-page-with-icon | pages, CLI | live | state |
| build-cli-002-filtered-export | data sources, query | live | artifact exact-match |
| build-cli-003-schema-add-select | database schema | live | state |
| build-cli-004-file-upload-attach | files | live | state |
| build-pages-001-markdown-section-edit | Markdown API | live | state (markdown re-read) |
| build-workers-001-tool-scaffold | Workers tools | offline | exec --local |
| build-workers-002-output-schema-robust | Workers tools | offline | exec --local (edge inputs) |
| build-workers-003-sync-pagination | Workers syncs | offline | exec --local vs mock API |
| build-workers-004-webhook-db-write | Workers webhooks | live | exec --local + state |
| build-workers-005-enrichment-tool | Workers tools | live | state |
| build-nac-001-workspace-from-spec | Notion-as-Code | offline | canonical intents |
| build-nac-002-csv-seeded | NAC + Node build | offline | canonical intents |
| build-nac-003-relations-rollup | NAC schema | offline | canonical intents |
| build-nac-004-board-view-filters | NAC views | offline | canonical intents |
| build-nac-005-content-markdown | NAC content | offline | canonical intents |
| build-nac-006-custom-agent | NAC custom agents | offline | canonical intents |

## Investigate (8)

| id | surface | runtime | verified by |
|---|---|---|---|
| investigate-workers-001-runs-log-rootcause | Workers ops/logs | offline | answer-file match |
| investigate-db-001-aggregate-250-rows | pagination (silent truncation trap) | live | answer-file match |
| investigate-db-002-relation-25cap | relation property pagination | live | answer-file match |
| investigate-search-001-find-across-workspace | Search API | live | answer-file match |
| investigate-comments-001-thread-summary | Comments API | live | answer-file match |
| investigate-users-001-bot-identity | Users/auth | live | answer-file match |
| investigate-views-001-view-config-report | /v1/views | live | answer-file match |
| investigate-docs-001-progressive-disclosure | CLI help discovery | offline | answer-file match |

## Resolve (10)

| id | surface | runtime | verified by |
|---|---|---|---|
| resolve-api-001-datasource-id-confusion | API versioning (2025-09-03 split) | live | script runs + state |
| resolve-workers-001-broken-schema | Workers tools | offline | exec --local |
| resolve-workers-002-stateless-bug | Workers runtime model | offline | exec --local |
| resolve-workers-003-rate-limit-429 | pacer/backoff | offline | exec --local vs flaky mock |
| resolve-nac-001-idempotent-extend | resourceId stability | offline | intents diff (IDs pinned) |
| resolve-nac-002-migration-preserve | schema migration | offline | intents diff (IDs pinned) |
| resolve-nac-003-anchor-error | NAC anchor rule | offline | build succeeds + intents |
| resolve-db-001-bulk-archive-condition | bulk ops | live | state |
| resolve-pages-001-markdown-clobber | Markdown PATCH safety | live | state |
| resolve-instructions-001-workflow-canary | repo-instruction compliance | offline | static (forbidden API absent) + exec --local |

## Operate (4)

| id | surface | runtime | verified by |
|---|---|---|---|
| operate-workers-001-env-secrets | workers env | offline | config state match |
| operate-batch-001-rate-limited-writes | 3 req/s discipline | live | state + timing |
| operate-workers-002-exec-local-harness | exec --local usage | offline | answer-file match |
| operate-files-001-list-audit | files API | live | answer-file match |

## Coverage matrix (product × stage)

| Product area | build | investigate | resolve | operate |
|---|---|---|---|---|
| Pages & Markdown API | ✅ | – | ✅ | – |
| Databases / data sources / queries | ✅ | ✅✅ | ✅ | – |
| Views | ✅ (NAC) | ✅ | – | – |
| Search | – | ✅ | – | – |
| Comments | – | ✅ | – | – |
| Users / identity | – | ✅ | – | – |
| Files | ✅ | – | – | ✅ |
| Workers: tools | ✅✅ | – | ✅✅ | – |
| Workers: syncs | ✅ | – | – | – |
| Workers: webhooks | ✅ | – | – | – |
| Workers: ops (env/runs/logs) | – | ✅ | – | ✅✅ |
| Notion-as-Code: workspace/schema | ✅✅✅ | – | ✅✅✅ | – |
| Notion-as-Code: custom agents | ✅ | – | – | – |
| CLI core (auth, api, help) | ✅ | ✅ | – | – |
| API versioning / rate limits | – | – | ✅✅ | ✅ |

**Deliberate exclusions** (documented in the post): the MCP CRUD surface (owned by [MCPMark](https://mcpmark.ai) — 28 Notion tasks; we don't re-implement it), Workers *deployment* (Business-plan-gated; behavior verified via `exec --local` instead), UI-only features (automations, permissions UI, teamspace admin — not exposed to the public API).

**Exhibition (3, outside the 38):** `showcase-001-student-studying` (a study system — spaced repetition, courses, notes, weak spots, assigned reading), `showcase-002-mobile-grooming-business` (a service business — recurring bookings across two vans, supplies, servicing, and whether van two pays for itself) and `showcase-003-twitch-creator` (a content pipeline — VODs to clips to videos, a freelance editor, scripts, sponsor deliverables). Each is one identical open-ended prompt sent to every config; the results are screenshotted and shown as a gallery with objective placard stats under each. Three subjects rather than three attempts at one, so the gallery poses three genuinely different information-architecture problems — a scheduling algorithm, an operational clock, and a flow that changes state as it moves. Unscored by design: `suite: other`, no oracle, verifier always returns 1, skipped by both QC gates.

**Suite assignment:** ~28 of 38 → `benchmark` (published, frozen at v1); ~10 traps/pain-point tasks → `regression`; plus a private holdout (~8 additional unpublished tasks) for contamination detection later.
