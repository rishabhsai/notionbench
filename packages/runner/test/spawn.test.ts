import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfig } from '../src/config.js';
import {
  buildTrialEnv,
  clearVersionCache,
  redactedEnvKeys,
  runTrial,
  STRIPPED_ENV_KEYS,
  type TrialIdentity,
} from '../src/spawn.js';
import { readTranscript } from '../src/transcript.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_BIN = path.join(HERE, 'fake-bin');
const FIXTURES = path.join(HERE, 'fixtures');

let scratch: string;
let originalPath: string | undefined;

const IDENTITY: TrialIdentity = {
  runId: '20260731-120000',
  taskId: 'build-cli-001-create-page-with-icon',
  configId: 'claude-code-opus-5',
  docsCondition: 'with',
  trial: 1,
};

const CLAUDE: AgentConfig = {
  id: 'claude-code-opus-5',
  label: 'Claude Code × Opus 5',
  harness: 'claude-code',
  model: 'opus',
  enabled: true,
  pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
};

const CODEX: AgentConfig = {
  id: 'codex-high',
  label: 'Codex high',
  harness: 'codex',
  model: 'gpt-5.6-sol',
  reasoningEffort: 'high',
  enabled: true,
};

beforeAll(() => {
  originalPath = process.env.PATH;
  // The fake `claude` / `codex` shell scripts shadow the real CLIs for these tests.
  process.env.PATH = `${FAKE_BIN}${path.delimiter}${originalPath ?? ''}`;
  process.env.FAKE_FIXTURES = FIXTURES;
});

afterAll(() => {
  if (originalPath !== undefined) process.env.PATH = originalPath;
  delete process.env.FAKE_FIXTURES;
});

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'nb-spawn-'));
  clearVersionCache();
  for (const k of ['FAKE_CLAUDE_MODE', 'FAKE_CODEX_MODE', 'FAKE_CLI_ARGV_OUT', 'FAKE_CLI_ENV_OUT', 'FAKE_CLI_CWD_OUT', 'FAKE_CLI_STDIN_OUT', 'FAKE_CLI_PID_OUT']) {
    delete process.env[k];
  }
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function trial(overrides: Partial<Parameters<typeof runTrial>[0]> = {}) {
  const workspaceDir = overrides.workspaceDir ?? path.join(scratch, 'workspace');
  const trialDir = overrides.trialDir ?? path.join(scratch, 'results', 'trial-1');
  await writeFile(
    await mkdirp(workspaceDir).then(() => path.join(workspaceDir, 'seed.txt')),
    'seed',
    'utf8',
  );
  return runTrial({
    config: CLAUDE,
    identity: IDENTITY,
    prompt: 'Create a page titled "Roadmap" with a 🚀 icon.',
    workspaceDir,
    trialDir,
    timeoutMs: 20_000,
    killGraceMs: 500,
    notionHome: path.join(scratch, 'notion-home'),
    ...overrides,
  });
}

async function mkdirp(dir: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
}

describe('buildTrialEnv', () => {
  it('strips API keys so a subscription run cannot silently switch to API billing', () => {
    const env = buildTrialEnv({
      base: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-xxx', OPENAI_API_KEY: 'sk-oai-xxx', HOME: '/h' },
    });
    for (const k of STRIPPED_ENV_KEYS) expect(env[k]).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/h'); // subscription auth lives here — must survive
  });

  it('applies per-trial Notion isolation', () => {
    const env = buildTrialEnv({
      base: {},
      notionHome: '/tmp/nb-x/notion-home',
      notionApiToken: 'ntn_secret',
    });
    expect(env.NOTION_HOME).toBe('/tmp/nb-x/notion-home');
    expect(env.NOTION_KEYRING).toBe('0');
    expect(env.NOTION_API_TOKEN).toBe('ntn_secret');
    expect(env.CI).toBe('1');
  });

  it('sets NOTION_KEYRING=0 even when no token is leased', () => {
    expect(buildTrialEnv({ base: {} }).NOTION_KEYRING).toBe('0');
  });

  it('lets config env override the defaults', () => {
    const env = buildTrialEnv({ base: {}, configEnv: { NOTION_KEYRING: '1' } });
    expect(env.NOTION_KEYRING).toBe('1');
  });

  it('redacts secret-bearing names when listing env keys', () => {
    const keys = redactedEnvKeys({ NOTION_API_TOKEN: 'ntn_secret', PATH: '/usr/bin' });
    expect(keys).toContain('NOTION_API_TOKEN=<redacted>');
    expect(keys).toContain('PATH');
    expect(keys.join(' ')).not.toContain('ntn_secret');
  });
});

