/**
 * Minimal LOCAL copies of the shared NotionBench domain types.
 *
 * TODO(unify): `@notionbench/core` is being authored in parallel and will own the
 * canonical definitions of `TaskSpec` / `DocsCondition` / `TokenUsage` / `TaskFamily`
 * / `TaskStage`. Once core lands, delete the duplicated declarations below, add
 * `@notionbench/core` to this package's dependencies, and re-export from there so
 * there is exactly one definition per concept. Nothing outside this file should
 * hard-code these shapes.
 *
 * Everything here is intentionally structural (no classes, no runtime values that
 * core would also own) so the swap is a pure type-level change.
 */

/** Whether Notion's own AGENTS.md / skills docs are present in the trial workspace. */
export type DocsCondition = 'with' | 'without';

export const DOCS_CONDITIONS: readonly DocsCondition[] = ['with', 'without'];

/**
 * Agent CLI harness we shell out to. `command-template` is the generic escape
 * hatch for any prompt-in/files-out CLI (a README-stated v1 requirement).
 */
export type HarnessId = 'claude-code' | 'codex' | 'command-template' | 'tera' | 'luna';

/** Product area a task exercises (docs/COVERAGE.md). */
export type TaskFamily = 'cli' | 'workers' | 'nac' | 'ops' | 'pages' | 'db' | 'api' | string;

/** docs/COVERAGE.md stages. */
export type TaskStage = 'build' | 'investigate' | 'resolve' | 'operate';

/** `offline` needs no Notion account; `live` needs a leased workspace + token. */
export type TaskRuntime = 'offline' | 'live';

/** docs/PLAN.md suite governance. */
export type TaskSuite = 'benchmark' | 'regression' | 'other';

export interface TaskLimits {
  /** Wall-clock budget for one trial, in seconds. */
  time: number;
  /** Soft budget in API-equivalent USD; reported, not enforced by the runner. */
  cost?: number;
}

/**
 * The subset of a task the runner needs in order to launch a trial. The full
 * spec (verifier module wiring, fixtures provisioning, topics taxonomy) lives in
 * core + scoring.
 */
export interface TaskSpec {
  id: string;
  /** Absolute path to the task directory (`evals/<id>`). */
  dir: string;
  /** Absolute path to PROMPT.md. */
  promptPath: string;
  suite?: TaskSuite;
  family?: TaskFamily;
  stage?: TaskStage;
  runtime?: TaskRuntime;
  difficulty?: string;
  topics?: string[];
  /** `none` | `rest` | `live` */
  fixture?: string;
  verify?: string[];
  limits?: Partial<TaskLimits>;
}

/**
 * Normalized token accounting across harnesses.
 *
 * IMPORTANT cross-harness caveat (do not "simplify" this away):
 *   - Claude Code reports `input_tokens` EXCLUSIVE of cache reads/writes, which
 *     are separate counters (`cache_read_input_tokens`, `cache_creation_input_tokens`).
 *   - Codex reports `input_tokens` INCLUSIVE of `cached_input_tokens`.
 * `inputTokensIncludeCached` records which convention the source used so cost
 * math downstream can't silently double-count. `totalTokens` is always computed
 * correctly for the source convention.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Reasoning tokens, when the harness reports them separately (Codex does). */
  reasoningOutputTokens: number;
  /** Billable-ish total, computed per the source's convention. */
  totalTokens: number;
  /** True when `inputTokens` already contains `cacheReadInputTokens` (Codex). */
  inputTokensIncludeCached: boolean;
  /** Only some harnesses self-report a dollar figure; subscription runs ignore it. */
  costUsd?: number;
}

export function emptyUsage(inputTokensIncludeCached = false): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    inputTokensIncludeCached,
  };
}
