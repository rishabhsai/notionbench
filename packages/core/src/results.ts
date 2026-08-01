/**
 * Trial result types.
 *
 * The unit of measurement is an **agent config** (harness x model x reasoning
 * effort), not a raw API model — see docs/PLAN.md. Every rollout is one
 * (task, config, docs condition, trial index) tuple.
 */
import { z } from "zod"

/** Docs-axis condition: Notion's own AGENTS.md/skills present in the sandbox or not. */
export const DOCS_CONDITIONS = ["provided", "withheld"] as const
export type DocsCondition = (typeof DOCS_CONDITIONS)[number]

export const AgentConfigSchema = z
  .object({
    /** Stable slug used in filenames and report rows, e.g. `claude-code-opus-5`. */
    id: z.string().min(1),
    /** Harness CLI, e.g. `claude-code`, `codex`. */
    harness: z.string().min(1),
    /** Model as the harness names it, e.g. `opus-5`. */
    model: z.string().min(1),
    /** Reasoning effort where the harness exposes one. */
    reasoningEffort: z.string().min(1).optional(),
    /** Pinned harness CLI version, recorded in run metadata. */
    harnessVersion: z.string().min(1).optional(),
  })
  .strict()

export type AgentConfig = z.infer<typeof AgentConfigSchema>

export const TokenUsageSchema = z
  .object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    /** Cached input tokens, when the harness reports them. */
    cachedInput: z.number().int().nonnegative().optional(),
  })
  .strict()

export type TokenUsage = z.infer<typeof TokenUsageSchema>

/**
 * Score of one trial: a total in [0,1] plus named subscores contributed by the
 * individual verify layers (e.g. `{ static: 1, intents: 0.5 }`).
 */
export const ScoreSchema = z
  .object({
    total: z.number().min(0).max(1),
    subscores: z.record(z.string(), z.number().min(0).max(1)).default({}),
  })
  .strict()

export type Score = z.infer<typeof ScoreSchema>

export const TrialResultSchema = z
  .object({
    taskId: z.string().min(1),
    config: AgentConfigSchema,
    /** 0-based trial index within the k independent trials. */
    trial: z.number().int().nonnegative(),
    docsCondition: z.enum(DOCS_CONDITIONS),
    score: ScoreSchema,
    tokens: TokenUsageSchema,
    /** Count of failed tool calls (mirrors Notion's internal eval table). */
    toolErrors: z.number().int().nonnegative(),
    /** Total tool calls, when the harness reports them. */
    toolCalls: z.number().int().nonnegative().optional(),
    /** Wall-clock duration of the rollout, in milliseconds. */
    wallTime: z.number().nonnegative(),
    /** Path to the persisted transcript, relative to the results root. */
    transcriptPath: z.string().min(1),
    /** ISO-8601 start timestamp. */
    startedAt: z.string().datetime().optional(),
    /** Set when the rollout itself failed (timeout, crash, rate limit). */
    error: z.string().optional(),
    /** Verifier-specific detail blob, persisted for the failure-mode gallery. */
    details: z.unknown().optional(),
  })
  .strict()

export type TrialResult = z.infer<typeof TrialResultSchema>

/** True when the trial counts as solved (verifiers are pass/fail per layer). */
export function isSolved(result: TrialResult, threshold = 1): boolean {
  return result.error === undefined && result.score.total >= threshold
}

/** Stable key identifying the cell a trial belongs to (used for checkpointing). */
export function trialKey(r: {
  taskId: string
  config: { id: string }
  docsCondition: DocsCondition
  trial: number
}): string {
  return `${r.config.id}|${r.docsCondition}|${r.taskId}|${r.trial}`
}

export function parseTrialResult(data: unknown): TrialResult {
  return TrialResultSchema.parse(data)
}
