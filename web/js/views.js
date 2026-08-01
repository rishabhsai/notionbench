/* views.js — DOM rendering: page meta, live section, database card, charts. */
(function () {
  "use strict";
  const NB = (window.NB = window.NB || {});
  const { fmt } = NB;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const FAMILY_TAG = { cli: "tag-blue", workers: "tag-orange", nac: "tag-purple", ops: "tag-green" };
  const STAGE_TAG = { build: "tag-yellow", investigate: "tag-blue", resolve: "tag-pink", operate: "tag-gray" };
  const FAMILY_NAME = { cli: "ntn CLI", workers: "Workers", nac: "Notion-as-Code", ops: "Operations" };
  const STATUS = {
    running: { icon: "▸", word: "running" },
    done: { icon: "✓", word: "done" },
    cooldown: { icon: "⏸", word: "cooldown" },
    blocked: { icon: "✕", word: "blocked" },
    pending: { icon: "○", word: "pending" },
  };
  const slotVar = (i) => `var(--s${(i % 7) + 1})`;
  const famTag = (f) => `<span class="tag ${FAMILY_TAG[f] || "tag-gray"}">${esc(f)}</span>`;
  const stgTag = (s) => `<span class="tag ${STAGE_TAG[s] || "tag-gray"}">${esc(s)}</span>`;
  const statusChip = (s) => {
    const m = STATUS[s] || STATUS.pending;
    return `<span class="status-chip ${esc(s)}"><span aria-hidden="true">${m.icon}</span>${m.word}</span>`;
  };
  const meterHtml = (frac, fill, extra = "") =>
    `<div class="meter ${extra}" style="--fill:${fill};--track:color-mix(in srgb, ${fill} 20%, transparent)"><i style="width:${(100 * Math.max(0, Math.min(1, frac))).toFixed(1)}%"></i></div>`;

  /* ---------- page meta ---------- */
  function renderMeta(data, live) {
    $("run-meta").innerHTML =
      `<span class="mono">${esc(data.run)}</span>` +
      `<span>updated ${fmt.date(data.generatedAt)}</span>` +
      `<span>k=${NB.stats.observedK(data)} trial${NB.stats.observedK(data) === 1 ? "" : "s"} · ${data.totals.cells.toLocaleString("en-US")} cells</span>`;
    const pill = $("mode-pill");
    if (live) {
      pill.className = "pill pill-live";
      pill.textContent = "Live";
    } else {
      pill.className = "pill";
      pill.textContent = data.mode === "final" ? "Final results" : "Snapshot";
    }
  }

  /* ---------- live section ---------- */
  function renderLive(data) {
    const { totals } = data;
    $("hero-done").textContent = totals.done.toLocaleString("en-US");
    $("hero-total").textContent = totals.cells.toLocaleString("en-US");
    const eta = NB.stats.etaMs(data);
    $("hero-eta").textContent = eta && totals.done < totals.cells ? `≈ ${fmt.durMs(eta)} remaining` : totals.done >= totals.cells ? "run complete" : "";
    $("hero-meter").innerHTML = meterHtml(totals.done / (totals.cells || 1), "var(--seq)");
    $("hero-meter").setAttribute("aria-label", `${totals.done} of ${totals.cells} cells complete`);
    const elapsed = data.startedAt ? Date.now() - Date.parse(data.startedAt) : null;
    $("hero-stats").innerHTML =
      `<span><b>${fmt.pct(totals.done / (totals.cells || 1))}</b> complete</span>` +
      `<span><b>${totals.failed}</b> failed cells</span>` +
      (elapsed ? `<span><b>${fmt.durMs(elapsed)}</b> elapsed</span>` : "") +
      `<span><b>${data.configs.filter((c) => c.status === "done").length}/${data.configs.length}</b> configs done</span>`;

    // lanes
    $("lanes").innerHTML = data.configs.map((c) => {
      const frac = c.progress.total ? c.progress.done / c.progress.total : 0;
      const fill = { running: "var(--seq)", done: "var(--st-good)", cooldown: "var(--st-warn)", blocked: "var(--st-crit)", pending: "var(--ink-3)" }[c.status];
      let side = "";
      if (c.window) {
        const wf = c.window.limit ? c.window.used / c.window.limit : 0;
        side += `<span>window ${fmt.tokens(c.window.used)} / ${fmt.tokens(c.window.limit)} · resets ${fmt.time(c.window.resetsAt)}</span>` +
                meterHtml(wf, wf >= 0.95 ? "var(--st-warn)" : "var(--seq)", "thin");
      }
      if (c.status === "cooldown" && c.cooldownUntil) side += `<span>resumes ${fmt.time(c.cooldownUntil)}</span>`;
      if (c.status === "blocked") side += `<span style="color:var(--st-crit)">needs attention — see failures</span>`;
      const now = c.currentTask ? `<div class="lane-now" title="current task">▸ ${esc(c.currentTask)}</div>` : "";
      return `<div class="lane">
        <div class="lane-id">
          <span class="dot" style="background:${slotVar(c.slot)}"></span>
          <span class="lane-name" title="${esc(c.label)}">${esc(c.short)}</span>
          ${statusChip(c.status)}
        </div>
        <div class="lane-mid">
          ${meterHtml(frac, fill)}
          <div class="lane-count">${c.progress.done} / ${c.progress.total} cells</div>
          ${now}
        </div>
        <div class="lane-side">${side}</div>
      </div>`;
    }).join("");

    // failures feed
    const feed = [...data.failures].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 12);
    $("failures").innerHTML = feed.length
      ? feed.map((f) => {
          const cfg = data.configs.find((c) => c.id === f.config);
          return `<div class="fail-row">
            <div class="fail-head"><span class="fail-x">✕</span><span>${fmt.time(f.at)}</span><span class="fail-task">${esc(f.taskId)}</span><span>${esc(cfg ? cfg.short : f.config)} · trial ${f.trial}</span></div>
            <div class="fail-diag">${esc(f.diagnostic)}</div>
          </div>`;
        }).join("")
      : `<span class="empty">No failures yet.</span>`;
  }

  /* ---------- database card ---------- */
  const TABS = [
    { id: "all", icon: "▤", label: "All results" },
    { id: "product", icon: "▦", label: "By product" },
    { id: "stage", icon: "▥", label: "By stage" },
    { id: "agent", icon: "☰", label: "By agent" },
  ];

  function renderTabs(state, onTab) {
    $("tabs").innerHTML = TABS.map((t) =>
      `<button class="vtab" role="tab" id="vtab-${t.id}" aria-selected="${state.tab === t.id}" data-tab="${t.id}"><span class="ti" aria-hidden="true">${t.icon}</span>${t.label}</button>`
    ).join("");
    for (const b of $("tabs").querySelectorAll(".vtab"))
      b.addEventListener("click", () => onTab(b.dataset.tab));
  }

  const LB_COLS = [
    { key: "label", label: "Agent config", num: false },
    { key: "avg", label: "avg@k", num: true },
    { key: "pass3", label: "pass^k", num: true },
    { key: "toolErrs", label: "Tool errors", num: true, title: "mean per trial" },
    { key: "tokPerTrial", label: "Tokens/trial", num: true, title: "mean tokens per completed trial" },
    { key: "tokTotal", label: "Total tokens", num: true, cls: "col-total", title: "summed over completed trials" },
    { key: "cost", label: "API-equiv cost", num: true },
    { key: "medWallS", label: "Median time", num: true, title: "median wall time per trial" },
    { key: "totalWallS", label: "Total time", num: true, cls: "col-total", title: "summed wall time over completed trials" },
  ];

  function renderLeaderboard(data, state, rerender) {
    const rows = NB.stats.perConfig(data).filter((r) => r.trials > 0);
    // Totals are only comparable across configs that completed the same number
    // of cells; mid-run stragglers get their two total columns muted + starred.
    const maxTrials = rows.reduce((a, r) => Math.max(a, r.trials), 0);
    const key = state.sort.key, dir = state.sort.dir;
    const val = (r) => key === "label" ? r.cfg.label.toLowerCase() : r[key];
    rows.sort((a, b) => (val(a) > val(b) ? dir : val(a) < val(b) ? -dir : 0));

    const partial = data.configs.some((c) => c.status !== "done");
    const head = LB_COLS.map((c) => {
      const arrow = state.sort.key === c.key ? `<span class="arr">${dir < 0 ? "▼" : "▲"}</span>` : "";
      return `<th class="sortable ${c.num ? "num" : ""} ${c.cls || ""}" data-key="${c.key}" ${c.title ? `title="${c.title}"` : ""} aria-sort="${state.sort.key === c.key ? (dir < 0 ? "descending" : "ascending") : "none"}">${c.label}${arrow}</th>`;
    }).join("");

    let starred = false;
    const body = rows.map((r, i) => {
      const running = r.cfg.status !== "done" && data.mode === "live";
      const short = r.trials < maxTrials;
      if (short) starred = true;
      const star = short ? `<span class="star" aria-label="not comparable — fewer completed cells">*</span>` : "";
      const totCls = short ? "num col-total not-comp" : "num col-total";
      const inOut = `${r.tokensIn.toLocaleString("en-US")} in / ${r.tokensOut.toLocaleString("en-US")} out`;
      return `<tr>
        <td class="rank">${i + 1}</td>
        <td><div class="cfg-cell"><span class="dot" style="background:${slotVar(r.cfg.slot)}"></span><span>${esc(r.cfg.label)}${running ? ` <span class="sub">(${r.cfg.progress.done}/${r.cfg.progress.total} cells)</span>` : ""}</span></div></td>
        <td class="num"><span class="score-cell">${meterHtml(r.avg, "var(--seq)", "thin")}<span>${fmt.score(r.avg)}<span class="ci">±${r.ciHalf.toFixed(2)}</span></span></span></td>
        <td class="num">${fmt.pct(r.pass3)}</td>
        <td class="num">${r.toolErrs.toFixed(1)}</td>
        <td class="num" title="mean over ${r.trials} completed trial${r.trials === 1 ? "" : "s"}">${fmt.tokens(Math.round(r.tokPerTrial))}</td>
        <td class="${totCls}" title="${inOut}">${fmt.tokens(r.tokTotal)}${star}</td>
        <td class="num">${fmt.money(r.cost)}</td>
        <td class="num">${fmt.dur(r.medWallS)}</td>
        <td class="${totCls}">${fmt.dur(r.totalWallS)}${star}</td>
      </tr>`;
    }).join("");

    $("board").innerHTML = `<table class="db">
      <thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table>` +
      (partial ? `<p class="chart-note">Configs still running are scored on completed cells only — ± is the 95% Wilson interval on the solve rate.</p>`
               : `<p class="chart-note">± is the 95% Wilson interval on the solve rate. pass^k = solved in all k trials (k = ${NB.stats.observedK(data)} in this run). Tokens/trial is the mean per completed trial; median time the per-trial median; the total columns are sums over the run.</p>`) +
      (starred ? `<p class="chart-note">* Total tokens and total time are sums over completed cells only — this config has completed fewer cells than the fullest one, so its totals cover less work and aren't comparable across rows. Per-trial means and medians are.</p>` : "");

    for (const th of $("board").querySelectorAll("th.sortable"))
      th.addEventListener("click", () => {
        const k = th.dataset.key;
        state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : k === "label" ? 1 : -1 };
        rerender();
      });
  }

  function renderMatrix(data, dim) {
    const keys = dim === "family" ? NB.schema.FAMILIES : NB.schema.STAGES;
    const tag = dim === "family" ? famTag : stgTag;
    const mx = NB.stats.matrix(data, dim);
    const rows = NB.stats.perConfig(data).filter((r) => r.trials > 0).sort((a, b) => b.avg - a.avg);
    const head = keys.map((k) => `<th class="num">${tag(k)}</th>`).join("");
    const body = rows.map((r) => {
      const cells = keys.map((k) => {
        const c = mx[r.cfg.id]?.[k];
        if (!c || !c.n) return `<td class="num" style="color:var(--ink-3)">–</td>`;
        const w = Math.max(0, Math.min(1, (c.avg - 0.45) / 0.55));
        return `<td class="num heat" style="--w:${w.toFixed(2)}" title="${c.n} trials"><span>${c.avg.toFixed(2)}</span></td>`;
      }).join("");
      return `<tr><td><div class="cfg-cell"><span class="dot" style="background:${slotVar(r.cfg.slot)}"></span>${esc(r.cfg.label)}</div></td>${cells}<td class="num" style="color:var(--ink-2)">${fmt.score(r.avg)}</td></tr>`;
    }).join("");
    $("board").innerHTML = `<table class="db"><thead><tr><th>Agent config</th>${head}<th class="num">Overall</th></tr></thead><tbody>${body}</tbody></table>` +
      `<p class="chart-note">Cell shading tracks avg@3 within the ${dim === "family" ? "product family" : "stage"} — darker wash, higher score.</p>`;
  }

  function renderByAgent(data, state, rerender) {
    if (!state.agent || !data.configs.some((c) => c.id === state.agent)) state.agent = data.configs[0]?.id;
    const picker = `<div class="agent-picker" role="group" aria-label="Pick an agent config">` +
      data.configs.map((c) =>
        `<button class="agent-chip" aria-pressed="${c.id === state.agent}" data-id="${c.id}"><span class="dot" style="background:${slotVar(c.slot)}"></span>${esc(c.short)}</button>`
      ).join("") + `</div>`;

    const rows = NB.stats.taskRows(data, state.agent);
    const body = rows.map((r) => {
      const dots = [0, 1, 2].map((i) => {
        const t = r.trials[i];
        if (!t) return `<span class="tdot miss" title="trial ${i + 1}: not run"></span>`;
        return `<span class="tdot ${t.solved ? "pass" : "fail"}" title="trial ${t.trial}: ${t.solved ? "solved" : "failed"} · score ${t.score.toFixed(2)}"></span>`;
      }).join("");
      return `<tr>
        <td class="mono">${esc(r.taskId)}</td>
        <td>${famTag(r.family)}</td><td>${stgTag(r.stage)}</td>
        <td><span class="trials" aria-label="${r.trials.filter((t) => t.solved).length} of ${r.trials.length} trials solved">${dots}</span></td>
        <td class="num">${fmt.score(r.avg)}</td>
        <td class="num">${isFinite(r.bestS) ? fmt.dur(r.bestS) : "–"}</td>
      </tr>`;
    }).join("");
    $("board").innerHTML = picker + (rows.length
      ? `<table class="db"><thead><tr><th>Task</th><th>Family</th><th>Stage</th><th>Trials</th><th class="num">avg@3</th><th class="num">Best time</th></tr></thead><tbody>${body}</tbody></table>` +
        `<p class="chart-note">● solved · ◯ failed · dashed = not yet run.</p>`
      : `<p class="chart-note">No completed cells for this config yet.</p>`);
    for (const b of $("board").querySelectorAll(".agent-chip"))
      b.addEventListener("click", () => { state.agent = b.dataset.id; rerender(); });
  }

  function renderBoard(data, state) {
    const rerender = () => renderBoard(data, state);
    renderTabs(state, (tab) => { state.tab = tab; rerender(); });
    if (state.tab === "product") renderMatrix(data, "family");
    else if (state.tab === "stage") renderMatrix(data, "stage");
    else if (state.tab === "agent") renderByAgent(data, state, rerender);
    else renderLeaderboard(data, state, rerender);
  }

  /* ---------- charts ---------- */
  function renderCharts(data) {
    const rows = NB.stats.perConfig(data).filter((r) => r.trials > 0 && r.cost > 0);
    NB.charts.pareto($("chart-pareto"), rows.map((r) => ({
      label: r.cfg.short, cost: r.cost, avg: r.avg, ciHalf: r.ciHalf,
    })));

    const mx = NB.stats.matrix(data, "family");
    const famTasks = {};
    for (const r of data.results) (famTasks[r.family] = famTasks[r.family] || new Set()).add(r.taskId);
    NB.charts.familyBars($("chart-family"), NB.schema.FAMILIES.map((f) => ({
      family: f, tagClass: FAMILY_TAG[f],
      n: famTasks[f] ? famTasks[f].size : 0,
      rows: data.configs.map((c) => {
        const cell = mx[c.id]?.[f];
        return { label: c.short, full: c.label, color: slotVar(c.slot), value: cell && cell.n ? cell.avg : null, trials: cell ? cell.n : 0 };
      }),
    })));
  }

  NB.views = {
    render(data, state, { live }) {
      // unhide first: chart label collision-solving needs measurable bboxes
      $("loading").hidden = true;
      $("app").hidden = false;
      renderMeta(data, live);
      const liveSec = $("live");
      const showLive = live || data.mode === "live";
      liveSec.hidden = !showLive;
      if (showLive) renderLive(data);
      renderBoard(data, state);
      renderCharts(data);
    },
  };
})();
