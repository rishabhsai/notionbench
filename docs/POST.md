# How well do coding agents build on Notion's developer platform?

*Draft — numbers are from the run in progress and will be regenerated when it lands.*

Notion shipped a developer platform in May 2026 — the `ntn` CLI, Workers, and
Notion-as-Code — and said it was built for AI coding agents. We wrote 38 tasks
across every programmable surface of it and ran eight agent configurations
through them three times each. Every rollout is graded by a program. No model
judges anything.

The headline: **Codex with GPT-5.6 Luna scored 98.2%, one point behind Opus 5,
for $2.18 against Opus's $66.01.**

---

## Results

| Config | Solve rate | Reliable (3/3) | Tool calls/trial | Tool error rate | Cost | Median time |
|---|---:|---:|---:|---:|---:|---:|
| Claude Code × Opus 5 | **99.1%** | 97.4% | 16.6 | 3.0% | $66.01 | 1m26s |
| Claude Code × Fable 5 | 98.2% | 97.4% | 12.0 | 4.4% | $99.37 | 1m11s |
| **Codex × GPT-5.6 Luna (high)** | **98.2%** | 94.7% | 14.4 | 16.9% | **$2.18** | 1m31s |
| Codex × GPT-5.6 Sol (xhigh) | 95.6% | 94.7% | 14.1 | 15.9% | $57.65 | 1m56s |
| Claude Code × Sonnet 5 (high) | 94.7% | 89.5% | 16.1 | 5.0% | $50.84 | 1m02s |
| Codex × GPT-5.6 Sol (medium) | 93.9% | 92.1% | 11.7 | 20.1% | $48.30 | 1m30s |
| OpenCode × DeepSeek V4 Flash | 85.7% | 69.0% | 20.4 | 0.6% | $0.53 | **54s** |
| OpenCode × Kimi K3 | — | — | 16.3 | 1.5% | $5.00 | 3m04s |

**Solve rate** is the share of all trials solved, with a 95% Wilson interval.
**Reliable** is the share of tasks solved in all three trials. Cost is
API-equivalent — token counts are measured and priced at public list rates,
while the runs themselves were on subscriptions.

---

## Four things the numbers say

### Price and capability have come apart

Luna costs $0.20 per million input tokens. Fable costs $10. On this suite they
score within a rounding error of each other. Per point of solve rate, Luna costs
$2.22 and Fable costs $101.14.

DeepSeek V4 Flash goes further down: 85.7% for **53 cents**, or $0.61 per point.
If you are wiring up Notion automations and can tolerate retrying a task
occasionally, the cheap tier now works.

### Reliability is a separate axis, and one column shows it

DeepSeek solves 85.7% of trials but only 69.0% of tasks *every* time. It never
failed a task outright — all 38 were solved at least once — so nothing here is
beyond it. It does not converge on the same task twice.

Its failures are also not near-misses. When DeepSeek fails, 23% of the
verifier's subscores pass. When Sonnet fails, 62% do. DeepSeek either does the
task properly or goes substantially off-track.

Meanwhile it makes more tool calls than any other config, 20.4 per trial against
Opus's 16.6, with the fewest errors at 0.6%, in the least time. Fast, busy,
accurate per action, unreliable per task. One score column hides all of that.

### Tool errors belong to the harness, not the model

| harness | tool error rate |
|---|---:|
| OpenCode | 0.6 – 1.5% |
| Claude Code | 3.0 – 5.0% |
| Codex | **15.9 – 20.1%** |

One in five Codex tool calls fails. The three Codex rows span two models at
three reasoning efforts and land within four points of each other, while Claude
Code's three models cluster just as tightly somewhere else. Whatever produces
that number lives in the scaffold.

It does not stop Codex scoring well — Luna is third overall — so the errors are
recoverable. Still, 30× is a wide spread for a metric nobody publishes.

The tails differ too. Claude Code hit the 15-minute ceiling twice and ran one
task to 18 minutes. Codex never exceeded 6 minutes across 342 trials.

