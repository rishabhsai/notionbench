/**
 * `notionbench serve <runDir>` — the live dashboard endpoint.
 *
 * A full grid runs for days across subscription rate windows (docs/PLAN.md
 * "Pacing"), so the interesting question during a run is not "what did it score"
 * but "is it still moving, and what is stuck". This serves both halves of that:
 *
 *   GET /api/status   the JSON contract in web/js/schema.js, assembled live from
 *                     the run's state.json + results.jsonl (+ runconfig for labels)
 *   GET /             the static dashboard in web/, so one command gives a
 *                     working private monitor with nothing else installed
 *
 * Design constraints:
 *  - **Zero dependencies.** node:http only. The runner already spends its budget
 *    on subprocesses; a status page is not worth a dependency tree.
 *  - **The runner is the writer, this is a reader.** Nothing here mutates the run.
 *    Every request re-reads state.json/results.jsonl *only if their mtime+size
 *    changed*, so a 10s poll costs three stats and nothing else on a quiet run.
 *  - **The token is the gate, not the origin.** `Access-Control-Allow-Origin: *`
 *    so the dashboard can be opened from a file:// copy or another host; the
 *    bearer token is what actually protects the endpoint. The static assets are
 *    NOT behind the token — a browser cannot attach an Authorization header to a
 *    top-level navigation, and the assets carry no run data (all of it arrives
 *    through /api/status).
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dedupeByCell, readResults, type TrialRecord } from '@notionbench/scoring';
import { STATE_VERSION, type CellState, type RunStateFile } from './checkpoint.js';
import { V1_ROSTER, loadRunConfig, type AgentConfig } from './config.js';
import { readRateWindowState, type RateWindowState } from './queue.js';

/** Bumped only when the wire shape changes incompatibly; web/js/schema.js pins it. */
export const STATUS_SCHEMA_VERSION = 1;

/** Newest failures kept in the payload — the dashboard shows a feed, not an archive. */
const MAX_FAILURES = 50;

export const DEFAULT_PORT = 8377;
export const DEFAULT_HOST = '127.0.0.1';

// ---------------------------------------------------------------------------
// The wire contract (mirror of web/js/schema.js — change both or neither).
// ---------------------------------------------------------------------------

export type ConfigStatus = 'running' | 'cooldown' | 'blocked' | 'done' | 'pending';

export interface StatusConfig {
  id: string;
  label: string;
  harness: string;
  model: string;
  status: ConfigStatus;
  cooldownUntil?: string;
  progress: { done: number; total: number };
  currentTask?: string;
  tokens: { input: number; output: number };
  apiEquivCostUsd: number;
  window?: { used: number; limit: number; resetsAt: string };
}

export interface StatusTrial {
  trial: number;
  solved: boolean;
  /** [0,1]. */
  score: number;
  wallTimeS: number;
  tokens: { input: number; output: number };
  toolErrors: number;
}

export interface StatusResult {
  taskId: string;
  family: string;
  stage: string;
  config: string;
  trials: StatusTrial[];
}

export interface StatusFailure {
  at: string;
  taskId: string;
  config: string;
  trial: number;
  diagnostic: string;
}

export interface StatusPayload {
  schemaVersion: number;
  run: string;
  /** Run start — the dashboard's ETA is (elapsed / done) × remaining. */
  startedAt?: string;
  generatedAt: string;
  mode: 'live' | 'final';
  totals: { cells: number; done: number; failed: number };
  configs: StatusConfig[];
  results: StatusResult[];
  failures: StatusFailure[];
}

// ---------------------------------------------------------------------------
// state.json + results.jsonl -> StatusPayload
// ---------------------------------------------------------------------------

export interface StatusInput {
  state: RunStateFile;
  records: TrialRecord[];
  rateWindow: RateWindowState;
  /** The runconfig roster, purely for human labels. Missing ids fall back to the id. */
  roster: AgentConfig[];
}

