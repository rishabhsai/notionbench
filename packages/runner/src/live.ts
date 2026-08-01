/**
 * The runner's half of the `runtime: live` contract.
 *
 * An offline task's starting state is a directory. A live task's starting state
 * is a *Notion workspace*, so the trial lifecycle grows two steps that offline
 * tasks never see:
 *
 *   before spawn   provision `fixture/spec.json` into a real workspace, under a
 *                  per-trial root page, and drop `notionbench.json` into the
 *                  trial workspace so the agent can find its sandbox;
 *   after scoring  archive that root, which takes its whole subtree with it.
 *
 * Everything that actually talks to Notion lives in `evals/_lib/live/` — the
 * dependency-free client, the spec loader, the provisioner. This module is only
 * the seam: it locates that library, resolves the operator's workspace settings
 * (token / parent page / API base), and turns a failed teardown into a logged
 * orphan rather than a dead run.
 *
 * Three deliberate choices:
 *
 *  - **The live library is loaded dynamically, by path.** `@notionbench/runner`
 *    is a compiled package and `evals/` is task content; a static import would
 *    make the runner unbuildable without the task suite and would drag the
 *    evals tree into `tsc`'s program. A dynamic import also gives tests a seam
 *    (`NOTIONBENCH_LIVE_LIB`) that needs no mocking framework.
 *  - **Teardown failures are never fatal.** A run is hours to days of paid
 *    subscription time; losing it because a cleanup call 500'd would be absurd.
 *    A failed (or deliberately skipped) teardown is written to the run log as an
 *    ORPHAN line naming the page id, which is what an orphan reaper needs.
 *  - **Missing credentials fail at *plan* time, not at cell 300.** Provisioning
 *    without `NOTION_PARENT_PAGE_ID` would either create pages at the workspace
 *    level (un-archivable via the API — a permanent leak per trial) or fail every
 *    single cell after the grid is already running.
 */

import { appendFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TaskSpec } from './types.js';

/** Notion's public API root — what an unconfigured live run talks to. */
export const DEFAULT_NOTION_API_BASE = 'https://api.notion.com';

/** Point this at a directory exporting the live lib's surface (tests, forks). */
export const LIVE_LIB_ENV = 'NOTIONBENCH_LIVE_LIB';

/** Appended to, never rewritten: the run's operational narrative. */
export const RUN_LOG_FILENAME = 'run.log';

/** Dropped into the trial workspace by `writeWorkspacePointer`. */
export const POINTER_FILENAME = 'notionbench.json';

// ---------------------------------------------------------------------------
// The slice of `evals/_lib/live/` this module uses.
//
// Structural types only: the runner must not depend on the evals tree at build
// time, so these mirror the exported contracts rather than importing them.
// ---------------------------------------------------------------------------

export interface LiveNotionClient {
  archivePage(pageId: string): Promise<unknown>;
}

/** What `provisionFixture` returns (`evals/_lib/live/provision.ts`). */
export interface LiveFixture {
  rootId: string;
  idMap: Record<string, string>;
  dataSourceIds: Record<string, string>;
  created: { pages: number; databases: number; rows: number; blocks: number };
  specId: string;
}

export interface LiveLib {
  provisionTaskFixture(
    taskDir: string,
    opts: {
      client?: LiveNotionClient;
      clientOptions?: { auth?: string; baseUrl?: string };
      parentPageId?: string;
      label?: string;
      concurrency?: number;
    },
  ): Promise<LiveFixture>;
  teardownFixture(
    client: LiveNotionClient,
    rootId: string,
  ): Promise<{ ok: boolean; error?: string }>;
  writeWorkspacePointer(
    workspaceDir: string,
    fixture: { rootId: string },
  ): Promise<string>;
  NotionClient: new (opts?: { auth?: string; baseUrl?: string }) => LiveNotionClient;
}

// ---------------------------------------------------------------------------
// Task classification
// ---------------------------------------------------------------------------

/** `<taskDir>/fixture/spec.json` — mirrors `specPathFor` in the live lib. */
export function specPathFor(taskDir: string): string {
  return path.join(taskDir, 'fixture', 'spec.json');
}

/** A task that needs a Notion workspace at all. */
export function isLiveTask(task: TaskSpec): boolean {
  return task.runtime === 'live';
}

