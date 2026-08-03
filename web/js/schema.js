/**
 * schema.js — the data contract + adapter layer.
 *
 * This is the ONE module that knows the wire shape produced by the runner
 * (`/api/status` in live mode, `data/results.json` in static mode). Everything
 * else in the UI consumes the normalized shape returned by NB.schema.adapt().
 * When the real runner schema diverges from this contract, reconcile it here
 * and nowhere else.
 *
 * Contract (TypeScript; kept as the source of truth even though the site
 * ships as plain JS — mirror any change into the JSDoc typedefs below):
 *
 *   interface StatusPayload {
 *     schemaVersion: 1;
 *     run: string;
 *     startedAt?: string;          // EXTENSION: run start, needed for the live ETA
 *     generatedAt: string;
 *     mode: "live" | "final";
 *     totals: { cells: number; done: number; failed: number };
 *     configs: Array<{
 *       id: string; label: string; harness: string; model: string;
 *       status: "running" | "cooldown" | "blocked" | "done" | "pending";
 *       cooldownUntil?: string;
 *       progress: { done: number; total: number };
 *       currentTask?: string;
 *       tokens: { input: number; output: number };
 *       apiEquivCostUsd: number;
 *       window?: { used: number; limit: number; resetsAt: string };
 *     }>;
 *     results: Array<{
 *       taskId: string; family: string; stage: string; config: string;
 *       trials: Array<{
 *         trial: number; solved: boolean; score: number;   // score in [0,1]
 *         wallTimeS: number; tokens: { input: number; output: number };
 *         toolCalls: number; toolErrors: number;
 *       }>;
 *     }>;
 *     failures: Array<{ at: string; taskId: string; config: string;
 *                       trial: number; diagnostic: string }>;
 *     alerts?: Array<{               // EXTENSION: run watchdog (results/<run>/ALERT.json)
 *       level: "halt" | "warn" | "acknowledged"; kind: string; taskId?: string;
 *       configIds: string[]; evidence: string; at: string; halted: boolean;
 *       acknowledgedReason?: string;
 *     }>;
 *   }
 *
 * `alerts` is additive at schemaVersion 1: it appeared with the runner's
 * deterministic watchdog, which halts a run when several configs fail the same
 * task with the same diagnostic (a verifier bug, not a model failure). A payload
 * without it normalizes to an empty array, so nothing downstream has to branch.
 *
 * `"acknowledged"` is a halt-level signal a human reviewed in advance
 * (`--ack <task>[:<pattern>] --ack-reason "<why>"`) — the run kept going and the
 * failure is still recorded. It is preserved rather than folded into "warn"
 * precisely so the dashboard can distinguish "nobody has looked at this" from
 * "someone looked at this and here is what they said".
 */
(function () {
  "use strict";
  const NB = (window.NB = window.NB || {});

  const FAMILIES = ["cli", "workers", "nac", "ops"];
  const STAGES = ["build", "investigate", "resolve", "operate"];
  const STATUSES = ["running", "cooldown", "blocked", "done", "pending"];

  /** Derive a compact label ("Opus 5 high") from the full config label. */
  function shortLabel(cfg) {
    const m = String(cfg.label || cfg.id).split("×").pop().trim();
    return m.replace(/[()]/g, "").replace(/\s+/g, " ");
  }

  /**
   * Normalize a raw payload into the shape the views consume.
   * Tolerant: fills defaults for anything missing, drops what it can't read.
   * Throws only when the payload is unusable.
   */
  function adapt(raw) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.configs)) {
      throw new Error("unrecognized payload — expected { configs, results, … }");
    }
    if (raw.schemaVersion !== 1) {
      console.warn("NotionBench: unknown schemaVersion", raw.schemaVersion, "— attempting to read anyway");
    }

    const configs = raw.configs.map((c, i) => ({
      id: String(c.id ?? `config-${i}`),
      label: String(c.label ?? c.id ?? `config-${i}`),
      short: shortLabel(c),
      harness: String(c.harness ?? ""),
      model: String(c.model ?? ""),
      status: STATUSES.includes(c.status) ? c.status : "pending",
      cooldownUntil: c.cooldownUntil ?? null,
      progress: { done: c.progress?.done ?? 0, total: c.progress?.total ?? 0 },
      currentTask: c.currentTask ?? null,
      tokens: { input: c.tokens?.input ?? 0, output: c.tokens?.output ?? 0 },
      apiEquivCostUsd: Number(c.apiEquivCostUsd ?? 0),
      window: c.window ?? null,
      slot: i % 7, // fixed color slot by declared order — never re-ranked
    }));

    const results = (raw.results || [])
      .filter((r) => r && r.taskId && Array.isArray(r.trials))
      .map((r) => ({
        taskId: String(r.taskId),
        family: FAMILIES.includes(r.family) ? r.family : "cli",
        stage: STAGES.includes(r.stage) ? r.stage : "build",
        config: String(r.config),
        trials: r.trials.map((t) => ({
          trial: t.trial ?? 0,
          solved: !!t.solved,
          score: Math.max(0, Math.min(1, Number(t.score ?? 0))),
          wallTimeS: Number(t.wallTimeS ?? 0),
          tokens: { input: t.tokens?.input ?? 0, output: t.tokens?.output ?? 0 },
          toolCalls: Number(t.toolCalls ?? 0),
          toolErrors: Number(t.toolErrors ?? 0),
        })),
      }));

    return {
      run: String(raw.run ?? "run"),
      startedAt: raw.startedAt ?? null,
      generatedAt: raw.generatedAt ?? null,
      mode: raw.mode === "live" ? "live" : "final",
      totals: {
        cells: raw.totals?.cells ?? 0,
        done: raw.totals?.done ?? 0,
        failed: raw.totals?.failed ?? 0,
      },
      configs,
      results,
      failures: (raw.failures || []).map((f) => ({
        at: f.at ?? "",
        taskId: f.taskId ?? "?",
        config: f.config ?? "?",
        trial: f.trial ?? 0,
        diagnostic: String(f.diagnostic ?? ""),
      })),
      alerts: (raw.alerts || [])
        .filter((a) => a && a.evidence)
        .map((a) => ({
          level:
            a.level === "halt"
              ? "halt"
              : a.level === "acknowledged"
                ? "acknowledged"
                : "warn",
          kind: String(a.kind ?? "unknown"),
          taskId: a.taskId ?? null,
          configIds: Array.isArray(a.configIds) ? a.configIds.map(String) : [],
          evidence: String(a.evidence),
          at: a.at ?? "",
          halted: !!a.halted,
          acknowledgedReason: a.acknowledgedReason
            ? String(a.acknowledgedReason)
            : null,
        })),
    };
  }

  NB.schema = { adapt, FAMILIES, STAGES };
})();
