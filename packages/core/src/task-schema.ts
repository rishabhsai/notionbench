/**
 * Task metadata schema for NotionBench.
 *
 * Every task lives in `evals/<id>/` and is described by the YAML frontmatter of
 * its `PROMPT.md`. The shape mirrors `docs/PLAN.md` ("Task frontmatter format")
 * and the dimension tags in `docs/COVERAGE.md`.
 */
import { z } from "zod"

/** Suite governance buckets (see docs/PLAN.md "Suite structure & governance"). */
export const SUITES = ["benchmark", "regression", "other"] as const
export type Suite = (typeof SUITES)[number]

/** Product area the task exercises. */
export const FAMILIES = ["cli", "workers", "nac", "ops"] as const
export type Family = (typeof FAMILIES)[number]

/** What the agent is asked to do (docs/COVERAGE.md stages). */
export const STAGES = ["build", "investigate", "resolve", "operate"] as const
export type Stage = (typeof STAGES)[number]

/** Coarse difficulty band, L1 (trivial) .. L4 (multi-step, adversarial). */
export const DIFFICULTIES = ["L1", "L2", "L3", "L4"] as const
export type Difficulty = (typeof DIFFICULTIES)[number]

/** `offline` needs no Notion account; `live` leases a workspace fixture. */
export const RUNTIMES = ["offline", "live"] as const
export type Runtime = (typeof RUNTIMES)[number]

/** How the task's starting state is provisioned. */
export const FIXTURE_KINDS = ["none", "rest", "live"] as const
export type FixtureKind = (typeof FIXTURE_KINDS)[number]

/**
 * Verification layers (docs/PLAN.md "Verification design").
 * - `static`      — tsc/lint style checks inside the sandbox
 * - `exec-local`  — `ntn workers exec --local` behavioral assertions
 * - `intents`     — canonical `dist/intents.json` comparison (Notion-as-Code)
 * - `state`       — host-side live-workspace assertions
 * - `answer-file` — exact/structured match against an agent-written answer file
 * - `artifact`    — exact match of a produced file (e.g. exported JSON)
 * - `timing`      — wall-clock/pacing assertions (rate-limit tasks)
 */
export const VERIFY_LAYERS = [
  "static",
  "exec-local",
  "intents",
  "state",
  "answer-file",
  "artifact",
  "timing",
] as const
export type VerifyLayer = (typeof VERIFY_LAYERS)[number]

/**
 * Task ids are either `<stage>-<area>-<nnn>-<slug>` (docs/COVERAGE.md) or the
 * shorter `<family>/<slug>` form used in docs/PLAN.md. Both are accepted; the
 * loader additionally checks the id against the directory it was found in.
 */
export const TASK_ID_RE = /^[a-z0-9]+(?:[-.][a-z0-9]+)*(?:\/[a-z0-9]+(?:[-.][a-z0-9]+)*)*$/

export const LimitsSchema = z
  .object({
    /** Hard wall-clock budget for a single trial, in seconds. */
    time: z.number().positive().default(900),
    /** Soft budget in API-equivalent USD for a single trial. */
    cost: z.number().positive().default(3),
  })
  .strict()

export type Limits = z.infer<typeof LimitsSchema>

export const TaskMetaSchema = z
  .object({
    id: z.string().regex(TASK_ID_RE, "task id must be lowercase kebab/slash-separated"),
    title: z.string().min(1).optional(),
    suite: z.enum(SUITES),
    family: z.enum(FAMILIES),
    stage: z.enum(STAGES),
    topics: z.array(z.string().min(1)).default([]),
    difficulty: z.enum(DIFFICULTIES),
    runtime: z.enum(RUNTIMES).default("offline"),
    fixture: z.enum(FIXTURE_KINDS).default("none"),
    verify: z.array(z.enum(VERIFY_LAYERS)).min(1),
    limits: LimitsSchema.default({ time: 900, cost: 3 }),
    /** Held out of the published suite (contamination detection). */
    holdout: z.boolean().default(false),
    /** Free-form note for task authors; never shown to the agent. */
    notes: z.string().optional(),
  })
  .strict()
  .superRefine((meta, ctx) => {
    // A `live` fixture only makes sense for a `live` runtime, and an offline
    // task can never be verified by live workspace state.
    if (meta.runtime === "offline" && meta.fixture === "live") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fixture"],
        message: "offline tasks cannot use a live fixture",
      })
    }
    if (meta.runtime === "offline" && meta.verify.includes("state")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verify"],
        message: "offline tasks cannot use the `state` verify layer",
      })
    }
  })

export type TaskMeta = z.infer<typeof TaskMetaSchema>
/** Shape accepted on input (before defaults are applied). */
export type TaskMetaInput = z.input<typeof TaskMetaSchema>

/** Parsed form of a `<stage>-<area>-<nnn>-<slug>` id. */
export interface ParsedTaskId {
  stage: Stage
  area: string
  index: number
  slug: string
}

const CONVENTIONAL_ID_RE = /^([a-z]+)-([a-z0-9]+)-(\d{3})-([a-z0-9-]+)$/

/**
 * Parse the `<stage>-<area>-<nnn>-<slug>` convention from docs/COVERAGE.md.
 * Returns `undefined` for ids that do not follow it (e.g. `nac/foo`).
 */
export function parseTaskId(id: string): ParsedTaskId | undefined {
  const m = CONVENTIONAL_ID_RE.exec(id)
  if (!m) return undefined
  const [, stage, area, index, slug] = m
  if (!(STAGES as readonly string[]).includes(stage)) return undefined
  return { stage: stage as Stage, area, index: Number(index), slug }
}

/** Human-readable zod error, one line per issue. */
export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      const path = i.path.length > 0 ? i.path.join(".") : "(root)"
      return `${path}: ${i.message}`
    })
    .join("; ")
}

export class TaskMetaError extends Error {
  constructor(
    message: string,
    readonly source?: string,
  ) {
    super(source ? `${source}: ${message}` : message)
    this.name = "TaskMetaError"
  }
}

/**
 * Validate raw frontmatter data into a `TaskMeta`.
 * Throws `TaskMetaError` with a readable message on failure.
 */
export function parseTaskMeta(data: unknown, source?: string): TaskMeta {
  const result = TaskMetaSchema.safeParse(data)
  if (!result.success) {
    throw new TaskMetaError(formatZodError(result.error), source)
  }
  const meta = result.data
  const parsed = parseTaskId(meta.id)
  if (parsed && parsed.stage !== meta.stage) {
    throw new TaskMetaError(
      `id declares stage "${parsed.stage}" but frontmatter stage is "${meta.stage}"`,
      source,
    )
  }
  return meta
}
