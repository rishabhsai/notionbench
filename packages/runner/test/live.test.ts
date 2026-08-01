/**
 * The live half of the trial lifecycle: **provision → spawn → score → teardown**.
 *
 * Three layers, cheapest first:
 *
 *  1. pure resolution — settings precedence and the plan-time requirement check;
 *  2. a **stub live library** (`NOTIONBENCH_LIVE_LIB` → a directory of two tiny
 *     modules) that records every call, so "was provisioning invoked with the
 *     right token, parent page and API base?" is a file-read rather than a mock
 *     framework;
 *  3. the **real** `evals/_lib/live/` provisioning code against
 *     `fake-notion.ts` — an in-process Notion on port 0 — so the wiring is
 *     proven end to end: a real spec is materialized, a real agent process
 *     mutates it through the pointer file, the verifier grades it from the ctx
 *     the runner passed, and teardown really trashes the root.
 *
 * No network, no token, no subscription.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readResults } from '@notionbench/scoring';
import { main } from '../src/cli.js';
import {
  inspectLiveTasks,
  liveRequirementProblems,
  loadLiveLib,
  resolveLiveLibDir,
  resolveLiveSettings,
} from '../src/live.js';
import type { TaskSpec } from '../src/types.js';

const LIVE_LIB = fileURLToPath(new URL('../../../evals/_lib/live/', import.meta.url));

let scratch: string;
let evalsRoot: string;
let resultsRoot: string;
let runconfigPath: string;
let stubLog: string;
let out: string[];
let errs: string[];
let restore: (() => void) | undefined;

/** Env keys these tests own; every one is restored after each case. */
const OWNED_ENV = [
  'NOTION_API_TOKEN',
  'NOTION_PARENT_PAGE_ID',
  'NOTION_API_BASE',
  'NOTIONBENCH_NOTION_TOKENS',
  'NOTIONBENCH_LIVE_LIB',
  'NB_STUB_LOG',
  'NB_STUB_PROVISION_FAIL',
  'NB_STUB_TEARDOWN_FAIL',
  'NB_AGENT_ENV_OUT',
];
let savedEnv: Record<string, string | undefined> = {};

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const MINIMAL_SPEC = {
  version: 1,
  id: 'build-live-001-fixture',
  root: { title: 'NotionBench · live test', icon: '🧪' },
  pages: [
    {
      key: 'handbook',
      title: 'Team Handbook',
      blocks: [{ type: 'paragraph', text: 'Everything a new teammate needs.' }],
    },
  ],
};

/**
 * A live task. `evalBody` is the verifier's function body; it receives
 * `{ workspaceDir, ctx }` exactly as the scoring harness delivers it.
 */
async function writeLiveTask(
  id: string,
  opts: { evalBody: string; spec?: unknown; runtime?: string } = { evalBody: 'return { score: 1 }' },
): Promise<void> {
  const dir = path.join(evalsRoot, id);
  await mkdir(path.join(dir, 'fixture', 'workspace'), { recursive: true });
  await writeFile(
    path.join(dir, 'PROMPT.md'),
    `---\nid: ${id}\nsuite: benchmark\nfamily: cli\nstage: build\nruntime: ${opts.runtime ?? 'live'}\n` +
      `fixture: rest\nlimits: { time: 60 }\n---\n\nDo the live thing.\n`,
    'utf8',
  );
  await writeFile(path.join(dir, 'fixture', 'workspace', 'README.md'), '# fixture\n', 'utf8');
  if (opts.spec !== null) {
    await writeFile(
      path.join(dir, 'fixture', 'spec.json'),
      `${JSON.stringify(opts.spec ?? { ...MINIMAL_SPEC, id }, null, 2)}\n`,
      'utf8',
    );
  }
  await writeFile(
    path.join(dir, 'EVAL.ts'),
    `export default async ({ workspaceDir, ctx }) => {\n${opts.evalBody}\n}\n`,
    'utf8',
  );
}

/** An ordinary offline task, to prove live wiring changes nothing for it. */
async function writeOfflineTask(id: string): Promise<void> {
  const dir = path.join(evalsRoot, id);
  await mkdir(path.join(dir, 'fixture', 'workspace'), { recursive: true });
  await writeFile(
    path.join(dir, 'PROMPT.md'),
    `---\nid: ${id}\nsuite: benchmark\nfamily: cli\nstage: build\nruntime: offline\nlimits: { time: 30 }\n---\n\nOffline.\n`,
    'utf8',
  );
  await writeFile(
    path.join(dir, 'EVAL.ts'),
    'export default async () => ({ score: 1, subscores: {}, diagnostics: ["offline"] })\n',
    'utf8',
  );
}

/**
 * A live library that records instead of calling Notion.
 *
 * Two modules, matching the real layout (`provision.*` + `notion.*`), loaded by
 * the same code path the real one is. Calls are appended as JSON lines to
 * `NB_STUB_LOG` so assertions read a file rather than reaching into module state.
 */
