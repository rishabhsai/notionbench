# Notion Evals ("NotionBench") — Master Plan
*Updated 2026-07-31. Model-comparison edition.*

## One-liner
An open benchmark measuring **which LLM is best at building on Notion's developer platform** — `ntn` CLI, Workers, and Notion-as-Code — with fully programmatic verification, published as a repo + results blog post. "Supabase Evals, for Notion, done more rigorously."

## What changed vs. earlier drafts
- **Run via subscriptions (Claude Code sub + Codex sub), like Supabase did.** Unit of measurement = **agent config** (harness × model × reasoning effort), not raw API model. Runner shells out to the installed CLIs in headless mode (`claude -p`, `codex exec`) inside the sandbox, authenticated via the user's subs. Cross-vendor rows are therefore model+harness bundles (that's what a reader choosing a tool actually experiences — same framing as Supabase Evals); within-vendor rows (Opus 5 vs Fable 5 under identical Claude Code) ARE clean model comparisons — say so explicitly in the post.
- **Configs (pin harness CLI versions in run metadata):**
  - Claude Code × Opus 5
  - Claude Code × Fable 5
  - Codex × GPT-5.6 Sol — medium reasoning
  - Codex × GPT-5.6 Sol — high reasoning
  - Tera / Luna — only if a sub or affordable API path exists (verify; else cut)
  - +1 budget config (e.g. Claude Code × Haiku 4.5) for the cost-Pareto story
- **Cost reporting under subs:** actual $ spend is a flat subscription, so report **tokens (from each CLI's own usage output) + API-equivalent cost** computed from published per-token prices (state this method in the post; it's what the terminal-bench leaderboard effectively does).
- **Pacing:** subscription rate windows (5-hour/weekly caps) mean the full grid runs over several days — schedule trials in batches per config; the runner must checkpoint/resume (task×trial granularity) so a rate-limit stall never loses work.
- (Superseded: earlier draft used a neutral inspect-ai scaffold with raw API models; kept as a possible "scaffold-normalized" appendix run if API budget appears.)
- **Report mirrors Notion's own internal eval table** (their Apr 24 teaser): av score %, av tool calls, total tool errors, av/total tokens, av/total time — plus our additions: **cost USD/solved task, pass^5 (reliability), Wilson 95% CIs**.

## Task suite — 30 tasks, 4 families

### A. `ntn` CLI operations (9 tasks, L1–L3) — live workspace verify
1. Identity/auth sanity: use `ntn api` to find the bot user + workspace id, write to answer file.
2. Create a page with specified title/icon/parent via CLI.
3. Query a data source with filter+sort, export matching rows to JSON (exact-match verify).
4. Add a `select` property with specific options/colors to an existing data source.
5. Bulk archive all rows matching a condition (verify survivors + archived set).
6. **Pagination trap**: aggregate over a 250-row data source (>100/page forces cursors; catches silent truncation).
7. Upload a file via `ntn files create` and attach it to a page.
8. **Version-confusion fix**: repair a failing script that conflates `database_id`/`data_source_id` (post-2025-09-03 model split — punishes stale training knowledge).
9. Markdown surgery: `GET /pages/{id}/markdown`, edit one section, `PATCH` back without clobbering the rest.

### B. Workers (9 tasks, L2–L4) — verified via `ntn workers exec --local` (no deploy, no Business plan)
10. Scaffold a worker exposing tool X with correct input schema.
11. Tool with `outputSchema` + graceful handling of missing fields.
12. Sync worker against a local mock API (fixture JSON server) — pagination + upsert `changes[]` correctness.
13. Webhook worker that mutates a database via `context.notion` (live verify).
14. Dedup tool: flag duplicate rows in a fixture DB (live verify).
15. Enrichment tool: given a page id, compute + write derived properties (live verify).
16. **Fix-the-broken-worker**: schema/behavior bug provided; make behavioral tests pass.
17. Multi-tool worker with shared state discipline (stateless-between-invocations correctness).
18. **Instruction-compliance canary**: task where the hidden `worker.workflow()` API is tempting; template's AGENTS.md forbids it. Score = did the agent obey repo instructions over its priors.

### C. Notion-as-Code (8 tasks, L2–L4) — verified OFFLINE via compiled `dist/intents.json` (pure build, no Notion account needed)
19. Author a workspace from an English spec (DB, properties, seeded rows) → canonical intents match.
20. **Data-driven generation**: build reads a provided CSV and seeds rows from it.
21. **Idempotency**: extend an existing NAC project per spec WITHOUT changing any existing `resourceId` (the apply-twice-no-duplicates property).
22. **Migration**: change property types/options per spec, resourceIds stable, seeded data preserved.
23. Two-way relation + rollup across two databases (cross-reference resolution).
24. Board view with groupBy + filters (within the flat-filter model).
25. Page content authoring in Notion-flavored Markdown (callouts, toggles, tables) → intents content match.
26. Full mini-workspace: teamspace + 2 DBs + views + pages from one spec (integration task).

### D. Platform ops/debugging (4 tasks, L2–L3)
27. Diagnose a failing worker from `ntn workers runs logs` output (fixture logs) → written root cause + fix.
28. Env/secrets workflow: `ntn workers env set/pull` correctly (mock).
29. Read the docs task: answer questions requiring the CLI's own `--help` / docs discovery (progressive disclosure).
30. Rate-limit-aware batch: script a 50-write batch that respects 3 req/s (verify timing + completeness).

