#!/usr/bin/env node
// Generates the mock fixtures the web UI is built against:
//   web/data/results.json       — final snapshot (static/public mode)
//   web/data/results.js         — same payload as a classic-script global,
//                                 the file:// fallback when fetch() is blocked
//   web/data/results.live.json  — mid-run snapshot (served by dev/mock-server.mjs)
// Deterministic: seeded PRNG, so re-running produces identical files.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

// ---------- seeded PRNG ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260731);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// ---------- configs (order = fixed color-slot order in the UI) ----------
// strength: mean solve probability; inRate/outRate: internal $/Mtok used only
// to synthesize plausible apiEquivCostUsd totals (never shown as prices).
const CONFIGS = [
  { id: "opencode-kimi-k3",        label: "OpenCode × Kimi K3",          short: "Kimi K3",     harness: "OpenCode",    model: "Kimi K3",            strength: 0.84, inRate: 0.6,  outRate: 2.5,  outMul: 1.0 },
  { id: "claude-code-opus-5-high", label: "Claude Code × Opus 5 (high)", short: "Opus 5 high", harness: "Claude Code", model: "Opus 5 (high)",      strength: 0.81, inRate: 15,   outRate: 75,   outMul: 1.2 },
  { id: "codex-gpt56-sol-xhigh",   label: "Codex × GPT-5.6 Sol (xhigh)", short: "Sol xhigh",   harness: "Codex",       model: "GPT-5.6 Sol (xhigh)",strength: 0.70, inRate: 1.25, outRate: 10,   outMul: 2.6 },
  { id: "claude-code-sonnet-5-high",label:"Claude Code × Sonnet 5 (high)",short:"Sonnet 5 high",harness: "Claude Code", model: "Sonnet 5 (high)",    strength: 0.70, inRate: 3,    outRate: 15,   outMul: 1.1 },
  { id: "codex-gpt56-luna-high",   label: "Codex × GPT-5.6 Luna (high)", short: "Luna high",   harness: "Codex",       model: "GPT-5.6 Luna (high)",strength: 0.67, inRate: 1.75, outRate: 14,   outMul: 1.4 },
  { id: "claude-code-fable-5",     label: "Claude Code × Fable 5",       short: "Fable 5",     harness: "Claude Code", model: "Fable 5",            strength: 0.64, inRate: 2,    outRate: 10,   outMul: 0.9 },
  { id: "codex-gpt56-sol-medium",  label: "Codex × GPT-5.6 Sol (medium)",short: "Sol med",     harness: "Codex",       model: "GPT-5.6 Sol (medium)",strength: 0.55, inRate: 1.25, outRate: 10,  outMul: 0.7 },
];

// ---------- 38 tasks: family × stage ----------
const T = (family, stage, name) => ({ taskId: `${family}/${name}`, family, stage });
const TASKS = [
  // cli (10)
  T("cli", "build", "md-tree-import"), T("cli", "build", "db-scaffold"), T("cli", "build", "blocks-append"),
  T("cli", "investigate", "query-plan-debug"), T("cli", "investigate", "perm-audit"),
  T("cli", "resolve", "sync-conflict"), T("cli", "resolve", "rate-retry"),
  T("cli", "operate", "backup-cron"), T("cli", "operate", "bulk-archive"), T("cli", "operate", "export-filter"),
  // workers (10)
  T("workers", "build", "form-intake"), T("workers", "build", "slack-digest"), T("workers", "build", "webhook-relay"),
  T("workers", "investigate", "cold-start-trace"), T("workers", "investigate", "payload-diff"),
  T("workers", "resolve", "retry-storm"), T("workers", "resolve", "schema-drift"),
  T("workers", "operate", "secret-rotate"), T("workers", "operate", "cron-monitor"), T("workers", "operate", "log-tail"),
  // nac (10)
  T("nac", "build", "crm-model"), T("nac", "build", "wiki-perms"), T("nac", "build", "sprint-board"),
  T("nac", "investigate", "drift-report"), T("nac", "investigate", "intent-lint"),
  T("nac", "resolve", "merge-divergence"), T("nac", "resolve", "rollback-partial"),
  T("nac", "operate", "apply-ci"), T("nac", "operate", "env-promote"), T("nac", "operate", "seed-fixtures"),
  // ops (8)
  T("ops", "build", "token-broker"), T("ops", "build", "usage-ledger"),
  T("ops", "investigate", "quota-forensics"), T("ops", "investigate", "audit-trace"),
  T("ops", "resolve", "key-leak"), T("ops", "resolve", "limit-breach"),
  T("ops", "operate", "alert-route"), T("ops", "operate", "safe-teardown"),
];
const FAM_ADJ = { cli: 0.08, nac: 0.02, workers: -0.05, ops: -0.10 };
const STG_ADJ = { build: 0.06, investigate: -0.02, resolve: -0.07, operate: -0.06 };

