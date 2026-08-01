# NotionBench

**How well do AI coding agents build on Notion's developer platform?**

An open benchmark that runs coding agents — Claude Code, Codex, and friends — against real tasks on the [Notion developer platform](https://developers.notion.com): the `ntn` CLI, Workers, and Notion-as-Code. Every task is scored by **deterministic, programmatic verification** — no LLM judges.

> Inspired by [Supabase Evals](https://supabase.com/evals), [Terminal-Bench](https://www.tbench.ai), [MCPMark](https://mcpmark.ai), and [τ-bench](https://github.com/sierra-research/tau-bench). Notion's platform shipped in May 2026 and is explicitly "built for AI coding agents" — this measures that, publicly and reproducibly.

## Results

*Coming soon — first run in progress.*

| Agent config | Score (avg@3) | pass^3 | Tool errors | Tokens | API-equiv cost | Time |
|---|---|---|---|---|---|---|
| OpenCode × Kimi K3 | – | – | – | – | – | – |
| Claude Code × Opus 5 (high) | – | – | – | – | – | – |
| Claude Code × Sonnet 5 (high) | – | – | – | – | – | – |
| Codex × GPT-5.6 Sol (medium) | – | – | – | – | – | – |
| Codex × GPT-5.6 Luna (high) | – | – | – | – | – | – |
| Claude Code × Fable 5 | – | – | – | – | – | – |
| Codex × GPT-5.6 Sol (xhigh) | – | – | – | – | – | – |

Grouped by product area, stage (build / investigate / resolve / operate), and docs condition.

## Design in one minute

- **38 tasks** across 4 stages and every programmable Notion surface — see [docs/COVERAGE.md](docs/COVERAGE.md).
- **Two suites** (`benchmark` = published, frozen per version; `regression` = known failure modes, grows freely, never affects published scores).
- **Three verification layers**: static (typecheck), behavioral (`ntn workers exec --local`, canonical intents comparison for Notion-as-Code — both offline & deterministic), and live workspace state assertions (host-side, never visible to the agent).
- **k=3 independent trials** per task for v1 (extending to 5 via checkpoint/resume); we report avg@k with Wilson intervals *and* pass^k (reliability) — no "retry then grade."
- **Docs axis**: every config runs docs-provided vs docs-withheld — measuring which model best learns a brand-new API from its documentation.
- **QC per task (CI)**: the oracle solution must pass, a null agent must fail, and a plausibly-wrong solution must fail.

## Repository layout

```
evals/<id>/            one task: PROMPT.md (frontmatter + instruction), EVAL.ts (scorer),
                       fixture/ (workspace state), solution/ (oracle), wrong/ (QC foil)
packages/core/         task metadata schema, frontmatter parsing, canonical types
packages/runner/       spawns agent CLIs headless in the sandbox; checkpoint/resume
packages/sandbox/      Docker environment (ntn, Node 24, templates preinstalled)
packages/scoring/      verification layers: intents canonicalizer, exec-local driver,
                       live-state assertion helpers, stats (pass^k, Wilson)
docs/                  COVERAGE.md (task × dimension matrix), methodology notes
```

## Status

🚧 Early scaffold. Task authoring in progress. Watch the repo for the first results post.

## License

MIT
