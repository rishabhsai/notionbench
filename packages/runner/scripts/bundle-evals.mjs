#!/usr/bin/env node
/**
 * Vendor the task suite into this package immediately before `npm pack`.
 *
 * ## Why the tasks ship inside the runner rather than as `@notionbench/evals`
 *
 * A benchmark number is only meaningful as a (runner, task suite) pair. If the
 * suite were its own package, npm's semver ranges would let `notionbench@0.3.0`
 * resolve an older or newer suite than the one its scores were calibrated
 * against, and two people reporting "NotionBench 0.3" could have measured
 * different things. Shipping both in one tarball makes the version a single
 * fact: one `notionbench@x.y.z` is exactly one suite, always.
 *
 * It also makes `npx notionbench run --dry-run` work with nothing installed but
 * the CLI itself, which a separate package could only achieve by being a hard
 * dependency anyway — the same bytes, with a version-skew failure mode added.
 *
 * The cost is honest and bounded: the suite is the bulk of the tarball, and a
 * task-only fix still requires a runner release. That is the intended tradeoff —
 * task edits change scores, so they *should* be a release.
 *
 * `evals/` lives at the repo root (outside any package) because every
 * `EVAL.ts` imports `@notionbench/scoring` by name, which the workspace
 * resolves via `evals/node_modules`. Copying at prepack keeps that layout
 * authoritative in git while still producing a self-contained tarball.
 */
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SOURCE = path.resolve(PKG, "../../evals")
const DEST = path.join(PKG, "evals")

/**
 * Build output and installed trees are regenerated at scoring time (see
 * evals/.gitignore), and `node_modules` there is a workspace symlink farm that
 * would be meaningless — or broken — inside a tarball.
 */
const SKIP = new Set(["node_modules", "dist", ".qc", ".notionbench-exec.ts"])

async function copyTree(from, to) {
  await fs.mkdir(to, { recursive: true })
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) await copyTree(src, dst)
    else if (entry.isFile()) await fs.copyFile(src, dst)
  }
}

async function main() {
  // postpack: the copy has served its purpose once the tarball exists. Leaving
  // it would shadow the repo's own evals/ for anything run from this directory,
  // and quietly go stale against it.
  if (process.argv.includes("--clean")) {
    await fs.rm(DEST, { recursive: true, force: true })
    return
  }

  try {
    await fs.access(SOURCE)
  } catch {
    throw new Error(
      `cannot bundle tasks: ${SOURCE} does not exist.\n` +
        "prepack is only runnable from a full repo checkout.",
    )
  }
  // Stale tasks are worse than missing ones: a removed task that lingers in the
  // tarball still shows up in `notionbench tasks` and still gets scored.
  await fs.rm(DEST, { recursive: true, force: true })
  await copyTree(SOURCE, DEST)

  let files = 0
  const count = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) await count(path.join(dir, e.name))
      else files++
    }
  }
  await count(DEST)
  process.stdout.write(`bundled ${files} task files into ${path.relative(PKG, DEST)}/\n`)
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`)
  process.exit(1)
})
