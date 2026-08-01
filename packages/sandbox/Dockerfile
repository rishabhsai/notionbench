# NotionBench sandbox image.
#
# Contains everything a task needs EXCEPT the agent CLIs — see README.md
# ("v1 runs agents on the host") for why `claude` / `codex` are deliberately absent.
#
# Build:  docker build -t notionbench/sandbox:v1 packages/sandbox
FROM node:24-slim

# git      — Notion-as-Code / Workers templates are git projects; tasks may init repos
# python3  — Layer 3 state verifiers and fixture provisioning scripts (notion_client)
# ca-certificates — TLS to api.notion.com
# curl     — task fixtures that talk to the local mock API server
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        python3 \
        python3-pip \
        python3-venv \
        ca-certificates \
        curl \
        jq \
    && rm -rf /var/lib/apt/lists/*

# The Notion CLI under test. Pin at build time and record the resolved version into
# run metadata — `ntn` is a two-month-old surface and moves fast.
ARG NTN_VERSION=latest
RUN npm install -g "ntn@${NTN_VERSION}" \
    && npm cache clean --force \
    && ntn --version > /opt/ntn-version.txt

# Preinstalled template clones. Baked in at build time so no trial ever needs
# github.com at runtime — the sandbox network allowlist is api.notion.com only
# (docs/PLAN.md "Anti-cheat"), and a per-trial clone would also be a flakiness source.
ARG WORKERS_TEMPLATE_REF=main
ARG NAC_TEMPLATE_REF=main
RUN mkdir -p /opt/templates \
    && git clone --depth 1 --branch "${WORKERS_TEMPLATE_REF}" \
         https://github.com/makenotion/workers-template.git /opt/templates/workers-template \
    && git clone --depth 1 --branch "${NAC_TEMPLATE_REF}" \
         https://github.com/makenotion/notion-as-code-template.git /opt/templates/notion-as-code-template \
    # Record the exact commits, then drop git history: fixtures must not leak
    # upstream solutions or dates via `git log` (docs/PLAN.md "Anti-cheat").
    && (cd /opt/templates/workers-template && git rev-parse HEAD > /opt/templates/workers-template.sha) \
    && (cd /opt/templates/notion-as-code-template && git rev-parse HEAD > /opt/templates/notion-as-code-template.sha) \
    && rm -rf /opt/templates/workers-template/.git /opt/templates/notion-as-code-template/.git

# Warm the templates' node_modules so offline trials don't need npm at runtime.
RUN for t in /opt/templates/*/; do \
      if [ -f "$t/package.json" ]; then (cd "$t" && npm install --no-audit --fund=false || true); fi; \
    done \
    && npm cache clean --force

# Non-root. Trials run untrusted model-authored code.
RUN useradd --create-home --shell /bin/bash --uid 10001 agent \
    && mkdir -p /work /home/agent/.notion \
    && chown -R agent:agent /work /home/agent /opt/templates

USER agent
WORKDIR /work

# Per-trial isolation for the `ntn` CLI (docs/PLAN.md "Fixtures & isolation").
# NOTION_HOME is overridden per trial by the runner; NOTION_KEYRING=0 keeps the CLI
# from ever reaching for an OS keychain that does not exist in a container.
ENV NOTION_HOME=/home/agent/.notion \
    NOTION_KEYRING=0 \
    NOTIONBENCH_TEMPLATES_DIR=/opt/templates \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    CI=1

CMD ["bash"]
