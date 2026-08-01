# @notionbench/runner

Runs the benchmark: launches commercial agent CLIs headlessly, one process per
trial, checkpoints every cell, and paces the grid around subscription rate windows.

```bash
notionbench run --dry-run    # the exact plan: grid, argv per config, child env
notionbench run --tasks 'build-nac-*' --configs claude-code-opus-5 --trials 5 --docs both
notionbench run --resume 20260731-120000
notionbench score results/latest
notionbench status 20260731-120000
notionbench configs          # roster + which harnesses have an adapter
notionbench tasks --tasks '*nac*'
```

## One trial: spawn → score → checkpoint

`run` does all three per cell, in that order, and the order is the contract:

1. **spawn** the agent CLI in a prepared trial workspace (see `@notionbench/sandbox`);
2. **score** it by running the task's `EVAL.ts` in a child process
   (`@notionbench/scoring`), *while the workspace still exists* — cleanup happens
   in `finally`;
3. **append** the merged row to `results/<runId>/results.jsonl` (fsynced), and only
   then **checkpoint** the cell as done. A crash in between costs a re-run of one
   cell, never a cell that claims a verdict nothing recorded.

`rate_limited` and `spawn_error` trials are *not* scored — the agent never got its
turn, and verifying the untouched fixture would write a spurious 0. `timeout` and
`failed` trials **are** scored: the agent had its wall clock, and whether the
workspace solves the task is the verifier's call, not the runner's. A verifier that
crashes or hangs yields `scored: false` — an absence of measurement, kept distinct
from a zero all the way into the report.

## Reporting

```bash
notionbench score results/latest          # markdown to stdout + results/<run>/summary.md
notionbench score 20260731-120000 --k 3   # count 3 trials per task
notionbench score results/latest --json
```

`score` reads nothing but `results.jsonl`, so an archived results tree produces the
same numbers years later. It prints the README config table (avg@k with a Wilson
interval, pass^k, tool errors, tokens, API-equivalent cost, wall time) plus
per-product-area, per-stage and per-docs-condition breakdowns. Stage comes from the
task id prefix, the `<stage>-<area>-<nnn>-<slug>` convention docs/COVERAGE.md fixes.

## Dry runs

`notionbench run --dry-run` prints the full execution plan — the grid, every task
with its real timeout and prompt size, the **exact argv** each config will be
spawned with (prompt elided), and the environment every child will see, including
which API-key variables are about to be stripped. It is strictly read-only: no
`<cli> --version` probe, no run directory, no checkpoint. `--json` emits the same
plan as data.

## Headless invocation

Both forms below were verified against the CLIs installed on the authoring machine
(`claude 2.1.220`, `codex-cli 0.144.6`) by capturing real output, not from memory.
Auth is the operator's **subscription** — `buildTrialEnv` strips `ANTHROPIC_API_KEY`
and `OPENAI_API_KEY` from every child so a stray key cannot silently reroute billing
and change what is being measured.

**Claude Code**

```
claude -p "<prompt>" \
  --output-format stream-json --verbose \
  --model <opus|fable|haiku|claude-opus-5|…> \
  [--effort <low|medium|high|xhigh|max>] \
  --permission-mode bypassPermissions \
  --strict-mcp-config --setting-sources project \
  --no-session-persistence
```

- `--verbose` is **required** with `-p --output-format stream-json`; without it the
  stream is suppressed.
- `--strict-mcp-config --setting-sources project` keeps the operator's personal MCP
  servers, plugins and skills out of the measurement while still letting the task
  workspace's own `AGENTS.md` / `CLAUDE.md` / `.claude/skills` load — which is
  exactly what the docs axis manipulates.
- Usage comes from the terminal `{"type":"result",…}` message
  (`usage.input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`,
  `output_tokens`, plus `total_cost_usd` and `modelUsage`).
- `{"type":"rate_limit_event","rate_limit_info":{"status":…,"resetsAt":…}}` is the
  structured rate-window signal; `status: "allowed"` is emitted on every turn and is
  the happy path.

**Codex**

```
codex exec "<prompt>" \
  --json --skip-git-repo-check \
  -C <workspace> -s workspace-write \
  --ignore-user-config --ephemeral \
  -m gpt-5.6-sol \
  -c approval_policy="never" \
  -c model_reasoning_effort="<minimal|low|medium|high|xhigh>"
```