async function writeStubLib(): Promise<string> {
  const dir = path.join(scratch, 'stub-live');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'provision.mjs'),
    `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const log = (entry) =>
  appendFileSync(process.env.NB_STUB_LOG, JSON.stringify(entry) + '\\n', 'utf8')

let n = 0

export async function provisionTaskFixture(taskDir, opts) {
  n++
  const rootId = '00000000-0000-4000-8000-00000000000' + n
  log({
    call: 'provision',
    taskDir,
    rootId,
    parentPageId: opts.parentPageId,
    label: opts.label,
    client: opts.client?.describe?.(),
  })
  const fail = process.env.NB_STUB_PROVISION_FAIL
  if (fail === '1' || (fail === 'once' && n === 1)) {
    throw new Error('stub: the workspace said no')
  }
  return {
    rootId,
    idMap: { root: rootId, handbook: 'page-' + n },
    dataSourceIds: {},
    created: { pages: 2, databases: 0, rows: 0, blocks: 1 },
    specId: path.basename(taskDir),
  }
}

export async function teardownFixture(client, rootId) {
  log({ call: 'teardown', rootId, client: client?.describe?.() })
  if (process.env.NB_STUB_TEARDOWN_FAIL === '1') return { ok: false, error: 'stub: archive 500' }
  return { ok: true }
}

export async function writeWorkspacePointer(workspaceDir, fixture) {
  const file = path.join(workspaceDir, 'notionbench.json')
  mkdirSync(workspaceDir, { recursive: true })
  writeFileSync(file, JSON.stringify({ root_page_id: fixture.rootId }), 'utf8')
  log({ call: 'pointer', workspaceDir, rootId: fixture.rootId })
  return file
}
`,
    'utf8',
  );
  await writeFile(
    path.join(dir, 'notion.mjs'),
    `export class NotionClient {
  constructor(opts = {}) { this.opts = opts }
  describe() { return { auth: this.opts.auth, baseUrl: this.opts.baseUrl } }
}
`,
    'utf8',
  );
  process.env.NOTIONBENCH_LIVE_LIB = dir;
  process.env.NB_STUB_LOG = stubLog;
  return dir;
}

interface StubCall {
  call: 'provision' | 'teardown' | 'pointer';
  taskDir?: string;
  parentPageId?: string;
  label?: string;
  rootId?: string;
  workspaceDir?: string;
  client?: { auth?: string; baseUrl?: string };
}

async function readStubLog(): Promise<StubCall[]> {
  let text: string;
  try {
    text = await readFile(stubLog, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as StubCall);
}

/** A Node "agent CLI"; `node --version` answers the runner's version probe. */
async function writeAgent(body: string): Promise<string> {
  const file = path.join(scratch, `agent-${Math.random().toString(36).slice(2, 8)}.mjs`);
  await writeFile(file, body, 'utf8');
  return file;
}

const IDLE_AGENT = `import { writeFileSync } from 'node:fs'
if (process.env.NB_AGENT_ENV_OUT) {
  writeFileSync(
    process.env.NB_AGENT_ENV_OUT,
    JSON.stringify({
      NOTION_API_BASE: process.env.NOTION_API_BASE ?? null,
      NOTION_API_TOKEN: process.env.NOTION_API_TOKEN ?? null,
    }),
    'utf8',
  )
}
console.log(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } }))
`;

async function writeRunconfig(opts: {
  agent: string;
  notion?: Record<string, string>;
  trials?: number;
}): Promise<void> {
  await writeFile(
    runconfigPath,
    JSON.stringify({
      configs: [
        {
          id: 'fake-agent',
          label: 'Fake Agent',
          harness: 'command-template',
          command: process.execPath,
          argsTemplate: [opts.agent, '{workspace}', '{prompt}'],
          model: 'fake-1',
          enabled: true,
        },
      ],
      ...(opts.notion ? { notion: opts.notion } : {}),
      resultsRoot,
      evalsRoot,
      concurrency: 1,
      trials: opts.trials ?? 1,
      timeoutSec: 60,
    }),
    'utf8',
  );
}

function capture(): void {
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errs.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  restore = () => {
    process.stdout.write = o;
    process.stderr.write = e;
  };
}

function runIdOf(): string {
  const id = /run (\d{8}-\d{6})/.exec(out.join(''))?.[1];
  if (!id) throw new Error(`no run id in output:\n${out.join('')}`);
  return id;
}

async function runLog(runId: string): Promise<string> {
  return readFile(path.join(resultsRoot, runId, 'run.log'), 'utf8');
}

/**
 * Assert the run finished, and if it did not, say *why* in the failure message.
 *
 * A cell can fail for reasons that live entirely in state.json — provisioning,
 * workspace prep — so a bare `expect(code).toBe(0)` here would report "expected
 * 1 to be 0" and nothing else. These are the tests most likely to break on
 * someone else's machine; they should explain themselves when they do.
 */
async function expectRunSucceeded(code: number): Promise<void> {
  if (code === 0) return;
  let state = '(no state.json)';
  try {
    state = await readFile(path.join(resultsRoot, runIdOf(), 'state.json'), 'utf8');
  } catch {
    /* the run may have failed before the checkpoint existed */
  }
  throw new Error(
    `run exited ${code}\n--- stdout ---\n${out.join('')}\n--- stderr ---\n${errs.join('')}` +
      `\n--- state.json ---\n${state}`,
  );
}

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'nb-live-'));
  evalsRoot = path.join(scratch, 'evals');
  resultsRoot = path.join(scratch, 'results');
  runconfigPath = path.join(scratch, 'runconfig.json');
  stubLog = path.join(scratch, 'stub-calls.jsonl');
  out = [];
  errs = [];
  savedEnv = Object.fromEntries(OWNED_ENV.map((k) => [k, process.env[k]]));
  for (const k of OWNED_ENV) delete process.env[k];
  await mkdir(evalsRoot, { recursive: true });
});