### Workers is the hard part of the platform

Failures by family, across every config:

| family | failures |
|---|---:|
| Workers | 23 |
| Notion-as-Code | 12 |
| CLI | 8 |
| Ops | 6 |

Almost every configuration scored 100% on CLI tasks. Workers pulled everyone
down: 83% for both Sol tiers, 93% for Fable and Luna, 100% only for Opus. The
two hardest tasks in the suite are both Workers tasks, at 57% and 58%.

The shape of those failures suggests a documentation gap rather than a model
gap. Workers have a lifecycle — register a capability, name it, wire it to a
trigger — and the agents that failed usually skipped a step rather than getting
one wrong. Three configurations left the template's default `sayHello` tool
registered and never added the handler the task asked for.

---

## The suite is already saturating

21 of 38 tasks were solved by every configuration on every trial. Only 17
discriminate at all, and the top six sit between 93.9% and 99.1% — narrow enough
that ranking them on solve rate alone is close to reading noise.

Opus missed once in 114 trials: on a single trial of a search task it did all
the work and never wrote the answer file.

For v2 the interesting tasks are the ones that already hurt — Workers
lifecycles, instruction compliance, silent pagination — and the easy CLI tasks
should become a smoke test rather than a scored suite.

---

## How a task is graded

Three layers, chosen per task, all deterministic:

**Static.** The project typechecks and builds. Necessary, never sufficient.

**Behavioral.** `ntn workers exec --local` runs a Worker offline and
deterministically, which makes Workers testable without a Business plan or a
deployment. For Notion-as-Code, the build emits `dist/intents.json` and we
compare it to the oracle's canonically.

**Live state.** The verifier reads the workspace back through the public API and
asserts on what is actually there. Each trial gets a freshly provisioned
fixture, leased and torn down per cell. The agent never sees the verifier, the
fixture spec, or the oracle.

Every task passes a gate in CI before it can run: the oracle scores 1, a
plausibly-wrong solution scores 0, and a null agent scores 0. A task that cannot
fail its own foil measures nothing.

### Canonical comparison, and four spellings that broke it

Notion-as-Code lets you write the same workspace many ways, starting with
author-chosen resource IDs, so two correct programs differ in every identifier.
The canonicalizer relabels IDs from structure using graph refinement, so
isomorphic documents become byte-identical.

Getting "the same workspace" right was most of the work. Four times a correct
answer was marked wrong because the SDK permits two spellings and our oracle had
picked one:

| the two spellings | what we were doing |
|---|---|
| a view inline on a database vs. a separate `view` intent | treating them as different workspaces |
| `groupBy.type` omitted (derivable) vs. stated | requiring it |
| `visible: false` vs. `visibility: "hide"` | understanding only the boolean |
| `hidden: false` vs. omitting `hidden`, already the default | reading a redundant default as disagreement |

Each surfaced the same way: several independent frontier models failing one task
with the same complaint. Models do not fail identically; broken verifiers do,
and the run halts on that signature automatically.

---

## What a failure actually means

"Config X failed task Y" was at least five different claims in this run, and
only one of them is about the agent.

**1. Our verifier was wrong.** The four spellings above, plus three cases where
an assertion encoded a wrong belief about Notion that our fake server happened
to satisfy. Views report a filter property as an opaque ID rather than a name.
The schema percent-encodes those IDs (`"C~m%7C"`) while views reference them raw
(`"C~m|"`), so only some properties failed to resolve and it read as
intermittent. And `GET /pages/{id}/markdown` never renders the page title into
the body, so one task demanded a line Notion does not send and every config
failed it having done the work correctly.

CI cannot catch that class, because CI validates against the fake. A second
check now provisions the real fixture and runs the real oracle against
`api.notion.com`. Sweeping all 18 live tasks with it also caught a fixture
describing a workspace Notion will not build: Notion folds every page-level
comment into a single discussion, so a fixture declaring two threads silently
got one, and agents were marked wrong for reporting the shape the spec promised.

