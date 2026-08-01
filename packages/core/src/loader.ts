/**
 * Task directory loader.
 *
 * Layout of a task (mirrors Supabase Evals' PROMPT.md / EVAL.ts split):
 *
 * ```
 * evals/<id>/
 *   PROMPT.md     required — YAML frontmatter + Markdown instructions
 *   EVAL.ts       required — the verifier module
 *   fixture/      optional — starting state copied into the sandbox
 *   solution/     optional — oracle solution (must pass QC)
 *   wrong/        optional — plausibly-wrong solutions (must fail QC);
 *                            either a solution itself or a directory of them
 * ```
 */
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { parsePromptFile } from "./frontmatter.js"
import type { TaskMeta } from "./task-schema.js"

export const PROMPT_FILE = "PROMPT.md"
export const EVAL_FILE = "EVAL.ts"
export const FIXTURE_DIR = "fixture"
export const SOLUTION_DIR = "solution"
export const WRONG_DIR = "wrong"

/** Dir names that mark `wrong/` as one solution's content, not variant dirs. */
const CONTENT_DIR_NAMES = new Set(["src", "data", "live", "dist", "node_modules"])

export class TaskLoadError extends Error {
  constructor(
    message: string,
    readonly dir: string,
  ) {
    super(`${dir}: ${message}`)
    this.name = "TaskLoadError"
  }
}

export interface TaskPaths {
  /** Absolute path of the task directory. */
  dir: string
  promptPath: string
  evalPath: string
  fixtureDir?: string
  solutionDir?: string
  /**
   * Plausibly-wrong solutions used by QC. If `wrong/` contains subdirectories,
   * each subdirectory is one wrong solution; otherwise `wrong/` itself is one.
   */
  wrongDirs: string[]
}

export interface Task {
  meta: TaskMeta
  /** Markdown body of PROMPT.md (the agent-visible instructions). */
  prompt: string
  paths: TaskPaths
}

export interface LoadTaskOptions {
  /**
   * Require the frontmatter `id` to match the task's path relative to the
   * evals root (`evals/<id>/`). Defaults to true when a root is known.
   */
  checkIdMatchesDir?: boolean
  /** Root the id is resolved against; defaults to the task directory's parent. */
  root?: string
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function subdirs(p: string): Promise<string[]> {
  const entries = await fs.readdir(p, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => path.join(p, e.name))
    .sort()
}

/** Load and validate a single task directory. */
export async function loadTask(dir: string, opts: LoadTaskOptions = {}): Promise<Task> {
  const abs = path.resolve(dir)
  const promptPath = path.join(abs, PROMPT_FILE)
  const evalPath = path.join(abs, EVAL_FILE)

  let text: string
  try {
    text = await fs.readFile(promptPath, "utf8")
  } catch {
    throw new TaskLoadError(`missing ${PROMPT_FILE}`, abs)
  }
  if (!(await exists(evalPath))) {
    throw new TaskLoadError(`missing ${EVAL_FILE}`, abs)
  }

  const { meta, prompt } = parsePromptFile(text, path.join(path.basename(abs), PROMPT_FILE))

  const root = opts.root ? path.resolve(opts.root) : path.dirname(abs)
  const check = opts.checkIdMatchesDir ?? true
  if (check) {
    const rel = path.relative(root, abs).split(path.sep).join("/")
    if (rel !== meta.id) {
      throw new TaskLoadError(`frontmatter id "${meta.id}" does not match directory "${rel}"`, abs)
    }
  }

  const fixtureDir = path.join(abs, FIXTURE_DIR)
  const solutionDir = path.join(abs, SOLUTION_DIR)
  const wrongDir = path.join(abs, WRONG_DIR)

  let wrongDirs: string[] = []
  if (await isDir(wrongDir)) {
    // `wrong/` is a SINGLE wrong solution when it directly contains any file
    // (e.g. wrong/answer.json) or a content dir like `src/` — the shape every
    // authored task actually uses. It is a MULTI-VARIANT dir (each subdir =
    // one wrong solution) only when it consists purely of subdirectories none
    // of which is a content dir.
    const entries = await fs.readdir(wrongDir, { withFileTypes: true })
    const hasTopLevelFile = entries.some((e) => e.isFile())
    const nested = await subdirs(wrongDir)
    const hasContentDir = nested.some((d) => CONTENT_DIR_NAMES.has(path.basename(d)))
    wrongDirs =
      hasTopLevelFile || hasContentDir || nested.length === 0 ? [wrongDir] : nested
  }

  return {
    meta,
    prompt,
    paths: {
      dir: abs,
      promptPath,
      evalPath,
      ...((await isDir(fixtureDir)) ? { fixtureDir } : {}),
      ...((await isDir(solutionDir)) ? { solutionDir } : {}),
      wrongDirs,
    },
  }
}

export interface LoadTasksOptions extends Omit<LoadTaskOptions, "root"> {
  /** Maximum directory depth to search below the root (default 3). */
  maxDepth?: number
}

/**
 * Discover every task under `root` (any directory containing a PROMPT.md).
 * Ids may be nested (`nac/idempotent-extend`), hence the recursive scan.
 * Results are sorted by task id.
 */
export async function loadTasks(root: string, opts: LoadTasksOptions = {}): Promise<Task[]> {
  const absRoot = path.resolve(root)
  const dirs = await findTaskDirs(absRoot, opts.maxDepth ?? 3)
  const tasks: Task[] = []
  for (const dir of dirs) {
    tasks.push(await loadTask(dir, { ...opts, root: absRoot }))
  }
  const seen = new Map<string, string>()
  for (const t of tasks) {
    const prev = seen.get(t.meta.id)
    if (prev) throw new TaskLoadError(`duplicate task id "${t.meta.id}" (also in ${prev})`, t.paths.dir)
    seen.set(t.meta.id, t.paths.dir)
  }
  return tasks.sort((a, b) => (a.meta.id < b.meta.id ? -1 : a.meta.id > b.meta.id ? 1 : 0))
}

/** Directories containing a PROMPT.md, depth-limited, deterministic order. */
export async function findTaskDirs(root: string, maxDepth = 3): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (await exists(path.join(dir, PROMPT_FILE))) {
      out.push(dir)
      return // tasks do not nest inside tasks
    }
    if (depth <= 0) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const children = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => e.name)
      .sort()
    for (const name of children) {
      await walk(path.join(dir, name), depth - 1)
    }
  }
  await walk(path.resolve(root), maxDepth)
  return out.sort()
}
