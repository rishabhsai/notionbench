/* main.js — mode detection, data loading, polling, orchestration.
 *
 * Mode is auto-detected from URL hash params:
 *   #api=https://host:8377&key=abc  → LIVE: poll ${api}/api/status every 10s
 *   (no hash params)                → STATIC: load ./data/results.json once
 */
(function () {
  "use strict";
  const NB = window.NB;
  const POLL_MS = 10_000;

  const state = { tab: "all", sort: { key: "avg", dir: -1 }, agent: null };
  let lastGood = null;

  function hashParams() {
    const p = new URLSearchParams(location.hash.replace(/^#/, ""));
    return { api: p.get("api"), key: p.get("key") };
  }

  function render(data, live) {
    NB.views.render(data, state, { live });
  }

  function showError(msg) {
    const load = document.getElementById("loading");
    load.hidden = false;
    load.textContent = msg;
  }

  /* ---------- static mode ---------- */
  async function startStatic() {
    try {
      const res = await fetch("data/results.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      render(NB.schema.adapt(await res.json()), false);
    } catch (err) {
      // file:// blocks fetch — fall back to the classic-script payload
      const s = document.createElement("script");
      s.src = "data/results.js";
      s.onload = () => {
        try { render(NB.schema.adapt(window.NOTIONBENCH_DATA), false); }
        catch (e) { showError("Could not read results: " + e.message); }
      };
      s.onerror = () => showError("Could not load results (" + err.message + ").");
      document.head.append(s);
    }
  }

  /* ---------- live mode ---------- */
  async function pollLive(api, key) {
    const connPill = document.getElementById("conn-pill");
    try {
      const res = await fetch(api.replace(/\/$/, "") + "/api/status", {
        cache: "no-store",
        headers: key ? { Authorization: "Bearer " + key } : {},
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      lastGood = NB.schema.adapt(await res.json());
      connPill.hidden = true;
      render(lastGood, true);
    } catch (err) {
      // hold the previous render; just surface the connection state
      connPill.hidden = false;
      connPill.textContent = "reconnecting…";
      if (!lastGood) showError("Can't reach " + api + " — " + err.message + ". Retrying every 10s.");
    }
  }

  function startLive(api, key) {
    pollLive(api, key);
    setInterval(() => { if (!document.hidden) pollLive(api, key); }, POLL_MS);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) pollLive(api, key); });
  }

  /* ---------- boot ---------- */
  function boot() {
    const { api, key } = hashParams();
    if (api) startLive(api, key);
    else startStatic();
  }
  window.addEventListener("hashchange", () => location.reload());
  boot();
})();