/**
 * Pure assembly, so the contract is testable without a socket.
 *
 * The run's own `state.meta.configs` — not the roster — decides which configs
 * appear and in what order: the roster may have been edited since the run
 * started, and the dashboard assigns chart colors by declared order.
 */
export function buildStatus(input: StatusInput, now: number = Date.now()): StatusPayload {
  const { state, rateWindow } = input;
  const byId = new Map(input.roster.map((c) => [c.id, c]));
  const cellsByConfig = new Map<string, CellState[]>();
  for (const cell of Object.values(state.cells ?? {})) {
    let bucket = cellsByConfig.get(cell.configId);
    if (!bucket) cellsByConfig.set(cell.configId, (bucket = []));
    bucket.push(cell);
  }

  const cooldownUntil = new Map(rateWindow.cooldowns.map((c) => [c.configId, c.untilMs]));
  const blocked = new Set(rateWindow.blocked);

  const configs: StatusConfig[] = (state.meta?.configs ?? []).map((meta) => {
    const cells = cellsByConfig.get(meta.id) ?? [];
    const roster = byId.get(meta.id);
    const done = cells.filter((c) => c.status === 'done').length;
    const running = cells.find((c) => c.status === 'running');
    const until = cooldownUntil.get(meta.id);
    const isCooling = until !== undefined && until > now;

    let input = 0;
    let output = 0;
    let cost = 0;
    for (const cell of cells) {
      const t = tokensOf(cell.usage);
      input += t.input;
      output += t.output;
      cost += cell.apiEquivalentCostUsd ?? 0;
    }

    const out: StatusConfig = {
      id: meta.id,
      label: roster?.label ?? meta.id,
      harness: meta.harness,
      model: meta.reasoningEffort ? `${meta.model} (${meta.reasoningEffort})` : meta.model,
      status: configStatus({ cells, running: !!running, cooling: isCooling, blocked: blocked.has(meta.id) }),
      progress: { done, total: cells.length },
      tokens: { input, output },
      apiEquivCostUsd: round(cost, 2),
    };
    if (running) out.currentTask = running.taskId;
    if (isCooling) out.cooldownUntil = new Date(until).toISOString();
    // `window` (used/limit/resetsAt) is deliberately absent: subscription CLIs
    // do not report their remaining window, and the contract marks it optional.
    // Inventing a number here would put a fiction on the dashboard.
    return out;
  });

  const results = buildResults(input.records, state.meta?.trials ?? 0);
  const failures = buildFailures(input.records, Object.values(state.cells ?? {}));

  let cellCount = 0;
  let doneCount = 0;
  let failedCount = 0;
  let openCount = 0;
  for (const cell of Object.values(state.cells ?? {})) {
    cellCount++;
    if (cell.status === 'done') doneCount++;
    else if (cell.status === 'failed') failedCount++;
    else openCount++;
  }

  const startedAt = provenanceStartedAt(state) ?? state.createdAt;
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    run: state.runId,
    ...(startedAt ? { startedAt } : {}),
    generatedAt: new Date(now).toISOString(),
    mode: openCount > 0 ? 'live' : 'final',
    totals: { cells: cellCount, done: doneCount, failed: failedCount },
    configs,
    results,
    failures,
  };
}

/**
 * Status precedence: blocked beats cooldown beats running.
 *
 * `blocked` is the queue's permanently-blocked backstop (expired subscription,
 * revoked login) and is the one state a human has to act on, so it wins.
 */
function configStatus(args: {
  cells: CellState[];
  running: boolean;
  cooling: boolean;
  blocked: boolean;
}): ConfigStatus {
  if (args.blocked) return 'blocked';
  if (args.cooling) return 'cooldown';
  if (args.running) return 'running';
  if (args.cells.length === 0) return 'pending';
  const open = args.cells.some((c) => c.status === 'pending' || c.status === 'running');
  if (!open) return 'done';
  // Nothing in flight and nothing finished yet: not started.
  return args.cells.some((c) => c.status === 'done' || c.status === 'failed') ? 'running' : 'pending';
}

