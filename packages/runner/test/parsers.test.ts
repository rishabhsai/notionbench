import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claudeCodeAdapter, normalizeClaudeUsage } from '../src/parsers/claude-code.js';
import { codexAdapter, normalizeCodexUsage, reconcileCodexUsages } from '../src/parsers/codex.js';
import { getAdapter, UnknownHarnessError } from '../src/parsers/index.js';
import { compilePatterns, scanForRateLimit } from '../src/rate-limit.js';
import type { AgentConfig } from '../src/config.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function lines(name: string): Promise<string[]> {
  const text = await readFile(path.join(FIXTURES, name), 'utf8');
  return text.split('\n').filter((l) => l.length > 0);
}

const claudeConfig: AgentConfig = {
  id: 'claude-code-opus-5',
  label: 'Claude Code × Opus 5',
  harness: 'claude-code',
  model: 'opus',
  enabled: true,
};

const codexConfig: AgentConfig = {
  id: 'codex-high',
  label: 'Codex high',
  harness: 'codex',
  model: 'gpt-5.6-sol',
  reasoningEffort: 'high',
  enabled: true,
};

describe('claude-code invocation', () => {
  it('builds the verified headless argv', () => {
    const inv = claudeCodeAdapter.buildInvocation(claudeConfig, {
      prompt: 'Do the task',
      workspaceDir: '/tmp/ws',
    });
    expect(inv.args).toEqual([
      '-p',
      'Do the task',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'opus',
      '--permission-mode',
      'bypassPermissions',
      '--strict-mcp-config',
      '--setting-sources',
      'project',
      '--no-session-persistence',
    ]);
    expect(inv.stdin).toBe('ignore');
  });

  it('passes the prompt as one argv element, never a shell string', () => {
    const nasty = 'Create a page named "; rm -rf / #" and $(whoami)';
    const inv = claudeCodeAdapter.buildInvocation(claudeConfig, {
      prompt: nasty,
      workspaceDir: '/tmp/ws',
    });
    expect(inv.args[1]).toBe(nasty);
    expect(inv.args.filter((a) => a === nasty)).toHaveLength(1);
  });

  it('maps reasoningEffort onto --effort', () => {
    const inv = claudeCodeAdapter.buildInvocation(
      { ...claudeConfig, reasoningEffort: 'xhigh' },
      { prompt: 'p', workspaceDir: '/tmp/ws' },
    );
    expect(inv.args).toContain('--effort');
    expect(inv.args[inv.args.indexOf('--effort') + 1]).toBe('xhigh');
  });

  it('requires --verbose alongside stream-json (regression: stream is silent without it)', () => {
    const inv = claudeCodeAdapter.buildInvocation(claudeConfig, { prompt: 'p', workspaceDir: '/w' });
    expect(inv.args).toContain('--verbose');
    expect(inv.args).toContain('stream-json');
  });
});

describe('codex invocation', () => {
  it('builds the verified headless argv with effort as a config override', () => {
    const inv = codexAdapter.buildInvocation(codexConfig, {
      prompt: 'Do the task',
      workspaceDir: '/tmp/ws',
    });
    expect(inv.args.slice(0, 3)).toEqual(['exec', 'Do the task', '--json']);
    expect(inv.args).toContain('--skip-git-repo-check');
    expect(inv.args).toContain('--ignore-user-config');
    expect(inv.args[inv.args.indexOf('-C') + 1]).toBe('/tmp/ws');
    expect(inv.args[inv.args.indexOf('-s') + 1]).toBe('workspace-write');
    expect(inv.args[inv.args.indexOf('-m') + 1]).toBe('gpt-5.6-sol');
    // Reasoning effort is NOT a flag on codex; it is a TOML config override.
    expect(inv.args).toContain('model_reasoning_effort="high"');
  });

  it('omits the effort override when the config does not pin one', () => {
    const inv = codexAdapter.buildInvocation(
      { ...codexConfig, reasoningEffort: undefined },
      { prompt: 'p', workspaceDir: '/w' },
    );
    expect(inv.args.some((a) => a.startsWith('model_reasoning_effort'))).toBe(false);
  });
});

