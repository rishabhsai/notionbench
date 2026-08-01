import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../src/config.js';
import { isScorable, toTrialRecord, unscoredRecord } from '../src/score.js';
import type { TrialOutcome } from '../src/spawn.js';
import type { TaskSpec } from '../src/types.js';

const task: TaskSpec = {
  id: 'build-nac-001-workspace-from-spec',
  dir: '/repo/evals/build-nac-001-workspace-from-spec',
  promptPath: '/repo/evals/build-nac-001-workspace-from-spec/PROMPT.md',
  suite: 'benchmark',
  family: 'nac',
  stage: 'build',
  runtime: 'offline',
};

const config: AgentConfig = {
  id: 'claude-code-opus-5',
  label: 'Claude Code × Opus 5',
  harness: 'claude-code',
  model: 'opus',
  enabled: true,
};

const runDir = '/repo/results/20260731-120000';

function outcome(patch: Partial<TrialOutcome> = {}): TrialOutcome {
  return {
    identity: {
      runId: '20260731-120000',
      taskId: task.id,
      configId: config.id,
      docsCondition: 'with',
      trial: 2,
    },
    status: 'completed',
    exitCode: 0,
    signal: null,
    timedOut: false,
    startedAt: '2026-07-31T12:00:00.000Z',
    finishedAt: '2026-07-31T12:04:00.000Z',
    durationMs: 240_000,
    trialDir: path.join(runDir, task.id, config.id, 'docs-with', 'trial-2'),
    transcriptPath: 'transcript.jsonl',
    resultPath: 'result.json',
    workspaceDir: '/tmp/ws',
    parsed: {
      usage: null,
      usageRaw: null,
      toolCalls: 12,
      toolErrors: 2,
      rateLimitSignals: [],
      parseWarnings: [],
    },
    usage: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 10,
      reasoningOutputTokens: 0,
      totalTokens: 1530,
      inputTokensIncludeCached: false,
    },
    apiEquivalentCostUsd: 0.03,
    rateLimit: { detected: false, signals: [] },
    invocation: { command: 'claude', args: [], cwd: '/tmp/ws', envKeys: [] },
    stdoutBytes: 100,
    stderrBytes: 0,
    truncatedInMemory: false,
    ...patch,
  };
}

function verdict(patch: Record<string, unknown> = {}) {
  return {
    ok: true,
    score: 1,
    subscores: { build: 1, canonical: 1 },
    diagnostics: ['build ok'],
    durationMs: 3_000,
    exitCode: 0,
    signal: null,
    timedOut: false,
    command: 'node eval-harness.js',
    stdout: '',
    stderr: '',
    ...patch,
  } as Parameters<typeof toTrialRecord>[0]['score'];
}

describe('isScorable', () => {
  it('scores a trial the agent actually ran, however it ended', () => {
    expect(isScorable('completed')).toBe(true);
    expect(isScorable('failed')).toBe(true);
    // The agent got its wall clock; the workspace may still solve the task.
    expect(isScorable('timeout')).toBe(true);
  });

  it('does not score a trial the agent never got to run', () => {
    expect(isScorable('rate_limited')).toBe(false);
    expect(isScorable('spawn_error')).toBe(false);
  });
});

describe('toTrialRecord', () => {
  it('merges the rollout and the verdict into one self-describing row', () => {
    const record = toTrialRecord({
      task,
      config,
      outcome: outcome(),
      runId: '20260731-120000',
      runDir,
      score: verdict(),
    });
    expect(record).toMatchObject({
      v: 1,
      runId: '20260731-120000',
      taskId: task.id,
      family: 'nac',
      stage: 'build',
      suite: 'benchmark',
      configId: 'claude-code-opus-5',
      configLabel: 'Claude Code × Opus 5',
      harness: 'claude-code',
      model: 'opus',
      docsCondition: 'with',
      trial: 2,
      score: 1,
      scored: true,
      status: 'completed',
      toolCalls: 12,
      toolErrors: 2,
      apiEquivalentCostUsd: 0.03,
      wallTimeMs: 240_000,
    });
    expect(record.subscores).toEqual({ build: 1, canonical: 1 });
    expect(record.diagnostics).toEqual(['build ok']);
    expect(record.tokens?.totalTokens).toBe(1530);
  });

  it('stores the trial dir relative to the run so a results tree stays movable', () => {
    const record = toTrialRecord({
      task,
      config,
      outcome: outcome(),
      runId: '20260731-120000',
      runDir,
      score: verdict(),
    });
    expect(record.trialDir).toBe(
      path.join(task.id, config.id, 'docs-with', 'trial-2'),
    );
  });

  it('records a verifier failure as unmeasured, not as a zero', () => {
    const record = toTrialRecord({
      task,
      config,
      outcome: outcome(),
      runId: '20260731-120000',
      runDir,
      score: verdict({ ok: false, score: 0, error: 'verifier exceeded its time budget' }),
    });
    expect(record.scored).toBe(false);
    expect(record.score).toBe(0);
    expect(record.scoreError).toBe('verifier exceeded its time budget');
  });

  it('never lets a stale score through when the verifier failed', () => {
    const record = toTrialRecord({
      task,
      config,
      outcome: outcome(),
      runId: '20260731-120000',
      runDir,
      // A malformed verdict could carry a score alongside ok:false.
      score: verdict({ ok: false, score: 1, error: 'boom' }),
    });
    expect(record.score).toBe(0);
    expect(record.scored).toBe(false);
  });

  it('omits empty subscore/diagnostic blocks rather than writing noise', () => {
    const record = toTrialRecord({
      task,
      config,
      outcome: outcome(),
      runId: '20260731-120000',
      runDir,
      score: verdict({ subscores: {}, diagnostics: [] }),
    });
    expect(record.subscores).toBeUndefined();
    expect(record.diagnostics).toBeUndefined();
  });

  it('carries the rollout error through', () => {
    const record = toTrialRecord({
      task,
      config,
      outcome: outcome({ status: 'timeout', timedOut: true, error: 'wall clock exceeded' }),
      runId: '20260731-120000',
      runDir,
      score: verdict({ score: 0 }),
    });
    expect(record.status).toBe('timeout');
    expect(record.error).toBe('wall clock exceeded');
  });
});

describe('unscoredRecord', () => {
  it('accounts for an attempt the runner declined to verify', () => {
    const record = unscoredRecord({
      task,
      config,
      outcome: outcome({ status: 'rate_limited' }),
      runId: '20260731-120000',
      runDir,
      reason: 'not scored: status rate_limited',
    });
    expect(record.scored).toBe(false);
    expect(record.score).toBe(0);
    expect(record.scoreError).toBe('not scored: status rate_limited');
    expect(record.status).toBe('rate_limited');
  });
});
