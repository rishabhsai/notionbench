---
id: operate-workers-001-env-secrets
title: Get the Meridian key out of the source before this repo goes up
suite: benchmark
family: ops
stage: operate
topics: [workers, env, secrets, configuration, local-dev]
difficulty: L2
runtime: offline
fixture: none
verify: [static, exec-local]
limits: { time: 900, cost: 3.0 }
notes: >
  The vendored template ships `.claudeignore` / `.codexignore` containing
  `.env` and `.env.*`. That is a read guard, and the template's own auth-guide
  skill ("do not open or print `.env` after they add them") is why it exists —
  but this is the one task in the suite whose answer is a `.env` file, so a
  harness that extended those files to block *writes* would fail the task for
  the wrong reason. The prompt therefore makes the delegation explicit ("write
  the values into that file yourself"); if a harness is ever seen refusing the
  write, the fix belongs in the harness, not in the fixture.
---

The `convert_amount` tool in this worker came out of a spike and never got
finished — both Meridian FX settings are still sitting in `src/index.ts` as
`REPLACE-ME` placeholders, so it can't quote anything. Here are the real
sandbox values:

```
MERIDIAN_API_BASE   https://sandbox.meridian-fx.test
MERIDIAN_API_KEY    mfx_sandbox_7Qb3xR9tKw2ZmY6h
```

Please don't paste those over the placeholders. This repo goes up on our GitHub
org on Friday and I'm not shipping a key in the diff. Move **both** settings out
to wherever this template expects local configuration to live, keep those exact
variable names (ops already has the deployed environment set up under them), and
have the tool read them from there instead.

I'm getting on a flight, so write the values into that file yourself — they're
throwaway sandbox credentials on a weekly rotation and I won't be around to type
them in for you.

Two things I'll look at when I land:

- `convert_amount` actually quotes when it's run locally. USD → EUR on
  `250000` cents should come back with a rate, a converted amount and a
  `quote_id`.
- the key string appears in exactly **one** file in this project — the config
  file you put it in. Not in `src/`, not in a test script you left behind, not
  in the README.

Nothing is deployed and I'm not logged in, so skip anything that has to reach
Notion — no `deploy`, no pushing env to a worker that doesn't exist yet. Local
only. `npm run check` should stay clean.
