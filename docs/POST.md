# I benchmarked 8 coding agents on Notion's new platform and got a tie

Notion shipped a developer platform in May: the `ntn` CLI, Workers, and
Notion-as-Code. They said it was built for AI coding agents. I wanted to know if
that was true, so I wrote 38 tasks covering every programmable part of it, ran
eight agent setups through each task three times, and had a program grade the
lot. 890 runs finished and were scored.

The scores came out almost identical. Twenty-one of the 38 tasks were solved by
every setup on every trial, and the top six finished between 93.9% and 99.1%.
Ranking them by score tells you very little.

The differences showed up in cost, consistency, and which parts of the platform
they got stuck on.

| | solve rate | reliable (3/3) | tool error rate | cost | median time |
|---|---:|---:|---:|---:|---:|
| Claude Code × Opus 5 | 99.1% | 97.4% | 3.0% | $66.01 | 1m26s |
| Claude Code × Fable 5 | 98.2% | 97.4% | 4.4% | $99.37 | 1m11s |
| Codex × GPT-5.6 Luna | 98.2% | 94.7% | 16.9% | $2.18 | 1m31s |
| Codex × GPT-5.6 Sol (xhigh) | 95.6% | 94.7% | 15.9% | $57.65 | 1m56s |
| Claude Code × Sonnet 5 | 94.7% | 89.5% | 5.0% | $50.84 | 1m02s |
| Codex × GPT-5.6 Sol (medium) | 93.9% | 92.1% | 20.1% | $48.30 | 1m30s |
| OpenCode × Kimi K3 * | 87.3% | 68% (25/38) | 1.7% | $13.81 | 3m27s |
| OpenCode × DeepSeek V4 Flash * | 86.0% | 69% (29/38) | 0.6% | $0.53 | 1m00s |

Solve rate is the share of trials solved, averaged per task so every task counts
once. Reliable is the share of tasks solved in all three trials. Cost is
API-equivalent: the token counts are real, priced at list rates, but the runs
themselves went through subscriptions.

\* The two OpenCode rows are short. That account hit a weekly usage limit twice
mid-run, so Kimi and DeepSeek completed 101 and 105 of their 114 cells. Both
covered all 38 tasks at least once, so the solve rates hold, but only 25 and 29
tasks got all three trials and their reliability numbers cover those subsets.
The 225 cells I threw out are in `results.superseded.jsonl` with a reason
attached to each.

---

## Why I built this

Notion has gone hard on AI this year. They keep shipping things aimed at agents:
a CLI, Workers, Notion-as-Code, skills files in their own templates. I wanted to
know whether agents are any good at using them, and I couldn't find anyone who
had measured it.

## How I approached it

A program grades every task, so no model is judging another model's work.

Tasks use whichever of three checks fit. The project has to typecheck and build. `ntn workers exec --local` runs a Worker offline and
deterministically, which means you can test Workers without a Business plan or a
deployment. For tasks that touch a real workspace, a verifier reads it back
through the public API and asserts on what is actually there. Every trial gets a
fresh workspace, torn down afterwards.

Each task has to pass a gate before it can run. The correct solution has to
score 1, a deliberately wrong solution has to score 0, and an agent that does
nothing has to score 0. If the wrong solution ever starts passing, I fix the
task or drop it.

Notion-as-Code needed more than a text diff. You can describe the same workspace
many different ways, starting with resource IDs you name yourself, so two
correct programs disagree on every identifier. I relabel the IDs from the graph
structure, which makes equivalent programs come out byte-identical.

---

## What I found

### Cost and score came apart

| | solve rate | cost |
|---|---:|---:|
| Claude Code × Fable 5 | 98.2% | $99.37 |
| **Codex × GPT-5.6 Luna** | **98.2%** | **$2.18** |

They tied at 98.2%, and one run cost 46 times as much as the other.

It holds further down the price list too. DeepSeek V4 Flash scored 86.0% for 53
cents, in the fastest median time of anything I ran, with the lowest tool error
rate on the board.

I went in assuming the frontier models would pull ahead on an API this new.
They mostly didn't.

### DeepSeek was inconsistent between trials

DeepSeek solves 86% of trials but only 69% of tasks *every* time.

It never failed a task outright, so nothing in the suite is beyond it. It just
doesn't land the same task twice. And when it does fail, it fails badly: 23% of
the verifier's checks pass on a failed DeepSeek run, against 62% for Sonnet.