// per-task idiosyncrasy, shared across configs (some tasks are just hard)
const taskNoise = new Map(TASKS.map((t) => [t.taskId, (rand() - 0.5) * 0.26]));
const taskChecks = new Map(TASKS.map((t) => [t.taskId, 4 + Math.floor(rand() * 7)])); // 4..10 checks

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const r2 = (x) => Math.round(x * 100) / 100;

function makeTrial(cfg, task, trial) {
  const p = clamp(cfg.strength + FAM_ADJ[task.family] + STG_ADJ[task.stage] + taskNoise.get(task.taskId), 0.04, 0.97);
  const n = taskChecks.get(task.taskId);
  const solved = rand() < p;
  let score;
  if (solved) score = 1;
  else {
    const passed = Math.floor(rand() * rand() * n * 0.9); // failed trials skew low
    score = r2(passed / n);
  }
  const inTok = Math.round((30_000 + rand() * 190_000) * (solved ? 1 : 1.25));
  const outTok = Math.round((3_000 + rand() * 26_000) * cfg.outMul * (solved ? 1 : 1.3));
  const wallTimeS = Math.round(80 + rand() * 700 * cfg.outMul * (solved ? 1 : 1.4));
  const lambda = (1 - cfg.strength) * 3 + (task.family === "ops" ? 0.8 : 0.2);
  const toolErrors = Math.floor(rand() * lambda + rand() * lambda * 0.5);
  return { trial, solved, score, wallTimeS, tokens: { input: inTok, output: outTok }, toolErrors };
}

