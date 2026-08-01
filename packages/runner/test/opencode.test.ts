import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../src/config.js';
import { getAdapter } from '../src/parsers/index.js';
import { opencodeAdapter, sumOpencodeSteps } from '../src/parsers/opencode.js';
import { compilePatterns, scanForRateLimit } from '../src/rate-limit.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function lines(name: string): Promise<string[]> {
  const text = await readFile(path.join(FIXTURES, name), 'utf8');
  return text.split('\n').filter((l) => l.length > 0);
}

const opencodeConfig: AgentConfig = {
  id: 'opencode-kimi-k3',
  label: 'OpenCode × Kimi K3',
  harness: 'opencode',
  model: 'opencode-go/kimi-k3',
  enabled: true,
};

/**
 * Per-step numbers copied verbatim from the captured run
 * (results/20260801-071041/build-nac-001-workspace-from-spec/opencode-kimi-k3/
 *  docs-with/trial-1/transcript.jsonl), which is also what the fixture is trimmed from.
 */
const REAL_STEPS = [
  { total: 10614, input: 10366, output: 175, reasoning: 73, read: 0, write: 0, cost: 0.034818 },
  { total: 29643, input: 18498, output: 223, reasoning: 682, read: 10240, write: 0, cost: 0.072141 },
  { total: 36335, input: 7207, output: 197, reasoning: 259, read: 28672, write: 0, cost: 0.0370626 },
  { total: 36579, input: 613, output: 108, reasoning: 18, read: 35840, write: 0, cost: 0.014481 },
  { total: 38402, input: 1576, output: 272, reasoning: 202, read: 36352, write: 0, cost: 0.0227436 },
];
const sum = (f: (s: (typeof REAL_STEPS)[number]) => number) => REAL_STEPS.reduce((a, s) => a + f(s), 0);

describe('opencode invocation', () => {
  it('builds the verified headless argv', () => {
    const inv = opencodeAdapter.buildInvocation(opencodeConfig, {
      prompt: 'Do the task',
      workspaceDir: '/tmp/ws',
    });
    expect(inv.command).toBe('opencode');
    expect(inv.args).toEqual([
      'run',
      'Do the task',
      '-m',
      'opencode-go/kimi-k3',
      '--format',
      'json',
      '--dir',
      '/tmp/ws',
      '--title',
      'notionbench-opencode-kimi-k3',
    ]);
    expect(inv.stdin).toBe('ignore');
    expect(inv.versionArgs).toEqual(['--version']);
  });

  it('always passes --dir (regression: without it OpenCode escapes the trial workspace)', () => {
    // OpenCode does not honour the process cwd; it re-anchors to a previously known
    // project directory. The first captured run had no --dir and the agent wandered
    // into the benchmark repo, read the task's expected/intents.json, and wrote its
    // answer into evals/…/fixture/workspace/src/main.ts.
    const inv = opencodeAdapter.buildInvocation(opencodeConfig, {
      prompt: 'p',
      workspaceDir: '/tmp/trial-workspace',
    });
    const i = inv.args.indexOf('--dir');
    expect(i).toBeGreaterThan(-1);
    expect(inv.args[i + 1]).toBe('/tmp/trial-workspace');
  });

  it('requests raw JSON events, not the formatted output', () => {
    const inv = opencodeAdapter.buildInvocation(opencodeConfig, { prompt: 'p', workspaceDir: '/w' });
    expect(inv.args[inv.args.indexOf('--format') + 1]).toBe('json');
  });

  it('passes the prompt as one argv element, never a shell string', () => {
    const nasty = 'Create a page named "; rm -rf / #" and $(whoami)';
    const inv = opencodeAdapter.buildInvocation(opencodeConfig, {
      prompt: nasty,
      workspaceDir: '/tmp/ws',
    });
    expect(inv.args[1]).toBe(nasty);
    expect(inv.args.filter((a) => a === nasty)).toHaveLength(1);
  });

  it('maps reasoningEffort onto --variant, and omits it when unpinned', () => {
    const pinned = opencodeAdapter.buildInvocation(
      { ...opencodeConfig, reasoningEffort: 'high' },
      { prompt: 'p', workspaceDir: '/w' },
    );
    expect(pinned.args[pinned.args.indexOf('--variant') + 1]).toBe('high');

    const unpinned = opencodeAdapter.buildInvocation(opencodeConfig, {
      prompt: 'p',
      workspaceDir: '/w',
    });
    expect(unpinned.args).not.toContain('--variant');
  });

  it('appends extraArgs verbatim', () => {
    const inv = opencodeAdapter.buildInvocation(
      { ...opencodeConfig, extraArgs: ['--pure'] },
      { prompt: 'p', workspaceDir: '/w' },
    );
    expect(inv.args[inv.args.length - 1]).toBe('--pure');
  });

  it('is registered under the "opencode" harness id', () => {
    expect(getAdapter('opencode')).toBe(opencodeAdapter);
  });
});