None of that shows up if you run each task once.

### Tool errors varied sharply by harness

| harness | tool error rate |
|---|---:|
| OpenCode | 0.6 – 1.7% |
| Claude Code | 3.0 – 5.0% |
| Codex | **15.9 – 20.1%** |

One in five Codex tool calls fails. Same tasks, same sandbox, and a 30× spread
between harnesses running two different models at three reasoning efforts.

### Workers is where they got stuck

| surface | failure rate |
|---|---:|
| CLI | 2% |
| Notion-as-Code | 6% |
| Ops | 7% |
| **Workers** | **10%** |

The two hardest tasks in the suite are both Workers tasks, at 57% and 58%.

The subscores show why. In the webhook task,
`registered` failed 9 times, and `delivered`, `target_updated` and
`unknown_ignored` failed 10 times each. All three are downstream of
registration, so missing that one step takes every check after it with you.

Seven trials shipped the worker template's default `sayHello` tool and never
added the handler the task asked for. The build passes, the typecheck passes,
and the webhook fires into nothing.

I think the docs are the problem here. Workers have a lifecycle: register a
capability, name it, wire it to a trigger, verify it. Agents that failed had
skipped one of those steps, usually the first.

So that's what I want to test next. Write a proper Workers skill covering the
full lifecycle, hand it to the same eight setups, and run it again to see
whether the 10% drops.

### One agent load-tested the production database

The rate-limit task seeds 50 contacts and asks for them to be imported without
tripping Notion's 3 requests per second.

DeepSeek wrote 87 rows. The extra 37 were named `BurstTest 001` through
`BurstTest 060`. It had found the rate limit by writing its own junk into the
target database, and then left it all there.

### Sometimes they forget to save

All three failures on the workspace-search task are the same line: `could not
read answer.json`.

One of them is Opus's only miss in 114 trials. It searched the workspace, found
every runbook, worked out which ones had no owner, and never wrote the file.

---

## Try it

```bash
npx notionbench tasks          # the 38 tasks
npx notionbench run --dry-run  # the grid, argv, and child env, without spending anything
npx notionbench run --trials 3
npx notionbench score results/latest
```

## What they build when you don't tell them

Everything above measures whether an agent can follow a spec. It says nothing
about what it makes when you leave the shape open, so I gave all six the same
loose brief three times: a study system, a grooming business with two vans, and
a Twitch creator's pipeline.

The biggest difference was whether they put anything in the databases they
built. Claude Code seeded 2,285 rows across the three briefs. Codex seeded 64,
and all three Codex setups handed back the Twitch pipeline empty.

They built similar structures regardless. On the grooming brief, Sol at extra-high
built ten databases with 14 views, close to Opus's eleven, and filled them with
rows reading `Conditioner — Van 1 / COUNT / 1 / 3`. Opus filled its version with
named dogs booked to vans across a year.

They also disagreed about shape. Sol at medium never made a single sub-page
across all three briefs. Luna made seven and nested none of them. Opus was the
only one to go two levels deep, and the only one to use timelines and charts at
all.

All eighteen workspaces are public. [Open them and poke
around](https://app.notion.com/p/rishabhsai/NotionBench-Runs-3af6ab85753b808daa60d1dd1b0c40a0).

## What this doesn't tell you

Three trials is enough to see that DeepSeek is inconsistent and not enough to
put a tight number on it. Every task has exactly one wording, and I have no idea
how much the scores move if you phrase them differently. Workers deployment is
untested because it needs a Business plan, so I check behaviour offline with
`exec --local` instead. Nothing here runs longer than a single session with a
15-minute ceiling, so this says nothing about an agent working for an hour.

And the suite is getting easy. Twenty-one of the 38 tasks are now solved by
everyone on every trial, which means most of the signal comes from about 17
tasks.

## What is next

**A Workers skill, then a re-run.** If the docs theory is right, the Workers
failure rate should drop.

**More setups.** Grok 4, Composer, and DeepSeek Pro.

**A docs-withheld arm.** Every agent here got the `AGENTS.md` and skills Notion
ships. Running it both ways separates knowing the platform from being able to
read its documentation.

**Harder tasks.** Twenty-one of the 38 are solved by everyone every time.

*[github.com/rishabhsai/notionbench](https://github.com/rishabhsai/notionbench) · MIT*
