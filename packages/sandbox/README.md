# @notionbench/sandbox

Trial workspace preparation, plus the container image that carries the task
toolchain (`ntn`, node, python, the preinstalled Notion templates).

Two things live here:

- **`src/workspace.ts`** — pure-fs preparation of a per-trial workspace, including
  the docs axis (`with` / `without` Notion's AGENTS.md + skills). Used by
  `@notionbench/runner` on every trial. No Docker needed.
- **`Dockerfile`** — `node:24-slim` + `git` + `python3` + `npm i -g ntn` +
  `/opt/templates/{workers-template,notion-as-code-template}` + a non-root `agent`
  user.

## v1 isolation model: agents run on the host

**The agent CLIs (`claude`, `codex`) are deliberately NOT in the image.**

NotionBench measures commercial agent CLIs driven by the operator's *subscriptions*
rather than API keys (see `docs/PLAN.md`). Those subscriptions authenticate against
credentials in the operator's home directory and, in general, against a device/session
binding that is not portable into a throwaway container. Baking the CLIs into the
image would mean either mounting real credentials into every one of ~2,100 rollouts
or falling back to API keys — which would change the thing being measured.

So v1 works like this:

```
host
├─ claude / codex  (subscription auth, operator's real credentials)
└─ child process
   ├─ cwd  = /tmp/nb-<task>-XXXX/workspace   ← the only place the agent works
   └─ env  = NOTION_HOME=/tmp/nb-.../notion-home
             NOTION_KEYRING=0
             NOTION_API_TOKEN=<per-trial lease>
             (ANTHROPIC_API_KEY / OPENAI_API_KEY stripped)
```

Isolation in v1 therefore comes from four things, not from a container:

1. **A throwaway workspace directory** per trial, seeded from
   `evals/<id>/fixture/workspace` and deleted afterwards.
2. **Env isolation** — a per-trial `NOTION_HOME`, `NOTION_KEYRING=0` so the CLI never
   touches the operator's keychain, and a per-trial leased `NOTION_API_TOKEN`.
   `@notionbench/runner`'s `buildTrialEnv` also strips `ANTHROPIC_API_KEY` /
   `OPENAI_API_KEY` so a stray key cannot silently reroute a subscription run.
3. **The CLIs' own sandboxes** — `codex exec -s workspace-write` confines writes to
   the workspace; Claude Code runs with `--strict-mcp-config --setting-sources project`
   so the operator's personal MCP servers, plugins and skills stay out of the
   measurement.
4. **Host-side verification** — verifiers never run inside the agent's environment
   (`docs/PLAN.md` "Anti-cheat"), so a compromised workspace cannot forge a pass.

### What v1 does *not* give you (and the honest cost)

- **No filesystem containment beyond cwd.** A model-authored `rm -rf ~` or a read of
  `~/.ssh` is *not* structurally prevented for Claude Code (Codex's `workspace-write`
  sandbox does prevent writes outside the workspace, but reads are broader). We accept
  this because the code being run is written by frontier commercial models on
  benign developer tasks, and because the alternative in v1 is not measuring
  subscriptions at all.
- **No network allowlist.** `docs/PLAN.md` specifies an `api.notion.com`-only
  allowlist to keep the benchmark repo unreachable from inside a trial. On the host
  that is not enforced. A model that decided to search the web for
  `notionbench` could in principle find published tasks. Mitigations for v1: the
  ~25% private holdout exists precisely to detect this, and full trajectories are
  published so contamination is auditable after the fact.
- **Weaker crash isolation.** A wedged CLI can leave background processes on the host.
  The runner mitigates this by spawning each trial `detached` in its own process group
  and killing the whole group on timeout (SIGTERM, then SIGKILL after a grace period).

### v2: full container isolation

v2 moves the agent into this image and gets the network allowlist and filesystem
containment for free. The blocker is credential delivery, and the plausible paths are:

- an OAuth/device-code flow that can be completed once and mounted read-only, or
- a per-run credential-broker sidecar on the host that the container talks to over a
  unix socket, or
- accepting API keys for a separate "scaffold-normalized" appendix run, which
  `docs/PLAN.md` already contemplates.

Until then the image is still useful and still built: it pins `ntn` and the two
templates, and it is what the `offline` families (Notion-as-Code, `exec --local`
Workers tasks) can run inside today, since those need no subscription at all.

## Usage

```ts
import { prepareWorkspace } from '@notionbench/sandbox';

const ws = await prepareWorkspace({
  taskDir: 'evals/build-nac-001-workspace-from-spec',
  docsCondition: 'without',
  docsBundle: 'nac',
});

try {
  // ws.dir        → agent cwd
  // ws.notionHome → export as NOTION_HOME
  // ws.docsStripped → ['AGENTS.md', 'packages/foo/AGENTS.md', ...]
} finally {
  await ws.cleanup();
}
```

### The docs axis

| condition | behaviour |
|---|---|
| `with` | copies `<taskDir>/fixture/docs/**` into the workspace (task-authored bundle wins), then fills gaps from `/opt/templates/<template>/{AGENTS.md,.claude,skills,…}` |
| `without` | recursively removes `AGENTS.md`, `CLAUDE.md`, `SKILLS.md`, `.cursorrules`, `GEMINI.md` and the `.claude` / `.agents` / `.cursor` / `.codex` directories |

The strip is recursive on purpose: fixtures cloned from an upstream template carry
`AGENTS.md` files in subdirectories, and leaving one behind would quietly contaminate
the headline docs-axis chart. It is deliberately *not* broad enough to delete a bare
`docs/` directory, because `investigate-*` tasks legitimately hand the agent
documentation and logs as part of the task itself.

## Building the image

```bash
pnpm --filter @notionbench/sandbox docker:build
# or, pinning:
docker build \
  --build-arg NTN_VERSION=0.4.2 \
  --build-arg WORKERS_TEMPLATE_REF=main \
  -t notionbench/sandbox:v1 packages/sandbox
```

The build records `/opt/ntn-version.txt` and
`/opt/templates/<name>.sha` so a published result set can name the exact platform
surface it was measured against. Template `.git` directories are removed after the
SHAs are captured — `docs/PLAN.md` requires that fixtures carry no git history.