function buildRun({ live }) {
  const startedAt = "2026-07-29T06:00:00Z";
  const generatedAt = live ? "2026-07-31T09:47:12Z" : "2026-07-31T21:04:00Z";
  const perConfigCells = TASKS.length * 3; // 114

  // live: how many cells each config has completed
  const liveState = {
    "opencode-kimi-k3":         { status: "done",     cells: 114 },
    "claude-code-opus-5-high":  { status: "done",     cells: 114 },
    "codex-gpt56-sol-xhigh":    { status: "done",     cells: 114 },
    "claude-code-sonnet-5-high":{ status: "running",  cells: 61, currentTask: "workers/retry-storm",
                                  window: { used: 2_950_000, limit: 5_000_000, resetsAt: "2026-07-31T11:00:00Z" } },
    "codex-gpt56-sol-medium":   { status: "cooldown", cells: 87, cooldownUntil: "2026-07-31T10:12:00Z",
                                  window: { used: 5_000_000, limit: 5_000_000, resetsAt: "2026-07-31T10:12:00Z" } },
    "claude-code-fable-5":      { status: "blocked",  cells: 42 },
    "codex-gpt56-luna-high":    { status: "pending",  cells: 0 },
  };

  const results = [];
  const configs = [];
  for (const cfg of CONFIGS) {
    const budget = live ? liveState[cfg.id].cells : perConfigCells;
    let cells = 0, tin = 0, tout = 0, cost = 0;
    for (const task of TASKS) {
      const trials = [];
      for (let k = 1; k <= 3; k++) {
        if (cells >= budget) break;
        const tr = makeTrial(cfg, task, k);
        trials.push(tr);
        tin += tr.tokens.input; tout += tr.tokens.output;
        cost += (tr.tokens.input * cfg.inRate + tr.tokens.output * cfg.outRate) / 1e6;
        cells++;
      }
      if (trials.length) results.push({ taskId: task.taskId, family: task.family, stage: task.stage, config: cfg.id, trials });
    }
    const st = live ? liveState[cfg.id] : { status: "done" };
    configs.push({
      id: cfg.id, label: cfg.label, harness: cfg.harness, model: cfg.model,
      status: st.status,
      ...(st.cooldownUntil ? { cooldownUntil: st.cooldownUntil } : {}),
      progress: { done: cells, total: perConfigCells },
      ...(st.currentTask ? { currentTask: st.currentTask } : {}),
      tokens: { input: tin, output: tout },
      apiEquivCostUsd: r2(cost),
      ...(st.window ? { window: st.window } : {}),
    });
  }

  const done = configs.reduce((s, c) => s + c.progress.done, 0);
  const failures = live ? [
    { at: "2026-07-31T09:41:55Z", taskId: "workers/retry-storm", config: "claude-code-sonnet-5-high", trial: 2,
      diagnostic: "exec-local: assertion failed — expected 3 delivery attempts with backoff [1s,4s,16s], observed [1s,1s,1s]; verifier exit 1" },
    { at: "2026-07-31T09:36:10Z", taskId: "nac/merge-divergence", config: "claude-code-fable-5", trial: 1,
      diagnostic: "runner: agent CLI exited 401 (integration token expired mid-trial); config moved to blocked — manual re-auth required" },
    { at: "2026-07-31T09:28:44Z", taskId: "ops/key-leak", config: "codex-gpt56-sol-medium", trial: 3,
      diagnostic: "live-state: leaked key still valid after remediation window; assert revoked==true failed" },
    { at: "2026-07-31T09:15:02Z", taskId: "cli/sync-conflict", config: "codex-gpt56-sol-medium", trial: 2,
      diagnostic: "intents: canonical diff — extra intent update_page(archived=true) not in oracle set" },
    { at: "2026-07-31T08:58:31Z", taskId: "workers/schema-drift", config: "claude-code-sonnet-5-high", trial: 1,
      diagnostic: "typecheck: TS2339 property 'select' does not exist on type 'PartialDatabaseObjectResponse' (workers/handler.ts:47)" },
    { at: "2026-07-31T08:44:19Z", taskId: "ops/quota-forensics", config: "claude-code-fable-5", trial: 3,
      diagnostic: "exec-local: timeout after 900s — agent loop stuck retrying ntn workers logs --follow" },
  ] : [];

  return {
    schemaVersion: 1,
    run: live ? "run-2026-07-29-v1" : "run-2026-07-29-v1",
    startedAt, // extension: needed for the live ETA (not in the original contract)
    generatedAt,
    mode: live ? "live" : "final",
    totals: { cells: perConfigCells * CONFIGS.length, done, failed: live ? failures.length + 1 : 0 },
    configs, results, failures,
  };
}

const finalRun = buildRun({ live: false });
const liveRun = buildRun({ live: true });
writeFileSync(join(OUT, "results.json"), JSON.stringify(finalRun, null, 1));
writeFileSync(join(OUT, "results.live.json"), JSON.stringify(liveRun, null, 1));
writeFileSync(join(OUT, "results.js"),
  "// Auto-generated fallback for file:// where fetch() is unavailable. Same payload as results.json.\n" +
  "window.NOTIONBENCH_DATA = " + JSON.stringify(finalRun) + ";\n");
console.log("wrote results.json (%d results), results.live.json, results.js", finalRun.results.length);