describe('opencode transcript parsing', () => {
  it('sums tokens across EVERY step_finish, not just the last one', async () => {
    const parsed = opencodeAdapter.parse({
      stdoutLines: await lines('opencode-success.jsonl'),
      stderrLines: [],
    });

    expect(parsed.numTurns).toBe(REAL_STEPS.length);
    expect(parsed.usage).toEqual({
      inputTokens: sum((s) => s.input),
      // reasoning is a separate addend in OpenCode's report, folded into output here
      // so `outputTokens` means the same billable thing it does on the other adapters.
      outputTokens: sum((s) => s.output) + sum((s) => s.reasoning),
      cacheReadInputTokens: sum((s) => s.read),
      cacheCreationInputTokens: sum((s) => s.write),
      reasoningOutputTokens: sum((s) => s.reasoning),
      totalTokens: sum((s) => s.total),
      inputTokensIncludeCached: false,
      costUsd: parsed.usage?.costUsd,
    });
    // Concrete numbers from the real run, so a refactor that quietly changes the
    // convention fails loudly.
    expect(parsed.usage?.inputTokens).toBe(38260);
    expect(parsed.usage?.outputTokens).toBe(2209);
    expect(parsed.usage?.cacheReadInputTokens).toBe(111104);
    expect(parsed.usage?.totalTokens).toBe(151573);
    // Taking the last step alone (what a single-event parser would do) is 4x low.
    expect(parsed.usage!.totalTokens).toBeGreaterThan(REAL_STEPS[4]!.total * 3);
  });

  it('records that OpenCode’s input EXCLUDES cached reads', async () => {
    const parsed = opencodeAdapter.parse({
      stdoutLines: await lines('opencode-success.jsonl'),
      stderrLines: [],
    });
    expect(parsed.usage?.inputTokensIncludeCached).toBe(false);
    // The provenance flag is not a guess: per-step,
    // total == input + output + reasoning + cache.read + cache.write exactly, and
    // step 4 reports 613 input against 35 840 cached reads — an inclusive counter
    // cannot be smaller than the subset it supposedly contains.
    for (const s of REAL_STEPS) {
      expect(s.input + s.output + s.reasoning + s.read + s.write).toBe(s.total);
    }
    expect(REAL_STEPS[3]!.input).toBeLessThan(REAL_STEPS[3]!.read);
  });

  it('sums the provider-reported cost across steps', async () => {
    const parsed = opencodeAdapter.parse({
      stdoutLines: await lines('opencode-success.jsonl'),
      stderrLines: [],
    });
    expect(parsed.reportedCostUsd).toBeCloseTo(sum((s) => s.cost), 8);
    expect(parsed.reportedCostUsd).toBeCloseTo(0.1812462, 8);
    // Mirrored onto the usage row so a consumer holding only TokenUsage still sees it.
    expect(parsed.usage?.costUsd).toBeCloseTo(0.1812462, 8);
    expect(parsed.usageRaw).toMatchObject({
      source: 'step_finish.part.tokens',
      stepCount: REAL_STEPS.length,
      costSource: 'step_finish.part.cost',
    });
  });

  it('counts tool calls and keeps session/final text', async () => {
    const parsed = opencodeAdapter.parse({
      stdoutLines: await lines('opencode-success.jsonl'),
      stderrLines: [],
    });
    expect(parsed.toolCalls).toBe(6); // 5 read + 1 bash
    expect(parsed.toolErrors).toBe(0);
    expect(parsed.sessionId).toBe('ses_043d6d22cffe4250Zzn6NuerLU');
    expect(parsed.finalText).toContain('src/main.ts');
    expect(parsed.harnessError).toBeUndefined();
    expect(parsed.rateLimitSignals).toEqual([]);
    expect(parsed.parseWarnings).toEqual([]);
    // Span of the agent's own events, not the trial wall clock.
    expect(parsed.durationMs).toBeGreaterThan(0);
  });

  it('counts a non-completed tool state as a tool error', async () => {
    const parsed = opencodeAdapter.parse({
      stdoutLines: await lines('opencode-tool-error.jsonl'),
      stderrLines: [],
    });
    expect(parsed.toolCalls).toBe(3);
    expect(parsed.toolErrors).toBe(1); // state.status === "error" on the missing file
    expect(parsed.parseWarnings.join(' ')).toContain('File not found');
  });

  it('treats an unknown tool state as an error rather than a clean call', () => {
    const parsed = opencodeAdapter.parse({
      stdoutLines: [
        '{"type":"tool_use","part":{"type":"tool","tool":"bash","state":{"status":"aborted"}}}',
        '{"type":"tool_use","part":{"type":"tool","tool":"bash"}}',
      ],
      stderrLines: [],
    });
    expect(parsed.toolCalls).toBe(2);
    expect(parsed.toolErrors).toBe(2);
  });

  it('tolerates malformed and unknown lines without losing the parseable records', () => {
    const parsed = opencodeAdapter.parse({
      stdoutLines: [
        'INFO  starting opencode server on :4096',
        '{ truncated json',
        '',
        '{"type":"tool_use","part":{"type":"tool","tool":"read","state":{"status":"completed"}}}',
        '{"type":"brand_new_event","part":{}}',
        '{"type":"step_finish","part":{"type":"step-finish"}}',
        '{"type":"step_finish","timestamp":2,"part":{"type":"step-finish","tokens":{"total":30,"input":10,"output":5,"reasoning":5,"cache":{"write":2,"read":8}},"cost":0.5}}',
      ],
      stderrLines: [],
    });
    expect(parsed.toolCalls).toBe(1);
    expect(parsed.usage?.inputTokens).toBe(10);
    expect(parsed.usage?.outputTokens).toBe(10); // 5 output + 5 reasoning
    expect(parsed.usage?.totalTokens).toBe(30);
    expect(parsed.reportedCostUsd).toBeCloseTo(0.5, 8);
    const warnings = parsed.parseWarnings.join(' | ');
    expect(warnings).toContain('non-JSON stdout line');
    expect(warnings).toContain('brand_new_event');
    expect(warnings).toContain('step_finish without a part.tokens object');
  });

  it('returns null usage rather than zeros when no step_finish is present', () => {
    const parsed = opencodeAdapter.parse({ stdoutLines: [], stderrLines: [] });
    expect(parsed.usage).toBeNull();
    expect(parsed.reportedCostUsd).toBeUndefined();
    expect(parsed.parseWarnings.join(' ')).toContain('no step_finish token reports');
  });

  it('surfaces a usage-window error event as a structured rate-limit signal', () => {
    const parsed = opencodeAdapter.parse({
      stdoutLines: [
        '{"type":"error","part":{"error":"Go limit reached: usage limit reached for opencode-go/kimi-k3"}}',
      ],
      stderrLines: [],
    });
    expect(parsed.harnessError).toContain('Go limit reached');
    expect(parsed.rateLimitSignals).toHaveLength(1);
    expect(parsed.rateLimitSignals[0]!.source).toBe('stdout-structured');
  });

  it('sumOpencodeSteps rejects empty and all-zero input', () => {
    expect(sumOpencodeSteps([])).toBeNull();
    expect(sumOpencodeSteps([{ total: 0, input: 0, output: 0, reasoning: 0 }])).toBeNull();
    expect(sumOpencodeSteps(['nope', null])).toBeNull();
  });

  it('sumOpencodeSteps survives drifted/missing fields', () => {
    expect(sumOpencodeSteps([{ input: 10, output: '???' }])).toEqual({
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

describe('opencode rate-window phrasing', () => {
  const patterns = compilePatterns();

  it('matches OpenCode Go’s usage-limit wording', () => {
    const signals = scanForRateLimit(
      [
        'Go limit reached',
        'Usage limit reached. To continue using this model now, subscribe.',
        'Free usage exceeded',
        '{"action":{"reason":"account_rate_limit"}}',
      ],
      'stderr-text',
      patterns,
    );
    expect(signals).toHaveLength(4);
  });

  it('leaves ordinary OpenCode output alone', () => {
    expect(
      scanForRateLimit(
        ['Build succeeded. Let me verify the compiled intents:', 'wrote dist/intents.json'],
        'stderr-text',
        patterns,
      ),
    ).toEqual([]);
  });
});
