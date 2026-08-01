# @notionbench/runner

Runs the benchmark: launches commercial agent CLIs headlessly, one process per
trial, checkpoints every cell, and paces the grid around subscription rate windows.

```bash
notionbench run --dry-run    # the exact plan: grid, argv per config, child env
notionbench run --tasks 'build-nac-*' --configs claude-code-opus-5 --trials 5 --docs both
notionbench run --resume 20260731-120000   # replays that run's recorded grid, exactly
notionbench run --dry-run --resume 20260731-120000
notionbench run --resume 20260731-120000 --redo build-nac-004-board-view-filters
notionbench score results/latest
notionbench status 20260731-120000
notionbench serve results/latest   # live dashboard + /api/status while the run executes
notionbench doctor results/latest  # post-hoc audit: which tasks look invalid?
notionbench configs          # roster + which harnesses have an adapter
notionbench tasks --tasks '*nac*'
```

## Catching an invalid task early

A full grid is 798 cells over several days of paid subscription time. The
expensive failure is not a crash — it is a run that completes beautifully and
whose results have to be thrown away because one task's verifier was wrong the
whole time. Three things exist to make that cheap instead:

| | what it does | when |
|---|---|---|
| [execution ordering](#execution-ordering) | every task gets a verdict from every config in the **first pass**, so cross-config evidence about task N assembles in minutes, not days | while planning |
| [the watchdog](#the-watchdog) | deterministic, in-process; **halts** the run when a task looks invalid rather than hard | while running |
| [`doctor`](#doctor-auditing-a-finished-run) | read-only audit of a finished or halted run — "these tasks look invalid, investigate before publishing" | before publishing |
| [`--redo`](#fix-one-task-and-re-run-only-it) | invalidate and re-run exactly one task's cells | after fixing it |

## Execution ordering

```bash
notionbench run --order trial-major,task-major   # default
notionbench run --order config-major             # the old behaviour, for comparison
```

The order cells execute in does not change any number the benchmark reports. It
changes enormously how fast a broken task is *detectable*.

**`trial-major,task-major` (default)**

```
outer   trial 1 for every (task, config), then trial 2, then trial 3
inner   within a trial, task by task: every config runs task 1,
        then every config runs task 2, …
```

The first pass covers **all** tasks, so the seven verdicts about task N land
within one task-block of each other. Under the previous, implicit ordering —
each config walking its own task list, `config-major` — the seventh config's
verdict on task 30 arrives only after it has independently ground through tasks
1..29, which on a rate-window-paced grid is days after the first config's.
That is the whole gap the watchdog needs closed to be useful.

Concurrency and the serial-per-config rule are untouched: configs still run in
parallel up to `--concurrency`, and a config never has two cells in flight.

### Blocks are soft barriers

A task-block is an *emission order*, never a synchronisation point — **nothing
ever waits for a block to complete.**

The scheduler scans its pending queue front to back and takes the first cell
whose config is neither busy nor cooling down. A config sitting in a 30-minute
Kimi cooldown is simply skipped, and the other six walk straight on into the
next task-block. The straggler's cell keeps its rank, stays pending, and — since
that rank is ahead of everything else in its own lane — is the first thing that
config picks up when its window reopens. It then continues in task order from
there.

The cost is bounded and deliberate: a cooled-down config's verdict on that block
arrives late, so the watchdog may compare 6 of 7 verdicts instead of 7 (its
thresholds are 3 configs, or 60% of the run's configs, precisely so that this is
still enough). The alternative — a hard barrier — would let one config's rate
window idle the other six for half an hour at a time, which over 798 cells is
measured in days.

Retries follow the same rule: a retried cell goes back to *its own place in the
order*, not to the back of the queue, so a flake on task 3 of trial 1 cannot push
that task's first-trial evidence behind the whole of trial 3.

### Recorded and replayed

The policy is written into `results/<runId>/run-spec.json` under `execution.order`
and replayed by `--resume`, for the same reason every other execution knob is:
"the second half of this grid ran in a different order than the first" is exactly
the kind of unrecorded difference the spec file exists to prevent. A run created
before ordering existed has no recorded policy and is replayed as `config-major`
— the order it actually executed — with a note saying so, never as today's
default.

## The watchdog

Deterministic and in-process. **No model is involved** — only counting, set
intersection and string normalization. It is evaluated after every scored cell,
and its one job is to separate:

> *every frontier agent failed this task with the **same** complaint*
> → almost certainly the verifier or the fixture. **Halt.**

from

> *several agents failed this task with **different** complaints*
> → that is what a hard task looks like. **Keep going.**

### Signals and their defaults

| signal | default | halts? | why that number |
|---|---|---|---|
| **cross-config identical failure** — ≥N configs failed the same task in the same trial and their diagnostics share a normalized substring | 3 configs, **or** ≥60% of the configs in the run | yes | 3 is what both real bugs looked like. Three independent frontier models do not produce the same failure *text* by coincidence; they do produce different ones on a genuinely hard task. The 60% arm keeps a narrow grid (`--configs a,b,c`) from being blind. The denominator is the run's config count, never "the configs that have reported so far" — otherwise the first two verdicts of every block are trivially 100% of them. |
| **verifier crash** — `scored: false` after the verifier actually ran | 1 occurrence | yes | The measurement apparatus failed. Never a legitimate agent failure, and every later cell on that task is unmeasured too. |
| **fixture provisioning failure** on a live task | 2 for the same task | yes | One can be a Notion 500. Two on the same `spec.json`, while other tasks provision fine, is the spec. |
| **total-task failure** — every config that attempted it scored 0, no shared diagnostic | 5 configs | **no — warns** | A task all frontier models fail may be broken *or* brutally hard, and NotionBench exists to contain tasks nothing solves. Halting on "hard" would be the benchmark censoring its own headline result. Set `watchdog.totalTaskFailure.halt` to opt in. |
| **infrastructure** — nothing completed in X minutes while work was runnable | 60 min | yes | 4× the 900s per-trial budget, and the stall clock only advances while at least one config was actually free to run, so a legitimate all-configs cooldown cannot trip it. |
| **infrastructure** — free disk below Y GB | 5 GB | yes | Transcripts and workspaces are the run's only durable output. |
| **infrastructure** — every config down | all *blocked* | yes (blocked) / warns (merely cooling) | Every config permanently blocked means the run cannot progress. Every config merely cooling is the normal shape of a paced grid. |

Diagnostics are normalized before comparison — urls, uuids, hex ids, paths,
numbers and quote styles are stripped — so `missing field \`type\` at intents[3]`
and `missing field 'type' at intents[9]` compare equal, while
`rollup aggregation is sum, expected average` and
`relation points at the wrong data source` do not.

### On halt

1. **Stop scheduling new cells.** In-flight cells are *never* killed — they run
   to completion and are scored normally. Killing a trial mid-flight would waste
   the one genuinely expensive thing and leave a workspace unverified; the point
   of halting is to stop spending, not to destroy what has been spent.
2. Write `results/<runId>/ALERT.json` and a banner block into `run.log`.
3. Exit **3**, naming the task, the evidence, and the exact command to re-run it
   after a fix.

```
notionbench run … --no-watchdog          # disable entirely
notionbench run … --watchdog-warn-only   # alert and record, but never stop
```

### When the failure is real: `--ack`

Sometimes the watchdog is right about the evidence and wrong about the
conclusion. On the 798-cell run, `resolve-instructions-001-workflow-canary`
failed in three configs with one diagnostic
(`tool_unknown_category … InvalidToolInputError`) — the halt signature. But the
task's prompt says *"a category nobody has expensed answers with zeros rather
than an error"*, those three configs had pinned their tool's input schema to an
enum so the SDK rejected the call, and two other configs handled it correctly.
The task is fine; the failure is real and belongs in the results.

Both existing escapes throw away the protection of the other 37 tasks.
`--ack` is the surgical one:

```bash
notionbench run --resume 20260801-085000 \
  --ack resolve-instructions-001-workflow-canary:tool_unknown_category \
  --ack-reason "reviewed 2026-08-01: the prompt says an unexpensed category answers with zeros,
                not an error; these configs pinned the tool input schema to an enum, so the SDK
                rejects the call. Two configs handled it. Genuine agent failure."
```

- **Nothing is hidden.** The signal is still detected and still written to
  `ALERT.json`, to `run-spec.json`, to the console and to `doctor` — at
  `level: "acknowledged"`, carrying your reason. The cells are still scored 0 and
  still counted as failures. Only the *halt* is withheld.
- **`--ack-reason` is mandatory.** A suppression with no stated reason is
  indistinguishable from one nobody thought about, and a published run has to be
  able to show which failures a human reviewed and why.
- **Prefer the `task:substring` form.** The substring is matched against the
  *normalized* shared diagnostic (lower-cased, ids/paths/numbers stripped —
  matching is case-insensitive), so a **different** failure mode on the same task
  still halts. The bare `--ack <taskId>` form covers the whole task's
  cross-config-identical-failure and total-task-failure signals, including modes
  nobody has looked at yet.
- **Verifier crashes and fixture-provisioning failures can never be
  acknowledged**, by any spelling of the flag. Those are the measurement
  apparatus failing rather than the agent — the disk-full incident that motivated
  this watchdog presented as a verifier crash — so `--ack` refuses to name them
  and the matcher refuses those alert kinds outright:

  ```
  $ notionbench run … --ack some-task:verifier-crash --ack-reason "…"
  --ack refused: --ack "some-task:verifier-crash" names "verifier-crash", which can never be
  acknowledged. A verifier crash means the verifier returned no usable verdict … Fix the
  verifier or the fixture, then `notionbench run --resume <runId> --redo <taskId>`.
  ```

Acknowledgments are run metadata: they are stored in `run-spec.json` with the
reason, the timestamp and the argv that recorded them, appended to the spec's
history, and **replayed automatically on `--resume`** — so an unattended
overnight resume does not re-halt on something already reviewed, and does not
need the flag re-typed. `--dry-run` prints the ones in force, including inherited
ones, and `doctor` lists every one of them above its own report with the number
of cells it covers (see below).

Thresholds live under `"watchdog"` in `runconfig.json`; every field is optional
and merges over the defaults above:

```json
{
  "watchdog": {
    "crossConfig": { "minConfigs": 3, "minFraction": 0.6, "minSharedChars": 24 },
    "verifierCrash": { "enabled": true, "minOccurrences": 1 },
    "fixtureFailure": { "enabled": true, "minOccurrences": 2 },
    "totalTaskFailure": { "enabled": true, "minConfigs": 5, "halt": false },
    "infrastructure": { "stallMinutes": 60, "minFreeDiskGb": 5 }
  }
}
```

The active alerts are also served on `/api/status` as an additive `alerts` array
(`{level, kind, taskId, configIds, evidence, at, halted}`), so the dashboard can
show that a run stopped and why.

## `doctor`: auditing a finished run

```bash
notionbench doctor results/latest
notionbench doctor 20260801-085000 --json
```

Read-only in the same sense `serve` is: it opens no checkpoint, takes no lock and
writes nothing, so it is safe to point at a run that is still executing. It
re-uses the watchdog's thresholds and diagnostic normalization, so a finished
grid is judged by exactly the rules the live run was judged by.

Per task it reports who attempted it, who solved it, whether the failures share a
diagnostic once ids and paths are stripped, whether the verifier ever failed to
return a verdict, and which cells the runner abandoned — then a plain-English
verdict. Exit code carries it, so it works as a publish gate in CI:

| code | meaning |
|---|---|
| 0 | no *unreviewed* cross-config failure signature — safe to publish (includes the `acknowledged` verdict below) |
| 1 | at least one task is SUSPECT (every config scored 0, for different stated reasons) |
| 3 | at least one task looks INVALID (shared diagnostic, or a verifier crash) |

Acknowledgments (`--ack`) are printed **above everything else**, read from
`run-spec.json` and `ALERT.json`, with the reason and the number of failed cells
each one covers. A run carrying any acknowledgment is never reported as *clean*:

```
ACKNOWLEDGMENTS (1) — human-reviewed failure signature(s) the watchdog was told not to halt on
  this run is NOT clean; every one of these is recorded as a failure and reviewed below
  resolve-instructions-001-workflow-canary:tool_unknown_category
      reason:   reviewed 2026-08-01: the prompt says an unexpensed category answers with zeros…
      covers:   3 failed cell(s) across opus, sol-medium, sonnet; downgraded 1 finding(s)
      recorded: 2026-08-01T21:40:11.204Z  ·  run --resume 20260801-085000 --ack …
  verifier crashes and fixture-provisioning failures are never acknowledgeable, so nothing
  above suppressed a broken measurement.
…
verdict: no invalid tasks detected, but 1 ACKNOWLEDGED failure signature(s) were reviewed and
         suppressed — this run is not clean
```

On the real 35-cell pilot (`20260801-085000`, 34/35, one Sonnet failure):

```
tasks
  build-cli-001-create-page-with-icon          6/7 solved
      - 1 config(s): "no page titled "onboarding checklist" anywhere under the sandbox root"
  build-nac-001-workspace-from-spec            7/7 solved
  …
verdict: no invalid tasks detected
  No task shows a cross-config failure signature: where configs failed, they
  failed for different stated reasons, which is what genuine agent misses look like.
  Safe to publish as far as task validity goes.
```

## Fix one task and re-run only it

```bash
# 1. the run halted, or doctor flagged it
notionbench doctor results/20260801-085000

# 2. fix evals/build-nac-004-board-view-filters/EVAL.ts

# 3. re-run ONLY that task's cells — one command
notionbench run --resume 20260801-085000 --redo build-nac-004-board-view-filters
```

`--redo` is deliberately not just a filter. A filter narrows which *pending*
cells run, and the whole problem with a task found to be broken is that its cells
are already `done`, holding verdicts a wrong verifier produced. So `--redo`
**invalidates** them first:

- the task's rows are moved out of `results.jsonl` into
  `results.superseded.jsonl` (nothing is deleted; the report never reads the
  archive, so the history stays on disk and the decision stays auditable);
- its cells are reset to `pending` with their attempt budget restored and their
  mirrored score cleared, so `notionbench status` cannot keep reporting a verdict
  that has been retired;
- the pass is restricted to exactly those cells — no other task is touched;
- the whole thing is appended to `run-spec.json`'s `history` as a `redo` entry.

It is repeatable and comma-separated (`--redo a --redo b,c`), composes with the
other filters (`--redo t --configs opus` redoes only that config's cells of `t`),
requires `--resume`, and refuses a task that is not in the recorded grid. Add
`--dry-run` to see exactly what would be invalidated without touching anything:

```
resume 20260801-085000
  --redo           build-nac-004-board-view-filters — would INVALIDATE 7 cell(s)
                   (7 already done) and retire 7 scored row(s)
                   retired rows move to results.superseded.jsonl; nothing is deleted
```

Relying on `dedupeByCell` alone (last row per cell wins) would only be safe if
every retired cell were actually re-run in the same pass — and on a multi-day
grid an interrupted re-run is the normal case, which would leave the report
averaging two different verifiers' answers under one task id.

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

## Resume replays the run, not the config file

A full grid is a multi-day experiment: subscription rate windows force many
resumes, most of them unattended. So a run's definition is frozen at creation in
`results/<runId>/run-spec.json` — the resolved task ids, the resolved config
definitions (harness/model/effort/pricing **as they were at launch**), the docs
conditions, the trial count, the execution knobs, and provenance (runconfig path,
a hash of the resolved configs, argv, host, CLI versions).

`--resume <runId>` replays exactly that. It never rebuilds the grid from
`runconfig.json` or from the defaults of the flags you did not type this time.

> This is not hypothetical. Run `20260801-085000` was launched as 5 tasks × 7
> configs × `--docs with` × `--trials 1` = 35 cells. A bare
> `notionbench run --resume 20260801-085000` rebuilt the grid from config
> defaults — 39 tasks × 8 configs × both docs conditions × 5 trials = 3,120 cells
> — printed `3085 new cell(s) added` and started executing: a docs arm the
> project had cut, a config outside the published roster, and k=5 where the
> project chose k=3. ~271h of agent time, noticed by hand after ten seconds.

The rules:

- **Done cells stay done.** Only pending cells (and cells that were in flight when
  the process died) run.
- **Adding cells needs `--expand`.** Any resume that would grow the grid is a hard
  error naming precisely what differs, e.g.
  `refusing to add 3085 cell(s) to run 20260801-085000: --trials 5 vs recorded 1,
  docs with+without vs recorded with, 34 task(s) not in the recorded grid …;
  pass --expand to extend this run`. With `--expand`, the addition is logged
  loudly and appended to the spec's `history` (with the previous grid).
- **Narrowing is allowed.** `--configs`/`--tasks`/`--docs`/`--trials` may restrict
  a pass to a subset of the recorded grid; the excluded cells keep their state.
- **Config drift is reported, never applied.** If a recorded config no longer
  matches `runconfig.json` (model, effort, harness, invocation, pricing…), the
  resume prints a `!! CONFIG DRIFT` block and records it in the spec — and then
  executes the **recorded** definition. Results scored under the old definition
  are therefore never mixed with new ones; measuring the new definition means
  starting a new run.
  *Pricing-only drift is a warning, not an error:* the API-equivalent cost column
  is computed from the recorded pricing, so the run stays internally consistent,
  and hard-failing the unattended overnight resume over an edit that cannot change
  a single token of a trajectory costs more than it protects. Model/effort/
  harness drift is flagged as `CHANGED DEFINITION`.
- **`--dry-run --resume` works and touches nothing** — it prints the replayed
  grid, how much of it is done, and what would run, without resetting an
  interrupted cell or writing a byte.
- **Runs created before `run-spec.json` existed** reconstruct their grid from
  `state.json` — the run's own recorded metadata and completed cells, never the
  current config file. Cells that were never completed and are not in that grid
  (the residue of an unguarded resume) are pruned, and the reconstructed spec is
  persisted so the next resume is exact. If nothing in `state.json` can describe a
  grid, the resume fails with a message instead of guessing.

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
  What the cells *are* is a separate file, `run-spec.json`, written once — see
  [Resume replays the run, not the config file](#resume-replays-the-run-not-the-config-file).

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

The optional `watchdog` block tunes the halt thresholds; every field merges over
the documented defaults, so omitting the block entirely is the same as accepting
them. See [The watchdog](#the-watchdog).

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
