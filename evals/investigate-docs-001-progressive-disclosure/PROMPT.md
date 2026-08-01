---
id: investigate-docs-001-progressive-disclosure
title: Finish the CLI runbook before CI eats another afternoon
suite: benchmark
family: ops
stage: investigate
topics: [cli, help-discovery, env-vars, documentation]
difficulty: L2
runtime: offline
fixture: none
verify: [answer-file]
limits: { time: 600, cost: 2.0 }
---

I started a runbook for the `ntn` CLI (`RUNBOOK.md`) and left every line I
wasn't sure about as a TODO. CI has been failing on the keychain thing twice a
week and I'd like to stop guessing.

Fill in the gaps and write them to `answer.json` in the project root, as a flat
JSON object with these keys:

- `keyring_env_var` — the environment variable that makes the CLI keep
  credentials in a file instead of the OS keychain
- `keyring_disable_value` — what you set it to for that to happen
- `state_root_env_var` — the environment variable that overrides where the CLI
  keeps its config/auth state
- `json_flag` — the flag that makes `ntn whoami` print the raw response
- `plain_flag` — the flag that makes `ntn workers runs list` print
  tab-separated columns with no header row
- `local_flag` — the flag that makes `ntn workers exec` run the capability on
  this machine instead of against the deployed worker
- `docs_flag` — the flag that makes `ntn api` print the full official markdown
  docs for an endpoint
- `resolve_command` — the command that turns a database id into the data source
  ids you can query

Spell flags and variable names exactly the way the CLI itself spells them. For
`resolve_command` just the command, no id argument.

Don't guess from memory — this CLI is three months old and the answers are in
its own help output. I don't need `RUNBOOK.md` updated, only `answer.json`.
