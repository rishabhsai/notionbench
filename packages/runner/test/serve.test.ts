/**
 * `notionbench serve` — the live dashboard endpoint.
 *
 * The load-bearing assertion here is *conformance*: the payload is fed to the
 * real `web/js/schema.js` adapter (evaluated in a vm with a fake `window`), so a
 * drift between the runner and the page fails this test instead of silently
 * rendering an empty dashboard at 2am mid-run.
 */

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cellKey, type CellState, type RunStateFile } from '../src/checkpoint.js';
import type { RateWindowState } from '../src/queue.js';
import { StatusSource, buildStatus, dashboardUrl, serve, type ServeHandle } from '../src/serve.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WEB_ROOT = path.join(REPO_ROOT, 'web');
const KEY = 'test-token-0123456789';

// --- the page's own adapter, loaded once ------------------------------------

/** Run web/js/schema.js in a vm with a fake `window` and hand back NB.schema. */
function loadPageSchema(): { adapt: (raw: unknown) => Record<string, unknown> } {
  const src = readFileSync(path.join(WEB_ROOT, 'js', 'schema.js'), 'utf8');
  const window: Record<string, unknown> = {};
  vm.runInNewContext(src, { window, console });
  const nb = window.NB as { schema: { adapt: (raw: unknown) => Record<string, unknown> } };
  return nb.schema;
}

// --- fabricated run directory ------------------------------------------------

type Fixture = { dir: string; state: RunStateFile };

const CONFIG_META = [
  { id: 'cfg-running', harness: 'claude-code', model: 'opus' },
  { id: 'cfg-cooldown', harness: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
  { id: 'cfg-blocked', harness: 'claude-code', model: 'fable' },
  { id: 'cfg-done', harness: 'claude-code', model: 'haiku' },
  { id: 'cfg-pending', harness: 'codex', model: 'gpt-5.6-luna' },
];

function usage(input: number, output: number, inclusive = false) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: 1_000,
    cacheCreationInputTokens: 500,
    reasoningOutputTokens: 0,
    totalTokens: input + output,
    inputTokensIncludeCached: inclusive,
  };
}

function cell(over: Partial<CellState> & Pick<CellState, 'taskId' | 'configId' | 'trial'>): CellState {
  return {
    docsCondition: 'with',
    status: 'pending',
    attempts: 0,
    rateLimitedAttempts: 0,
    history: [],
    ...over,
  } as CellState;
}

function stateFile(): RunStateFile {
  const cells: CellState[] = [
    // cfg-running: one done, one in flight.
    cell({
      taskId: 'build-cli-001',
      configId: 'cfg-running',
      trial: 1,
      status: 'done',
      usage: usage(120_000, 8_000),
      apiEquivalentCostUsd: 1.25,
      toolErrors: 0,
      score: 1,
      scored: true,
      finishedAt: '2026-07-31T09:10:00.000Z',
    }),
    cell({
      taskId: 'build-nac-001',
      configId: 'cfg-running',
      trial: 1,
      status: 'running',
      startedAt: '2026-07-31T09:40:00.000Z',
    }),
    // cfg-cooldown: pending work, paused by a usage window.
    cell({ taskId: 'build-cli-001', configId: 'cfg-cooldown', trial: 1, status: 'pending', rateLimitedAttempts: 3 }),
    cell({
      taskId: 'build-nac-001',
      configId: 'cfg-cooldown',
      trial: 1,
      status: 'done',
      usage: usage(90_000, 5_000, true),
      apiEquivalentCostUsd: 0.5,
      finishedAt: '2026-07-31T08:00:00.000Z',
    }),
    // cfg-blocked: gave up on one cell entirely.
    cell({
      taskId: 'build-cli-001',
      configId: 'cfg-blocked',
      trial: 1,
      status: 'failed',
      attempts: 3,
      lastError: 'agent CLI exited 401 (integration token expired mid-trial)',
      lastTrialStatus: 'spawn_error',
      finishedAt: '2026-07-31T09:36:10.000Z',
    }),
    cell({ taskId: 'build-nac-001', configId: 'cfg-blocked', trial: 1, status: 'pending', rateLimitedAttempts: 20 }),
    // cfg-done: nothing left open.
    cell({
      taskId: 'build-cli-001',
      configId: 'cfg-done',
      trial: 1,
      status: 'done',
      usage: usage(10_000, 1_000),
      apiEquivalentCostUsd: 0.02,
      finishedAt: '2026-07-31T07:00:00.000Z',
    }),
    // cfg-pending: never started.
    cell({ taskId: 'build-cli-001', configId: 'cfg-pending', trial: 1 }),
  ];
  const byKey: Record<string, CellState> = {};
  for (const c of cells) byKey[cellKey(c)] = c;
  return {
    version: 1,
    runId: '20260731-060000',
    createdAt: '2026-07-31T05:59:00.000Z',
    updatedAt: '2026-07-31T09:47:00.000Z',
    meta: {
      concurrency: 2,
      trials: 3,
      docsConditions: ['with', 'without'],
      maxAttempts: 3,
      cooldownMs: 1_800_000,
      evalsRoot: '/repo/evals',
      resultsRoot: '/repo/results',
      configs: CONFIG_META,
      taskIds: ['build-cli-001', 'build-nac-001'],
      provenance: { startedAt: '2026-07-31T06:00:00.000Z', node: 'v22.0.0' },
    },
    cells: byKey,
  };
}

