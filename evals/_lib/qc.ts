/**
 * Task QC harness (docs/PLAN.md, "QC per task (CI-enforced)").
 *
 * For every task it materializes a throwaway trial workspace, overlays one of
 *
 *   solution/  the oracle           — must score 1
 *   wrong/     a plausible mistake  — must score 0
 *   (nothing)  the null agent       — must score 0
 *
 * runs the task's EVAL.ts against it, and prints PASS/FAIL. Any deviation from
 * the expected outcome exits non-zero, so this doubles as the CI gate.
 *
 * Usage:
 *   node evals/_lib/qc.ts                      # every task, every variant
 *   node evals/_lib/qc.ts build-nac-001-…      # one task
 *   node evals/_lib/qc.ts --variant solution   # one variant
 *   node evals/_lib/qc.ts --keep               # keep trial dirs for inspection
 *
 * Dependencies are installed once per task into a warm cache and symlinked into
 * each trial, so the three variants of a task share one `npm install`.
 *
 * `runtime: live` tasks are skipped here and gated by `_lib/live/qc-live.ts`
 * (`pnpm --filter @notionbench/evals run qc:live`) instead: their state lives in
 * a Notion workspace rather than a directory, so the same three-variant contract
 * needs a provisioned fixture and an API to inspect. Both gates run in CI.
 */
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { NPM, copyDir, exists, head, run } from "./proc.ts"
import type { EvalResult } from "./types.ts"

const EVALS_ROOT = path.resolve(import.meta.dirname, "..")
const VARIANTS = ["solution", "wrong", "null"] as const
type Variant = (typeof VARIANTS)[number]

const EXPECTED: Record<Variant, 0 | 1> = { solution: 1, wrong: 0, null: 0 }

