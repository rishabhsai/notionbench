# @notionbench/runner

Runs the benchmark: launches commercial agent CLIs headlessly, one process per
trial, checkpoints every cell, and paces the grid around subscription rate windows.

```bash
notionbench run --dry-run    # the exact plan: grid, argv per config, child env
notionbench run --tasks 'build-nac-*' --configs claude-code-opus-5 --trials 5 --docs both
notionbench run --resume 20260731-120000
notionbench score results/latest
notionbench status 20260731-120000
notionbench serve results/latest   # live dashboard + /api/status while the run executes
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

For a `runtime: live` task that ships a `fixture/spec.json` the sequence grows a
step on each end — **provision → spawn → score → checkpoint → teardown** — see
[Live tasks](#live-tasks-a-real-notion-workspace) below.

`rate_limited` and `spawn_error` trials are *not* scored — the agent never got its
turn, and verifying the untouched fixture would write a spurious 0. `timeout` and
`failed` trials **are** scored: the agent had its wall clock, and whether the
workspace solves the task is the verifier's call, not the runner's. A verifier that
crashes or hangs yields `scored: false` — an absence of measurement, kept distinct
from a zero all the way into the report.

## Live tasks: a real Notion workspace

Most tasks are offline — their starting state is a directory. A `runtime: live`
task's starting state is a *Notion workspace*, so its trials are bracketed by two
extra steps:

```
provision  create fixture/spec.json's pages, databases and rows under a fresh
           per-trial root page; drop notionbench.json (the root id, nothing more)
           into the trial workspace so the agent can find its sandbox
  spawn    …
  score    EVAL.ts receives ctx {apiBase, rootId, idMap, token}
teardown   archive the root page — its whole subtree goes with it
```

The provisioning itself is `evals/_lib/live/provision.ts`; the runner only calls
it. `src/live.ts` locates that library (following `--evals`, overridable with
`NOTIONBENCH_LIVE_LIB`) and imports it lazily — an all-offline run never loads it.

### Setup

```bash
export NOTION_API_TOKEN=ntn_…                        # your integration token
export NOTION_PARENT_PAGE_ID=<page id>               # a page shared with it
notionbench run --tasks 'build-cli-*' --dry-run      # see what it would create
```

| | where | notes |
|---|---|---|
| token | `NOTION_API_TOKEN`, or `NOTIONBENCH_NOTION_TOKENS=a,b` for a pool | **env only.** Never in runconfig.json; one token is leased per live trial and held for its whole duration |
| parent page | `NOTION_PARENT_PAGE_ID`, or `"notion": {"parentPageId": …}` | env wins |
| API base | `NOTION_API_BASE`, or `"notion": {"apiBase": …}` | env wins; defaults to `https://api.notion.com`. A configured value is also exported into the agent's child env, since a config file is not inherited the way the environment is |

**Fixture roots are never created at the workspace level.** A workspace-level
page cannot be archived through the public API, so a run that created one would
leak an un-deletable page per trial. Everything hangs off the shared parent page,
which is why one is mandatory.

### Failing fast

If live tasks are in the grid and the token or the parent page is missing,
`notionbench run` **refuses to start** — before a run directory exists — and says
which is missing and how to set it. Discovering that at cell 300 of a multi-day
grid is the expensive way to learn it. `--dry-run` prints the same diagnosis under
a `live fixtures` section instead of failing, along with how many fixtures the
grid would create, under which page, and against which API base.

### Teardown, orphans and `--no-teardown`

Teardown runs after the verdict is already durable and is **never fatal**: losing
a multi-day run because a cleanup call returned 500 would be absurd. A failed
teardown — or `--no-teardown`, which keeps fixtures for debugging — appends an
ORPHAN line to `results/<runId>/run.log`:

```
2026-07-31T…Z  ORPHAN live fixture retained  <runId> <cell>  root=<page id>  reason=…
               reap: PATCH https://api.notion.com/v1/pages/<id> {"in_trash":true} (or open … and delete it)
```

That line is what an orphan reaper (or a human) needs: `grep ORPHAN
results/<runId>/run.log`. The run also prints a count at the end. Successful
provisions and teardowns are logged to the same file, so `run.log` is a complete
account of what the run did to the workspace.

### Verifiers

A live `EVAL.ts` resolves its workspace through `resolveLiveContext`
(`evals/_lib/live/context.ts`): ctx first, then `NOTION_API_BASE` /
`NOTION_API_TOKEN` / `NOTIONBENCH_ROOT_ID` / `NOTIONBENCH_ID_MAP`, then the trial
workspace's `notionbench.json`. The runner passes ctx, which is the only channel
that carries the **id map** — the fallbacks can recover the root page and nothing
else. A verifier that only needs the root still grades correctly if ctx is ever
missing, which is the difference between "one cell is unscored" and "the run is
silently zeroed".

Live tasks are gated in CI by `pnpm --filter @notionbench/evals run qc:live`,
which provisions each spec into an **in-process fake Notion**
(`evals/_lib/live/fake-notion.ts`, port 0) and asserts oracle=1 / wrong=0 /
null=0 plus that teardown really trashed the root. No network, no token.

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

## Watching a run (`serve`)

```bash
notionbench serve results/latest --port 8377          # random token, printed
notionbench serve results/latest --key $NB_DASH_TOKEN # pin one instead
```

It prints a ready-to-open URL that carries both the API base and the token in the
hash:

```
http://127.0.0.1:8377/#api=http://127.0.0.1:8377&key=<token>
```

`GET /api/status` returns the `schemaVersion: 1` payload `web/js/schema.js`
consumes, assembled on demand from the run's `state.json` + `results.jsonl` (+
`runconfig.json` for labels). `serve` also hosts `web/` itself, so that one command
is a working private dashboard with nothing else installed.

- **Read-only.** No checkpoint is opened, no lock taken; pointing it at the
  directory a run is actively writing is safe. Each request re-reads a file only
  when its mtime+size changed, so a 10s poll costs three `stat`s on a quiet run.
- **The token is the gate.** `Authorization: Bearer <key>` on `/api/*` (401
  otherwise) and `Access-Control-Allow-Origin: *`, so the dashboard works from a
  `file://` copy or another host. The static assets are *not* token-gated — a
  browser cannot attach a header to a top-level navigation, and they carry no run
  data. Bind stays on loopback unless you pass `--host`.
- Config status maps checkpoint cells to `pending` / `running` / `done`, and the
  scheduler's mirrored rate-window state (`results/<run>/rate-window.json`) to
  `cooldown` / `blocked`.

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

The optional `notion` block configures live fixtures:

```json
{
  "notion": {
    "parentPageId": "1f0e…",
    "apiBase": "https://api.notion.com"
  }
}
```

Both fields are overridden by `NOTION_PARENT_PAGE_ID` / `NOTION_API_BASE`, both
are validated at load (a bad `apiBase` is a config error, not a run-time 404), and
a `token` key is **rejected** — runconfig.json is checked in, so the integration
token stays in the environment. See [Live tasks](#live-tasks-a-real-notion-workspace).

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
