/**
 * QC harness for `runtime: live` tasks — the live counterpart of `_lib/qc.ts`.
 *
 * Same contract, same gate: for every live task the oracle must score 1, a
 * plausibly-wrong solution must score 0, and the null agent must score 0. A task
 * that cannot fail is not a task.
 *
 * The difference is where the workspace lives. An offline task's state is a
 * directory; a live task's state is a Notion workspace. So each variant gets:
 *
 *   1. a fresh in-memory Notion (`fake-notion.ts`) — port 0, no wall clock;
 *   2. `fixture/spec.json` provisioned into it through the *real* provisioning
 *      code path (`provision.ts`), so QC exercises provisioning too;
 *   3. a throwaway copy of `fixture/workspace/` plus the `notionbench.json`
 *      pointer the agent would receive;
 *   4. `live/<variant>.mjs` run as a plain Node script against
 *      `NOTION_API_BASE`, standing in for the agent;
 *   5. the task's `EVAL.ts`, invoked with the same ctx the runner is expected
 *      to pass: `{taskDir, apiBase, token, rootId, idMap}`;
 *   6. teardown — the fixture root is archived, and the assertion that it went
 *      to the trash is itself part of the gate.
 *
 * The `ntn` CLI is deliberately absent: it is a native binary that talks to
 * api.notion.com and cannot be pointed at the fake server. What this proves is
 * that each verifier grades the *end state* correctly. The CLI leg is exercised
 * by real runs. Every task's EVAL.ts header spells out that asymmetry.
 *
 * Nothing here sleeps or reads the wall clock, so the whole gate is a couple of
 * seconds and its output is deterministic.
 *
 * Usage:
 *   node evals/_lib/live/qc-live.ts                        # every live task
 *   node evals/_lib/live/qc-live.ts build-cli-001-…        # one task
 *   node evals/_lib/live/qc-live.ts --variant solution     # one variant
 *   node evals/_lib/live/qc-live.ts --keep                 # keep trial dirs
 */
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { NPM, copyDir, exists, head, run } from "../proc.ts"
import type { EvalResult } from "../types.ts"
import { startFakeNotion, type FakeNotionServer } from "./fake-notion.ts"
import { NotionClient, isTrashed } from "./notion.ts"
import {
  provisionFixture,
  specPathFor,
  teardownFixture,
  writeWorkspacePointer,
  type ProvisionResult,
} from "./provision.ts"
import { loadSpec } from "./spec.ts"

const EVALS_ROOT = path.resolve(import.meta.dirname, "..", "..")
const VARIANTS = ["solution", "wrong", "null"] as const
type Variant = (typeof VARIANTS)[number]

const EXPECTED: Record<Variant, 0 | 1> = { solution: 1, wrong: 0, null: 0 }

const qcRoot = process.env.NOTIONBENCH_QC_LIVE_DIR ?? path.join(os.tmpdir(), "notionbench-qc-live")

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

/**
 * A live task is one with a `fixture/spec.json`.
 *
 * That is also why live tasks keep their oracle under `live/` rather than the
 * conventional `solution/`: `_lib/qc.ts` treats the presence of `solution/` as
 * "this task is ready to grade offline" and would try — and fail — to score a
 * task whose state lives in a Notion workspace. Keeping the two gates disjoint
 * by directory name means neither has to know about the other.
 */
async function findLiveTasks(): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fs.readdir(EVALS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "_lib") continue
    const dir = path.join(EVALS_ROOT, entry.name)
    if (!(await exists(path.join(dir, "PROMPT.md")))) continue
    if (await exists(specPathFor(dir))) out.push(dir)
  }
  return out.sort()
}

/** `live/<variant>.mjs`, or the `<variant>/solve.mjs` layout, whichever exists. */
async function oracleScript(taskDir: string, variant: Variant): Promise<string | undefined> {
  for (const candidate of [
    path.join(taskDir, "live", `${variant}.mjs`),
    path.join(taskDir, variant, "solve.mjs"),
  ]) {
    if (await exists(candidate)) return candidate
  }
  return undefined
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
  /** Requests the fake server saw — a cheap "did it paginate?" signal. */
  apiCalls: number
}