export interface LiveTaskInfo {
  /** Tasks that need a Notion integration token (`runtime: live`). */
  live: TaskSpec[];
  /** Subset with a `fixture/spec.json` — these get a provisioned fixture. */
  provisioned: TaskSpec[];
  /** Task ids in `provisioned`, for O(1) lookup on the hot path. */
  provisionedIds: Set<string>;
}

/**
 * Split the grid into "needs a workspace" and "needs a provisioned fixture".
 *
 * The two are not the same: a `runtime: live` task may drive an already-shared
 * workspace with no fixture of its own, and (defensively) a task may ship a
 * spec without having declared `runtime: live` yet. Both get handled.
 */
export async function inspectLiveTasks(tasks: TaskSpec[]): Promise<LiveTaskInfo> {
  const live: TaskSpec[] = [];
  const provisioned: TaskSpec[] = [];
  for (const task of tasks) {
    const hasSpec = await isFile(specPathFor(task.dir));
    if (hasSpec) provisioned.push(task);
    if (isLiveTask(task) || hasSpec) live.push(task);
  }
  return { live, provisioned, provisionedIds: new Set(provisioned.map((t) => t.id)) };
}

// ---------------------------------------------------------------------------
// Operator settings
// ---------------------------------------------------------------------------

/** The optional `notion` block of runconfig.json. */
export interface NotionSettings {
  parentPageId?: string;
  apiBase?: string;
}

export interface LiveSettings {
  /** Integration token. Env only — a token never belongs in a checked-in config. */
  token?: string;
  tokenSource?: string;
  /** Page every per-trial fixture root is created under. */
  parentPageId?: string;
  parentPageIdSource?: string;
  apiBase: string;
  apiBaseSource: string;
  /** True when the operator named an API base (so children should see it too). */
  apiBaseExplicit: boolean;
}

/**
 * Resolve where live fixtures go. Environment wins over runconfig.json: the file
 * is checked in and shared, the environment is this operator, this invocation.
 */
export function resolveLiveSettings(opts: {
  notion?: NotionSettings;
  env?: NodeJS.ProcessEnv;
} = {}): LiveSettings {
  const env = opts.env ?? process.env;
  const notion = opts.notion ?? {};

  const poolToken = (env.NOTIONBENCH_NOTION_TOKENS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)[0];
  const envToken = env.NOTION_API_TOKEN?.trim();
  const token = envToken || poolToken;
  const tokenSource = envToken
    ? 'env.NOTION_API_TOKEN'
    : poolToken
      ? 'env.NOTIONBENCH_NOTION_TOKENS'
      : undefined;

  const envParent = env.NOTION_PARENT_PAGE_ID?.trim();
  const parentPageId = envParent || notion.parentPageId?.trim();
  const parentPageIdSource = envParent
    ? 'env.NOTION_PARENT_PAGE_ID'
    : notion.parentPageId
      ? 'runconfig.notion.parentPageId'
      : undefined;

  const envBase = env.NOTION_API_BASE?.trim();
  const configBase = notion.apiBase?.trim();
  const apiBase = (envBase || configBase || DEFAULT_NOTION_API_BASE).replace(/\/+$/, '');
  const apiBaseSource = envBase
    ? 'env.NOTION_API_BASE'
    : configBase
      ? 'runconfig.notion.apiBase'
      : 'default';

  return {
    token: token || undefined,
    tokenSource,
    parentPageId: parentPageId || undefined,
    parentPageIdSource,
    apiBase,
    apiBaseSource,
    apiBaseExplicit: Boolean(envBase || configBase),
  };
}

/**
 * What is missing before this grid can run. Empty means "go".
 *
 * Returned as a list rather than thrown so `--dry-run` can print the same
 * findings without failing, which is the whole point of a dry run.
 */
