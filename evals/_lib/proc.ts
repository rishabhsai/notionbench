/**
 * Small process / filesystem helpers shared by the offline verifiers.
 *
 * Everything here is dependency-free so an `EVAL.ts` can be executed with a
 * bare `node evals/<id>/EVAL.ts` (Node >= 22.18 strips the types natively).
 */
import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import * as path from "node:path"

export interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** True when the process was killed by the timeout. */
  timedOut: boolean
}

export interface RunOptions {
  cwd: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

/** Run a command, capturing output. Never throws on a non-zero exit. */
export function run(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 180_000
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, ...opts.env },
        // npm/npx are shell scripts on some platforms; keep shell off and rely
        // on the resolved binary so argument quoting stays exact.
        shell: false,
      },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; signal?: NodeJS.Signals }) | null
        resolve({
          code: typeof e?.code === "number" ? e.code : e ? 1 : 0,
          signal: e?.signal ?? null,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          timedOut: e?.signal === "SIGTERM" && Boolean(e),
        })
      },
    )
    child.on("error", () => {
      /* resolved by the callback */
    })
  })
}

/** `npm` resolves through the shell on Windows; on POSIX this is enough. */
export const NPM = process.platform === "win32" ? "npm.cmd" : "npm"
export const NPX = process.platform === "win32" ? "npx.cmd" : "npx"

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * Recursively copy `src` into `dst`, creating `dst` if needed.
 * Skips `node_modules`, `dist`, and VCS metadata so fixtures stay lean.
 */
export async function copyDir(src: string, dst: string, skip = SKIP_DEFAULT): Promise<void> {
  await fs.mkdir(dst, { recursive: true })
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue
    const from = path.join(src, entry.name)
    const to = path.join(dst, entry.name)
    if (entry.isDirectory()) await copyDir(from, to, skip)
    else if (entry.isSymbolicLink()) await fs.symlink(await fs.readlink(from), to)
    else await fs.copyFile(from, to)
  }
}

export const SKIP_DEFAULT = new Set(["node_modules", "dist", ".git", ".DS_Store"])

/**
 * Install dependencies if `node_modules` is missing.
 *
 * Trials are expected to arrive pre-installed (the runner warms the fixture),
 * but QC and one-off local scoring runs need this fallback.
 */
export async function ensureDeps(
  dir: string,
  timeoutMs = 300_000,
): Promise<{ installed: boolean; result?: RunResult }> {
  if (await exists(path.join(dir, "node_modules"))) return { installed: false }
  const result = await run(NPM, ["install", "--no-audit", "--no-fund"], { cwd: dir, timeoutMs })
  return { installed: true, result }
}

export async function readJson<T = unknown>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, "utf8")) as T
}

/** First `n` lines of a blob, for diagnostics that must stay readable. */
export function head(text: string, n = 20): string {
  const lines = text.trimEnd().split("\n")
  return lines.length <= n ? lines.join("\n") : `${lines.slice(0, n).join("\n")}\n… (+${lines.length - n} lines)`
}