describe('claude-code transcript parsing', () => {
  it('extracts usage, tool calls and tool errors from a full stream', async () => {
    const parsed = claudeCodeAdapter.parse({
      stdoutLines: await lines('claude-code-success.jsonl'),
      stderrLines: [],
    });

    expect(parsed.usage).toEqual({
      inputTokens: 23,
      outputTokens: 427,
      cacheReadInputTokens: 39040,
      cacheCreationInputTokens: 13650,
      reasoningOutputTokens: 0,
      // Claude's input_tokens EXCLUDES cache, so the total is the sum of all four.
      totalTokens: 23 + 427 + 39040 + 13650,
      inputTokensIncludeCached: false,
    });
    expect(parsed.toolCalls).toBe(3);
    expect(parsed.toolErrors).toBe(1);
    expect(parsed.numTurns).toBe(7);
    expect(parsed.durationMs).toBe(43980);
    expect(parsed.reportedCostUsd).toBeCloseTo(0.4213);
    expect(parsed.sessionId).toBe('c8482ac0-fc4d-4e5b-a23a-e12eec19fb81');
    expect(parsed.finalText).toContain('Wrote answer.json');
    expect(parsed.harnessError).toBeUndefined();
    expect(parsed.parseWarnings).toEqual([]);
    // The raw object is preserved so drifted formats stay recoverable.
    expect(parsed.usageRaw).toMatchObject({ source: 'result.usage' });
  });

  it('treats an "allowed" rate_limit_event as the happy path, not a signal', async () => {
    const parsed = claudeCodeAdapter.parse({
      stdoutLines: await lines('claude-code-success.jsonl'),
      stderrLines: [],
    });
    expect(parsed.rateLimitSignals).toEqual([]);
  });

  it('surfaces a rejected rate_limit_event as a structured signal with a reset time', async () => {
    const parsed = claudeCodeAdapter.parse({
      stdoutLines: await lines('claude-code-rate-limited.jsonl'),
      stderrLines: [],
    });
    expect(parsed.rateLimitSignals).toHaveLength(1);
    expect(parsed.rateLimitSignals[0]!.matched).toBe('rate_limit_info.status=rejected');
    expect(parsed.rateLimitSignals[0]!.resetsAtEpochSec).toBe(1785556200);
    expect(parsed.harnessError).toBe('rate_limit_error');
    // Usage is still recovered — a throttled trial's tokens were really spent.
    expect(parsed.usage?.outputTokens).toBe(64);
  });

  it('falls back to the last assistant usage when the stream is truncated', async () => {
    const parsed = claudeCodeAdapter.parse({
      stdoutLines: await lines('claude-code-truncated.jsonl'),
      stderrLines: [],
    });
    expect(parsed.usage).not.toBeNull();
    expect(parsed.usage?.outputTokens).toBe(88);
    expect(parsed.usageRaw).toMatchObject({ source: 'assistant.message.usage (fallback)' });
    expect(parsed.parseWarnings.join(' ')).toContain('no result message');
  });

  it('tolerates non-JSON noise without losing the parseable records', () => {
    const parsed = claudeCodeAdapter.parse({
      stdoutLines: [
        'Warning: something printed outside the stream',
        '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"x","name":"Bash","input":{}}],"usage":{"input_tokens":5,"output_tokens":6,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}',
        '{ truncated json',
      ],
      stderrLines: [],
    });
    expect(parsed.toolCalls).toBe(1);
    expect(parsed.usage?.outputTokens).toBe(6);
    expect(parsed.parseWarnings.length).toBeGreaterThan(0);
  });

  it('returns null usage rather than zeros when nothing is parseable', () => {
    const parsed = claudeCodeAdapter.parse({ stdoutLines: [], stderrLines: [] });
    expect(parsed.usage).toBeNull();
    expect(parsed.parseWarnings.join(' ')).toContain('no result message');
  });

  it('normalizeClaudeUsage rejects an all-zero usage object', () => {
    expect(
      normalizeClaudeUsage({
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ).toBeNull();
    expect(normalizeClaudeUsage(undefined)).toBeNull();
    expect(normalizeClaudeUsage('nope')).toBeNull();
  });

  it('survives a usage object with drifted/missing fields', () => {
    const usage = normalizeClaudeUsage({ input_tokens: 10, output_tokens: '???' });
    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 10,
      inputTokensIncludeCached: false,
    });
  });
});