describe('runTrial: happy path', () => {
  it('captures a lossless transcript and parses usage', async () => {
    process.env.FAKE_CLAUDE_MODE = 'success';
    const outcome = await trial();

    expect(outcome.status).toBe('completed');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.usage?.totalTokens).toBe(23 + 427 + 39040 + 13650);
    expect(outcome.parsed.toolCalls).toBe(3);
    expect(outcome.parsed.toolErrors).toBe(1);
    expect(outcome.invocation.cliVersion).toBe('2.1.220 (Claude Code)');

    const t = await readTranscript(outcome.transcriptPath);
    expect(t.malformed).toBe(0);
    expect(t.stdoutLines).toHaveLength(11);
    // Raw lines are stored verbatim so a drifted format is re-parseable later.
    expect(JSON.parse(t.stdoutLines[0]!).type).toBe('system');

    const start = t.meta.find((m) => m.event === 'start')!;
    const end = t.meta.find((m) => m.event === 'end')!;
    expect(start.identity).toEqual(IDENTITY);
    expect(end.status).toBe('completed');
    expect(end.toolCalls).toBe(3);
  });

  it('writes a result.json summary next to the transcript', async () => {
    process.env.FAKE_CLAUDE_MODE = 'success';
    const outcome = await trial();
    const saved = JSON.parse(await readFile(outcome.resultPath, 'utf8'));
    expect(saved.status).toBe('completed');
    expect(saved.identity).toEqual(IDENTITY);
    expect(saved.usage.totalTokens).toBe(outcome.usage!.totalTokens);
  });

  it('computes an API-equivalent cost from published prices', async () => {
    process.env.FAKE_CLAUDE_MODE = 'success';
    const outcome = await trial();
    // 23 in + 427 out + 39040 cache-read + 13650 cache-write at the config's rates.
    const expected =
      (23 / 1e6) * 5 + (427 / 1e6) * 25 + (39040 / 1e6) * 0.5 + (13650 / 1e6) * 6.25;
    expect(outcome.apiEquivalentCostUsd).toBeCloseTo(expected, 8);
  });

  it('runs the CLI in the trial workspace with the adapter-built argv', async () => {
    process.env.FAKE_CLAUDE_MODE = 'success';
    process.env.FAKE_CLI_ARGV_OUT = path.join(scratch, 'argv.txt');
    process.env.FAKE_CLI_CWD_OUT = path.join(scratch, 'cwd.txt');
    const outcome = await trial();

    const argv = (await readFile(process.env.FAKE_CLI_ARGV_OUT, 'utf8')).split('\n').filter(Boolean);
    expect(argv.slice(0, 2)).toEqual(['-p', 'Create a page titled "Roadmap" with a 🚀 icon.']);
    expect(argv).toContain('stream-json');
    expect(argv).toContain('--verbose');
    expect(argv).toContain('bypassPermissions');

    const cwd = (await readFile(process.env.FAKE_CLI_CWD_OUT, 'utf8')).trim();
    expect(await realpath(cwd)).toBe(await realpath(outcome.workspaceDir));
  });

  it('closes stdin so codex does not append it to the prompt or block forever', async () => {
    process.env.FAKE_CODEX_MODE = 'success';
    process.env.FAKE_CLI_STDIN_OUT = path.join(scratch, 'stdin.txt');
    const outcome = await trial({ config: CODEX });
    // If stdin were an open pipe, the fake CLI's `cat` would never return and this
    // test would hit the vitest timeout instead of finishing.
    expect(outcome.status).toBe('completed');
    expect(await readFile(process.env.FAKE_CLI_STDIN_OUT, 'utf8')).toBe('');
  });

  it('passes per-trial Notion isolation into the child and never writes the token to disk', async () => {
    process.env.FAKE_CLAUDE_MODE = 'success';
    process.env.FAKE_CLI_ENV_OUT = path.join(scratch, 'env.txt');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-be-stripped';
    try {
      const outcome = await trial({ notionApiToken: 'ntn_leased_secret_token' });
      const childEnv = await readFile(process.env.FAKE_CLI_ENV_OUT, 'utf8');

      expect(childEnv).toContain('NOTION_API_TOKEN=ntn_leased_secret_token');
      expect(childEnv).toContain('NOTION_KEYRING=0');
      expect(childEnv).toContain(`NOTION_HOME=${path.join(scratch, 'notion-home')}`);
      expect(childEnv).not.toContain('sk-ant-should-be-stripped');

      // The results tree is published (docs/PLAN.md); the lease must not leak.
      const transcript = await readFile(outcome.transcriptPath, 'utf8');
      const result = await readFile(outcome.resultPath, 'utf8');
      expect(transcript).not.toContain('ntn_leased_secret_token');
      expect(result).not.toContain('ntn_leased_secret_token');
      expect(transcript).toContain('NOTION_API_TOKEN=<redacted>');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('parses codex output through the codex adapter', async () => {
    process.env.FAKE_CODEX_MODE = 'success';
    const outcome = await trial({ config: CODEX });
    expect(outcome.status).toBe('completed');
    expect(outcome.usage?.inputTokensIncludeCached).toBe(true);
    expect(outcome.usage?.totalTokens).toBe(184320 + 4210);
    expect(outcome.invocation.cliVersion).toBe('codex-cli 0.144.6');
    // Codex writes MCP tracing to stderr even on success; it must not fail the trial.
    expect(outcome.stderrBytes).toBeGreaterThan(0);
  });
});

describe('runTrial: rate windows', () => {
  it('detects structured rate-limit events and derives the cooldown from resetsAt', async () => {
    process.env.FAKE_CLAUDE_MODE = 'rate-limit';
    const now = 1785556200 * 1000 - 20 * 60_000; // 20 minutes before the reset
    const outcome = await trial({ now: () => now, defaultCooldownMs: 30 * 60_000 });

    expect(outcome.status).toBe('rate_limited');
    expect(outcome.rateLimit.detected).toBe(true);
    expect(outcome.rateLimit.signals[0]!.matched).toContain('rejected');
    // Prefer the CLI's own reset time over the configured default.
    expect(outcome.rateLimit.cooldownMs).toBe(20 * 60_000);
  });

  it('detects a text-only usage-limit message when the run also failed', async () => {
    process.env.FAKE_CLAUDE_MODE = 'rate-limit-stderr';
    const outcome = await trial();
    expect(outcome.status).toBe('rate_limited');
    expect(outcome.rateLimit.signals.length).toBeGreaterThan(0);
    // No reset time available, so the configured cooldown applies.
    expect(outcome.rateLimit.cooldownMs).toBe(30 * 60_000);
  });

  it('does NOT flag a successful trial that merely talks about rate limits', async () => {
    // operate-batch-001-rate-limited-writes is literally a task about 3 req/s pacing;
    // its transcripts are full of the phrase and must still be scored.
    process.env.FAKE_CLAUDE_MODE = 'mentions-rate-limit';
    const outcome = await trial();
    expect(outcome.status).toBe('completed');
    expect(outcome.rateLimit.detected).toBe(false);
  });

  it('detects codex usage-limit exhaustion from stderr plus turn.failed', async () => {
    process.env.FAKE_CODEX_MODE = 'rate-limit';
    const outcome = await trial({ config: CODEX });
    expect(outcome.status).toBe('rate_limited');
    expect(outcome.parsed.harnessError).toContain('usage limit');
  });
});

describe('runTrial: failures', () => {
  it('records a non-zero exit as failed but still writes a transcript', async () => {
    process.env.FAKE_CLAUDE_MODE = 'fail';
    const outcome = await trial();
    expect(outcome.status).toBe('failed');
    expect(outcome.exitCode).toBe(3);
    const t = await readTranscript(outcome.transcriptPath);
    expect(t.stderrLines.join(' ')).toContain('workspace trust dialog');
  });

  it('reports spawn_error when the CLI is not installed', async () => {
    process.env.NOTIONBENCH_CLAUDE_BIN = path.join(scratch, 'definitely-not-a-cli');
    try {
      const outcome = await trial();
      expect(outcome.status).toBe('spawn_error');
      expect(outcome.error).toMatch(/ENOENT/);
      expect(outcome.usage).toBeNull();
      // Even a failed launch leaves an auditable transcript.
      const t = await readTranscript(outcome.transcriptPath);
      expect(t.meta.find((m) => m.event === 'start')).toBeDefined();
      expect(t.meta.find((m) => m.event === 'end')!.status).toBe('spawn_error');
    } finally {
      delete process.env.NOTIONBENCH_CLAUDE_BIN;
    }
  });

  it('keeps partial output when the stream ends mid-line', async () => {
    process.env.FAKE_CLAUDE_MODE = 'garbage';
    const outcome = await trial();
    const t = await readTranscript(outcome.transcriptPath);
    // The trailing partial line is flushed rather than dropped.
    expect(t.stdoutLines.some((l) => l.includes('trailing garbage'))).toBe(true);
    expect(outcome.parsed.parseWarnings.length).toBeGreaterThan(0);
    expect(outcome.usage?.outputTokens).toBe(2);
  });
});

describe('runTrial: timeouts', () => {
  it('SIGTERMs a hung CLI at the wall clock and kills its grandchildren too', async () => {
    process.env.FAKE_CLAUDE_MODE = 'hang';
    process.env.FAKE_CLI_PID_OUT = path.join(scratch, 'grandchild.pid');

    const outcome = await trial({ timeoutMs: 900, killGraceMs: 600 });
    expect(outcome.status).toBe('timeout');
    expect(outcome.timedOut).toBe(true);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(800);

    const pid = Number((await readFile(process.env.FAKE_CLI_PID_OUT, 'utf8')).trim());
    expect(Number.isInteger(pid)).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    // The agent's own `bash` tool calls must not survive as orphans on the host.
    expect(() => process.kill(pid, 0)).toThrow();

    const t = await readTranscript(outcome.transcriptPath);
    expect(t.meta.some((m) => m.event === 'timeout' && m.action === 'SIGTERM')).toBe(true);
  });

  it('escalates to SIGKILL when the CLI ignores SIGTERM', async () => {
    process.env.FAKE_CLAUDE_MODE = 'ignore-term';
    const outcome = await trial({ timeoutMs: 600, killGraceMs: 500 });

    expect(outcome.status).toBe('timeout');
    expect(outcome.signal).toBe('SIGKILL');
    const t = await readTranscript(outcome.transcriptPath);
    expect(t.meta.some((m) => m.event === 'timeout' && m.action === 'SIGKILL')).toBe(true);
  });
});

async function realpath(p: string): Promise<string> {
  const { realpath: rp } = await import('node:fs/promises');
  return rp(p);
}