export function liveRequirementProblems(info: LiveTaskInfo, settings: LiveSettings): string[] {
  const problems: string[] = [];
  if (info.live.length > 0 && !settings.token) {
    problems.push(
      `no Notion integration token, but ${info.live.length} live task(s) are in the grid ` +
        `(${sample(info.live.map((t) => t.id))}). ` +
        'Set NOTION_API_TOKEN=ntn_… , or NOTIONBENCH_NOTION_TOKENS=tok1,tok2 for a pool ' +
        'sized to --concurrency.',
    );
  }
  if (info.provisioned.length > 0 && !settings.parentPageId) {
    problems.push(
      `no parent page, but ${info.provisioned.length} task(s) provision a fixture into a real ` +
        `workspace (${sample(info.provisioned.map((t) => t.id))}). ` +
        'Set NOTION_PARENT_PAGE_ID=<page id> — a page shared with the integration — or add ' +
        '"notion": { "parentPageId": "…" } to runconfig.json. Fixture roots are created under ' +
        'that page and never at the workspace level, because a workspace-level page cannot be ' +
        'archived through the API and would leak one un-deletable page per trial.',
    );
  }
  return problems;
}

/** The failfast message printed instead of starting a run. */
export function renderLiveProblems(problems: string[]): string {
  return (
    'live tasks are selected but the Notion workspace is not configured:\n' +
    problems.map((p) => `  - ${p}`).join('\n') +
    '\n\nInspect the plan without spending anything: notionbench run --dry-run\n' +
    'Or restrict the grid to offline tasks with --tasks.\n'
  );
}

// ---------------------------------------------------------------------------
// Loading `evals/_lib/live/`
// ---------------------------------------------------------------------------

const MODULE_EXTENSIONS = ['.ts', '.mjs', '.js'];

/**
 * Where the live library lives, first hit wins:
 *
 *   1. `NOTIONBENCH_LIVE_LIB` — a directory (tests, forks with a relocated suite);
 *   2. `<evalsRoot>/_lib/live` — the normal case, following the run's own --evals;
 *   3. the repo checkout this runner was built from.
 */
export async function resolveLiveLibDir(
  evalsRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const candidates = [
    env[LIVE_LIB_ENV],
    path.join(path.resolve(evalsRoot), '_lib', 'live'),
    fileURLToPath(new URL('../../../evals/_lib/live/', import.meta.url)),
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);
  for (const dir of candidates) {
    if (await moduleIn(dir, 'provision')) return dir;
  }
  return undefined;
}