function record(over: Record<string, unknown>): Record<string, unknown> {
  return {
    v: 1,
    runId: '20260731-060000',
    taskId: 'build-cli-001',
    family: 'cli',
    stage: 'build',
    configId: 'cfg-running',
    docsCondition: 'with',
    trial: 1,
    score: 1,
    scored: true,
    status: 'completed',
    toolCalls: 20,
    toolErrors: 0,
    tokens: usage(120_000, 8_000),
    apiEquivalentCostUsd: 1.25,
    wallTimeMs: 98_400,
    startedAt: '2026-07-31T09:08:00.000Z',
    finishedAt: '2026-07-31T09:10:00.000Z',
    ...over,
  };
}

const RECORDS = [
  record({}),
  // same task+config, the OTHER docs condition — the dashboard has no docs axis.
  record({ docsCondition: 'without', score: 0.6, diagnostics: ['3 of 5 assertions failed'] }),
  record({
    taskId: 'build-nac-001',
    // No family/stage on this row: they are optional in results.jsonl, and the
    // dashboard needs both, so they must be inferred from the task id.
    family: undefined,
    stage: undefined,
    configId: 'cfg-cooldown',
    trial: 2,
    score: 0,
    scored: false,
    scoreError: 'verifier timed out after 600s',
    status: 'completed',
    finishedAt: '2026-07-31T08:00:00.000Z',
  }),
  record({
    taskId: 'build-cli-001',
    configId: 'cfg-done',
    trial: 3,
    score: 0.25,
    diagnostics: ['expected 3 retries with backoff, observed 1'],
    finishedAt: '2026-07-31T07:00:00.000Z',
  }),
];

const RATE_WINDOW: RateWindowState = {
  updatedAt: '2026-07-31T09:45:00.000Z',
  cooldowns: [{ configId: 'cfg-cooldown', untilMs: Date.parse('2026-07-31T10:12:00.000Z') }],
  blocked: ['cfg-blocked'],
};

const RUNCONFIG = {
  configs: CONFIG_META.map((c) => ({
    ...c,
    label: `Harness × ${c.model}`,
    enabled: true,
  })),
};

/** The dashboard's clock, so relative statuses (cooldown) are deterministic. */
const NOW = Date.parse('2026-07-31T09:47:12.000Z');

async function makeRun(): Promise<Fixture> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nb-serve-'));
  const state = stateFile();
  await writeFile(path.join(dir, 'state.json'), JSON.stringify(state), 'utf8');
  await writeFile(
    path.join(dir, 'results.jsonl'),
    `${RECORDS.map((r) => JSON.stringify(r)).join('\n')}\n`,
    'utf8',
  );
  await writeFile(path.join(dir, 'rate-window.json'), JSON.stringify(RATE_WINDOW), 'utf8');
  await writeFile(path.join(dir, 'runconfig.json'), JSON.stringify(RUNCONFIG), 'utf8');
  return { dir, state };
}

let fx: Fixture;
let handle: ServeHandle | undefined;

beforeEach(async () => {
  fx = await makeRun();
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  await rm(fx.dir, { recursive: true, force: true });
});

async function start(): Promise<string> {
  handle = await serve({
    runDir: fx.dir,
    port: 0,
    host: '127.0.0.1',
    key: KEY,
    webRoot: WEB_ROOT,
    // Pin the clock: `cooldown` is "until > now", and the fixture's cooldown is
    // a fixed instant. Without this the test rots the moment that instant passes.
    now: () => NOW,
  });
  return `http://127.0.0.1:${handle.port}`;
}

