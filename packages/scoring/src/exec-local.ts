/**
 * Offline drivers used by the behavioural verification layer.
 *
 * - `execLocal()` runs `ntn workers exec <key> -d '<json>' --local --json`
 *   inside a candidate project and parses the JSON the CLI writes to stdout.
 *   stdout and stderr are captured separately: the CLI logs progress to stderr,
 *   so mixing them would corrupt the payload.
 * - `runBuild()` runs a Notion-as-Code project's `npm run build` and returns the
 *   path to the compiled `dist/intents.json` for canonical comparison.
 *
 * Neither helper uses a shell, so task inputs are never word-split or expanded.
 */
import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import * as path from "node:path"

export interface RunCommandOptions {
  cwd: string
  /** Milliseconds before the child is killed (default 60_000). */
  timeoutMs?: number
  /** Extra environment; merged over `process.env` unless `replaceEnv` is set. */
  env?: NodeJS.ProcessEnv
  replaceEnv?: boolean
  /** Written to the child's stdin, then closed. */
  stdin?: string
  /** Max bytes retained per stream (default 8 MiB). */
  maxBuffer?: number
}

export interface RunCommandResult {
  command: string
  args: string[]
  cwd: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
  /** Set when the binary could not be spawned at all (e.g. ENOENT). */
  spawnError?: string
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024

/** Spawn a command (no shell), capturing stdout/stderr separately. */
export function runCommand(
  command: string,
  args: string[],
  opts: RunCommandOptions,
): Promise<RunCommandResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER
  const env = opts.replaceEnv ? { ...opts.env } : { ...process.env, ...opts.env }
  const started = Date.now()

  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      // escalate if the child ignores SIGTERM
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000)
      killTimer.unref?.()
    }, timeoutMs)
    timer.unref?.()

    const finish = (result: Omit<RunCommandResult, "command" | "args" | "cwd" | "durationMs">) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve({
        command,
        args,
        cwd: opts.cwd,
        durationMs: Date.now() - started,
        ...result,
      })
    }

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < maxBuffer) stdout += chunk
    })
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < maxBuffer) stderr += chunk
    })
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        timedOut,
        spawnError: `${err.code ?? "ERROR"}: ${err.message}`,
      })
    })
    child.on("close", (code, signal) => {
      finish({ exitCode: code, signal, stdout, stderr, timedOut })
    })

    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin)
    else child.stdin?.end()
  })
}

// ---------------------------------------------------------------------------
// ntn workers exec --local
// ---------------------------------------------------------------------------

export interface ExecLocalOptions extends RunCommandOptions {
  /** Binary to invoke; defaults to `ntn` resolved from PATH. */
  command?: string
  /** Extra CLI flags appended after the standard ones. */
  extraArgs?: string[]
}

export interface ExecLocalResult extends RunCommandResult {
  /** True when the CLI exited 0, was not killed, and printed parseable JSON. */
  ok: boolean
  /** Parsed stdout payload; undefined when parsing failed. */
  output?: unknown
  /** Why parsing failed, when it did. */
  parseError?: string
}

/**
 * Run one tool/handler of a Workers project locally:
 * `ntn workers exec <key> -d '<json>' --local --json`.
 */
export async function execLocal(
  key: string,
  input: unknown,
  opts: ExecLocalOptions,
): Promise<ExecLocalResult> {
  const command = opts.command ?? "ntn"
  const args = [
    "workers",
    "exec",
    key,
    "-d",
    JSON.stringify(input ?? {}),
    "--local",
    "--json",
    ...(opts.extraArgs ?? []),
  ]
  const result = await runCommand(command, args, opts)
  if (result.spawnError || result.timedOut || result.exitCode !== 0) {
    return { ...result, ok: false }
  }
  const parsed = parseJsonStdout(result.stdout)
  if ("error" in parsed) {
    return { ...result, ok: false, parseError: parsed.error }
  }
  return { ...result, ok: true, output: parsed.value }
}

/**
 * Extract the JSON payload from a CLI's stdout. Tolerates leading/trailing
 * noise: tries the whole buffer, then each trailing line, then the first
 * balanced `{...}` / `[...]` block.
 */
export function parseJsonStdout(stdout: string): { value: unknown } | { error: string } {
  const text = stdout.trim()
  if (text.length === 0) return { error: "no output on stdout" }

  const whole = tryParse(text)
  if (whole) return whole

  const lines = text.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line.length === 0) continue
    const parsed = tryParse(line)
    if (parsed) return parsed
  }

  const start = firstJsonIndex(text)
  if (start >= 0) {
    for (let end = text.length; end > start; end--) {
      const parsed = tryParse(text.slice(start, end))
      if (parsed) return parsed
    }
  }
  return { error: `stdout is not JSON: ${truncate(text, 200)}` }
}

function tryParse(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) }
  } catch {
    return undefined
  }
}

function firstJsonIndex(text: string): number {
  const brace = text.indexOf("{")
  const bracket = text.indexOf("[")
  if (brace < 0) return bracket
  if (bracket < 0) return brace
  return Math.min(brace, bracket)
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`
}

// ---------------------------------------------------------------------------
// Notion-as-Code build
// ---------------------------------------------------------------------------

export interface RunBuildOptions extends RunCommandOptions {
  /** Package manager binary (default `npm`). */
  command?: string
  /** Arguments (default `["run", "build"]`). */
  args?: string[]
  /** Build output to look for, relative to `cwd` (default `dist/intents.json`). */
  intentsPath?: string
}

export interface RunBuildResult extends RunCommandResult {
  /** True when the build exited 0 and produced the intents file. */
  ok: boolean
  /** Absolute path to `dist/intents.json`; undefined when it was not produced. */
  intentsPath?: string
  /** Why the build is not usable, when it is not. */
  failure?: string
}

/** Compile a Notion-as-Code project and locate its `dist/intents.json`. */
export async function runBuild(cwd: string, opts: Partial<RunBuildOptions> = {}): Promise<RunBuildResult> {
  const command = opts.command ?? "npm"
  const args = opts.args ?? ["run", "build"]
  const relative = opts.intentsPath ?? path.join("dist", "intents.json")
  const result = await runCommand(command, args, {
    ...opts,
    cwd,
    timeoutMs: opts.timeoutMs ?? 300_000,
  })

  if (result.spawnError) return { ...result, ok: false, failure: result.spawnError }
  if (result.timedOut) return { ...result, ok: false, failure: "build timed out" }
  if (result.exitCode !== 0) {
    return { ...result, ok: false, failure: `build exited with code ${result.exitCode}` }
  }

  const intentsPath = path.resolve(cwd, relative)
  try {
    const stat = await fs.stat(intentsPath)
    if (!stat.isFile()) throw new Error("not a file")
  } catch {
    return { ...result, ok: false, failure: `build produced no ${relative}` }
  }
  return { ...result, ok: true, intentsPath }
}

/** Read and JSON-parse a built intents file. */
export async function readIntentsFile(intentsPath: string): Promise<unknown> {
  const text = await fs.readFile(intentsPath, "utf8")
  return JSON.parse(text)
}
