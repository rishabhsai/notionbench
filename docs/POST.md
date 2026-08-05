# I benchmarked 8 coding agents on Notion's new platform and got a tie

I expected a leaderboard. I got a photo finish.

Notion shipped a developer platform in May — the `ntn` CLI, Workers, and
Notion-as-Code — and said it was built for AI coding agents. So I wrote 38 tasks
across every programmable surface of it, ran eight agent configurations through
each one three times, and graded all 912 rollouts with a program.

Twenty-one of the 38 tasks were solved by every single config on every single
trial. The top six landed between 93.9% and 99.1%. Ranking them by score is
close to reading noise.

The interesting stuff was everywhere else.

---

## Why I built this

Notion has gone properly AI-native this year. They keep shipping things aimed at
agents — a CLI, Workers, Notion-as-Code, skills files in their own templates —
and I wanted to know whether agents are actually any good at using them.

Nobody had checked. So I checked.

## How I approached it

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
two correct programs disagree on every identifier. I canonicalise by relabelling
IDs from the graph structure, which makes equivalent documents byte-identical.

---

## What I found

### The price of a point collapsed

| | solve rate | cost |
|---|---:|---:|
| Claude Code × Fable 5 | 98.2% | $99.37 |
| **Codex × GPT-5.6 Luna** | **98.2%** | **$2.18** |

Same score. Forty-six times the price.

Keep going down the price list and it holds. DeepSeek V4 Flash scored 86.0% for
**53 cents**, in the fastest median time of anything I ran, with the lowest tool
error rate on the board.

I went in assuming the frontier models would separate themselves on a brand new
API. They mostly did not.

### One column tells you what the score does not

DeepSeek solves 86% of trials. It solves 69% of tasks *every* time.

It never failed a task outright, so nothing here is beyond it — it just does not
land the same task twice. And when it misses, it misses big: 23% of the
verifier's checks pass on a failed DeepSeek run, against 62% for Sonnet.

You cannot see that gap without running every task more than once.

### Your harness leaks more than your model

| harness | tool error rate |
|---|---:|
| OpenCode | 0.6 – 1.7% |
| Claude Code | 3.0 – 5.0% |
| Codex | **15.9 – 20.1%** |

One in five Codex tool calls fails. Same tasks, same sandbox — a 30× spread that
tracks the scaffold, not the model.

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
`unknown_ignored` failed 10 times each. All downstream of registration. Miss the
first step and every check after it goes with you.

Seven trials shipped the worker template's default `sayHello` tool and never
added the handler the task asked for. Build passes, typecheck passes, webhook
fires into nothing.

That smells like docs rather than difficulty. Workers have a lifecycle —
register, name, wire to a trigger, verify — and agents were skipping a step, not
fumbling one.

So that is what I want to test next: write a proper Workers skill covering the
full lifecycle, hand it to the same eight configs, and re-run. If I am right,
the 10% collapses.

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

---

### Some agents furnish the house. Others hand you the blueprints.

Solve rates measure whether an agent can follow a spec. They say nothing about
what it builds when the shape is left to it.

So I gave all six the same open brief — *build a system for a mobile dog-grooming
business with two vans* — plus two more like it. No score, no right answer.

The clearest split was whether they put anything in the databases they made.

| | study | grooming | twitch | **rows seeded** |
|---|---:|---:|---:|---:|
| **Opus 5** | 46 | 1,633 | 236 | **1,915** |
| Fable 5 | 88 | 103 | 69 | 260 |
| Sonnet 5 | 0 | 47 | 63 | 110 |
| Sol (xhigh) | 21 | 18 | 0 | 39 |
| Sol (medium) | 5 | 10 | 0 | 15 |
| Luna (high) | 5 | 5 | 0 | 10 |

Claude Code seeded 2,285 rows across the three briefs. Codex seeded 64. All
three Codex configs handed back the Twitch pipeline completely empty.

This is not a structure gap. On the grooming brief Sol at extra-high built **ten**
databases with 14 views and 18 relations — near-identical scaffolding to Opus's
eleven. It just left them unfurnished, with rows reading `Conditioner — Van 1 /
COUNT / 1 / 3`.

Opus built a working diary instead. Named dogs — Maple, Bruno, Rufus, Ziggy —
assigned to vans and groomers with real dates, under a line that reads
*"Bookings land as texts. Put them straight into the diary below — everything
else on this page works itself out from there."* Then a section called **Ring
these before they drift**.

Sol at medium did a third thing: a *"First setup — about 20 minutes"* checklist
over six databases, with a rule of thumb — *one appointment row per visit, one
cost row per receipt* — and left the filling-in to you.

All three are defensible readings of the same sentence, and which one you want
depends entirely on whether you intend to demo the thing or run it. On the
scored suite these configs land within four points of each other.

They disagreed about shape, too. Sol at medium never created a single sub-page
across all three briefs — everything went flat onto one root page. Luna made the
most sub-pages of anyone, seven, but never nested them. Opus was the only one to
go two levels deep, and the only one to reach for the full view vocabulary:
board, calendar, chart, table *and* timeline, where Sonnet and Fable stuck to
tables and lists throughout.

Nobody asked for any of that. Given "build me a system", one agent hands you a
single dense page, another hands you seven flat ones, and a third builds a
hierarchy with a timeline in it.

One more number worth holding next to this: Sonnet made **131 tool calls** on the
grooming brief, more than Opus's 99, and produced 47 rows against Opus's 1,633.
Effort and output are not the same axis.

Every workspace below is the real thing, still live in Notion — open one and
poke at it.

## Try it

```bash
npx notionbench tasks          # the 38 tasks
npx notionbench run --dry-run  # the grid, argv, and child env, without spending anything
npx notionbench run --trials 3
npx notionbench score results/latest
```

## What is next

**A Workers skill, then a re-run.** The hypothesis above deserves a number.

**More configs.** Grok 4, Composer, and DeepSeek Pro.

**A docs-withheld arm.** Every agent here got the `AGENTS.md` and skills Notion
ships. Running it both ways separates knowing the platform from being able to
read its documentation.

**Harder tasks.** Twenty-one of 38 are free points now.

*[github.com/rishabhsai/notionbench](https://github.com/rishabhsai/notionbench) · MIT*
