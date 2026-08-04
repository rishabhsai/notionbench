import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_CONCURRENCY,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_TRIALS,
  V1_ROSTER,
  apiEquivalentCostUsd,
  defaultEvalsRoot,
  loadRunConfig,
  resolveRunConfig,
  selectConfigs,
  type AgentConfig,
} from '../src/config.js';
import { hasAdapter } from '../src/parsers/index.js';
import { TokenPool } from '../src/token-pool.js';

let scratch: string;
const repoCwd = process.cwd();

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'nb-config-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('v1 roster', () => {
  it('contains the configs docs/PLAN.md commits to', () => {
    const ids = V1_ROSTER.map((c) => c.id);
    expect(ids).toContain('claude-code-opus-5');
    expect(ids).toContain('claude-code-fable-5');
    expect(ids).toContain('codex-gpt-5.6-sol-medium');
    expect(ids).toContain('codex-gpt-5.6-sol-high');
    expect(ids).toContain('tera');
    expect(ids).toContain('luna');
  });

  it('separates the two Codex rows only by reasoning effort', () => {
    const medium = V1_ROSTER.find((c) => c.id === 'codex-gpt-5.6-sol-medium')!;
    const high = V1_ROSTER.find((c) => c.id === 'codex-gpt-5.6-sol-high')!;
    expect(medium.model).toBe(high.model);
    expect([medium.reasoningEffort, high.reasoningEffort]).toEqual(['medium', 'high']);
  });

  it('keeps the two within-vendor Claude rows on the same harness (clean model comparison)', () => {
    const opus = V1_ROSTER.find((c) => c.id === 'claude-code-opus-5')!;
    const fable = V1_ROSTER.find((c) => c.id === 'claude-code-fable-5')!;
    expect(opus.harness).toBe(fable.harness);
    expect(opus.model).not.toBe(fable.model);
  });

  it('leaves tera/luna disabled because their invocation is unverified', () => {
    for (const id of ['tera', 'luna']) {
      const c = V1_ROSTER.find((x) => x.id === id)!;
      expect(c.enabled).toBe(false);
      expect(c.note).toMatch(/TODO/);
      // A disabled placeholder must have no adapter — silently producing null
      // usage would be worse than refusing to schedule it.
      expect(hasAdapter(c.harness)).toBe(false);
    }
  });

  it('gives every enabled config a registered adapter', () => {
    for (const c of V1_ROSTER.filter((x) => x.enabled)) {
      expect(hasAdapter(c.harness)).toBe(true);
    }
  });

  it('uses filesystem-safe ids, since they become results/ path segments', () => {
    for (const c of V1_ROSTER) {
      expect(c.id).toMatch(/^[a-z0-9][a-z0-9._-]*$/i);
      expect(c.id).not.toContain('/');
    }
  });
});

describe('resolveRunConfig', () => {
  it('falls back to the built-in defaults', () => {
    const rc = resolveRunConfig();
    expect(rc.concurrency).toBe(DEFAULT_CONCURRENCY);
    expect(rc.trials).toBe(DEFAULT_TRIALS);
    expect(rc.rateWindow.cooldownMs).toBe(DEFAULT_COOLDOWN_MS);
    expect(rc.configs).toBe(V1_ROSTER);
  });

  it('merges a partial override without dropping the rest', () => {
    const rc = resolveRunConfig({ concurrency: 4, rateWindow: { cooldownMs: 60_000 } });
    expect(rc.concurrency).toBe(4);
    expect(rc.trials).toBe(DEFAULT_TRIALS);
    expect(rc.rateWindow.cooldownMs).toBe(60_000);
    expect(rc.rateWindow.patterns.length).toBeGreaterThan(0);
  });

  it('rejects nonsensical numbers instead of running a broken grid for days', () => {
    expect(() => resolveRunConfig({ trials: 0 })).toThrow(ConfigError);
    expect(() => resolveRunConfig({ concurrency: -1 })).toThrow(/concurrency/);
  });

  it('rejects duplicate and unsafe config ids', () => {
    const base: AgentConfig = { id: 'a', label: 'a', harness: 'codex', model: 'm', enabled: true };
    expect(() => resolveRunConfig({ configs: [base, { ...base }] })).toThrow(/duplicate/);
    expect(() => resolveRunConfig({ configs: [{ ...base, id: '../escape' }] })).toThrow(
      /filesystem-safe/,
    );
  });

  it('defaults enabled to true for user-supplied configs', () => {
    const rc = resolveRunConfig({
      configs: [{ id: 'x', label: 'x', harness: 'codex', model: 'm' } as AgentConfig],
    });
    expect(rc.configs[0]!.enabled).toBe(true);
  });
});

