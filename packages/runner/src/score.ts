/**
 * The scoring half of a trial.
 *
 * The runner's job does not end when the agent's process exits: a trial is only
 * a data point once its workspace has been verified. This module is the seam —
 * it takes the rollout outcome plus the trial workspace, runs the task's
 * verifier out of process (`@notionbench/scoring`), and merges the two into the
 * one row that lands in `results/<runId>/results.jsonl`.
 *
 * Ordering matters and is enforced by the caller: **spawn → score → checkpoint**.
 * The workspace is deleted on cleanup, so verification has to happen while it
 * still exists; and the cell is only marked done after the row is on disk, so a
 * crash can never leave a cell claiming to be scored with nothing to show.
 */

import {
  appendResult,
  runTaskScorer,
  type TaskScoreResult,
  type TrialRecord,
  TRIAL_RECORD_VERSION,
} from '@notionbench/scoring';
import path from 'node:path';
import type { AgentConfig } from './config.js';
import type { TrialOutcome } from './spawn.js';
import type { TaskSpec } from './types.js';

/**
 * Trial statuses whose workspace is not worth verifying.
 *
 * `rate_limited` and `spawn_error` mean the agent never got its turn — the cell
 * will be retried, and scoring the untouched fixture would write a spurious 0.
 * `timeout` and `failed` ARE scored: the agent had its wall clock and may well
 * have finished the work before the harness fell over, and it is the verifier's
 * job — not the runner's — to decide whether the workspace solves the task.
 */
export const UNSCORABLE_STATUSES = new Set(['rate_limited', 'spawn_error']);

export function isScorable(status: string): boolean {
  return !UNSCORABLE_STATUSES.has(status);
}

export interface ScoreTrialOptions {
  task: TaskSpec;
  config: AgentConfig;
  outcome: TrialOutcome;
  /** The prepared workspace the agent just worked in. Must still exist. */
  workspaceDir: string;
  runId: string;
  /** `results/<runId>` — where results.jsonl lives. */
  runDir: string;
  /** Wall-clock budget for verification. Defaults to the scoring package's. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * `{apiBase, rootId, idMap, token}` for a `runtime: live` trial whose fixture
   * the runner provisioned.
   *
   * A live verifier resolves its workspace from ctx first, then the environment,
   * then the trial workspace's `notionbench.json` (see
   * `evals/_lib/live/context.ts`). Passing ctx is what makes the *id map*
   * available at all — the fallbacks can only recover the root — so a verifier
   * that wants to check a specific seeded row does not have to re-discover it.
   */
  liveCtx?: {
    apiBase: string;
    rootId: string;
    idMap: Record<string, string>;
    token?: string;
  };
}

export interface ScoredTrial {
  score: TaskScoreResult;
  record: TrialRecord;
}

/**
 * Verify one trial and append its row. Returns both the raw verdict (for the
 * console line and the checkpoint) and the row that was persisted.
 */
export async function scoreTrial(opts: ScoreTrialOptions): Promise<ScoredTrial> {
  const { task, config, outcome } = opts;
  const score = await runTaskScorer({
    taskDir: task.dir,
    workspaceDir: opts.workspaceDir,
    ctx: {
      runId: opts.runId,
      taskId: task.id,
      configId: config.id,
      docsCondition: outcome.identity.docsCondition,
      trial: outcome.identity.trial,
      trialStatus: outcome.status,
      timeoutMs: opts.timeoutMs,
      // Spread last: for a live task these four keys are the whole point of the
      // call, and nothing above may shadow them.
      ...(opts.liveCtx ?? {}),
    },
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });

  const record = toTrialRecord({ ...opts, score });
  await appendResult(opts.runDir, record);
  return { score, record };
}

/**
 * Merge a rollout outcome and a verifier verdict into the persisted row.
 *
 * Pure and exported so the row layout is testable without spawning anything.
 */
export function toTrialRecord(args: {
  task: TaskSpec;
  config: AgentConfig;
  outcome: TrialOutcome;
  runId: string;
  runDir: string;
  score: TaskScoreResult;
}): TrialRecord {
  const { task, config, outcome, score } = args;
  return {
    v: TRIAL_RECORD_VERSION,
    runId: args.runId,

    taskId: task.id,
    family: task.family,
    stage: task.stage,
    suite: task.suite,
    configId: config.id,
    configLabel: config.label,
    harness: config.harness,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    docsCondition: outcome.identity.docsCondition,
    trial: outcome.identity.trial,

    // `score` is only meaningful when the verifier returned a verdict; the
    // report keeps unverified trials visible instead of averaging them in
    // silently, which is why both fields are persisted.
    score: score.ok ? score.score : 0,
    scored: score.ok,
    subscores: Object.keys(score.subscores).length > 0 ? score.subscores : undefined,
    diagnostics: score.diagnostics.length > 0 ? score.diagnostics : undefined,
    scoreError: score.ok ? undefined : score.error,
    scoreDurationMs: score.durationMs,

    status: outcome.status,
    toolCalls: outcome.parsed.toolCalls,
    toolErrors: outcome.parsed.toolErrors,
    tokens: outcome.usage,
    apiEquivalentCostUsd: outcome.apiEquivalentCostUsd,
    wallTimeMs: outcome.durationMs,
    startedAt: outcome.startedAt,
    finishedAt: outcome.finishedAt,
    // Relative so an archived results tree stays movable.
    trialDir: path.relative(args.runDir, outcome.trialDir) || undefined,
    error: outcome.error,
  };
}

/**
 * The row written for a trial the runner declined to verify (`rate_limited`,
 * `spawn_error`), so that results.jsonl still accounts for every attempt.
 * Marked `scored: false` — it is an absence of measurement, not a zero.
 */
export function unscoredRecord(args: {
  task: TaskSpec;
  config: AgentConfig;
  outcome: TrialOutcome;
  runId: string;
  runDir: string;
  reason: string;
}): TrialRecord {
  return toTrialRecord({
    ...args,
    score: {
      ok: false,
      score: 0,
      subscores: {},
      diagnostics: [],
      error: args.reason,
      durationMs: 0,
      exitCode: null,
      signal: null,
      timedOut: false,
      command: '',
      stdout: '',
      stderr: '',
    },
  });
}
