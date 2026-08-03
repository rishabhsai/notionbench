/* charts.js — hand-rolled inline SVG. No libraries, no external requests.
   Specs follow the dataviz method: 2px lines, ≥8px markers with a 2px surface
   ring, bars ≤24px with rounded data-ends and square baselines, hairline solid
   gridlines, selective direct labels, tooltips that enhance (the leaderboard
   table is every chart's table-view twin). */
(function () {
  "use strict";
  const NB = (window.NB = window.NB || {});
  const SVGNS = "http://www.w3.org/2000/svg";

  function el(name, attrs = {}, text) {
    const n = document.createElementNS(SVGNS, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  }

  /* ---------- tooltip ---------- */
  const tip = {
    node: null,
    show(html, x, y) {
      const t = (this.node = this.node || document.getElementById("nb-tip"));
      if (!t) return;
      t.innerHTML = html;
      t.hidden = false;
      const r = t.getBoundingClientRect();
      const px = Math.min(x + 14, window.innerWidth - r.width - 8);
      const py = Math.max(8, Math.min(y - r.height - 10, window.innerHeight - r.height - 8));
      t.style.left = px + "px";
      t.style.top = (y - r.height - 10 < 8 ? y + 16 : py) + "px";
    },
    hide() { if (this.node) this.node.hidden = true; },
  };
  NB.tip = tip;

  function hoverable(node, html) {
    node.addEventListener("pointerenter", (e) => tip.show(html, e.clientX, e.clientY));
    node.addEventListener("pointermove", (e) => tip.show(html, e.clientX, e.clientY));
    node.addEventListener("pointerleave", () => tip.hide());
    node.addEventListener("focus", () => {
      const r = node.getBoundingClientRect();
      tip.show(html, r.left + r.width / 2, r.top);
    });
    node.addEventListener("blur", () => tip.hide());
    node.setAttribute("tabindex", "0");
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ---------- 1. score-vs-cost Pareto scatter ---------- */
  // points: [{ label, cost, avg, ciHalf }] — one hue for all dots; identity is
  // carried by direct labels (7 series of distinct hues would fail all-pairs CVD).
  function pareto(container, points) {
    container.replaceChildren();
    if (!points.length) return;
    const W = 460, H = 300, m = { t: 24, r: 20, b: 40, l: 44 };
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Scatter plot of avg@3 score against API-equivalent cost per agent config" });

    const costs = points.map((p) => p.cost), avgs = points.map((p) => p.avg);
    const x0 = Math.log10(Math.min(...costs) * 0.7), x1 = Math.log10(Math.max(...costs) * 1.5);
    let yMin = Math.floor((Math.min(...avgs) - 0.06) * 10) / 10, yMax = 1;
    const X = (c) => m.l + ((Math.log10(c) - x0) / (x1 - x0)) * (W - m.l - m.r);
    const Y = (v) => m.t + ((yMax - v) / (yMax - yMin)) * (H - m.t - m.b);

    // gridlines + ticks
    for (let v = yMin; v <= yMax + 1e-9; v += 0.1) {
      svg.append(el("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: "var(--grid)", "stroke-width": 1 }));
      svg.append(el("text", { x: m.l - 7, y: Y(v) + 3.5, "text-anchor": "end", "font-size": 10.5, fill: "var(--ink-3)" }, v.toFixed(1)));
    }
    for (const c of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]) {
      if (Math.log10(c) < x0 || Math.log10(c) > x1) continue;
      svg.append(el("line", { x1: X(c), x2: X(c), y1: H - m.b, y2: H - m.b + 4, stroke: "var(--axis)", "stroke-width": 1 }));
      svg.append(el("text", { x: X(c), y: H - m.b + 15, "text-anchor": "middle", "font-size": 10.5, fill: "var(--ink-3)" }, "$" + c));
    }
    svg.append(el("line", { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, stroke: "var(--axis)", "stroke-width": 1 }));
    svg.append(el("text", { x: (m.l + W - m.r) / 2, y: H - 6, "text-anchor": "middle", "font-size": 10.5, fill: "var(--ink-3)" }, "API-equivalent cost (USD, log scale)"));
    svg.append(el("text", { x: 12, y: 11, "font-size": 10.5, fill: "var(--ink-3)" }, "avg@3"));

    // Pareto frontier: cheapest-first, keep score maxima; step line under the dots
    const sorted = [...points].sort((a, b) => a.cost - b.cost);
    const frontier = [];
    let best = -1;
    for (const p of sorted) if (p.avg > best) { frontier.push(p); best = p.avg; }
    if (frontier.length > 1) {
      let d = `M ${X(frontier[0].cost)} ${Y(frontier[0].avg)}`;
      for (let i = 1; i < frontier.length; i++)
        d += ` H ${X(frontier[i].cost)} V ${Y(frontier[i].avg)}`;
      svg.append(el("path", { d, fill: "none", stroke: "var(--axis)", "stroke-width": 1.5, "stroke-linejoin": "round" }));
    }

    // direct labels; overlaps resolved after render via real bboxes
    const labelNodes = [];
    for (const p of points) {
      const px = X(p.cost), py = Y(p.avg);
      const left = px > W - m.r - 80;
      labelNodes.push(el("text", {
        x: left ? px - 10 : px + 10, y: py + 3.5,
        "text-anchor": left ? "end" : "start", "font-size": 11, fill: "var(--ink-2)",
        // Halo in the page background so a gridline crossing a label reads as a
        // gridline behind it rather than as a strikethrough through it.
        stroke: "var(--bg)", "stroke-width": 3, "paint-order": "stroke fill",
      }, p.label));
      svg.append(labelNodes[labelNodes.length - 1]);
    }

    // dots last: single hue, 2px surface ring, generous hit target
    for (const p of points) {
      const g = el("g");
      g.append(el("circle", { cx: X(p.cost), cy: Y(p.avg), r: 13, fill: "transparent" }));
      g.append(el("circle", { cx: X(p.cost), cy: Y(p.avg), r: 5, fill: "var(--seq)", stroke: "var(--bg)", "stroke-width": 2 }));
      hoverable(g, `<b>${esc(p.label)}</b><br>avg@3 ${p.avg.toFixed(2)} <span class="t2">±${p.ciHalf.toFixed(2)}</span><br><span class="t2">cost ${NB.fmt.money(p.cost)}</span>`);
      svg.append(g);
    }
    container.append(svg);

    // collision pass: with the svg in the DOM, real bboxes are measurable —
    // push overlapping labels apart vertically, keeping them inside the plot
    const boxes = [];
    const nodes = labelNodes
      .map((n) => ({ n, b: n.getBBox() }))
      .sort((a, b) => a.b.y - b.b.y);
    for (const it of nodes) {
      let { y } = it.b;
      const hits = (yy) => boxes.some((q) =>
        yy < q.y + q.height + 2 && yy + it.b.height + 2 > q.y &&
        it.b.x < q.x + q.width + 6 && it.b.x + it.b.width + 6 > q.x);
      let guard = 0;
      while (hits(y) && guard++ < 40) y += 3;
      if (y !== it.b.y) it.n.setAttribute("y", +it.n.getAttribute("y") + (y - it.b.y));
      boxes.push({ x: it.b.x, y, width: it.b.width, height: it.b.height });
    }
  }

  /* ---------- 2. per-family grouped bars (small multiples) ---------- */
  // families: [{ family, tagClass, rows: [{ label, value|null, color, n }] }]
  function familyBars(container, families) {
    container.replaceChildren();
    const grid = document.createElement("div");
    grid.className = "family-grid";
    for (const fam of families) {
      const panel = document.createElement("div");
      panel.className = "family-panel";
      const head = document.createElement("div");
      head.className = "fp-head";
      head.innerHTML = `<span class="tag ${fam.tagClass}">${esc(fam.family)}</span> <span class="mono" style="color:var(--ink-3);font-size:11px">${fam.n} tasks</span>`;
      panel.append(head);

      const rows = fam.rows, rowH = 22, barH = 13;
      // L is the label gutter. Config names grew when the roster went to eight
      // ("DeepSeek V4 Flash", "GPT-5.6 Sol xhigh") and were being clipped at the
      // viewBox edge, so the gutter and the box widen together.
      const W = 366, L = 124, R = 30, H = rows.length * rowH + 6;
      const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `avg@3 by agent for ${fam.family} tasks` });
      const X = (v) => L + v * (W - L - R);
      for (const g of [0.25, 0.5, 0.75, 1])
        svg.append(el("line", { x1: X(g), x2: X(g), y1: 2, y2: H - 4, stroke: "var(--grid)", "stroke-width": 1 }));
      svg.append(el("line", { x1: L, x2: L, y1: 2, y2: H - 4, stroke: "var(--axis)", "stroke-width": 1 }));

      rows.forEach((r, i) => {
        const y = i * rowH + 4;
        svg.append(el("text", { x: L - 7, y: y + barH - 3, "text-anchor": "end", "font-size": 10.5, fill: "var(--ink-2)" }, r.label));
        if (r.value == null) {
          svg.append(el("text", { x: L + 6, y: y + barH - 3, "font-size": 10.5, fill: "var(--ink-3)" }, "–"));
          return;
        }
        const w = Math.max(0, (r.value) * (W - L - R));
        const rr = Math.min(4, w); // rounded data-end, square baseline
        const d = `M ${L} ${y} h ${Math.max(0, w - rr)} a ${rr} ${rr} 0 0 1 ${rr} ${rr} v ${barH - 2 * rr} a ${rr} ${rr} 0 0 1 ${-rr} ${rr} h ${-Math.max(0, w - rr)} Z`;
        const bar = el("path", { d, fill: r.color });
        hoverable(bar, `<b>${esc(r.full)}</b><br>${esc(fam.family)} avg@3 ${r.value.toFixed(2)} <span class="t2">· ${r.trials} trials</span>`);
        svg.append(bar);
        svg.append(el("text", { x: L + w + 5, y: y + barH - 3, "font-size": 10.5, fill: "var(--ink)" }, r.value.toFixed(2)));
      });
      panel.append(svg);
      grid.append(panel);
    }
    container.append(grid);
  }

  NB.charts = { pareto, familyBars };
})();