interface Args {
  tasks: string[]
  variants: Variant[]
  keep: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { tasks: [], variants: [...VARIANTS], keep: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--keep") args.keep = true
    else if (a === "--variant") {
      const v = argv[++i] as Variant
      if (!VARIANTS.includes(v)) throw new Error(`unknown variant: ${v}`)
      args.variants = [v]
    } else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`)
    else args.tasks.push(a)
  }
  return args
}

/** Task directories are the ones holding a PROMPT.md. */
async function findTasks(): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fs.readdir(EVALS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "_lib") continue
    const dir = path.join(EVALS_ROOT, entry.name)
    if (await exists(path.join(dir, "PROMPT.md"))) out.push(dir)
  }
  return out.sort()
}

/**
 * A task is QC-able once it has an oracle. Tasks mid-authoring (PROMPT.md and
 * fixture written, `solution/` not yet) are reported as skipped rather than
 * failing the gate — but they are *printed*, so "the suite is green" can never
 * quietly mean "nothing ran".
 */
async function isQcable(taskDir: string): Promise<boolean> {
  return exists(path.join(taskDir, "solution"))
}

/**
 * A `runtime: live` task also has no `solution/` — its oracle is `live/*.mjs`
 * and its starting state is a Notion workspace, not a directory — so this gate
 * skips it too. Saying "still being authored" about a finished, gated task
 * would be a lie that hides a real gate, hence the separate message: live tasks
 * are covered by `qc:live` (`_lib/live/qc-live.ts`), which runs the identical
 * oracle=1 / wrong=0 / null=0 contract against an in-process fake Notion.
 */
async function isLiveTask(taskDir: string): Promise<boolean> {
  if (await exists(path.join(taskDir, "fixture", "spec.json"))) return true
  try {
    const prompt = await fs.readFile(path.join(taskDir, "PROMPT.md"), "utf8")
    return /^runtime:\s*live\s*$/m.test(prompt.split(/^---\s*$/m)[1] ?? "")
  } catch {
    return false
  }
}

const qcRoot = process.env.NOTIONBENCH_QC_DIR ?? path.join(os.tmpdir(), "notionbench-qc")

/**
 * One `npm install` per task, reused by all variants. The fixture is copied in
 * so the install matches its package.json/lockfile exactly.
 */
async function warmDeps(taskDir: string, fixtureWorkspace: string): Promise<string | undefined> {
  if (!(await exists(path.join(fixtureWorkspace, "package.json")))) return undefined
  const cache = path.join(qcRoot, path.basename(taskDir), "_deps")
  const modules = path.join(cache, "node_modules")
  if (await exists(modules)) return modules
  await fs.mkdir(cache, { recursive: true })
  await copyDir(fixtureWorkspace, cache)
  const result = await run(NPM, ["install", "--no-audit", "--no-fund"], { cwd: cache, timeoutMs: 600_000 })
  if (result.code !== 0) {
    throw new Error(`npm install failed for ${path.basename(taskDir)}:\n${head(result.stderr || result.stdout)}`)
  }
  return modules
}

async function materialize(
  taskDir: string,
  variant: Variant,
  fixtureWorkspace: string,
  modules: string | undefined,
): Promise<string> {
  const trial = path.join(qcRoot, path.basename(taskDir), variant)
  await fs.rm(trial, { recursive: true, force: true })
  await fs.mkdir(trial, { recursive: true })
  await copyDir(fixtureWorkspace, trial)
  if (variant !== "null") {
    const overlay = path.join(taskDir, variant)
    if (!(await exists(overlay))) throw new Error(`${path.basename(taskDir)}: missing ${variant}/`)
    await copyDir(overlay, trial)
  }
  if (modules) await fs.symlink(modules, path.join(trial, "node_modules"), "dir")
  return trial
}

interface Check {
  task: string
  variant: Variant
  expected: 0 | 1
  actual: 0 | 1 | "error"
  ok: boolean
  result?: EvalResult
  error?: string
  ms: number
}

async function runVariant(taskDir: string, variant: Variant, keep: boolean): Promise<Check> {
  const task = path.basename(taskDir)
  const started = Date.now()
  const base: Omit<Check, "actual" | "ok" | "ms"> = { task, variant, expected: EXPECTED[variant] }
  let trial: string | undefined
  try {
    const fixtureWorkspace = path.join(taskDir, "fixture", "workspace")
    if (!(await exists(fixtureWorkspace))) throw new Error("missing fixture/workspace")
    const modules = await warmDeps(taskDir, fixtureWorkspace)
    trial = await materialize(taskDir, variant, fixtureWorkspace, modules)

    const mod = (await import(path.join(taskDir, "EVAL.ts"))) as {
      default: (args: { workspaceDir: string; ctx?: Record<string, unknown> }) => Promise<EvalResult>
    }
    const result = await mod.default({ workspaceDir: trial, ctx: { taskDir } })
    const actual = result.score
    return { ...base, actual, ok: actual === EXPECTED[variant], result, ms: Date.now() - started }
  } catch (err) {
    return {
      ...base,
      actual: "error",
      ok: false,
      error: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err),
      ms: Date.now() - started,
    }
  } finally {
    if (!keep && trial) await fs.rm(trial, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const all = await findTasks()
  const tasks =
    args.tasks.length === 0
      ? all
      : args.tasks.map((t) => {
          const dir = all.find((d) => path.basename(d) === t || d === path.resolve(t))
          if (!dir) throw new Error(`no such task: ${t}`)
          return dir
        })
  if (tasks.length === 0) {
    console.log("no tasks found under evals/")
    return
  }

  const checks: Check[] = []
  const skipped: string[] = []
  /** Live tasks: skipped here, but gated — reported separately from "unfinished". */
  const live: string[] = []
  for (const taskDir of tasks) {
    console.log(`\n── ${path.basename(taskDir)}`)
    if (!(await isQcable(taskDir))) {
      if (await isLiveTask(taskDir)) {
        live.push(path.basename(taskDir))
        console.log(
          "   SKIP  runtime: live — graded against a real workspace by" +
            " `pnpm --filter @notionbench/evals run qc:live`",
        )
      } else {
        skipped.push(path.basename(taskDir))
        console.log("   SKIP  no solution/ — task is still being authored")
      }
      continue
    }
    for (const variant of args.variants) {
      const check = await runVariant(taskDir, variant, args.keep)
      checks.push(check)
      const status = check.ok ? "PASS" : "FAIL"
      const detail = check.actual === "error" ? "threw" : `score=${check.actual}`
      console.log(
        `   ${status}  ${variant.padEnd(8)} expected ${check.expected}, ${detail}  (${(check.ms / 1000).toFixed(1)}s)`,
      )
      const sub = check.result?.subscores
      if (sub && Object.keys(sub).length > 0) {
        console.log(`          subscores: ${Object.entries(sub).map(([k, v]) => `${k}=${v}`).join(" ")}`)
      }
      const showDiagnostics = !check.ok || process.env.NOTIONBENCH_QC_VERBOSE === "1"
      if (showDiagnostics) {
        for (const line of check.result?.diagnostics ?? []) {
          console.log(`          ${line.split("\n").join("\n          ")}`)
        }
        if (check.error) console.log(`          ERROR ${head(check.error, 12)}`)
      }
    }
  }

  const failed = checks.filter((c) => !c.ok)
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks green` +
      (skipped.length > 0 ? `, ${skipped.length} task(s) skipped: ${skipped.join(", ")}` : "") +
      (live.length > 0 ? `, ${live.length} live task(s) deferred to qc:live: ${live.join(", ")}` : "") +
      (args.keep ? ` (trials kept under ${qcRoot})` : ""),
  )
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAIL ${f.task} / ${f.variant}`)
    process.exitCode = 1
    return
  }
  // A gate that passes because it checked nothing is worse than no gate: fail
  // loudly if a selection matched no runnable task.
  if (checks.length === 0) {
    console.log(
      live.length > 0 && skipped.length === 0
        ? "  every selected task is live — run `pnpm --filter @notionbench/evals run qc:live` instead"
        : "  no QC-able task ran — refusing to report a green gate",
    )
    process.exitCode = 1
  }
}

await main()