afterEach(async () => {
  restore?.();
  restore = undefined;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('resolveLiveSettings', () => {
  it('prefers the environment over runconfig.json, and records which won', () => {
    const s = resolveLiveSettings({
      notion: { parentPageId: 'from-config', apiBase: 'https://config.example' },
      env: {
        NOTION_API_TOKEN: 'ntn_env',
        NOTION_PARENT_PAGE_ID: 'from-env',
        NOTION_API_BASE: 'https://env.example',
      },
    });
    expect(s).toMatchObject({
      token: 'ntn_env',
      tokenSource: 'env.NOTION_API_TOKEN',
      parentPageId: 'from-env',
      parentPageIdSource: 'env.NOTION_PARENT_PAGE_ID',
      apiBase: 'https://env.example',
      apiBaseSource: 'env.NOTION_API_BASE',
      apiBaseExplicit: true,
    });
  });

  it('falls back to runconfig.json when the environment is silent', () => {
    const s = resolveLiveSettings({
      notion: { parentPageId: 'from-config', apiBase: 'https://config.example/' },
      env: { NOTION_API_TOKEN: 'ntn_env' },
    });
    expect(s.parentPageId).toBe('from-config');
    expect(s.parentPageIdSource).toBe('runconfig.notion.parentPageId');
    // Trailing slash trimmed: it is concatenated with /v1/... paths downstream.
    expect(s.apiBase).toBe('https://config.example');
    expect(s.apiBaseSource).toBe('runconfig.notion.apiBase');
  });

  it('defaults to api.notion.com and reports the base as not explicit', () => {
    const s = resolveLiveSettings({ env: {} });
    expect(s.apiBase).toBe('https://api.notion.com');
    expect(s.apiBaseSource).toBe('default');
    expect(s.apiBaseExplicit).toBe(false);
    expect(s.token).toBeUndefined();
  });

  it('accepts the first token of a pool', () => {
    const s = resolveLiveSettings({ env: { NOTIONBENCH_NOTION_TOKENS: ' ntn_a , ntn_b ' } });
    expect(s.token).toBe('ntn_a');
    expect(s.tokenSource).toBe('env.NOTIONBENCH_NOTION_TOKENS');
  });
});

describe('inspectLiveTasks + liveRequirementProblems', () => {
  const task = (id: string, runtime: string): TaskSpec =>
    ({ id, dir: path.join(evalsRoot, id), promptPath: '', runtime }) as TaskSpec;

  it('separates "needs a workspace" from "needs a provisioned fixture"', async () => {
    await writeLiveTask('build-live-001-with-spec', { evalBody: 'return { score: 1 }' });
    await writeLiveTask('build-live-002-no-spec', { evalBody: 'return { score: 1 }', spec: null });
    await writeOfflineTask('build-off-001-plain');

    const info = await inspectLiveTasks([
      task('build-live-001-with-spec', 'live'),
      task('build-live-002-no-spec', 'live'),
      task('build-off-001-plain', 'offline'),
    ]);
    expect(info.live.map((t) => t.id)).toEqual([
      'build-live-001-with-spec',
      'build-live-002-no-spec',
    ]);
    expect(info.provisioned.map((t) => t.id)).toEqual(['build-live-001-with-spec']);
    expect(info.provisionedIds.has('build-live-001-with-spec')).toBe(true);
  });

  it('an all-offline grid needs nothing', async () => {
    await writeOfflineTask('build-off-001-plain');
    const info = await inspectLiveTasks([task('build-off-001-plain', 'offline')]);
    expect(info.live).toEqual([]);
    expect(liveRequirementProblems(info, resolveLiveSettings({ env: {} }))).toEqual([]);
  });

  it('names both missing pieces, with the tasks that need them', async () => {
    await writeLiveTask('build-live-001-with-spec', { evalBody: 'return { score: 1 }' });
    const info = await inspectLiveTasks([task('build-live-001-with-spec', 'live')]);
    const problems = liveRequirementProblems(info, resolveLiveSettings({ env: {} }));
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('NOTION_API_TOKEN');
    expect(problems[0]).toContain('build-live-001-with-spec');
    expect(problems[1]).toContain('NOTION_PARENT_PAGE_ID');
    // The reason a parent page is mandatory, not just a config knob.
    expect(problems[1]).toContain('cannot be archived');
  });

  it('a token alone still leaves provisioning unconfigured', async () => {
    await writeLiveTask('build-live-001-with-spec', { evalBody: 'return { score: 1 }' });
    const info = await inspectLiveTasks([task('build-live-001-with-spec', 'live')]);
    const problems = liveRequirementProblems(
      info,
      resolveLiveSettings({ env: { NOTION_API_TOKEN: 'ntn_x' } }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('parent page');
  });
});

describe('resolveLiveLibDir', () => {
  it('finds the checked-in evals/_lib/live from a runner build', async () => {
    const dir = await resolveLiveLibDir(path.join(scratch, 'nonexistent-evals'), {});
    expect(dir).toBeDefined();
    expect(path.resolve(dir!)).toBe(path.resolve(LIVE_LIB));
  });

  it('prefers the evals root the run was pointed at', async () => {
    const local = path.join(evalsRoot, '_lib', 'live');
    await mkdir(local, { recursive: true });
    await writeFile(path.join(local, 'provision.ts'), 'export const x = 1\n', 'utf8');
    expect(path.resolve((await resolveLiveLibDir(evalsRoot, {}))!)).toBe(path.resolve(local));
  });

  it('honours NOTIONBENCH_LIVE_LIB above everything', async () => {
    const dir = await writeStubLib();
    expect(await resolveLiveLibDir(evalsRoot, { NOTIONBENCH_LIVE_LIB: dir })).toBe(dir);
  });
});

describe('loadLiveLib', () => {
  it('loads the real evals/_lib/live surface', async () => {
    const lib = await loadLiveLib(LIVE_LIB);
    expect(typeof lib.provisionTaskFixture).toBe('function');
    expect(typeof lib.teardownFixture).toBe('function');
    expect(typeof lib.writeWorkspacePointer).toBe('function');
    expect(typeof lib.NotionClient).toBe('function');
  });

  it('names what is missing rather than failing on first use', async () => {
    const dir = path.join(scratch, 'half-a-lib');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'provision.mjs'), 'export const nope = 1\n', 'utf8');
    await expect(loadLiveLib(dir)).rejects.toThrow(/incomplete: expected provision\.\* and notion\.\*/);

    await writeFile(path.join(dir, 'notion.mjs'), 'export const NotionClient = 1\n', 'utf8');
    await expect(loadLiveLib(dir)).rejects.toThrow(/does not export provisionTaskFixture/);
  });
});

// ---------------------------------------------------------------------------

describe('run: plan-time failfast', () => {
  it('refuses to start a live grid with no token and no parent page', async () => {
    await writeLiveTask('build-live-001-fixture', { evalBody: 'return { score: 1 }' });
    await writeRunconfig({ agent: await writeAgent(IDLE_AGENT) });
    capture();
    const code = await main(['run', '--runconfig', runconfigPath, '--docs', 'with']);
    restore?.();

    expect(code).toBe(2);
    const text = errs.join('');
    expect(text).toContain('live tasks are selected but the Notion workspace is not configured');
    expect(text).toContain('NOTION_API_TOKEN');
    expect(text).toContain('NOTION_PARENT_PAGE_ID');
    expect(text).toContain('--dry-run');
    // Nothing was created: the whole point of failing at plan time.
    await expect(readFile(path.join(resultsRoot, 'latest', 'state.json'), 'utf8')).rejects.toThrow();
  });

  it('still refuses when only the parent page is missing', async () => {
    process.env.NOTION_API_TOKEN = 'ntn_test';
    await writeLiveTask('build-live-001-fixture', { evalBody: 'return { score: 1 }' });
    await writeRunconfig({ agent: await writeAgent(IDLE_AGENT) });
    capture();
    const code = await main(['run', '--runconfig', runconfigPath, '--docs', 'with']);
    restore?.();
    expect(code).toBe(2);
    expect(errs.join('')).toContain('NOTION_PARENT_PAGE_ID');
    expect(errs.join('')).not.toContain('no Notion integration token');
  });

  it('leaves an all-offline grid completely alone', async () => {
    await writeOfflineTask('build-off-001-plain');
    await writeRunconfig({ agent: await writeAgent(IDLE_AGENT) });
    capture();
    const code = await main(['run', '--runconfig', runconfigPath, '--docs', 'with']);
    restore?.();
    expect(code).toBe(0);
    expect(out.join('')).not.toContain('live:');
    const { records } = await readResults(path.join(resultsRoot, runIdOf()));
    expect(records).toHaveLength(1);
    expect(records[0]!.score).toBe(1);
  });
});

describe('run --dry-run: live preview', () => {
  beforeEach(async () => {
    await writeLiveTask('build-live-001-fixture', { evalBody: 'return { score: 1 }' });
    await writeOfflineTask('build-off-001-plain');
    await writeRunconfig({ agent: await writeAgent(IDLE_AGENT) });
  });

  it('describes what it would create instead of failing', async () => {
    capture();
    const code = await main([
      'run',
      '--runconfig',
      runconfigPath,
      '--dry-run',
      '--docs',
      'with',
      '--trials',
      '3',
    ]);
    restore?.();

    expect(code).toBe(0);
    const text = out.join('');
    expect(text).toContain('live fixtures (1 live task(s))');
    expect(text).toContain('3 fixture(s) — one per trial of build-live-001-fixture');
    expect(text).toContain('under page       UNSET');
    expect(text).toContain('https://api.notion.com  (default)');
    expect(text).toContain('token            ABSENT');
    expect(text).toContain('archive the root page');
    expect(text).toContain('this grid cannot run yet');
    expect(text).toContain('a real run stops here');
  });

  it('previews the configured destination once it is set', async () => {
    process.env.NOTION_API_TOKEN = 'ntn_test';
    process.env.NOTION_PARENT_PAGE_ID = 'page-123';
    capture();
    await main(['run', '--runconfig', runconfigPath, '--dry-run', '--docs', 'with']);
    restore?.();
    const text = out.join('');
    expect(text).toContain('under page       page-123  (env.NOTION_PARENT_PAGE_ID)');
    expect(text).toContain('token            present  (env.NOTION_API_TOKEN)');
    expect(text).not.toContain('this grid cannot run yet');
    // The token's *value* must never appear anywhere near a plan.
    expect(text).not.toContain('ntn_test');
  });

  it('says so when --no-teardown would keep every fixture', async () => {
    process.env.NOTION_API_TOKEN = 'ntn_test';
    process.env.NOTION_PARENT_PAGE_ID = 'page-123';
    capture();
    await main([
      'run',
      '--runconfig',
      runconfigPath,
      '--dry-run',
      '--docs',
      'with',
      '--no-teardown',
    ]);
    restore?.();
    expect(out.join('')).toContain('KEEP the root page (--no-teardown)');
    expect(out.join('')).toContain('logged as an ORPHAN');
  });

  it('is machine-readable', async () => {
    capture();
    await main(['run', '--runconfig', runconfigPath, '--dry-run', '--json', '--docs', 'with']);
    restore?.();
    const plan = JSON.parse(out.join('')) as {
      live: {
        tasks: string[];
        provisioned: string[];
        problems: string[];
        tokenPresent: boolean;
        teardown: boolean;
      };
    };
    expect(plan.live.tasks).toEqual(['build-live-001-fixture']);
    expect(plan.live.provisioned).toEqual(['build-live-001-fixture']);
    expect(plan.live.tokenPresent).toBe(false);
    expect(plan.live.teardown).toBe(true);
    expect(plan.live.problems).toHaveLength(2);
  });

  it('creates no run directory', async () => {
    capture();
    await main(['run', '--runconfig', runconfigPath, '--dry-run', '--docs', 'with']);
    restore?.();
    await expect(readFile(path.join(resultsRoot, 'latest', 'state.json'), 'utf8')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The lifecycle, against a recording stub of evals/_lib/live/.
// ---------------------------------------------------------------------------

/** Verifier that dumps the ctx it was handed, so ctx threading is observable. */
const CTX_DUMPING_EVAL = `
  const { writeFile } = await import("node:fs/promises")
  const p = await import("node:path")
  await writeFile(p.join(ctx.taskDir, "ctx-" + ctx.trial + ".json"), JSON.stringify(ctx), "utf8")
  const { readFile } = await import("node:fs/promises")
  let pointer = null
  try { pointer = JSON.parse(await readFile(p.join(workspaceDir, "notionbench.json"), "utf8")) } catch {}
  return {
    score: pointer && pointer.root_page_id === ctx.rootId ? 1 : 0,
    subscores: { pointer_matches_ctx: pointer && pointer.root_page_id === ctx.rootId ? 1 : 0 },
    diagnostics: ["rootId=" + String(ctx.rootId)],
  }
`;

describe('run: provisioning, ctx threading and teardown', () => {
  beforeEach(async () => {
    await writeStubLib();
    await writeLiveTask('build-live-001-fixture', { evalBody: CTX_DUMPING_EVAL });
  });

  it('provisions with the leased token, the configured page and the configured base', async () => {
    process.env.NOTION_API_TOKEN = 'ntn_leased';
    process.env.NB_AGENT_ENV_OUT = path.join(scratch, 'agent-env.json');
    await writeRunconfig({
      agent: await writeAgent(IDLE_AGENT),
      notion: { parentPageId: 'page-from-config', apiBase: 'https://notion.test' },
    });
    capture();
    const code = await main(['run', '--runconfig', runconfigPath, '--docs', 'with']);
    restore?.();
    expect(code).toBe(0);

    const calls = await readStubLog();
    const provision = calls.find((c) => c.call === 'provision')!;
    expect(provision).toBeDefined();
    expect(provision.taskDir).toBe(path.join(evalsRoot, 'build-live-001-fixture'));
    expect(provision.parentPageId).toBe('page-from-config');
    expect(provision.client).toEqual({ auth: 'ntn_leased', baseUrl: 'https://notion.test' });
    // The label makes a leaked root traceable to the exact cell that leaked it.
    expect(provision.label).toContain(runIdOf());
    expect(provision.label).toContain('build-live-001-fixture');
    expect(provision.label).toContain('fake-agent');

    // The pointer lands in the trial workspace, not the task fixture.
    const pointer = calls.find((c) => c.call === 'pointer')!;
    expect(pointer.workspaceDir).toMatch(/nb-build-live-001-fixture/);
    expect(pointer.rootId).toBe(provision.rootId);

    // A runconfig-only API base still reaches the agent's child process.
    const agentEnv = JSON.parse(await readFile(path.join(scratch, 'agent-env.json'), 'utf8')) as {
      NOTION_API_BASE: string;
      NOTION_API_TOKEN: string;
    };
    expect(agentEnv.NOTION_API_BASE).toBe('https://notion.test');
    expect(agentEnv.NOTION_API_TOKEN).toBe('ntn_leased');
  });

  it('threads {apiBase, rootId, idMap, token} into the verifier ctx', async () => {
    process.env.NOTION_API_TOKEN = 'ntn_leased';
    process.env.NOTION_PARENT_PAGE_ID = 'page-env';
    await writeRunconfig({ agent: await writeAgent(IDLE_AGENT) });
    capture();
    expect(await main(['run', '--runconfig', runconfigPath, '--docs', 'with'])).toBe(0);
    restore?.();

    const ctx = JSON.parse(
      await readFile(path.join(evalsRoot, 'build-live-001-fixture', 'ctx-1.json'), 'utf8'),
    ) as Record<string, unknown>;
    const provision = (await readStubLog()).find((c) => c.call === 'provision')!;

    expect(ctx.apiBase).toBe('https://api.notion.com');
    expect(ctx.rootId).toBe(provision.rootId);
    expect(ctx.token).toBe('ntn_leased');
    expect(ctx.idMap).toMatchObject({ root: provision.rootId, handbook: 'page-1' });
    // The pre-existing ctx entries are still there.
    expect(ctx.taskId).toBe('build-live-001-fixture');
    expect(ctx.configId).toBe('fake-agent');
    expect(ctx.trialStatus).toBe('completed');

    // And the verifier really could use it: it graded the pointer against ctx.
    const { records } = await readResults(path.join(resultsRoot, runIdOf()));
    expect(records[0]!.score).toBe(1);
    expect(records[0]!.subscores).toEqual({ pointer_matches_ctx: 1 });
  });

  it('tears the fixture down after the trial is scored, and logs it', async () => {
    process.env.NOTION_API_TOKEN = 'ntn_leased';
    process.env.NOTION_PARENT_PAGE_ID = 'page-env';
    await writeRunconfig({ agent: await writeAgent(IDLE_AGENT), trials: 2 });
    capture();
    expect(await main(['run', '--runconfig', runconfigPath, '--docs', 'with', '--trials', '2'])).toBe(0);
    restore?.();

    const calls = await readStubLog();
    const provisions = calls.filter((c) => c.call === 'provision');
    const teardowns = calls.filter((c) => c.call === 'teardown');
    expect(provisions).toHaveLength(2);
    expect(teardowns).toHaveLength(2);
    // One teardown per fixture, each with its own root — never a shared one.
    expect(teardowns.map((t) => t.rootId).sort()).toEqual(provisions.map((p) => p.rootId).sort());
    // Teardown reuses the trial's token, not an ambient one.
    expect(teardowns[0]!.client).toEqual({ auth: 'ntn_leased', baseUrl: 'https://api.notion.com' });

    // Ordering: a fixture is only torn down after its own scoring finished.
    const log = await runLog(runIdOf());
    expect(log).toMatch(/live provision .*spec=build-live-001-fixture .*pages=2 databases=0 rows=0 blocks=1/);
    expect(log).toMatch(/live teardown .*ok/);
    expect(log).not.toContain('ORPHAN');
    expect(log.indexOf('live provision')).toBeLessThan(log.indexOf('live teardown'));
  });

  it('--no-teardown keeps the fixture and records it as an orphan', async () => {
    process.env.NOTION_API_TOKEN = 'ntn_leased';
    process.env.NOTION_PARENT_PAGE_ID = 'page-env';
    await writeRunconfig({ agent: await writeAgent(IDLE_AGENT) });
    capture();
    const code = await main([
      'run',
      '--runconfig',
      runconfigPath,
      '--docs',
      'with',
      '--no-teardown',
    ]);
    restore?.();
    expect(code).toBe(0);

    const calls = await readStubLog();
    expect(calls.filter((c) => c.call === 'provision')).toHaveLength(1);
    expect(calls.filter((c) => c.call === 'teardown')).toHaveLength(0);

    const rootId = calls.find((c) => c.call === 'provision')!.rootId!;
    const log = await runLog(runIdOf());
    expect(log).toContain('ORPHAN live fixture retained');
    expect(log).toContain(`root=${rootId}`);
    expect(log).toContain('reason=--no-teardown');
    // The reaper note has to be actionable on its own.
    expect(log).toContain(`PATCH https://api.notion.com/v1/pages/${rootId} {"in_trash":true}`);

    expect(out.join('')).toContain('teardown DISABLED (--no-teardown)');
    expect(out.join('')).toContain('1 live fixture root(s) were not archived');
    // The trial itself is unaffected.
    const { records } = await readResults(path.join(resultsRoot, runIdOf()));
    expect(records[0]!.scored).toBe(true);
    expect(records[0]!.score).toBe(1);
  });

  it('a failed teardown is an orphan note, never a failed run', async () => {
    process.env.NOTION_API_TOKEN = 'ntn_leased';
    process.env.NOTION_PARENT_PAGE_ID = 'page-env';
    process.env.NB_STUB_TEARDOWN_FAIL = '1';
    await writeRunconfig({ agent: await writeAgent(IDLE_AGENT) });
    capture();
    const code = await main(['run', '--runconfig', runconfigPath, '--docs', 'with']);
    restore?.();

    expect(code).toBe(0);
    const { records } = await readResults(path.join(resultsRoot, runIdOf()));
    expect(records[0]!.scored).toBe(true);
    expect(records[0]!.score).toBe(1);
    const log = await runLog(runIdOf());
    expect(log).toContain('ORPHAN');
    expect(log).toContain('reason=stub: archive 500');
    expect(errs.join('')).toContain('ORPHAN');
  });

  it('a failed provisioning fails the cell instead of scoring an empty workspace', async () => {
    process.env.NOTION_API_TOKEN = 'ntn_leased';
    process.env.NOTION_PARENT_PAGE_ID = 'page-env';
    process.env.NB_STUB_PROVISION_FAIL = '1';
    await writeRunconfig({ agent: await writeAgent(IDLE_AGENT) });
    capture();
    const code = await main([
      'run',
      '--runconfig',
      runconfigPath,
      '--docs',
      'with',
      '--max-attempts',
      '1',
    ]);
    restore?.();

    expect(code).toBe(1);
    // No verdict was invented for a workspace that was never set up.
    await expect(readResults(path.join(resultsRoot, runIdOf()))).rejects.toThrow();
    const state = JSON.parse(
      await readFile(path.join(resultsRoot, runIdOf(), 'state.json'), 'utf8'),
    ) as { cells: Record<string, { status: string; lastError?: string }> };
    const cell = Object.values(state.cells)[0]!;
    expect(cell.status).toBe('failed');
    expect(cell.lastError).toContain('the workspace said no');
  });

  it('retries the cell after a transient provisioning failure', async () => {
    process.env.NOTION_API_TOKEN = 'ntn_leased';
    process.env.NOTION_PARENT_PAGE_ID = 'page-env';
    process.env.NB_STUB_PROVISION_FAIL = 'once';
    await writeRunconfig({ agent: await writeAgent(IDLE_AGENT) });
    capture();
    const code = await main([
      'run',
      '--runconfig',
      runconfigPath,
      '--docs',
      'with',
      '--max-attempts',
      '2',
    ]);
    restore?.();

    // The scheduler's retry budget covers infrastructure, so a workspace that
    // hiccups once costs a re-provision rather than the cell.
    expect(code).toBe(0);
    expect((await readStubLog()).filter((c) => c.call === 'provision')).toHaveLength(2);
    expect(errs.join('')).toContain('the workspace said no');
    const { records } = await readResults(path.join(resultsRoot, runIdOf()));
    expect(records).toHaveLength(1);
    expect(records[0]!.score).toBe(1);
  });

  it('offline tasks in a mixed grid are never provisioned', async () => {
    process.env.NOTION_API_TOKEN = 'ntn_leased';
    process.env.NOTION_PARENT_PAGE_ID = 'page-env';
    await writeOfflineTask('build-off-001-plain');
    await writeRunconfig({ agent: await writeAgent(IDLE_AGENT) });
    capture();
    expect(await main(['run', '--runconfig', runconfigPath, '--docs', 'with'])).toBe(0);
    restore?.();

    const calls = await readStubLog();
    expect(calls.filter((c) => c.call === 'provision')).toHaveLength(1);
    expect(calls.find((c) => c.call === 'provision')!.taskDir).toContain('build-live-001-fixture');
    const { records } = await readResults(path.join(resultsRoot, runIdOf()));
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.scored)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The real provisioning code, against an in-process Notion.
// ---------------------------------------------------------------------------

/**
 * The agent: reads the pointer it was given and creates a page under the
 * fixture root, using only `NOTION_API_BASE` / `NOTION_API_TOKEN` from its env.
 * That is the whole live contract from the agent's side.
 */
const NOTION_AGENT = `import { readFileSync } from 'node:fs'
import path from 'node:path'

const workspace = process.argv[2]
const pointer = JSON.parse(readFileSync(path.join(workspace, 'notionbench.json'), 'utf8'))
const res = await fetch(process.env.NOTION_API_BASE + '/v1/pages', {
  method: 'POST',
  headers: {
    authorization: 'Bearer ' + process.env.NOTION_API_TOKEN,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    parent: { type: 'page_id', page_id: pointer.root_page_id },
    properties: { title: { title: [{ type: 'text', text: { content: 'Agent Was Here' } }] } },
  }),
})
if (!res.ok) {
  console.error(await res.text())
  process.exit(1)
}
console.log(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } }))
`;

/** Verifier: finds the agent's page from the ctx the runner passed. */
const NOTION_EVAL = `
  const headers = { authorization: "Bearer " + ctx.token }
  const res = await fetch(ctx.apiBase + "/v1/blocks/" + ctx.rootId + "/children?page_size=100", { headers })
  const body = await res.json()
  const titles = (body.results ?? [])
    .filter((b) => b.type === "child_page")
    .map((b) => b.child_page.title)
  const created = titles.includes("Agent Was Here")
  const fixtureIntact = titles.includes("Team Handbook")
  return {
    score: created && fixtureIntact ? 1 : 0,
    subscores: {
      agent_created_page: created ? 1 : 0,
      fixture_intact: fixtureIntact ? 1 : 0,
      id_map_has_spec_key: ctx.idMap && ctx.idMap.handbook ? 1 : 0,
    },
    diagnostics: ["children: " + titles.join(", ")],
  }
`;

describe('run: the real live library against fake-notion', () => {
  it('provisions, hands the agent its sandbox, scores from ctx, then archives the root', async () => {
    const { startFakeNotion } = (await import(
      /* @vite-ignore */ new URL('../../../evals/_lib/live/fake-notion.ts', import.meta.url).href
    )) as {
      startFakeNotion: (opts?: unknown) => Promise<{
        url: string;
        token: string;
        parentPageId: string;
        store: { pages: Map<string, { inTrash: boolean; title: string }> };
        requests: Array<{ method: string; path: string }>;
        close(): Promise<void>;
      }>;
    };
    const server = await startFakeNotion();
    try {
      process.env.NOTION_API_TOKEN = server.token;
      process.env.NOTION_PARENT_PAGE_ID = server.parentPageId;
      await writeLiveTask('build-live-001-fixture', { evalBody: NOTION_EVAL });
      await writeRunconfig({
        agent: await writeAgent(NOTION_AGENT),
        // Deliberately via runconfig, not the environment: this is the path that
        // needs the runner to export NOTION_API_BASE into the child itself.
        notion: { apiBase: server.url },
      });

      capture();
      const code = await main(['run', '--runconfig', runconfigPath, '--docs', 'with']);
      restore?.();
      await expectRunSucceeded(code);

      const runId = runIdOf();
      const { records } = await readResults(path.join(resultsRoot, runId));
      expect(records).toHaveLength(1);
      expect(records[0]!.scored).toBe(true);
      expect(records[0]!.score).toBe(1);
      expect(records[0]!.subscores).toEqual({
        agent_created_page: 1,
        fixture_intact: 1,
        id_map_has_spec_key: 1,
      });

      // Teardown really happened, in the workspace, to the right page.
      const log = await runLog(runId);
      const rootId = /root=([0-9a-f-]+)/.exec(log)![1]!;
      expect(log).toMatch(/live teardown .*ok/);
      expect(log).not.toContain('ORPHAN');
      expect(server.store.pages.get(rootId)!.inTrash).toBe(true);
      // The operator's shared parent page is emphatically not touched.
      expect(server.store.pages.get(server.parentPageId)!.inTrash).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('--no-teardown leaves the root alive for inspection', async () => {
    const { startFakeNotion } = (await import(
      /* @vite-ignore */ new URL('../../../evals/_lib/live/fake-notion.ts', import.meta.url).href
    )) as {
      startFakeNotion: (opts?: unknown) => Promise<{
        url: string;
        token: string;
        parentPageId: string;
        store: { pages: Map<string, { inTrash: boolean; title: string }> };
        close(): Promise<void>;
      }>;
    };
    const server = await startFakeNotion();
    try {
      process.env.NOTION_API_TOKEN = server.token;
      process.env.NOTION_PARENT_PAGE_ID = server.parentPageId;
      await writeLiveTask('build-live-001-fixture', { evalBody: NOTION_EVAL });
      await writeRunconfig({
        agent: await writeAgent(NOTION_AGENT),
        notion: { apiBase: server.url },
      });

      capture();
      const code = await main([
        'run',
        '--runconfig',
        runconfigPath,
        '--docs',
        'with',
        '--no-teardown',
      ]);
      restore?.();
      await expectRunSucceeded(code);

      const log = await runLog(runIdOf());
      const rootId = /root=([0-9a-f-]+)/.exec(log)![1]!;
      expect(log).toContain('ORPHAN');
      expect(server.store.pages.get(rootId)!.inTrash).toBe(false);
      // …and the fixture root is titled after the cell that owns it.
      expect(server.store.pages.get(rootId)!.title).toContain('build-live-001-fixture');
    } finally {
      await server.close();
    }
  });
});