function getStatus(base: string, key: string | null = KEY): Promise<Response> {
  return fetch(`${base}/api/status`, {
    headers: key === null ? {} : { Authorization: `Bearer ${key}` },
  });
}

// ---------------------------------------------------------------------------

describe('/api/status schema conformance', () => {
  it('serves the schemaVersion 1 contract the dashboard consumes', async () => {
    const base = await start();
    const res = await getStatus(base);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');

    const body = (await res.json()) as Record<string, any>;
    expect(body.schemaVersion).toBe(1);
    expect(body.run).toBe('20260731-060000');
    // The ETA needs the run start, and it is the one field the page adds beyond
    // the contract — a missing startedAt silently disables the live ETA.
    expect(body.startedAt).toBe('2026-07-31T06:00:00.000Z');
    expect(typeof body.generatedAt).toBe('string');
    expect(Date.parse(body.generatedAt)).not.toBeNaN();
    expect(body.mode).toBe('live'); // cells still open

    expect(body.totals).toEqual({ cells: 8, done: 3, failed: 1 });

    for (const c of body.configs) {
      expect(typeof c.id).toBe('string');
      expect(typeof c.label).toBe('string');
      expect(typeof c.harness).toBe('string');
      expect(typeof c.model).toBe('string');
      expect(['running', 'cooldown', 'blocked', 'done', 'pending']).toContain(c.status);
      expect(typeof c.progress.done).toBe('number');
      expect(typeof c.progress.total).toBe('number');
      expect(typeof c.tokens.input).toBe('number');
      expect(typeof c.tokens.output).toBe('number');
      expect(typeof c.apiEquivCostUsd).toBe('number');
    }
    for (const r of body.results) {
      expect(typeof r.taskId).toBe('string');
      expect(typeof r.family).toBe('string');
      expect(typeof r.stage).toBe('string');
      expect(typeof r.config).toBe('string');
      expect(Array.isArray(r.trials)).toBe(true);
      for (const t of r.trials) {
        expect(typeof t.trial).toBe('number');
        expect(typeof t.solved).toBe('boolean');
        expect(t.score).toBeGreaterThanOrEqual(0);
        expect(t.score).toBeLessThanOrEqual(1);
        expect(typeof t.wallTimeS).toBe('number');
        expect(typeof t.tokens.input).toBe('number');
        expect(typeof t.toolErrors).toBe('number');
      }
    }
    for (const f of body.failures) {
      expect(typeof f.at).toBe('string');
      expect(typeof f.taskId).toBe('string');
      expect(typeof f.config).toBe('string');
      expect(typeof f.trial).toBe('number');
      expect(typeof f.diagnostic).toBe('string');
      expect(f.diagnostic.length).toBeGreaterThan(0);
    }
  });

  it("survives the page's own adapter (web/js/schema.js) without falling back", async () => {
    const base = await start();
    const payload = await (await getStatus(base)).json();
    const adapted = loadPageSchema().adapt(payload) as Record<string, any>;

    expect(adapted.run).toBe('20260731-060000');
    expect(adapted.mode).toBe('live');
    expect(adapted.startedAt).toBe('2026-07-31T06:00:00.000Z');
    expect(adapted.configs).toHaveLength(5);
    // The adapter coerces an unrecognized status to "pending"; every status we
    // emit must survive the round trip unchanged.
    const statuses = Object.fromEntries(adapted.configs.map((c: any) => [c.id, c.status]));
    expect(statuses).toEqual({
      'cfg-running': 'running',
      'cfg-cooldown': 'cooldown',
      'cfg-blocked': 'blocked',
      'cfg-done': 'done',
      'cfg-pending': 'pending',
    });
    // …and it drops results whose family/stage it doesn't recognize into
    // cli/build, so assert ours came through as authored.
    const row = adapted.results.find((r: any) => r.taskId === 'build-nac-001');
    expect(row.family).toBe('nac');
    expect(row.stage).toBe('build');
    expect(adapted.failures.length).toBeGreaterThan(0);
  });

  it('maps checkpoint + rate-window state onto the five dashboard statuses', () => {
    const status = buildStatus(
      { state: stateFile(), records: RECORDS as any, rateWindow: RATE_WINDOW, roster: RUNCONFIG.configs as any },
      NOW,
    );
    const byId = new Map(status.configs.map((c) => [c.id, c]));

    const running = byId.get('cfg-running')!;
    expect(running.status).toBe('running');
    expect(running.currentTask).toBe('build-nac-001');
    expect(running.progress).toEqual({ done: 1, total: 2 });
    // Claude-style usage: cache tokens are NOT inside inputTokens, so they add.
    expect(running.tokens).toEqual({ input: 121_500, output: 8_000 });
    expect(running.apiEquivCostUsd).toBe(1.25);
    expect(running.window).toBeUndefined();

    const cooling = byId.get('cfg-cooldown')!;
    expect(cooling.status).toBe('cooldown');
    expect(cooling.cooldownUntil).toBe('2026-07-31T10:12:00.000Z');
    expect(cooling.model).toBe('gpt-5.6-sol (high)'); // effort is part of the model label
    // Codex-style usage: inputTokens already includes the cache reads.
    expect(cooling.tokens.input).toBe(90_000);

    // Blocked beats every other state — it is the one a human must act on.
    expect(byId.get('cfg-blocked')!.status).toBe('blocked');
    expect(byId.get('cfg-done')!.status).toBe('done');
    expect(byId.get('cfg-pending')!.status).toBe('pending');
  });

  it('folds the docs axis into unique trial numbers and reports failures newest-first', () => {
    const status = buildStatus(
      { state: stateFile(), records: RECORDS as any, rateWindow: RATE_WINDOW, roster: RUNCONFIG.configs as any },
      NOW,
    );
    const row = status.results.find((r) => r.taskId === 'build-cli-001' && r.config === 'cfg-running')!;
    // meta.trials === 3, so the `without` trial 1 lands at 4 rather than colliding.
    expect(row.trials.map((t) => t.trial)).toEqual([1, 4]);
    expect(row.trials[0]!.solved).toBe(true);
    expect(row.trials[1]!.solved).toBe(false);
    expect(row.trials[1]!.score).toBeCloseTo(0.6);

    const ats = status.failures.map((f) => f.at);
    expect([...ats].sort().reverse()).toEqual(ats);
    // scored-failed, unverified, and abandoned cells all reach the feed.
    const diagnostics = status.failures.map((f) => f.diagnostic).join('\n');
    expect(diagnostics).toContain('3 of 5 assertions failed');
    expect(diagnostics).toContain('unverified: verifier timed out after 600s');
    expect(diagnostics).toContain('runner: agent CLI exited 401');
    // A solved trial is never in the feed: cfg-running contributes exactly the
    // one scored-but-failed row, not its passing sibling.
    expect(status.failures.filter((f) => f.config === 'cfg-running')).toHaveLength(1);
  });

  it('reports mode "final" once nothing is pending or running', () => {
    const state = stateFile();
    for (const c of Object.values(state.cells)) c.status = 'done';
    const status = buildStatus(
      { state, records: RECORDS as any, rateWindow: { updatedAt: '', cooldowns: [], blocked: [] }, roster: [] },
      NOW,
    );
    expect(status.mode).toBe('final');
    // No runconfig roster: labels fall back to the config id, never undefined.
    expect(status.configs.every((c) => typeof c.label === 'string' && c.label.length > 0)).toBe(true);
  });
});