describe('codex transcript parsing', () => {
  it('extracts usage, tool calls and tool errors', async () => {
    const parsed = codexAdapter.parse({
      stdoutLines: await lines('codex-success.jsonl'),
      stderrLines: [],
    });

    expect(parsed.usage).toEqual({
      inputTokens: 184320,
      outputTokens: 4210,
      cacheReadInputTokens: 161280,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 3100,
      // Codex's input_tokens INCLUDES cached, so cached must not be added again.
      totalTokens: 184320 + 4210,
      inputTokensIncludeCached: true,
    });
    // reasoning + agent_message are not tool calls; two commands + one file_change are.
    expect(parsed.toolCalls).toBe(3);
    expect(parsed.toolErrors).toBe(1); // exit_code 1 on the ntn call
    expect(parsed.sessionId).toBe('019fbb19-8634-7ad3-a9f2-8973914b349f');
    expect(parsed.finalText).toContain('answer.json');
  });

  it('distinguishes the two harnesses’ opposite cache conventions', async () => {
    const claude = claudeCodeAdapter.parse({
      stdoutLines: await lines('claude-code-success.jsonl'),
      stderrLines: [],
    });
    const codex = codexAdapter.parse({
      stdoutLines: await lines('codex-success.jsonl'),
      stderrLines: [],
    });
    expect(claude.usage!.inputTokensIncludeCached).toBe(false);
    expect(codex.usage!.inputTokensIncludeCached).toBe(true);
  });

  it('treats monotonically increasing turn usage as cumulative rather than summing', async () => {
    const parsed = codexAdapter.parse({
      stdoutLines: await lines('codex-multi-turn.jsonl'),
      stderrLines: [],
    });
    // Summing would give 135000 input; the last report already contains the first.
    expect(parsed.usage?.inputTokens).toBe(95000);
    expect(parsed.usage?.outputTokens).toBe(2400);
    expect(parsed.parseWarnings.join(' ')).toContain('cumulative');
  });

  it('sums per-turn usage when the reports are not monotonic', () => {
    const { usage, mode } = reconcileCodexUsages([
      { input_tokens: 5000, cached_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 0 },
      { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0 },
    ]);
    expect(mode).toBe('summed');
    expect(usage?.inputTokens).toBe(6000);
    expect(usage?.outputTokens).toBe(400);
  });

  it('captures turn.failed as a harness error and still counts the failed command', async () => {
    const parsed = codexAdapter.parse({
      stdoutLines: await lines('codex-failed.jsonl'),
      stderrLines: [],
    });
    expect(parsed.harnessError).toContain('usage limit');
    expect(parsed.toolCalls).toBe(1);
    expect(parsed.toolErrors).toBe(2); // the non-zero exit plus the error item
    expect(parsed.usage).toBeNull();
    expect(parsed.parseWarnings.join(' ')).toContain('no turn.completed usage');
  });

  it('normalizeCodexUsage rejects empty input', () => {
    expect(normalizeCodexUsage({})).toBeNull();
    expect(normalizeCodexUsage(null)).toBeNull();
  });
});

describe('rate-limit pattern scanning', () => {
  const patterns = compilePatterns();

  it('matches the real codex stderr shape', async () => {
    const text = await readFile(path.join(FIXTURES, 'codex-stderr-rate-limit.txt'), 'utf8');
    const signals = scanForRateLimit(text.split('\n'), 'stderr-text', patterns);
    expect(signals.length).toBeGreaterThanOrEqual(2);
    expect(signals.map((s) => s.matched).join(' ')).toMatch(/429|usage limit/i);
  });

  it('matches Claude Code’s usage-limit wording', () => {
    const signals = scanForRateLimit(
      ['Claude usage limit reached. Your limit will reset at 3:30pm.'],
      'stderr-text',
      patterns,
    );
    expect(signals).toHaveLength(1);
  });

  it('ignores ordinary output', () => {
    expect(
      scanForRateLimit(['Created page abc123', 'npm WARN deprecated foo@1'], 'stderr-text', patterns),
    ).toEqual([]);
  });

  it('drops an invalid regex from a user runconfig instead of throwing', () => {
    const compiled = compilePatterns(['(unclosed', 'usage limit']);
    expect(compiled.regexes).toHaveLength(1);
    expect(scanForRateLimit(['hit the usage limit'], 'stderr-text', compiled)).toHaveLength(1);
  });
});

describe('adapter registry', () => {
  it('resolves the two v1 harnesses', () => {
    expect(getAdapter('claude-code').id).toBe('claude-code');
    expect(getAdapter('codex').id).toBe('codex');
  });

  it('throws a directive error for placeholder harnesses rather than guessing', () => {
    expect(() => getAdapter('tera')).toThrow(UnknownHarnessError);
    expect(() => getAdapter('tera')).toThrow(/no adapter registered/);
  });
});
