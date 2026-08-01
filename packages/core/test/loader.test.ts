import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { findTaskDirs, loadTask, loadTasks, TaskLoadError } from "../src/loader.js"

let root: string

function prompt(id: string, extra = ""): string {
  return `---
id: ${id}
suite: benchmark
family: nac
stage: build
difficulty: L2
verify: [intents]
${extra}---

Do the thing for ${id}.
`
}

async function writeTask(
  id: string,
  opts: { extras?: string[]; withEval?: boolean; frontmatter?: string } = {},
): Promise<string> {
  const dir = path.join(root, id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "PROMPT.md"), opts.frontmatter ?? prompt(id))
  if (opts.withEval !== false) {
    await fs.writeFile(path.join(dir, "EVAL.ts"), "export default {}\n")
  }
  for (const extra of opts.extras ?? []) {
    await fs.mkdir(path.join(dir, extra), { recursive: true })
    await fs.writeFile(path.join(dir, extra, ".keep"), "")
  }
  return dir
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "notionbench-loader-"))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe("loadTask", () => {
  it("loads metadata, prompt and optional directories", async () => {
    const dir = await writeTask("build-nac-001-workspace-from-spec", {
      extras: ["fixture", "solution", "wrong"],
    })
    const task = await loadTask(dir, { root })
    expect(task.meta.family).toBe("nac")
    expect(task.prompt).toContain("Do the thing")
    expect(task.paths.fixtureDir).toBe(path.join(dir, "fixture"))
    expect(task.paths.solutionDir).toBe(path.join(dir, "solution"))
    expect(task.paths.wrongDirs).toEqual([path.join(dir, "wrong")])
  })

  it("omits directories that are absent", async () => {
    const dir = await writeTask("build-nac-002-csv-seeded")
    const task = await loadTask(dir, { root })
    expect(task.paths.fixtureDir).toBeUndefined()
    expect(task.paths.solutionDir).toBeUndefined()
    expect(task.paths.wrongDirs).toEqual([])
  })

  it("treats each subdirectory of wrong/ as one wrong solution", async () => {
    const dir = await writeTask("build-nac-003-relations-rollup", {
      extras: ["wrong/missing-rollup", "wrong/wrong-direction"],
    })
    const task = await loadTask(dir, { root })
    expect(task.paths.wrongDirs).toEqual([
      path.join(dir, "wrong", "missing-rollup"),
      path.join(dir, "wrong", "wrong-direction"),
    ])
  })

  it("errors when PROMPT.md or EVAL.ts is missing", async () => {
    const dir = await writeTask("build-nac-004-board-view-filters", { withEval: false })
    await expect(loadTask(dir, { root })).rejects.toThrow(/missing EVAL\.ts/)
    await expect(loadTask(path.join(root, "nope"), { root })).rejects.toThrow(/missing PROMPT\.md/)
  })

  it("errors when the id does not match the directory", async () => {
    const dir = path.join(root, "build-nac-005-content-markdown")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "PROMPT.md"), prompt("build-nac-009-other"))
    await fs.writeFile(path.join(dir, "EVAL.ts"), "export default {}\n")
    await expect(loadTask(dir, { root })).rejects.toThrow(TaskLoadError)
    const task = await loadTask(dir, { root, checkIdMatchesDir: false })
    expect(task.meta.id).toBe("build-nac-009-other")
  })

  it("matches nested ids against the root", async () => {
    const dir = await writeTask("nac/idempotent-extend")
    const task = await loadTask(dir, { root })
    expect(task.meta.id).toBe("nac/idempotent-extend")
  })
})

describe("loadTasks", () => {
  it("discovers flat and nested tasks, sorted by id", async () => {
    await writeTask("build-nac-002-csv-seeded")
    await writeTask("build-nac-001-workspace-from-spec")
    await writeTask("nac/idempotent-extend")
    const tasks = await loadTasks(root)
    expect(tasks.map((t) => t.meta.id)).toEqual([
      "build-nac-001-workspace-from-spec",
      "build-nac-002-csv-seeded",
      "nac/idempotent-extend",
    ])
  })

  it("does not descend into a task directory", async () => {
    const dir = await writeTask("build-nac-001-workspace-from-spec", { extras: ["solution"] })
    await fs.writeFile(path.join(dir, "solution", "PROMPT.md"), prompt("decoy"))
    const dirs = await findTaskDirs(root)
    expect(dirs).toEqual([dir])
  })

  it("rejects duplicate ids", async () => {
    await writeTask("a/dup", { frontmatter: prompt("dup", "") })
    await writeTask("b/dup", { frontmatter: prompt("dup", "") })
    await expect(loadTasks(root, { checkIdMatchesDir: false })).rejects.toThrow(/duplicate task id/)
  })
})