async function moduleIn(dir: string, basename: string): Promise<string | undefined> {
  for (const ext of MODULE_EXTENSIONS) {
    const candidate = path.join(dir, `${basename}${ext}`);
    if (await isFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Import the live library from `dir`.
 *
 * The real modules are TypeScript; Node strips types natively from 22.18, the
 * same mechanism `evals/_lib/qc.ts` and the scoring harness already rely on. A
 * Node too old to do that fails here with an explanation rather than an
 * `ERR_UNKNOWN_FILE_EXTENSION` a hundred lines away.
 */
export async function loadLiveLib(dir: string): Promise<LiveLib> {
  const provisionPath = await moduleIn(dir, 'provision');
  const notionPath = await moduleIn(dir, 'notion');
  if (!provisionPath || !notionPath) {
    throw new Error(
      `live library at ${dir} is incomplete: expected provision.* and notion.* ` +
        `(looked for ${MODULE_EXTENSIONS.join(', ')})`,
    );
  }
  let provision: Record<string, unknown>;
  let notion: Record<string, unknown>;
  try {
    provision = (await import(/* @vite-ignore */ pathToFileURL(provisionPath).href)) as Record<
      string,
      unknown
    >;
    notion = (await import(/* @vite-ignore */ pathToFileURL(notionPath).href)) as Record<
      string,
      unknown
    >;
  } catch (err) {
    throw new Error(
      `could not load the live fixture library from ${dir}: ${(err as Error).message}\n` +
        'These modules are TypeScript and are loaded by Node\'s built-in type stripping, ' +
        `which needs Node >= 22.18 (this process is ${process.version}).`,
    );
  }
  for (const name of ['provisionTaskFixture', 'teardownFixture', 'writeWorkspacePointer']) {
    if (typeof provision[name] !== 'function') {
      throw new Error(`live library at ${provisionPath} does not export ${name}()`);
    }
  }
  if (typeof notion.NotionClient !== 'function') {
    throw new Error(`live library at ${notionPath} does not export NotionClient`);
  }
  return {
    provisionTaskFixture: provision.provisionTaskFixture as LiveLib['provisionTaskFixture'],
    teardownFixture: provision.teardownFixture as LiveLib['teardownFixture'],
    writeWorkspacePointer: provision.writeWorkspacePointer as LiveLib['writeWorkspacePointer'],
    NotionClient: notion.NotionClient as LiveLib['NotionClient'],
  };
}

// ---------------------------------------------------------------------------
// The run log
// ---------------------------------------------------------------------------

/**
 * Append one timestamped line to `results/<runId>/run.log`.
 *
 * Best effort by construction: this file exists so a human (or a reaper script)
 * can find leaked fixtures after the fact, and a full disk must not be able to
 * take down a multi-day grid on the way to telling them so.
 */
export async function appendRunLog(runDir: string, line: string): Promise<void> {
  try {
    await mkdir(runDir, { recursive: true });
    await appendFile(
      path.join(runDir, RUN_LOG_FILENAME),
      `${new Date().toISOString()}  ${line}\n`,
      'utf8',
    );
  } catch {
    /* the log is a courtesy, never a dependency */
  }
}

// ---------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------

export interface ProvisionedFixture extends LiveFixture {
  /** The cell this fixture belongs to, for log lines. */
  label: string;
  /** The token the fixture was created with — teardown must reuse it. */
  token?: string;
  /** `{apiBase, rootId, idMap, token}` — exactly what a live EVAL.ts resolves. */
  ctx: { apiBase: string; rootId: string; idMap: Record<string, string>; token?: string };
}

export interface LiveFixturesOptions {
  settings: LiveSettings;
  /** Task ids that have a `fixture/spec.json`. */
  provisionedIds: Set<string>;
  /** `results/<runId>` — where run.log is appended. */
  runDir: string;
  /** Directory holding the live library. Resolved lazily when first needed. */
  libDir?: string;
  evalsRoot?: string;
  /** `--no-teardown`: keep fixtures for debugging; every one is logged as an orphan. */
  noTeardown?: boolean;
  /** Console echo for operator-visible events (orphans). */
  onNotice?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

/**
 * Per-run fixture lifecycle. One instance for the whole grid; every method is
 * safe to call for offline tasks (they no-op).
 */
export class LiveFixtures {
  readonly settings: LiveSettings;
  private readonly provisionedIds: Set<string>;
  private readonly runDir: string;
  private readonly opts: LiveFixturesOptions;
  private lib?: Promise<LiveLib>;
  /** Root ids that outlived the run: failed teardown, or --no-teardown. */
  readonly orphans: Array<{ rootId: string; label: string; reason: string }> = [];

  constructor(opts: LiveFixturesOptions) {
    this.opts = opts;
    this.settings = opts.settings;
    this.provisionedIds = opts.provisionedIds;
    this.runDir = opts.runDir;
  }

  /** True when this task's trials need a provisioned Notion fixture. */
  wants(task: TaskSpec): boolean {
    return this.provisionedIds.has(task.id);
  }

  get noTeardown(): boolean {
    return this.opts.noTeardown === true;
  }

  /**
   * Extra env for a live trial's child process.
   *
   * Only set when the operator named a non-default API base: children inherit
   * the parent's environment, so an operator-set `NOTION_API_BASE` already
   * arrives; one that came from runconfig.json otherwise would not, and the
   * agent would talk to a different Notion than its fixture lives in.
   */
  childEnv(): Record<string, string> | undefined {
    if (!this.settings.apiBaseExplicit) return undefined;
    return { NOTION_API_BASE: this.settings.apiBase };
  }

  /**
   * Load once, but never cache a *failure*.
   *
   * A rejected promise left in `this.lib` would be handed to every subsequent
   * cell, so one transient hiccup during the first import would turn the
   * scheduler's retry budget into three copies of the same stale error and take
   * the whole live half of the grid with it.
   */
  private async load(): Promise<LiveLib> {
    if (!this.lib) {
      const pending = (async () => {
        const dir =
          this.opts.libDir ??
          (await resolveLiveLibDir(this.opts.evalsRoot ?? 'evals', this.opts.env ?? process.env));
        if (!dir) {
          throw new Error(
            'no live fixture library found — expected <evalsRoot>/_lib/live/provision.ts ' +
              `(or ${LIVE_LIB_ENV} pointing at one)`,
          );
        }
        return loadLiveLib(dir);
      })();
      this.lib = pending;
      pending.catch(() => {
        if (this.lib === pending) this.lib = undefined;
      });
    }
    return this.lib;
  }

  /**
   * Create this trial's fixture and point the workspace at it.
   *
   * Throws on failure: a live trial without its fixture would grade the agent on
   * a workspace that was never set up, so the cell must fail (and be retried)
   * rather than silently score 0.
   */
  async provision(args: {
    task: TaskSpec;
    workspaceDir: string;
    /** The leased token for this trial; falls back to the run-level one. */
    token?: string;
    label: string;
  }): Promise<ProvisionedFixture> {
    const lib = await this.load();
    const token = args.token ?? this.settings.token;
    const fixture = await lib.provisionTaskFixture(args.task.dir, {
      client: new lib.NotionClient({ auth: token, baseUrl: this.settings.apiBase }),
      parentPageId: this.settings.parentPageId,
      label: args.label,
    });
    await lib.writeWorkspacePointer(args.workspaceDir, fixture);

    const created = fixture.created ?? { pages: 0, databases: 0, rows: 0, blocks: 0 };
    await appendRunLog(
      this.runDir,
      `live provision  ${args.label}  spec=${fixture.specId} root=${fixture.rootId} ` +
        `pages=${created.pages} databases=${created.databases} rows=${created.rows} blocks=${created.blocks}`,
    );

    return {
      ...fixture,
      label: args.label,
      token,
      ctx: {
        apiBase: this.settings.apiBase,
        rootId: fixture.rootId,
        idMap: fixture.idMap ?? {},
        token,
      },
    };
  }

  /**
   * Archive the fixture root, taking its subtree with it.
   *
   * Never throws and never rejects: this runs after the verdict is already
   * durable, so the worst a cleanup problem may cost is a line in the run log.
   */
  async teardown(fixture: ProvisionedFixture): Promise<{ ok: boolean; error?: string }> {
    if (this.noTeardown) {
      await this.recordOrphan(fixture, '--no-teardown');
      return { ok: false, error: 'teardown skipped (--no-teardown)' };
    }
    try {
      const lib = await this.load();
      const client = new lib.NotionClient({
        auth: fixture.token ?? this.settings.token,
        baseUrl: this.settings.apiBase,
      });
      const result = await lib.teardownFixture(client, fixture.rootId);
      if (result.ok) {
        await appendRunLog(this.runDir, `live teardown   ${fixture.label}  root=${fixture.rootId} ok`);
        return result;
      }
      await this.recordOrphan(fixture, result.error ?? 'archive returned not-ok');
      return result;
    } catch (err) {
      const error = (err as Error).message;
      await this.recordOrphan(fixture, error);
      return { ok: false, error };
    }
  }

  /**
   * The orphan-reaper note: everything needed to delete the page by hand, or to
   * feed a reaper, without re-reading the results tree.
   */
  private async recordOrphan(fixture: ProvisionedFixture, reason: string): Promise<void> {
    this.orphans.push({ rootId: fixture.rootId, label: fixture.label, reason });
    const line =
      `ORPHAN live fixture retained  ${fixture.label}  root=${fixture.rootId}  reason=${reason}  ` +
      `reap: PATCH ${this.settings.apiBase}/v1/pages/${fixture.rootId} {"in_trash":true} ` +
      `(or open https://www.notion.so/${fixture.rootId.replace(/-/g, '')} and delete it)`;
    await appendRunLog(this.runDir, line);
    this.opts.onNotice?.(line);
  }

  /** End-of-run summary line, or undefined when nothing leaked. */
  orphanSummary(): string | undefined {
    if (this.orphans.length === 0) return undefined;
    return (
      `${this.orphans.length} live fixture root(s) were not archived — see ` +
      `${path.join(this.runDir, RUN_LOG_FILENAME)} (grep ORPHAN)`
    );
  }
}

// ---------------------------------------------------------------------------

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

function sample(ids: string[], max = 3): string {
  return ids.length <= max ? ids.join(', ') : `${ids.slice(0, max).join(', ')}, +${ids.length - max} more`;
}
