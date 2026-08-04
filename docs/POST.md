# We benchmarked 8 coding agents on Notion's new platform and got a tie

We expected a leaderboard. We got a photo finish.

Notion shipped a developer platform in May — the `ntn` CLI, Workers, and
Notion-as-Code — and said it was built for AI coding agents. So we wrote 38
tasks across every programmable surface of it, ran eight agent configurations
through each one three times, and graded all 912 rollouts with a program.

Twenty-one of the 38 tasks were solved by every single config on every single
trial. The top six landed between 93.9% and 99.1%. Ranking them by score is
close to reading noise.

The interesting stuff was everywhere else.

---

## Why we built this

The platform is three months old. That is a narrow, closing window where no
model has meaningfully trained on it, so this measures whether an agent can
learn an unfamiliar API from its documentation rather than whether it memorised
one. In a year that experiment is gone.

"Built for agents" was also a claim nobody had checked. Notion ships
`AGENTS.md` files and skills in its own templates. That is testable.

And picking an agent is currently vibes. You can read a hundred threads about
which CLI is better and not find one number attached to a real platform.

## How we approached it

Every task is graded by a program. No model judges anything.

Three layers, picked per task. The project typechecks and builds.
`ntn workers exec --local` runs a Worker offline and deterministically, which
turns out to make Workers testable without a Business plan or a deployment. And
for live tasks, a verifier reads the workspace back through the public API and
asserts on what is actually there — each trial gets its own freshly provisioned
workspace, torn down after.

Before a task is allowed to run, it has to pass a gate: the correct solution
scores 1, a plausibly-wrong solution scores 0, and an agent that does nothing
scores 0. A task that cannot fail its own foil is not measuring anything.

Notion-as-Code needed more than a text diff. It lets you describe the same
workspace many different ways, starting with resource IDs you name yourself, so
two correct programs disagree on every identifier. We canonicalise by
relabelling IDs from the graph structure, which makes equivalent documents
byte-identical.

---

## What we found

### The price of a point collapsed

| | solve rate | cost |
|---|---:|---:|
| Claude Code × Fable 5 | 98.2% | $99.37 |
| **Codex × GPT-5.6 Luna** | **98.2%** | **$2.18** |

Same score. Forty-six times the price.

Keep going down the price list and it holds. DeepSeek V4 Flash scored 86.0% for
**53 cents**, in the fastest median time of anything we ran, with the lowest
tool error rate on the board.

We went in assuming the frontier models would separate themselves on a brand
new API — that unfamiliar surface would reward whatever makes Opus expensive.
It mostly did not.

### One column tells you what the score does not

DeepSeek solves 86% of trials. It solves 69% of tasks *every* time.

It never failed a task outright — all 38 fell at least once, so nothing here is
beyond it. It just does not land the same task twice. And when it misses, it
misses big: only 23% of the verifier's checks pass on a failed DeepSeek run,
against 62% for Sonnet. It either does the task or wanders off.

That gap is the whole ballgame if you are putting an agent in front of users,
and you cannot see it without running every task more than once.

### Your harness leaks more than your model

| harness | tool error rate |
|---|---:|
| OpenCode | 0.6 – 1.7% |
| Claude Code | 3.0 – 5.0% |
| Codex | **15.9 – 20.1%** |

One in five Codex tool calls fails.

Those three Codex rows are two different models at three reasoning efforts, and
they land within four points of each other. Claude Code's three models cluster
just as tightly, somewhere completely different. Whatever produces that number
is in the scaffold, not the weights.

It does not stop Codex from doing well — Luna is third overall — so the errors
are recoverable. But nobody publishes this number, and it is a 30× spread.

### Workers is the wall

Failure rate by surface, across every config:

| surface | failure rate |
|---|---:|
| CLI | 2% |
| Notion-as-Code | 6% |
| Ops | 7% |
| **Workers** | **10%** |

Both of the two hardest tasks in the suite are Workers tasks, at 57% and 58%.

Look at *which* checks fail and a pattern falls out. In the webhook task,
`registered` failed 9 times — and `delivered`, `target_updated` and
`unknown_ignored` failed 10 times each. Those are all downstream of
registration. Miss the first step and every check after it goes with you.

Seven trials shipped the worker template's default `sayHello` tool and never
added the handler the task asked for. The build passes. The typecheck passes.
The webhook fires into nothing.

Our hypothesis is that this is a documentation gap rather than a difficulty
one. Workers have a lifecycle — register a capability, name it, wire it to a
trigger, verify it — and agents were skipping a step, not fumbling one. The
`AGENTS.md` that ships in Notion's templates carries the CLI well and Workers
much less so.

That is testable, and it is the next thing we are running: write a proper
Workers skill covering the full lifecycle, hand it to the same eight configs,
and re-run. If the hypothesis holds, the 10% collapses. If it does not, Workers
is genuinely harder than the rest of the platform and that is worth knowing
too.

### One agent load-tested the production database

The rate-limit task seeds 50 contacts and asks for them to be imported without
tripping Notion's 3 requests per second.

DeepSeek wrote 87 rows. The extra 37 were named `BurstTest 001` through
`BurstTest 060`. It had worked out where the rate limit was by writing its own
junk into the target database, and then left it there.

The task was checking pacing discipline. It caught something better.

### Sometimes they just forget to save

All three failures on the workspace-search task are the same line:
`could not read answer.json`.

One of them is Opus's only miss in 114 trials. It searched the workspace, found
every runbook, worked out which ones had no owner, and never wrote the file.

### Our grader was wrong seven times

This is the part we did not expect at all.

Four times a correct answer was marked wrong because the SDK allows two
spellings and our reference solution had picked one. `visible: false` and
`visibility: "hide"` describe the same column. So do `hidden: false` and
leaving `hidden` out, since false is the default.

Three more came from trusting our own mock server. Views report a filter
property as an opaque ID rather than a name. The schema percent-encodes those
IDs while views reference them raw, so only *some* properties failed to
resolve, which made the bug look intermittent. And `GET /pages/{id}/markdown`
never renders the page title into the body — so one task demanded a line Notion
does not send, and every config failed it having done the work correctly.

CI could not catch any of those, because CI validated against the mock. There
is now a second check that runs the real solution against `api.notion.com`.

The tell, every time, was several independent frontier models failing one task
with an identical complaint. Models do not fail identically. Broken graders do.
The run halts automatically when three configs fail the same task the same way,
which is how we caught most of them before they cost a full pass.

---

## What we are doing next

**A Workers skill, then a re-run.** The hypothesis above deserves a number.

**More configs.** Grok 4, Composer, and DeepSeek Pro.

**A docs-withheld arm.** Every agent here got the `AGENTS.md` and skills Notion
ships. Running it both ways separates knowing the platform from being able to
read its documentation.

**Harder tasks.** Twenty-one of 38 are free points now.

## Try it

```bash
npx notionbench tasks          # the 38 tasks
npx notionbench run --dry-run  # the grid, argv, and child env, without spending anything
npx notionbench run --trials 3
npx notionbench score results/latest
```

Auth is your own subscription. Every rollout, token count and diagnostic from
this run is in `results/`, including the 198 rows we retired and why.

*[github.com/rishabhsai/notionbench](https://github.com/rishabhsai/notionbench) · MIT*
