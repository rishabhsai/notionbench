/**
 * Running a task's verifier.
 *
 * Every `evals/<id>/EVAL.ts` default-exports `async ({workspaceDir, ctx}) =>
 * {score, subscores, diagnostics}`. This module runs one in a child process and
 * turns "the verifier said 0" and "the verifier fell over" into two clearly
 * different outcomes — `ok` — because only the first is a statement about the
 * agent. Everything the aggregator later averages depends on that distinction.
 *
 * See `eval-harness.ts` for why it is a subprocess and how the result travels.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

/** Default file inside a task directory holding the verifier. */
export const EVAL_FILENAME = "EVAL.ts"

/** 10 minutes: a NAC verifier may `npm install` and `npm run build` a fixture. */
export const DEFAULT_SCORE_TIMEOUT_MS = 600_000

/** Bytes of child output retained for the failure report. */
const MAX_CAPTURED_BYTES = 256 * 1024

export interface RunTaskScorerOptions {
  /** Absolute path to the task directory (the one holding PROMPT.md and EVAL.ts). */
  taskDir: string
  /** Absolute path to the trial workspace to score. */
  workspaceDir: string
  /** Extra `EvalContext` entries (trial index, config id, …). `taskDir` is added for free. */
  ctx?: Record<string, unknown>
  /** Wall-clock budget for the whole verification. Default 10 min. */
  timeoutMs?: number
  /** Grace period between SIGTERM and SIGKILL. Default 5s. */
  killGraceMs?: number
  /** Verifier filename inside `taskDir`. Default `EVAL.ts`. */
  evalFilename?: string
  /** Node binary to run the harness with. Default `process.execPath`. */
  nodeExecPath?: string
  /**
   * Extra argv for Node itself. Type stripping is on by default from Node
   * 22.18, so this is normally empty; `--experimental-strip-types` is added
   * automatically on one retry if the child says it needs it.
   */
  nodeArgs?: string[]
  /** Env for the child. Defaults to the parent's. */
  env?: NodeJS.ProcessEnv
  /** Cancel an in-flight verification (run-level shutdown). */
  signal?: AbortSignal
}

export interface TaskScore {
  /** Verified outcome in [0,1]. Meaningless unless `ok`. */
  score: number
  /** Per-criterion breakdown; reported, never aggregated. */
  subscores: Record<string, number>
  /** Ordered, human-readable evidence for the score. */
  diagnostics: string[]
}

export interface TaskScoreResult extends TaskScore {
  /**
   * True when the verifier ran to completion and returned a well-formed result.
   * `ok:false` with `score:0` is "we do not know", NOT "the agent failed" —
   * callers must not fold it into an average without saying so.
   */
  ok: boolean
  /** Why the verification could not be trusted. Set iff `!ok`. */
  error?: string
  durationMs: number
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  /** The exact child invocation, for the run log. */
  command: string
  /** Tail of the child's stdout/stderr, capped. Failure evidence. */
  stdout: string
  stderr: string
}

/** stderr shapes meaning "this Node cannot import a .ts file as-is". */
const NEEDS_STRIP_TYPES = /ERR_UNKNOWN_FILE_EXTENSION|Unknown file extension "\.ts"|strip-types/i

export class ScorerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ScorerError"
  }
}

/** True when the task directory has a verifier to run. */
export async function hasScorer(taskDir: string, evalFilename = EVAL_FILENAME): Promise<boolean> {
  try {
    return (await stat(path.join(taskDir, evalFilename))).isFile()
  } catch {
    return false
  }
}

/**
 * Run one task's verifier against one trial workspace.
 *
 * Never throws for a verifier-side problem — a missing EVAL.ts, a crash, a
 * timeout and a malformed return value all come back as `ok:false` so a single
 * bad cell cannot abort a grid.
 */