/**
 * One `npm install` per task, shared by its three variants — the same warm
 * cache `_lib/qc.ts` keeps, because a *live* task can also ship a code
 * workspace (the Workers tasks provision a Notion fixture *and* hand the agent
 * the worker template). Tasks whose `fixture/workspace/` has no package.json —
 * every CLI task — never reach this and are unaffected.
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

async function runVariant(taskDir: string, variant: Variant, keep: boolean): Promise<Check> {
  const task = path.basename(taskDir)
  const started = Date.now()
  const base: Omit<Check, "actual" | "ok" | "ms" | "apiCalls"> = {
    task,
    variant,
    expected: EXPECTED[variant],
  }

  let server: FakeNotionServer | undefined
  let trial: string | undefined
  let fixture: ProvisionResult | undefined
  try {
    // ---- 1. a private Notion -----------------------------------------------
    server = await startFakeNotion()
    const client = new NotionClient({ auth: server.token, baseUrl: server.url })

    // ---- 2. the fixture ----------------------------------------------------
    const spec = await loadSpec(specPathFor(taskDir))
    fixture = await provisionFixture({
      spec,
      client,
      parentPageId: server.parentPageId,
    })

    // ---- 3. the trial workspace --------------------------------------------
    trial = path.join(qcRoot, task, variant)
    await fs.rm(trial, { recursive: true, force: true })
    await fs.mkdir(trial, { recursive: true })
    const fixtureWorkspace = path.join(taskDir, "fixture", "workspace")
    if (await exists(fixtureWorkspace)) {
      await copyDir(fixtureWorkspace, trial)
      const modules = await warmDeps(taskDir, fixtureWorkspace)
      if (modules) await fs.symlink(modules, path.join(trial, "node_modules"), "dir")
    }
    await writeWorkspacePointer(trial, fixture)

    const scriptEnv: NodeJS.ProcessEnv = {
      NOTION_API_BASE: server.url,
      NOTION_API_TOKEN: server.token,
      NOTION_PARENT_PAGE_ID: server.parentPageId,
      NOTIONBENCH_ROOT_ID: fixture.rootId,
      NOTIONBENCH_ID_MAP: JSON.stringify(fixture.idMap),
    }

    // ---- 4. the stand-in for the agent -------------------------------------
    if (variant !== "null") {
      const script = await oracleScript(taskDir, variant)
      if (!script) throw new Error(`${task}: no live/${variant}.mjs`)
      const result = await run(process.execPath, [script], {
        cwd: trial,
        env: scriptEnv,
        timeoutMs: 120_000,
      })
      if (result.code !== 0) {
        throw new Error(
          `live/${variant}.mjs exited ${result.code}:\n${head(result.stderr || result.stdout, 15)}`,
        )
      }
    }

    // ---- 5. the verifier ---------------------------------------------------
    const mod = (await import(path.join(taskDir, "EVAL.ts"))) as {
      default: (args: { workspaceDir: string; ctx?: Record<string, unknown> }) => Promise<EvalResult>
    }
    const before = server.requests.length
    const result = await mod.default({
      workspaceDir: trial,
      ctx: {
        taskDir,
        apiBase: server.url,
        token: server.token,
        rootId: fixture.rootId,
        idMap: fixture.idMap,
      },
    })
    const apiCalls = server.requests.length - before

    // ---- 6. teardown is part of the gate -----------------------------------
    const torn = await teardownFixture(client, fixture.rootId)
    if (!torn.ok) throw new Error(`teardown failed: ${torn.error}`)
    const root = await client.getPage(fixture.rootId)
    if (!isTrashed(root)) throw new Error("teardown did not put the fixture root in the trash")
    fixture = undefined

    const actual = result.score
    return { ...base, actual, ok: actual === EXPECTED[variant], result, ms: Date.now() - started, apiCalls }
  } catch (err) {
    return {
      ...base,
      actual: "error",
      ok: false,
      error: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err),
      ms: Date.now() - started,
      apiCalls: 0,
    }
  } finally {
    await server?.close()
    if (!keep && trial) await fs.rm(trial, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const all = await findLiveTasks()
  const tasks =
    args.tasks.length === 0
      ? all
      : args.tasks.map((t) => {
          const dir = all.find((d) => path.basename(d) === t || d === path.resolve(t))
          if (!dir) throw new Error(`no such live task: ${t}`)
          return dir
        })

  if (tasks.length === 0) {
    console.log("no live tasks found under evals/ (a live task is one with fixture/spec.json)")
    process.exitCode = 1
    return
  }

  const checks: Check[] = []
  for (const taskDir of tasks) {
    console.log(`\n── ${path.basename(taskDir)}`)
    for (const variant of args.variants) {
      const check = await runVariant(taskDir, variant, args.keep)
      checks.push(check)
      const status = check.ok ? "PASS" : "FAIL"
      const detail = check.actual === "error" ? "threw" : `score=${check.actual}`
      console.log(
        `   ${status}  ${variant.padEnd(8)} expected ${check.expected}, ${detail}` +
          `  (${(check.ms / 1000).toFixed(1)}s, ${check.apiCalls} verifier API calls)`,
      )
      const sub = check.result?.subscores
      if (sub && Object.keys(sub).length > 0) {
        console.log(`          subscores: ${Object.entries(sub).map(([k, v]) => `${k}=${v}`).join(" ")}`)
      }
      const verbose = process.env.NOTIONBENCH_QC_VERBOSE === "1"
      if (!check.ok || verbose) {
        for (const line of check.result?.diagnostics ?? []) {
          console.log(`          ${line.split("\n").join("\n          ")}`)
        }
        if (check.error) console.log(`          ERROR ${head(check.error, 12)}`)
      }
    }
  }

  const failed = checks.filter((c) => !c.ok)
  console.log(
    `\n${checks.length - failed.length}/${checks.length} live checks green` +
      (args.keep ? ` (trials kept under ${qcRoot})` : ""),
  )
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAIL ${f.task} / ${f.variant}`)
    process.exitCode = 1
    return
  }
  if (checks.length === 0) {
    console.log("  no live task ran — refusing to report a green gate")
    process.exitCode = 1
  }
}

await main()