/**
 * results.jsonl -> the dashboard's per-(task, config) rows.
 *
 * CONTRACT GAP: the dashboard has no docs axis — its cell is (task, config) and
 * trials are identified by number alone. The grid's docs axis is folded in by
 * offsetting the `without` trials past the `with` ones (`trials` per condition
 * comes from run meta), which keeps trial numbers unique without dropping half
 * the run from the live view.
 */
function buildResults(records: readonly TrialRecord[], trialsPerCondition: number): StatusResult[] {
  const offset = Math.max(trialsPerCondition, 0);
  const rows = new Map<string, StatusResult>();
  for (const r of dedupeByCell(records)) {
    const key = `${r.taskId}::${r.configId}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        taskId: r.taskId,
        family: r.family ?? familyOf(r.taskId),
        stage: r.stage ?? stageOf(r.taskId),
        config: r.configId,
        trials: [],
      };
      rows.set(key, row);
    }
    const t = tokensOf(r.tokens);
    row.trials.push({
      trial: r.docsCondition === 'without' ? offset + r.trial : r.trial,
      solved: r.scored === true && r.score >= 1,
      score: r.scored === true ? clamp01(r.score) : 0,
      wallTimeS: round((r.wallTimeMs ?? 0) / 1000, 1),
      tokens: { input: t.input, output: t.output },
      toolErrors: r.toolErrors ?? 0,
    });
  }
  for (const row of rows.values()) row.trials.sort((a, b) => a.trial - b.trial);
  return [...rows.values()];
}

/**
 * The failures feed: scored-but-failed and unverified trials, newest first,
 * plus cells the runner gave up on entirely (those never reach results.jsonl
 * with a verdict, and they are exactly what an operator is watching for).
 */
function buildFailures(records: readonly TrialRecord[], cells: readonly CellState[]): StatusFailure[] {
  const out: StatusFailure[] = [];
  for (const r of dedupeByCell(records)) {
    if (r.scored === true && r.score >= 1) continue;
    const diagnostic = r.scored === false
      ? `unverified: ${r.scoreError ?? r.error ?? 'the verifier returned no verdict'}`
      : (r.diagnostics ?? []).join(' · ') || `${r.status}: scored ${r.score}${r.error ? ` — ${r.error}` : ''}`;
    out.push({
      at: r.finishedAt ?? r.startedAt ?? '',
      taskId: r.taskId,
      config: r.configId,
      trial: r.trial,
      diagnostic,
    });
  }
  for (const cell of cells) {
    if (cell.status !== 'failed') continue;
    out.push({
      at: cell.finishedAt ?? cell.startedAt ?? '',
      taskId: cell.taskId,
      config: cell.configId,
      trial: cell.trial,
      diagnostic: `runner: ${cell.lastError ?? `cell abandoned after ${cell.attempts} attempt(s)`}`,
    });
  }
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return out.slice(0, MAX_FAILURES);
}

/**
 * One comparable input number across harnesses.
 *
 * Claude Code reports `inputTokens` exclusive of cache reads/writes; Codex
 * reports it inclusive (see types.ts). Summing the raw field would quietly
 * under-count one of them on the same chart.
 */
function tokensOf(usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; inputTokensIncludeCached: boolean } | null | undefined): {
  input: number;
  output: number;
} {
  if (!usage) return { input: 0, output: 0 };
  const cached = (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
  return {
    input: (usage.inputTokens ?? 0) + (usage.inputTokensIncludeCached ? 0 : cached),
    output: usage.outputTokens ?? 0,
  };
}

/** Task ids are `<stage>-<family>-<nnn>-<slug>` (docs/COVERAGE.md). */
function stageOf(taskId: string): string {
  return taskId.split(/[-/]/)[0] ?? 'build';
}

function familyOf(taskId: string): string {
  return taskId.split(/[-/]/)[1] ?? 'cli';
}

function provenanceStartedAt(state: RunStateFile): string | undefined {
  const v = state.meta?.provenance?.startedAt;
  return typeof v === 'string' ? v : undefined;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------
// Cheap re-reads
// ---------------------------------------------------------------------------

/**
 * Re-read a file only when it changed.
 *
 * mtime *and* size: mtime alone has coarse granularity on some filesystems, and
 * the runner rewrites state.json every few seconds during a busy run.
 */
class MtimeCache<T> {
  /** Number of times the underlying file was actually parsed. Tests assert on this. */
  reads = 0;
  private fingerprint?: string;
  private value?: T;

  constructor(
    private readonly filePath: string,
    private readonly load: () => Promise<T>,
    private readonly whenMissing: () => T,
  ) {}

  async get(): Promise<T> {
    let fingerprint: string;
    try {
      const st = await stat(this.filePath);
      fingerprint = `${st.mtimeMs}:${st.size}`;
    } catch {
      this.fingerprint = undefined;
      this.value = undefined;
      return this.whenMissing();
    }
    if (this.fingerprint === fingerprint && this.value !== undefined) return this.value;
    const value = await this.load();
    this.reads++;
    this.fingerprint = fingerprint;
    this.value = value;
    return value;
  }
}

export class StatusSource {
  readonly runDir: string;
  private readonly state: MtimeCache<RunStateFile>;
  private readonly results: MtimeCache<TrialRecord[]>;
  private readonly roster: MtimeCache<AgentConfig[]>;

  constructor(opts: { runDir: string; runconfigPath?: string }) {
    this.runDir = path.resolve(opts.runDir);
    const statePath = path.join(this.runDir, 'state.json');
    this.state = new MtimeCache(
      statePath,
      async () => parseState(await readFile(statePath, 'utf8'), statePath),
      () => {
        throw new Error(`no run state at ${statePath} (is ${this.runDir} a run directory?)`);
      },
    );
    this.results = new MtimeCache(
      path.join(this.runDir, 'results.jsonl'),
      async () => (await readResults(this.runDir)).records,
      () => [],
    );
    // Labels/pricing live in runconfig.json, not in the run state. A run whose
    // runconfig has since moved still renders — it just falls back to the
    // built-in roster, and then to the config id.
    const runconfigPath = path.resolve(opts.runconfigPath ?? path.join(this.runDir, 'runconfig.json'));
    this.roster = new MtimeCache(
      runconfigPath,
      async () => (await loadRunConfig(runconfigPath)).configs,
      () => V1_ROSTER,
    );
  }

  /** Files actually parsed since startup, per source. */
  get reads(): { state: number; results: number; roster: number } {
    return { state: this.state.reads, results: this.results.reads, roster: this.roster.reads };
  }

  async status(now: number = Date.now()): Promise<StatusPayload> {
    const [state, records, roster, rateWindow] = await Promise.all([
      this.state.get(),
      this.results.get(),
      this.roster.get(),
      // Small, rewritten only on a rate-window transition: read every time.
      readRateWindowState(this.runDir),
    ]);
    return buildStatus({ state, records, roster, rateWindow }, now);
  }
}

function parseState(raw: string, statePath: string): RunStateFile {
  const parsed = JSON.parse(raw) as RunStateFile;
  if (parsed.version !== STATE_VERSION) {
    throw new Error(`run state version ${parsed.version} at ${statePath} is not supported (expected ${STATE_VERSION})`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface ServeOptions {
  runDir: string;
  /** Bearer token required on /api/*. Generated when omitted. */
  key?: string;
  port?: number;
  host?: string;
  runconfigPath?: string;
  /** The static dashboard directory. Defaults to the repo's web/. */
  webRoot?: string;
  now?: () => number;
}

export interface ServeHandle {
  server: Server;
  port: number;
  host: string;
  key: string;
  source: StatusSource;
  /** The exact URL to open — dashboard + api + token, ready to paste. */
  url: string;
  close(): Promise<void>;
}

export function generateKey(): string {
  return randomBytes(24).toString('base64url');
}

/** `web/` as shipped in the repo, resolved the same way from src/ and dist/. */
export function defaultWebRoot(): string {
  return (
    process.env.NOTIONBENCH_WEB_ROOT ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web')
  );
}

/** `http://host:port/#api=http://host:port&key=…` — what `serve` prints. */
export function dashboardUrl(host: string, port: number, key: string): string {
  const origin = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  return `${origin}/#api=${origin}&key=${encodeURIComponent(key)}`;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

export function createStatusServer(opts: ServeOptions & { key: string }): { server: Server; source: StatusSource } {
  const source = new StatusSource({ runDir: opts.runDir, runconfigPath: opts.runconfigPath });
  const webRoot = path.resolve(opts.webRoot ?? defaultWebRoot());
  const now = opts.now ?? (() => Date.now());

  const server = createHttpServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      send(res, 500, { error: (err as Error).message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    cors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    let pathname: string;
    try {
      // `//foo` is scheme-relative to `new URL`, and a bad %-escape throws:
      // neither is worth a 500. Collapse the leading slashes, reject the rest.
      const target = (req.url ?? '/').replace(/^\/{2,}/, '/');
      pathname = decodeURIComponent(new URL(target, 'http://localhost').pathname);
    } catch {
      send(res, 400, { error: 'malformed request URL' });
      return;
    }

    if (pathname === '/api/status') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, { error: 'method not allowed' });
        return;
      }
      if (!authorized(req, opts.key)) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="notionbench"');
        send(res, 401, { error: 'unauthorized — pass Authorization: Bearer <key>' });
        return;
      }
      try {
        send(res, 200, await source.status(now()));
      } catch (err) {
        // A run directory that isn't one, or a torn state.json, is an operator
        // problem: say so instead of serving an empty-but-valid dashboard.
        send(res, 503, { error: (err as Error).message });
      }
      return;
    }

    if (pathname.startsWith('/api/')) {
      send(res, 404, { error: `no such endpoint: ${pathname}` });
      return;
    }
    await serveStatic(pathname, webRoot, res);
  }

  return { server, source };
}

