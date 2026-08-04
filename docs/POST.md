# Eight coding agents, 38 tasks, one new platform

Notion shipped a developer platform in May — the `ntn` CLI, Workers, and
Notion-as-Code — and said it was built for AI coding agents. Nobody had checked.

So we wrote 38 tasks covering every programmable surface of it, ran eight agent
configurations through each one three times, and graded all 912 rollouts with a
program. No model judges anything.

Most of them passed. Twenty-one of the 38 tasks were solved by every single
configuration on every single trial, and the top six finished between 93.9% and
99.1% — a spread narrow enough that ranking them by score is close to reading
noise.

Which makes the interesting question a different one. Not *can this agent build
on Notion*, but *what are you paying for*.

---

## Results

| Config | Solve rate | Reliable (3/3) | Tool error rate | Cost | Median time |
|---|---:|---:|---:|---:|---:|
| Claude Code × Opus 5 | **99.1%** | 97.4% | 3.0% | $66.01 | 1m26s |
| Claude Code × Fable 5 | 98.2% | 97.4% | 4.4% | $99.37 | 1m11s |
| **Codex × GPT-5.6 Luna (high)** | **98.2%** | 94.7% | 16.9% | **$2.18** | 1m31s |
| Codex × GPT-5.6 Sol (xhigh) | 95.6% | 94.7% | 15.9% | $57.65 | 1m56s |
| Claude Code × Sonnet 5 (high) | 94.7% | 89.5% | 5.0% | $50.84 | 1m02s |
| Codex × GPT-5.6 Sol (medium) | 93.9% | 92.1% | 20.1% | $48.30 | 1m30s |
| OpenCode × Kimi K3 † | 87.3% | 68% (25/38) | 1.7% | $13.81 | 3m27s |
| OpenCode × DeepSeek V4 Flash † | 86.0% | 69% (29/38) | **0.6%** | **$0.53** | **1m00s** |

Solve rate is macro-averaged over tasks, so every task counts once however many
trials it got. Reliable is the share of tasks solved in all three. Cost is
API-equivalent — tokens are measured, priced at list rates; the runs themselves
were on subscriptions.

† Both OpenCode rows are incomplete: that account hit a weekly usage limit twice
mid-run. Each completed a full pass over all 38 tasks, so the solve rates stand,
but only 25 and 29 tasks got all three trials, so their reliability figures
cover those subsets.

---

## Luna costs 46× less than Fable and scores the same

$2.18 against $99.37, both at 98.2%. Per point of solve rate that is $2.22
versus $101.14.

Go further down the price list and it still holds up. DeepSeek V4 Flash scores
86.0% for **53 cents**, in the fastest median time on the board, with the lowest
tool error rate of any config we ran.

The catch shows up one column over. DeepSeek solves 86% of trials but only 69%
of tasks *every* time. It never failed a task outright — all 38 fell at least
once — so nothing here is beyond it. It just does not land the same task twice.

That gap is worth more than the headline number if you are putting an agent in
front of users, and it is invisible unless you run every task more than once.
Sonnet shows a smaller version of it: 94.7% of trials, 89.5% of tasks.

## Your harness leaks more than your model

| harness | tool error rate |
|---|---:|
| OpenCode | 0.6 – 1.7% |
| Claude Code | 3.0 – 5.0% |
| Codex | **15.9 – 20.1%** |

One in five Codex tool calls fails. Those three rows cover two models at three
reasoning efforts and land within four points of each other, while Claude Code's
three models cluster just as tightly somewhere entirely different. Whatever
produces that number lives in the scaffold, not the weights.

It does not stop Codex from doing well — Luna is third overall — so the errors
are recoverable. The tails differ too: Claude Code hit our 15-minute ceiling
twice and ran one task to 18 minutes, while Codex never exceeded 6 minutes
across 342 trials.

## Workers is where the platform is hard

Failures cluster hard by surface. Almost every config scored 100% on CLI tasks.
Workers dragged everyone down — 83% for both Sol tiers, 93% for Fable and Luna,
100% only for Opus — and the two hardest tasks in the suite are both Workers
tasks, at 57% and 58%.

The shape of the failures points at documentation rather than difficulty. Agents
skipped a lifecycle step rather than getting one wrong:

**Seven trials never registered a handler.** The task asks for a webhook called
`onIncidentAlert`. Seven trials left the worker template's default `sayHello`
tool in place and shipped, so the webhook fired into nothing. Every Claude Code
config got this right on every trial; every failure came from Codex or OpenCode.

