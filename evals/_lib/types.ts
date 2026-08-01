/**
 * The contract every `evals/<id>/EVAL.ts` implements.
 *
 * A verifier is a default-exported async function. It is handed the trial
 * workspace (a throwaway copy of `fixture/workspace` with the agent's edits
 * applied) and returns a binary score plus enough diagnostics to explain it.
 *
 * Scorers run host-side, never inside the agent sandbox (docs/PLAN.md,
 * "Anti-cheat"), so they may shell out freely.
 */
export interface EvalContext {
  /** Absolute path of the task directory (the one holding PROMPT.md). */
  taskDir?: string
  /** Wall-clock budget for the whole verification, in milliseconds. */
  timeoutMs?: number
  /** Free-form runner metadata (trial index, agent config, ...). */
  [key: string]: unknown
}

export interface EvalArgs {
  /** Absolute path of the trial workspace to score. */
  workspaceDir: string
  ctx?: EvalContext
}

export interface EvalResult {
  /** Binary outcome. Partial credit lives in `subscores`, never in `score`. */
  score: 0 | 1
  /** Per-criterion breakdown in [0, 1]; reported, but not aggregated. */
  subscores?: Record<string, number>
  /** Ordered, human-readable evidence for the score. Always populated. */
  diagnostics: string[]
}

export type Scorer = (args: EvalArgs) => Promise<EvalResult>