- Reasoning effort is **not a flag** — it is a `-c` TOML config override.
- Codex reads piped stdin and appends it to the prompt as a `<stdin>` block, so the
  runner attaches `stdio: 'ignore'` for stdin. Leaving it open changes the prompt (or
  hangs).
- Usage comes from `{"type":"turn.completed","usage":{…}}`.

**Any other CLI** — the README's v1 requirement that any prompt-in/files-out agent
CLI works — via the `command-template` harness:

```json
{
  "id": "opencode-sonnet",
  "harness": "command-template",
  "command": "opencode",
  "argsTemplate": ["run", "--model", "{model}", "--cwd", "{workspace}", "{prompt}"],
  "model": "anthropic/claude-sonnet-5"
}
```

Placeholders: `{prompt}` `{workspace}` `{model}` `{effort}` `{configId}`. Set
`"promptVia": "stdin"` for CLIs that read the prompt from stdin (the pipe is closed
straight after writing). The template is refused at config time if it would never
deliver the prompt. Token accounting for this harness is a **heuristic** — it scans
JSON lines for usage-shaped objects, records what it picked and why in
`parseWarnings`, and reports `null` rather than fabricating zeros when a CLI is
silent. Configs whose token numbers are load-bearing should get a real adapter.

### The cache-accounting trap

The two harnesses use **opposite conventions** and getting this wrong silently
doubles or halves the headline token numbers:

| | Claude Code | Codex |
|---|---|---|
| `input_tokens` | **excludes** cache reads/writes | **includes** cached input |
| cache fields | `cache_read_input_tokens`, `cache_creation_input_tokens` | `cached_input_tokens` |
| total | in + out + cache-read + cache-write | in + out |

`TokenUsage.inputTokensIncludeCached` records which convention produced a row, and
`apiEquivalentCostUsd` subtracts cached input before pricing when it is `true`.

## Design notes

- **Transcripts are lossless.** `results/<run>/<task>/<config>/docs-<cond>/trial-N/transcript.jsonl`
  stores the raw line of every stdout/stderr chunk (`{"t":…,"s":"out","raw":…}`),
  bracketed by `meta` records carrying argv, cwd, CLI version and the final parsed
  usage. Agent CLI JSON drifts between releases; re-parsing must never require
  re-running a trial. Env var *names* are recorded, never values —
  `NOTION_API_TOKEN` appears as `NOTION_API_TOKEN=<redacted>`.
- **A rate window is not a failure.** A trial killed by a usage cap refunds its
  attempt, requeues at the front, and pauses only *that* config
  (`--cooldown-min`, default 30). Other configs keep running. Text patterns are
  configurable (`rateWindow.patterns`) because the wording drifts, and free-text
  matches only count when the run also failed — otherwise the
  `operate-batch-001-rate-limited-writes` task would flag itself.
- **Serial per config, concurrent across configs.** Two trials of the same config
  would race through the same subscription window; the global cap defaults to 2.
- **Timeouts kill the process group.** Trials spawn `detached`, so SIGTERM (then
  SIGKILL after `killGraceMs`) reaches the agent's own `bash` grandchildren instead
  of orphaning them on the host.
- **A non-zero exit or a timeout still marks the cell `done`.** "Done" means *we
  have a trajectory to score*; the host-side verifier, not the runner, decides
  pass/fail. Only infrastructure problems (spawn errors, workspace prep failures)
  consume the retry budget.
- **Checkpoints are crash-safe.** `results/<run>/state.json` is written
  temp-then-rename on every mutation, writes are serialized, and `resume()` returns
  cells that were in flight when the process died to `pending` *without* refunding
  their attempt — so a cell that reliably kills the runner eventually gives up.

## Configuration

Copy `runconfig.example.json` to `runconfig.json` at the repo root. The built-in v1
roster lives in `src/config.ts`; `tera` and `luna` are present but **disabled**,
with TODOs, because their headless invocation is unverified and no adapter is
registered — scheduling them throws rather than silently reporting null usage.

## Testing

```bash
pnpm --filter @notionbench/runner test
```

`test/fake-bin/{claude,codex}` are shell scripts that shadow the real CLIs on `PATH`
and replay the captured fixtures in `test/fixtures/`. They also expose
`FAKE_CLI_ARGV_OUT` / `FAKE_CLI_ENV_OUT` / `FAKE_CLI_STDIN_OUT` / `FAKE_CLI_PID_OUT`
so the spawn tests can assert on the exact argv, the child environment, that stdin
really is closed, and that a timeout kills grandchildren. No network, no
subscription, no tokens burned.