describe('auth', () => {
  it('401s without a bearer token', async () => {
    const base = await start();
    const res = await getStatus(base, null);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
    expect((await res.json()).error).toContain('unauthorized');
  });

  it('401s on a wrong token, and on a token of a different length', async () => {
    const base = await start();
    expect((await getStatus(base, 'nope')).status).toBe(401);
    expect((await getStatus(base, `${KEY}x`)).status).toBe(401);
    expect((await getStatus(base, KEY.toUpperCase())).status).toBe(401);
  });

  it('accepts the token case-insensitively on the scheme only', async () => {
    const base = await start();
    const res = await fetch(`${base}/api/status`, { headers: { Authorization: `bearer ${KEY}` } });
    expect(res.status).toBe(200);
  });

  it('does not gate the static dashboard (a browser cannot send a bearer on navigation)', async () => {
    const base = await start();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<script src="js/schema.js"></script>');
  });
});

describe('CORS', () => {
  it('answers preflight and allows any origin', async () => {
    const base = await start();
    const pre = await fetch(`${base}/api/status`, {
      method: 'OPTIONS',
      headers: { Origin: 'null', 'Access-Control-Request-Headers': 'authorization' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect(pre.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
    expect(pre.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('sets the CORS header on real responses too, including 401s', async () => {
    const base = await start();
    expect((await getStatus(base)).headers.get('access-control-allow-origin')).toBe('*');
    expect((await getStatus(base, null)).headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('mtime cache', () => {
  it('re-reads only when state.json or results.jsonl actually change', async () => {
    const source = new StatusSource({ runDir: fx.dir });
    const first = await source.status(NOW);
    expect(source.reads).toEqual({ state: 1, results: 1, roster: 1 });

    await source.status(NOW);
    await source.status(NOW);
    expect(source.reads).toEqual({ state: 1, results: 1, roster: 1 });
    expect(first.totals.done).toBe(3);

    // Advance the run: the in-flight cell finishes.
    const state = stateFile();
    const key = cellKey({ taskId: 'build-nac-001', configId: 'cfg-running', docsCondition: 'with', trial: 1 });
    state.cells[key]!.status = 'done';
    state.cells[key]!.finishedAt = '2026-07-31T09:50:00.000Z';
    state.updatedAt = '2026-07-31T09:50:00.000Z';
    const statePath = path.join(fx.dir, 'state.json');
    const before = await stat(statePath);
    await writeFile(statePath, JSON.stringify(state), 'utf8');
    const after = await stat(statePath);
    // Guard the guard: the fingerprint must actually differ, or the test proves nothing.
    expect(`${after.mtimeMs}:${after.size}`).not.toBe(`${before.mtimeMs}:${before.size}`);

    const next = await source.status(NOW);
    expect(source.reads.state).toBe(2);
    expect(source.reads.results).toBe(1); // untouched file, not re-parsed
    expect(next.totals.done).toBe(4);
    expect(next.configs.find((c) => c.id === 'cfg-running')!.currentTask).toBeUndefined();
  });

  it('picks up appended results.jsonl rows', async () => {
    const source = new StatusSource({ runDir: fx.dir });
    const before = await source.status(NOW);
    const rows = before.results.length;
    const { appendFile } = await import('node:fs/promises');
    await appendFile(
      path.join(fx.dir, 'results.jsonl'),
      `${JSON.stringify(record({ taskId: 'build-ops-001', family: 'ops', configId: 'cfg-done', trial: 2 }))}\n`,
      'utf8',
    );
    const after = await source.status(NOW);
    expect(source.reads.results).toBe(2);
    expect(after.results.length).toBe(rows + 1);
  });
});

describe('static dashboard + routing', () => {
  it('serves web/ assets with sane content types', async () => {
    const base = await start();
    const css = await fetch(`${base}/styles.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    const js = await fetch(`${base}/js/schema.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
  });

  it('refuses to escape the web root', async () => {
    const base = await start();
    const res = await fetch(`${base}/..%2f..%2fpackage.json`);
    expect([403, 404]).toContain(res.status);
    expect(await res.text()).not.toContain('"@notionbench/runner"');
  });

  it('404s unknown api routes as JSON', async () => {
    const base = await start();
    const res = await fetch(`${base}/api/nope`, { headers: { Authorization: `Bearer ${KEY}` } });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('no such endpoint');
  });

  it('503s with the reason when the directory is not a run', async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), 'nb-serve-empty-'));
    try {
      handle = await serve({ runDir: empty, port: 0, host: '127.0.0.1', key: KEY, webRoot: WEB_ROOT });
      const res = await getStatus(`http://127.0.0.1:${handle.port}`);
      expect(res.status).toBe(503);
      expect((await res.json()).error).toContain('no run state');
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('startup URL', () => {
  it('is a ready-to-open dashboard link carrying api + key in the hash', () => {
    expect(dashboardUrl('127.0.0.1', 8377, 'abc123')).toBe(
      'http://127.0.0.1:8377/#api=http://127.0.0.1:8377&key=abc123',
    );
  });

  it('generates a fresh token when none is pinned', async () => {
    handle = await serve({ runDir: fx.dir, port: 0, host: '127.0.0.1', webRoot: WEB_ROOT });
    expect(handle.key.length).toBeGreaterThanOrEqual(24);
    expect(handle.url).toContain(`key=${handle.key}`);
    expect((await getStatus(`http://127.0.0.1:${handle.port}`, handle.key)).status).toBe(200);
  });
});

describe('malformed requests', () => {
  it('does not 500 on a scheme-relative path or a bad %-escape', async () => {
    const base = await start();
    // `//` parses as scheme-relative to WHATWG URL; `%zz` throws in decodeURIComponent.
    expect((await fetch(`${base}//`)).status).toBe(200);
    expect((await fetch(`${base}/%zz`)).status).toBe(400);
  });
});