/** Start the server and resolve once it is accepting connections. */
export async function serve(opts: ServeOptions): Promise<ServeHandle> {
  const key = opts.key ?? generateKey();
  const host = opts.host ?? DEFAULT_HOST;
  const { server, source } = createStatusServer({ ...opts, key });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? DEFAULT_PORT, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (opts.port ?? DEFAULT_PORT);
  return {
    server,
    source,
    host,
    port,
    key,
    url: dashboardUrl(host, port, key),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/** Constant-time bearer comparison — the token is the only thing guarding the run. */
function authorized(req: IncomingMessage, key: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const given = Buffer.from(match[1]!);
  const expected = Buffer.from(key);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function serveStatic(pathname: string, webRoot: string, res: ServerResponse): Promise<void> {
  const rel = pathname === '/' || pathname.endsWith('/') ? `${pathname}index.html` : pathname;
  const target = path.resolve(webRoot, `.${path.posix.normalize(rel)}`);
  // Traversal guard: a `..` that escapes the web root is never served.
  if (target !== webRoot && !target.startsWith(webRoot + path.sep)) {
    send(res, 403, { error: 'forbidden' });
    return;
  }
  let body: Buffer;
  try {
    body = await readFile(target);
  } catch {
    send(res, 404, {
      error: `not found: ${pathname}`,
      hint: `static dashboard root is ${webRoot} — pass --web <dir> if that is wrong`,
    });
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'Content-Length': body.byteLength,
  });
  res.end(body);
}