**Five of eight configs rejected their own input.** One task specifies that a
tool asked about an unknown expense category answers with zeros rather than an
error. Five configs pinned the tool's input schema to an enum of known
categories, so the SDK rejected the value before their handler ran. Better
engineering, wrong answer — and it split across both harnesses, so it is a
reading of the spec rather than a scaffold quirk.

**One agent load-tested the production database.** The rate-limit task seeds 50
contacts and asks for them to be imported without tripping Notion's 3 requests
per second. DeepSeek wrote 87 rows. The extra 37 were named `BurstTest 001`
through `BurstTest 060` — it had probed the rate limit by writing its own junk
into the target database, then left it there.

**And sometimes they just forget to save.** All three failures on the
workspace-search task, including Opus's only miss in 114 trials, are the same
line: `could not read answer.json`. The agent searched the workspace, found
every runbook, and never wrote the file.

---

## If you are building on Notion right now

**Use the cheap tier and retry.** Luna at $2.18 is not a compromise on this
suite. If you are wiring up automations rather than shipping to users, DeepSeek
at 53 cents plus a retry beats paying 100× for four more points.

**Spend your reliability budget on Workers.** That is where every config loses,
and where a failure is quietest — a worker that registers the wrong capability
does not error, it just never runs.

**Pin what you actually want.** Two of the three failure stories above are
agents doing something defensible that the spec did not ask for. Say "answer
with zeros", say "do not add constraints", and say it in the prompt rather than
hoping.

## If you work on the platform

The `AGENTS.md` and skills files that ship in Notion's templates carry the CLI
well and Workers less so. A worked example of the full capability lifecycle —
register, name, wire to a trigger, verify with `exec --local` — would close most
of what we measured. The single most common failure in the whole run is an agent
that never replaced `sayHello`.

---

## How it is scored

Every task is graded by a program. Three layers, picked per task: the project
typechecks and builds; `ntn workers exec --local` runs a Worker offline and
deterministically, which makes Workers testable without a Business plan; and for
live tasks a verifier reads the workspace back through the public API and
asserts on what is there. Each trial gets a freshly provisioned fixture, leased
and torn down per cell, and the agent never sees the verifier or the oracle.

Before a task can run it passes a gate in CI: the oracle solution scores 1, a
plausibly-wrong solution scores 0, and an agent that does nothing scores 0. A
task that cannot fail its own foil measures nothing.

Notion-as-Code needed more than a diff. It lets you describe the same workspace
many ways, starting with author-chosen resource IDs, so two correct programs
differ in every identifier. We canonicalize by relabelling IDs from graph
structure, which makes isomorphic documents byte-identical.

## What we got wrong

Four times, a correct answer was marked wrong because the SDK allows two
spellings and our oracle had picked one. `visible: false` and `visibility:
"hide"` are the same column. `hidden: false` and omitting `hidden` are the same
column. Each showed up as several independent frontier models failing one task
with an identical complaint, which is a signature worth watching for: models
don't fail identically, broken graders do. The run halts automatically when
three configs fail the same task the same way.

Three more came from trusting our own mock. Views report a filter property as an
opaque ID rather than a name; the schema percent-encodes those IDs while views
reference them raw; and `GET /pages/{id}/markdown` never renders the page title
into the body, so one task demanded a line Notion does not send and every config
failed it having done the work correctly. CI could not catch any of these,
because CI validated against the mock. There is now a second check that runs the
real oracle against `api.notion.com`.

We also found a fixture describing a workspace Notion will not build: it folds
every page-level comment into one discussion, so a spec asking for two threads
silently got one, and agents were marked wrong for reporting what actually
existed.

None of those cells are in the numbers above. Corrections retire rows to
`results.superseded.jsonl` rather than deleting them — 198 of them, each with
its reason.

---

## Try it

The suite, the oracles, the foils and every rollout are open.

```bash
pnpm install && pnpm -r build
node packages/runner/dist/cli.js run --trials 3
node packages/runner/dist/cli.js score results/latest
```

Auth is your own subscription. Next on our list: Grok 4, Composer, and DeepSeek
Pro, plus a docs-withheld arm to separate knowing the platform from being able
to read its documentation. And harder tasks — 21 of 38 are free points now.

If you work on Notion's developer platform and want a surface covered or a
config on the board, the repo takes issues.

*[github.com/rishabhsai/notionbench](https://github.com/rishabhsai/notionbench) · MIT*
