import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { hasScorer, runTaskScorer } from "../src/run-eval.js"

const roots: string[] = []

async function makeTask(name: string, evalSource: string, filename = "EVAL.ts"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `nb-eval-${name}-`))
  roots.push(root)
  const taskDir = path.join(root, name)
  await mkdir(path.join(taskDir, "workspace"), { recursive: true })
  if (evalSource.length > 0) await writeFile(path.join(taskDir, filename), evalSource, "utf8")
  return taskDir
}

function workspaceOf(taskDir: string): string {
  return path.join(taskDir, "workspace")
}

afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
})

describe("hasScorer", () => {
  it("is true when the task has an EVAL.ts", async () => {
    const taskDir = await makeTask("present", "export default async () => ({ score: 1, diagnostics: [] })")
    expect(await hasScorer(taskDir)).toBe(true)
  })

  it("is false when it does not", async () => {
    const taskDir = await makeTask("absent", "")
    expect(await hasScorer(taskDir)).toBe(false)
  })
})

describe("runTaskScorer", () => {
  it("returns the verifier's score, subscores and diagnostics", async () => {
    const taskDir = await makeTask(
      "happy",
      `export default async () => ({
         score: 1,
         subscores: { build: 1, canonical: 1 },
         diagnostics: ["build ok", "canonical match"],
       })`,
    )
    const result = await runTaskScorer({ taskDir, workspaceDir: workspaceOf(taskDir) })
    expect(result.ok).toBe(true)
    expect(result.score).toBe(1)
    expect(result.subscores).toEqual({ build: 1, canonical: 1 })
    expect(result.diagnostics).toEqual(["build ok", "canonical match"])
    expect(result.exitCode).toBe(0)
    expect(result.error).toBeUndefined()
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("hands the verifier the workspace and the task dir", async () => {
    const taskDir = await makeTask(
      "args",
      `export default async ({ workspaceDir, ctx }) => ({
         score: 0,
         diagnostics: [workspaceDir, String(ctx.taskDir), String(ctx.trial)],
       })`,
    )
    const result = await runTaskScorer({
      taskDir,
      workspaceDir: workspaceOf(taskDir),
      ctx: { trial: 3 },
    })
    expect(result.ok).toBe(true)
    expect(result.diagnostics).toEqual([workspaceOf(taskDir), taskDir, "3"])
  })

  it("lets the runner override ctx.taskDir", async () => {
    const taskDir = await makeTask(
      "ctx-override",
      `export default async ({ ctx }) => ({ score: 0, diagnostics: [String(ctx.taskDir)] })`,
    )
    const result = await runTaskScorer({
      taskDir,
      workspaceDir: workspaceOf(taskDir),
      ctx: { taskDir: "/elsewhere" },
    })
    expect(result.diagnostics).toEqual(["/elsewhere"])
  })

  it("a score of 0 is a verdict, not a failure", async () => {
    const taskDir = await makeTask("zero", `export default async () => ({ score: 0, diagnostics: ["nope"] })`)
    const result = await runTaskScorer({ taskDir, workspaceDir: workspaceOf(taskDir) })
    expect(result.ok).toBe(true)
    expect(result.score).toBe(0)
  })

  it("reports a missing verifier without throwing", async () => {
    const taskDir = await makeTask("missing", "")
    const result = await runTaskScorer({ taskDir, workspaceDir: workspaceOf(taskDir) })
    expect(result.ok).toBe(false)
    expect(result.score).toBe(0)
    expect(result.error).toContain("no verifier at")
  })

  it("survives a verifier that throws, and keeps the stack as evidence", async () => {
    const taskDir = await makeTask(
      "throws",
      `export default async () => { throw new Error("fixture exploded") }`,
    )
    const result = await runTaskScorer({ taskDir, workspaceDir: workspaceOf(taskDir) })
    expect(result.ok).toBe(false)
    expect(result.score).toBe(0)
    expect(result.error).toContain("fixture exploded")
  })

  it("survives a verifier that fails to parse", async () => {
    const taskDir = await makeTask("syntax", `export default async () => ({ score: 1,`)
    const result = await runTaskScorer({ taskDir, workspaceDir: workspaceOf(taskDir) })
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it("rejects a module with no default export", async () => {
    const taskDir = await makeTask("no-default", `export const evaluate = async () => ({ score: 1 })`)
    const result = await runTaskScorer({ taskDir, workspaceDir: workspaceOf(taskDir) })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("no default-exported function")
  })

  it("rejects an out-of-range score instead of silently clamping it", async () => {
    const taskDir = await makeTask("bad-score", `export default async () => ({ score: 7, diagnostics: [] })`)
    const result = await runTaskScorer({ taskDir, workspaceDir: workspaceOf(taskDir) })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("score=7")
  })

  it("rejects a verifier that resolves to nothing", async () => {
    const taskDir = await makeTask("undefined", `export default async () => undefined`)
    const result = await runTaskScorer({ taskDir, workspaceDir: workspaceOf(taskDir) })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("expected { score, diagnostics }")
  })

  it("tolerates a missing subscores/diagnostics block", async () => {
    const taskDir = await makeTask("sparse", `export default async () => ({ score: 1 })`)
    const result = await runTaskScorer({ taskDir, workspaceDir: workspaceOf(taskDir) })
    expect(result.ok).toBe(true)
    expect(result.subscores).toEqual({})
    expect(result.diagnostics).toEqual([])
  })

  it("kills a verifier that hangs past its budget", async () => {
    const taskDir = await makeTask(
      "hangs",
      `export default async () => {
         await new Promise((resolve) => setTimeout(resolve, 120_000))
         return { score: 1, diagnostics: [] }
       }`,
    )
    const result = await runTaskScorer({
      taskDir,
      workspaceDir: workspaceOf(taskDir),
      timeoutMs: 700,
      killGraceMs: 300,
    })
    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe(true)
    expect(result.error).toContain("time budget")
  })

  it("is cancellable", async () => {
    const taskDir = await makeTask(
      "abortable",
      `export default async () => {
         await new Promise((resolve) => setTimeout(resolve, 120_000))
         return { score: 1, diagnostics: [] }
       }`,
    )
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 300)
    const result = await runTaskScorer({
      taskDir,
      workspaceDir: workspaceOf(taskDir),
      timeoutMs: 30_000,
      killGraceMs: 200,
      signal: abort.signal,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("cancelled")
  })

  it("catches a verifier whose promise never settles", async () => {
    // Node drains an empty event loop and exits 0, so this looks like a clean
    // exit with no result rather than a timeout. It must still not score as 0.
    const taskDir = await makeTask("never-settles", `export default async () => new Promise(() => {})`)
    const result = await runTaskScorer({ taskDir, workspaceDir: workspaceOf(taskDir), timeoutMs: 10_000 })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("without a result")
  })

  it("captures the verifier's stdout as failure evidence", async () => {
    const taskDir = await makeTask(
      "noisy",
      `console.log("npm WARN something")
       export default async () => ({ score: 1, diagnostics: [] })`,
    )
    const result = await runTaskScorer({ taskDir, workspaceDir: workspaceOf(taskDir) })
    expect(result.ok).toBe(true)
    expect(result.stdout).toContain("npm WARN something")
  })

  it("survives a verifier that calls process.exit mid-flight", async () => {
    const taskDir = await makeTask("exits", `process.exit(9)\nexport default async () => ({ score: 1 })`)
    const result = await runTaskScorer({ taskDir, workspaceDir: workspaceOf(taskDir) })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("without a result")
  })

  it("honours a custom verifier filename", async () => {
    const taskDir = await makeTask(
      "custom",
      `export default async () => ({ score: 1, diagnostics: ["alt"] })`,
      "VERIFY.ts",
    )
    const result = await runTaskScorer({
      taskDir,
      workspaceDir: workspaceOf(taskDir),
      evalFilename: "VERIFY.ts",
    })
    expect(result.ok).toBe(true)
    expect(result.diagnostics).toEqual(["alt"])
  })
})