**2. The environment was wrong.** Codex's sandbox blocks network access by
default, so every live task failed with "cannot resolve api.notion.com" until we
set `network_access=true`. Claude Code refuses to run as root. Ubuntu's
restriction on unprivileged user namespaces broke Codex's sandbox outright. None
of these are facts about a model.

**3. The provider stopped answering.** One account hit a weekly usage limit
mid-run. Its CLI hangs on exhaustion, with no error and nothing on stdout or
stderr, so the harness cannot tell it apart from a slow agent and records a
900-second timeout. Later the same CLI ran out of balance and failed properly in
two seconds with a clear message. Same tool, same account, two failure
behaviours, and the silent one costs a day. Cells where the agent never ran
carry 0 tool calls and 0 tokens, so they are identifiable afterwards and get
re-run rather than published as zeros.

**4. The agent could do it and did not follow the instruction.** One task says
*"Keep that wording exactly."* A configuration paraphrased it, built everything
else correctly, and failed on wording it was told not to change. Re-run on fresh
rollouts it got it right three times out of three, which makes it a property of
the rollout rather than the model, and the argument for k > 1. Another task
states that an unknown category returns zeros rather than an error; three
configurations pinned the tool's input schema to an enum, so the SDK rejected
the value before their handler ran. Arguably better engineering, and not what
the task specified.

**5. The agent could not do it.** Missed pagination, wrong property type, never
registered the webhook handler. This is the category the benchmark is for, and
the one people assume every failure belongs to.

A benchmark reporting only category 5 while quietly containing 1 through 4
publishes a number that means less than it looks like. Ours are separated
because we had to find each one to trust the rest.

---

## Keeping a multi-day run honest

798 cells take days, and a task whose verifier is wrong invalidates every cell
that touched it.

- **Trial-major ordering.** The first pass covers every task once, so all
  configurations' verdicts on task N land minutes apart instead of days apart.
  That is what makes a bad task detectable early.
- **A deterministic watchdog** halts the run when three or more configurations
  fail the same task in the same trial with the same normalized diagnostic. A
  verifier crash halts on the first occurrence. A task everyone fails for
  different reasons is flagged and never halted, since that is also what a hard
  task looks like.
- **Reviewed failures are acknowledged, not hidden.** `--ack` records the exact
  signature and a reason, and `doctor` stops calling the run clean afterwards.
  Verifier crashes and fixture failures can never be acknowledged.
- **Nothing is deleted.** Corrections retire rows to
  `results.superseded.jsonl`. This run has 198 of them, each carrying its reason.
- **Trial artifacts are kept.** The agent's `dist/intents.json`, `answer.json`
  and source are copied next to the verdict before the workspace is deleted, so
  a verifier fix can be re-scored instead of re-run.

---

## What we would run next

**Grok 4, Composer, and DeepSeek Pro.** The harness takes any prompt-in,
files-out CLI, so the roster is a question of access rather than engineering.

**The docs-withheld arm.** Every agent here was given the `AGENTS.md` and skills
files Notion ships in its templates, which is what a developer would actually
hand it. The harness supports withholding them, and running both arms separates
knowing the platform from being able to read its documentation — the question
that motivated this, currently answered in one arm only.

**Harder tasks.** 21 of 38 are now free points.

If you work on the Notion developer platform and want a surface covered, a task
added, or a configuration on the board, the repo takes issues.

---

## What this does not measure

Deployment, which is Business-plan gated — Workers behavior is verified offline
instead. The MCP surface, which [MCPMark](https://mcpmark.ai) already covers.
Anything UI-only. Long-horizon work, since tasks are single-session with a
15-minute ceiling. Prompt sensitivity: each task has one wording, and a
different phrasing would move some numbers by an unknown amount.

Three trials establish reliability coarsely. `pass^3` over 38 tasks is a real
signal and not a tight one.

---

*Repo: [github.com/rishabhsai/notionbench](https://github.com/rishabhsai/notionbench) · MIT.
Every rollout, token count and diagnostic behind these tables is in
`results/<runId>/results.jsonl`.*