export async function runTaskScorer(opts: RunTaskScorerOptions): Promise<TaskScoreResult> {
  const started = Date.now();
  const evalFilename = opts.evalFilename ?? EVAL_FILENAME
  const evalPath = path.join(opts.taskDir, evalFilename)

  if (!(await hasScorer(opts.taskDir, evalFilename))) {
    return {
      ok: false,
      score: 0,
      subscores: {},
      diagnostics: [],
      error: `no verifier at ${evalPath}`,
      durationMs: Date.now() - started,
      exitCode: null,
      signal: null,
      timedOut: false,
      command: "",
      stdout: "",
      stderr: "",
    }
  }

  const scratch = await mkdtemp(path.join(os.tmpdir(), "notionbench-score-"))
  const requestPath = path.join(scratch, "request.json")
  const responsePath = path.join(scratch, "response.json")
  try {
    await writeFile(
      requestPath,
      JSON.stringify({
        taskDir: opts.taskDir,
        workspaceDir: opts.workspaceDir,
        evalFilename,
        ctx: opts.ctx ?? {},
      }),
      "utf8",
    )

    let attempt = await spawnHarness(opts, requestPath, responsePath, opts.nodeArgs ?? [])
    // Older Node (< 22.18) needs to be told it may strip types. Retry once
    // rather than making every caller know which Node the operator has.
    if (
      !attempt.responded &&
      (opts.nodeArgs ?? []).length === 0 &&
      NEEDS_STRIP_TYPES.test(attempt.stderr)
    ) {
      attempt = await spawnHarness(opts, requestPath, responsePath, ["--experimental-strip-types"])
    }

    const base = {
      durationMs: Date.now() - started,
      exitCode: attempt.exitCode,
      signal: attempt.signal,
      timedOut: attempt.timedOut,
      command: attempt.command,
      stdout: attempt.stdout,
      stderr: attempt.stderr,
    }

    if (attempt.responded) {
      const r = attempt.responded
      return {
        ok: r.ok,
        score: r.score,
        subscores: r.subscores,
        diagnostics: r.diagnostics,
        error: r.ok ? undefined : (r.error ?? "verifier reported a failure"),
        ...base,
      }
    }

    return {
      ok: false,
      score: 0,
      subscores: {},
      diagnostics: [],
      error: describeFailure(attempt),
      ...base,
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

interface HarnessAttempt {
  /** Parsed response, when the harness managed to write one. */
  responded?: TaskScore & { ok: boolean; error?: string }
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  stdout: string
  stderr: string
  command: string
  spawnError?: string
}

function describeFailure(a: HarnessAttempt): string {
  if (a.spawnError) return `could not start the verifier: ${a.spawnError}`
  if (a.timedOut) return "verifier exceeded its time budget"
  if (a.aborted) return "verification was cancelled"
  const tail = (a.stderr || a.stdout).trim().split("\n").slice(-15).join("\n")
  return `verifier exited ${a.exitCode ?? `on ${a.signal}`} without a result${tail ? `:\n${tail}` : ""}`
}

/**
 * Absolute path to the harness, resolved next to this module.
 *
 * `dist/eval-harness.js` in a built package; `src/eval-harness.ts` when the
 * package is being run straight from source (vitest, `node --run` from a
 * checkout). Node loads either.
 */
async function harnessPath(): Promise<string> {
  const compiled = fileURLToPath(new URL("./eval-harness.js", import.meta.url))
  try {
    await stat(compiled)
    return compiled
  } catch {
    return fileURLToPath(new URL("./eval-harness.ts", import.meta.url))
  }
}

async function spawnHarness(
  opts: RunTaskScorerOptions,
  requestPath: string,
  responsePath: string,
  nodeArgs: string[],
): Promise<HarnessAttempt> {
  const node = opts.nodeExecPath ?? process.execPath
  const args = [...nodeArgs, await harnessPath(), requestPath, responsePath]
  const command = [node, ...args].join(" ")
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SCORE_TIMEOUT_MS
  const killGraceMs = opts.killGraceMs ?? 5_000

  let stdout = ""
  let stderr = ""
  let timedOut = false
  let aborted = false
  let spawnError: string | undefined
  let child: ChildProcess | undefined

  try {
    child = spawn(node, args, {
      // The workspace is the natural cwd, but a verifier is given absolute
      // paths and may delete its workspace; run from the task dir instead.
      cwd: opts.taskDir,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group: a verifier's `npm run build` grandchildren die with
      // it on timeout instead of being orphaned onto the operator's machine.
      detached: true,
      windowsHide: true,
    })
  } catch (err) {
    spawnError = (err as Error).message
  }

  let exitCode: number | null = null
  let exitSignal: NodeJS.Signals | null = null

  if (child && !spawnError) {
    const c = child
    c.stdout?.setEncoding("utf8")
    c.stderr?.setEncoding("utf8")
    c.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_CAPTURED_BYTES) stdout += chunk
    })
    c.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_CAPTURED_BYTES) stderr += chunk
    })

    let graceTimer: NodeJS.Timeout | undefined
    const stop = (): void => {
      killTree(c, "SIGTERM")
      graceTimer = setTimeout(() => killTree(c, "SIGKILL"), killGraceMs)
    }
    const onAbort = (): void => {
      aborted = true
      stop()
    }
    const killTimer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
    opts.signal?.addEventListener("abort", onAbort, { once: true })

    await new Promise<void>((resolve) => {
      c.on("error", (err) => {
        spawnError = err.message
        resolve()
      })
      c.on("close", (code, signal) => {
        exitCode = code
        exitSignal = signal
        resolve()
      })
    })

    clearTimeout(killTimer)
    if (graceTimer) clearTimeout(graceTimer)
    opts.signal?.removeEventListener("abort", onAbort)
  }

  let responded: HarnessAttempt["responded"]
  try {
    const raw = JSON.parse(await readFile(responsePath, "utf8")) as HarnessAttempt["responded"]
    if (raw && typeof raw.score === "number") responded = raw
  } catch {
    /* no response file: the failure is described from the exit instead */
  }

  return {
    responded,
    exitCode,
    signal: exitSignal,
    timedOut,
    aborted,
    stdout: tail(stdout),
    stderr: tail(stderr),
    command,
    spawnError,
  }
}

function tail(text: string, max = MAX_CAPTURED_BYTES): string {
  return text.length <= max ? text : `…\n${text.slice(text.length - max)}`
}

/** Kill the child's whole process group, falling back to the child alone. */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }
}
