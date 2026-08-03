/* stats.js — aggregation + formatting. Pure functions over the adapted model. */
(function () {
  "use strict";
  const NB = (window.NB = window.NB || {});

  /** Half-width of the 95% Wilson score interval for k successes in n trials. */
  function wilsonHalf(k, n, z = 1.96) {
    if (!n) return 0;
    const p = k / n, z2 = z * z;
    return (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  }

  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  function median(xs) {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /** Observed k: the max trials any (task, config) cell completed in this run. */
  function observedK(data) {
    let k = 0;
    for (const r of data.results) k = Math.max(k, r.trials.length);
    return k || 1;
  }

  /** Leaderboard rows: one per config, from trial-level results. */
  function perConfig(data) {
    const k = observedK(data);
    return data.configs.map((cfg) => {
      const rs = data.results.filter((r) => r.config === cfg.id);
      const trials = rs.flatMap((r) => r.trials);
      const solved = trials.filter((t) => t.solved).length;
      const full = rs.filter((r) => r.trials.length >= k);
      // Tokens and time both come from completed trials, so per-trial and total
      // aggregations stay consistent with each other (and with the incomplete-
      // run guard, which compares completed-trial counts).
      const tokIn = trials.reduce((a, t) => a + t.tokens.input, 0);
      const tokOut = trials.reduce((a, t) => a + t.tokens.output, 0);
      return {
        cfg,
        tasks: rs.length,
        trials: trials.length,
        avg: mean(trials.map((t) => t.score)),
        ciHalf: wilsonHalf(solved, trials.length),
        solveRate: trials.length ? solved / trials.length : 0,
        // null, not 0, when no cell has k trials yet: mid-run that means "not
        // enough data", and rendering it as 0% reads as "solved nothing".
        pass3: full.length ? full.filter((r) => r.trials.slice(0, k).every((t) => t.solved)).length / full.length : null,
        pass3n: full.length,
        k,
        toolErrs: mean(trials.map((t) => t.toolErrors)),
        // Errors need their denominator: 2.4 errors on 14 calls and 0.1 on 20
        // are opposite findings that look similar as raw counts.
        toolCalls: mean(trials.map((t) => t.toolCalls)),
        toolErrRate: (() => {
          const calls = trials.reduce((a, t) => a + (t.toolCalls || 0), 0);
          return calls ? trials.reduce((a, t) => a + (t.toolErrors || 0), 0) / calls : null;
        })(),
        tokensIn: tokIn,
        tokensOut: tokOut,
        tokTotal: tokIn + tokOut,
        tokPerTrial: trials.length ? (tokIn + tokOut) / trials.length : 0,
        cost: cfg.apiEquivCostUsd,
        medWallS: median(trials.map((t) => t.wallTimeS)),
        totalWallS: trials.reduce((a, t) => a + t.wallTimeS, 0),
      };
    });
  }

  /** cfgId -> dimValue -> { avg, n } for dim in {"family","stage"}. */
  function matrix(data, dim) {
    const out = {};
    for (const r of data.results) {
      const row = (out[r.config] = out[r.config] || {});
      const cell = (row[r[dim]] = row[r[dim]] || { sum: 0, n: 0 });
      for (const t of r.trials) { cell.sum += t.score; cell.n++; }
    }
    for (const row of Object.values(out))
      for (const c of Object.values(row)) c.avg = c.n ? c.sum / c.n : 0;
    return out;
  }

  /** Task-level rows for one config (the "By agent" view). */
  function taskRows(data, cfgId) {
    return data.results
      .filter((r) => r.config === cfgId)
      .map((r) => ({
        taskId: r.taskId, family: r.family, stage: r.stage,
        trials: r.trials,
        avg: mean(r.trials.map((t) => t.score)),
        bestS: Math.min(...r.trials.map((t) => t.wallTimeS)),
      }));
  }

  /** Live ETA from overall completion rate since startedAt. Null if unknowable. */
  function etaMs(data, now = Date.now()) {
    if (!data.startedAt || !data.totals.done) return null;
    const elapsed = now - Date.parse(data.startedAt);
    if (elapsed <= 0) return null;
    const remaining = data.totals.cells - data.totals.done;
    return remaining * (elapsed / data.totals.done);
  }

  /* ---------- formatters ---------- */
  const fmt = {
    pct: (x, d = 0) => (x === null || x === undefined ? "—" : (100 * x).toFixed(d) + "%"),
    score: (x) => x.toFixed(2),
    money: (x) => "$" + (x >= 100 ? Math.round(x).toLocaleString("en-US") : x.toFixed(2)),
    tokens(n) {
      if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
      if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
      return String(n);
    },
    dur(s) {
      s = Math.round(s);
      if (s < 60) return s + "s";
      const m = Math.floor(s / 60);
      if (m < 60) return m + "m " + (s % 60) + "s";
      return Math.floor(m / 60) + "h " + (m % 60) + "m";
    },
    durMs: (ms) => fmt.dur(ms / 1000),
    time(iso) {
      if (!iso) return "—";
      const d = new Date(iso);
      return isNaN(d) ? "—" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    },
    date(iso) {
      if (!iso) return "—";
      const d = new Date(iso);
      return isNaN(d) ? "—" : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    },
  };

  NB.stats = { observedK, wilsonHalf, mean, median, perConfig, matrix, taskRows, etaMs };
  NB.fmt = fmt;
})();