describe('the notion block', () => {
  it('is empty by default — an offline grid needs no workspace', () => {
    expect(resolveRunConfig().notion).toEqual({});
  });

  it('carries the live-fixture destination', () => {
    const rc = resolveRunConfig({ notion: { parentPageId: ' page-1 ', apiBase: 'https://x.test/' } });
    // Trimmed and de-slashed: both are concatenated with API paths downstream.
    expect(rc.notion).toEqual({ parentPageId: 'page-1', apiBase: 'https://x.test' });
  });

  it('rejects a blank parent page id rather than failing at cell 1', () => {
    expect(() => resolveRunConfig({ notion: { parentPageId: '  ' } })).toThrow(ConfigError);
  });

  it('rejects an apiBase that is not an http(s) URL', () => {
    expect(() => resolveRunConfig({ notion: { apiBase: 'api.notion.com' } })).toThrow(
      /must be an http\(s\) URL/,
    );
  });

  it('refuses a token in the config file', () => {
    expect(() =>
      resolveRunConfig({ notion: { token: 'ntn_secret' } as never }),
    ).toThrow(/NOTION_API_TOKEN/);
  });

  it('rejects a non-object notion block', () => {
    expect(() => resolveRunConfig({ notion: 'page-1' as never })).toThrow(ConfigError);
  });
});

describe('loadRunConfig', () => {
  it('reads a runconfig.json from disk', async () => {
    const p = path.join(scratch, 'runconfig.json');
    await writeFile(p, JSON.stringify({ trials: 3, concurrency: 1 }), 'utf8');
    const rc = await loadRunConfig(p);
    expect(rc.trials).toBe(3);
    expect(rc.concurrency).toBe(1);
  });

  it('uses the built-in defaults when no path is given', async () => {
    expect((await loadRunConfig()).trials).toBe(DEFAULT_TRIALS);
  });

  it('reports a missing or malformed file clearly', async () => {
    await expect(loadRunConfig(path.join(scratch, 'nope.json'))).rejects.toThrow(/not found/);
    const bad = path.join(scratch, 'bad.json');
    await writeFile(bad, '{ not json', 'utf8');
    await expect(loadRunConfig(bad)).rejects.toThrow(/not valid JSON/);
  });

  it('round-trips the shipped runconfig.example.json', async () => {
    const example = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      '..',
      'runconfig.example.json',
    );
    const rc = await loadRunConfig(example);
    expect(rc.configs.map((c) => c.id)).toContain('codex-gpt-5.6-sol-high');
    for (const c of rc.configs.filter((x) => x.enabled)) {
      expect(hasAdapter(c.harness)).toBe(true);
    }
    // Shipped empty on purpose: a copied config must hit `run`'s explicit
    // "set NOTION_PARENT_PAGE_ID" message, not a 404 from a placeholder id.
    expect(rc.notion).toEqual({});
  });
});

describe('selectConfigs', () => {
  it('returns every enabled config by default', () => {
    const selected = selectConfigs(V1_ROSTER, undefined);
    expect(selected.every((c) => c.enabled)).toBe(true);
    expect(selected.map((c) => c.id)).not.toContain('tera');
  });

  it('selects by id, preserving the requested order', () => {
    const selected = selectConfigs(V1_ROSTER, ['codex-gpt-5.6-sol-high', 'claude-code-opus-5']);
    expect(selected.map((c) => c.id)).toEqual(['codex-gpt-5.6-sol-high', 'claude-code-opus-5']);
  });

  it('names the known ids when given a typo', () => {
    expect(() => selectConfigs(V1_ROSTER, ['claude-opus'])).toThrow(/unknown config "claude-opus"/);
    expect(() => selectConfigs(V1_ROSTER, ['claude-opus'])).toThrow(/claude-code-opus-5/);
  });

  it('refuses a disabled config unless explicitly forced', () => {
    expect(() => selectConfigs(V1_ROSTER, ['tera'])).toThrow(/disabled/);
    expect(selectConfigs(V1_ROSTER, ['tera'], { includeDisabled: true })).toHaveLength(1);
  });
});