### The docs axis (the original contribution)
Every task runs in two conditions: **docs-provided** (Notion's own AGENTS.md/skills in the sandbox) vs **docs-withheld**. Headline chart #2: which model best learns a 2-month-old API from documentation. Platform is too new for training contamination — time-limited advantage, credibility asset.

## Suite structure & governance (adopted from Supabase Evals, hardened)
Every task declares a `suite` in its frontmatter: **benchmark | regression | other**.

- **Benchmark suite (published, frozen per version).** The smallest diverse set touching every dimension at least once — this is what the blog post and leaderboard report. Runs only when evaluating a new model or a new harness version. Frozen as `v1` once published: tasks never edited in place (fixes → `v1.1` with full re-run; additions → `v2`). This is what keeps published numbers comparable over time — the LiveBench/terminal-bench lesson Supabase leaves implicit.
- **Regression suite (grows freely, never affects published scores).** Known failure modes and pain-point traps harvested from bug reports/GitHub issues (our pagination-truncation, version-confusion, workflow-canary tasks start here; the best graduate into benchmark v2). Cheap to run often; also where new task ideas incubate before promotion.
- **Other**: experiments, docs-axis extras, holdout candidates.

**Dimension tags (frontmatter), Supabase-style — benchmark set must cover each at least once:**
- `family`: cli | workers | nac | ops (product area)
- `stage`: build (create something new) | resolve (fix/debug something broken) — we currently skew ~70/30 build; benchmark set should be closer to 60/40
- `topics`: pagination, schema-migration, relations, markdown, rate-limits, instruction-following, …

**Task frontmatter format** (PROMPT.md + verifier module, mirroring their `PROMPT.md`/`EVAL.ts`):
```yaml
id: nac/idempotent-extend
suite: benchmark
family: nac
stage: build
topics: [resource-ids, idempotency]
difficulty: L3
fixture: none          # none | rest | live
verify: [static, intents]   # layers used
limits: {time: 900, cost: 3.0}
```

**Two runtimes** (theirs: tools-evals vs local-stack; ours):
- `offline` — Family C + parts of D: no Notion account, pure build/exec-local. Free CI smoke suite.
- `live` — Families A/B: Docker sandbox + real `ntn` against the leased workspace fixture.

**Retry policy — deliberate divergence from Supabase:** they grade after one retry; we run k=5 independent trials and report avg@5 *and* pass^5 instead. A retry averages luck into the score; separate discovery (pass@1) from reliability (pass^5) is strictly more informative. Called out explicitly in the blog post's methodology section.

## Verification design (3 layers + QC)
- **Layer 1 static** (in sandbox, free): `tsc --noEmit` / `npm run check`.
- **Layer 2 behavioral** (deterministic, offline): `ntn workers exec --local` with fixed inputs → assert JSON output; NAC tasks → **canonical intents comparison**: normalize intents.json (stable sort, strip order-irrelevance), compare against oracle's intents **up to resourceId renaming** (graph-isomorphism-style: names may differ, structure + internal references must match; idempotency/migration tasks additionally pin resourceIds).
- **Layer 3 state** (live): host-side Python (notion_client) asserting on the per-sample fixture subtree; ID-anchored, diagnostic stderr per assertion; MCPMark-style but never inside the sandbox.
- **QC per task (CI-enforced)**: oracle solution passes; null agent fails; a plausibly-wrong solution fails.
- **Anti-cheat**: verifiers host-side only; sandbox network allowlist = api.notion.com only (bench repo blocked); no git history in fixtures; k=5 trials; all trajectories published; ~25% task holdout kept private.

## Fixtures & isolation
- Fixtures provisioned per-trial via REST SDK scripts (default) under a per-sample root page; NAC `apply` optional later.
- Per-sample env: `NOTION_HOME=<tmpdir>`, `NOTION_KEYRING=0`, `NOTION_API_TOKEN=<leased token>`; token pool sized to concurrency; host-side token bucket ~2.5 req/s/token; orphan reaper archives stale run roots.
- Family C needs no Notion account at all → it's also the free CI smoke suite.

## Metrics & blog post
- Headline: avg@5 score with Wilson 95% CI, per family and overall.
- Reliability: pass^5 (unbiased C(c,k)/C(n,k)).
- Cost: USD per solved task; Pareto chart (score vs $). Tool-error counts (mirror Notion's table).
- Chart 2: docs-provided vs withheld delta per model.
- Post structure: why (Supabase Evals for Supabase; Notion's platform is "built for agents", nobody measures it publicly; Notion evals models internally — closed) → method → results → failure-mode gallery (concrete trajectory excerpts) → repo.

## Budget & sequence
- ~30 tasks × 5 trials × 7 model-configs × 2 doc conditions ≈ 2,100 rollouts ceiling. Control: run docs-axis on a 12-task subset → ~1,260 rollouts. Est. $800–2,500. Trim models before trimming trials.
- Week 1: harness skeleton + Family C offline pipeline + 5 pilot tasks (C first — zero external deps) + QC CI.
- Week 2: Families A/B/D + fixtures + token pool + full QC.
- Week 3: pilot runs (2 models), fix task bugs, then full run + analysis + post.

## Open items
- Confirm Tera/Luna API model IDs + pricing before the full run.
- Notion account tier check: A/B/D need a real workspace + PAT/integration tokens (Plus tier likely fine since Workers use --local; verify PAT creation policy on user's plan).
- Decide holdout split (suggest 8 of 38 authored; publish 30).