describe('apiEquivalentCostUsd', () => {
  const priced: AgentConfig = {
    id: 'p',
    label: 'p',
    harness: 'claude-code',
    model: 'opus',
    enabled: true,
    pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
  };

  it('prices a Claude-convention usage object (input excludes cache)', () => {
    const cost = apiEquivalentCostUsd(priced, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
      inputTokensIncludeCached: false,
    });
    expect(cost).toBeCloseTo(5 + 25 + 0.5 + 6.25);
  });

  it('does not double-charge cached input for a Codex-convention usage object', () => {
    // input_tokens already contains cached_input_tokens, so only the fresh 200k is
    // billed at the input rate and the 800k cached at the cache-read rate.
    const cost = apiEquivalentCostUsd(priced, {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadInputTokens: 800_000,
      cacheCreationInputTokens: 0,
      inputTokensIncludeCached: true,
    });
    expect(cost).toBeCloseTo((200_000 / 1e6) * 5 + (800_000 / 1e6) * 0.5);
  });

  it('returns undefined rather than 0 when prices are unknown', () => {
    const unpriced: AgentConfig = { ...priced, pricing: undefined };
    expect(
      apiEquivalentCostUsd(unpriced, {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        inputTokensIncludeCached: false,
      }),
    ).toBeUndefined();
  });
});

describe('TokenPool', () => {
  it('hands out one token per concurrent trial and reuses it after release', async () => {
    const pool = new TokenPool(['t1', 't2']);
    const a = await pool.acquire();
    const b = await pool.acquire();
    expect(new Set([a!.token, b!.token])).toEqual(new Set(['t1', 't2']));
    expect(pool.available).toBe(0);

    let third: string | undefined;
    const pending = pool.acquire().then((l) => {
      third = l!.token;
    });
    expect(third).toBeUndefined(); // blocked until a lease is released
    a!.release();
    await pending;
    expect(third).toBe(a!.token);
  });

  it('is safe to release twice', async () => {
    const pool = new TokenPool(['t1']);
    const lease = await pool.acquire();
    lease!.release();
    lease!.release();
    expect(pool.available).toBe(1);
  });

  it('acquire() resolves to undefined for an offline-only run with no tokens', async () => {
    const pool = new TokenPool([]);
    expect(pool.isEmpty).toBe(true);
    expect(await pool.acquire()).toBeUndefined();
  });

  it('reads a multi-token pool from the environment', () => {
    expect(TokenPool.fromEnv({ NOTIONBENCH_NOTION_TOKENS: 'a, b ,c' }).size).toBe(3);
    expect(TokenPool.fromEnv({ NOTION_API_TOKEN: 'solo' }).size).toBe(1);
    expect(TokenPool.fromEnv({}).isEmpty).toBe(true);
  });
});

describe('defaultEvalsRoot', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
    process.chdir(repoCwd);
  });

  it('prefers an explicit NOTIONBENCH_EVALS over everything else', () => {
    process.env.NOTIONBENCH_EVALS = '/somewhere/else';
    expect(defaultEvalsRoot()).toBe('/somewhere/else');
  });

  it("prefers a checkout's own evals/ so task edits take effect immediately", async () => {
    delete process.env.NOTIONBENCH_EVALS;
    await mkdir(path.join(scratch, 'evals'), { recursive: true });
    process.chdir(scratch);
    // realpath: macOS resolves /var -> /private/var under the hood.
    expect(await realpath(defaultEvalsRoot())).toBe(await realpath(path.join(scratch, 'evals')));
  });

  it('never returns a path under node_modules — Node cannot strip types there', () => {
    delete process.env.NOTIONBENCH_EVALS;
    process.env.NOTIONBENCH_CACHE = path.join(scratch, 'cache');
    process.chdir(scratch);
    expect(defaultEvalsRoot()).not.toContain('node_modules');
  });

  it('resolves the run config to that same root', () => {
    process.env.NOTIONBENCH_EVALS = '/tasks/elsewhere';
    expect(resolveRunConfig().evalsRoot).toBe('/tasks/elsewhere');
  });
});
