#!/usr/bin/env node
/**
 * Make this package self-contained immediately before `npm pack`, by vendoring
 * the two things it needs at runtime but does not carry in `dependencies`: the
 * task suite, and the `@notionbench/*` workspace packages.
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
 * The cost is honest and bounded: the suite is the bulk of the tarball, and a
 * task-only fix still requires a runner release. That is the intended tradeoff —
 * task edits change scores, so they *should* be a release.
 *
 * `evals/` lives at the repo root (outside any package) because every
 * `EVAL.ts` imports `@notionbench/scoring` by name, which the workspace
 * resolves via `evals/node_modules`. Copying at prepack keeps that layout
 * authoritative in git while still producing a self-contained tarball.
 *
 * ## Why the workspace packages are vendored rather than depended on
 *
 * Publishing `@notionbench/scoring` and `@notionbench/sandbox` would require
 * owning the `@notionbench` npm scope, which needs a user or org of that exact
 * name; the registry answers `E404` on a scope you cannot write to. Rather than
 * stand up an org to host ~50KB of code, both are copied into
 * `dist/node_modules/@notionbench/` so `notionbench` publishes and installs as
 * exactly one package.
 *
 * They go under `dist/` specifically: npm strips a `node_modules` directory at
 * the package root out of the tarball, but keeps a nested one, and Node's
 * resolver checks `dist/node_modules/` before walking further up. So
 * `import ... from '@notionbench/scoring'` in the compiled runner keeps
 * resolving with no rewriting of import specifiers, no bundler, and no change to
 * the source — in a checkout the same specifier resolves through pnpm's
 * workspace links instead, so `pnpm -r build` and the tests are untouched.
 */
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EVALS_SOURCE = path.resolve(PKG, "../../evals")
const EVALS_DEST = path.join(PKG, "evals")
const VENDOR_DEST = path.join(PKG, "dist", "node_modules", "@notionbench")
const MANIFEST = path.join(PKG, "package.json")
const MANIFEST_BACKUP = path.join(PKG, "package.json.prepack-backup")

/** Workspace packages the runner imports by name at runtime. */
const VENDORED = ["scoring", "sandbox"]

/**
 * Build output and installed trees are regenerated at scoring time (see
 * evals/.gitignore), and `node_modules` there is a workspace symlink farm that
 * would be meaningless — or broken — inside a tarball.
 */
const SKIP = new Set(["node_modules", "dist", ".qc", ".notionbench-exec.ts"])

async function copyTree(from, to, skip = new Set()) {
  await fs.mkdir(to, { recursive: true })
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) await copyTree(src, dst, skip)
    else if (entry.isFile()) await fs.copyFile(src, dst)
  }
}

async function countFiles(dir) {
  let n = 0
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += await countFiles(path.join(dir, e.name))
    else n++
  }
  return n
}

async function bundleEvals() {
  try {
    await fs.access(EVALS_SOURCE)
  } catch {
    throw new Error(
      `cannot bundle tasks: ${EVALS_SOURCE} does not exist.\n` +
        "prepack is only runnable from a full repo checkout.",
    )
  }
  // Stale tasks are worse than missing ones: a removed task that lingers in the
  // tarball still shows up in `notionbench tasks` and still gets scored.
  await fs.rm(EVALS_DEST, { recursive: true, force: true })
  await copyTree(EVALS_SOURCE, EVALS_DEST, SKIP)
  return countFiles(EVALS_DEST)
}

async function bundleWorkspacePackages() {
  await fs.rm(VENDOR_DEST, { recursive: true, force: true })
  for (const name of VENDORED) {
    const from = path.resolve(PKG, "..", name)
    // Only what the package would have published: its manifest and build output.
    // Copying src/ and test/ too would double the size for nothing.
    const dist = path.join(from, "dist")
    try {
      await fs.access(dist)
    } catch {
      throw new Error(`cannot vendor @notionbench/${name}: ${dist} is missing. Run \`pnpm -r build\` first.`)
    }
    const to = path.join(VENDOR_DEST, name)
    await fs.mkdir(to, { recursive: true })
    await fs.copyFile(path.join(from, "package.json"), path.join(to, "package.json"))
    await copyTree(dist, path.join(to, "dist"))
  }
  return countFiles(VENDOR_DEST)
}

/**
 * Drop the vendored packages from the manifest that goes into the tarball.
 *
 * They have to stay in the checked-in `devDependencies` — that is what makes
 * pnpm link them into the workspace so `tsc` and the tests resolve them — but
 * `@notionbench/scoring@0.1.0` does not exist on any registry, so publishing
 * that reference would leave a dangling entry in the manifest for anyone who
 * reads or reinstalls it. Consumers never install devDependencies, so removing
 * them changes nothing about what `npm install notionbench` fetches.
 *
 * The original is kept byte-for-byte and restored by postpack.
 */
async function stripVendoredFromManifest() {
  await restoreManifest() // self-heal after an interrupted pack
  const original = await fs.readFile(MANIFEST, "utf8")
  const manifest = JSON.parse(original)
  const dev = manifest.devDependencies ?? {}
  for (const name of VENDORED) delete dev[`@notionbench/${name}`]
  manifest.devDependencies = dev
  await fs.writeFile(MANIFEST_BACKUP, original)
  await fs.writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function restoreManifest() {
  try {
    const backup = await fs.readFile(MANIFEST_BACKUP, "utf8")
    await fs.writeFile(MANIFEST, backup)
    await fs.rm(MANIFEST_BACKUP, { force: true })
  } catch {
    // no backup: nothing to restore
  }
}

async function main() {
  // postpack: the copies have served their purpose once the tarball exists.
  // Leaving evals/ would shadow the repo's own suite for anything run from this
  // directory, and dist/node_modules would shadow the workspace links — both
  // then quietly go stale against their sources.
  if (process.argv.includes("--clean")) {
    await restoreManifest()
    await fs.rm(EVALS_DEST, { recursive: true, force: true })
    await fs.rm(path.join(PKG, "dist", "node_modules"), { recursive: true, force: true })
    return
  }

  const tasks = await bundleEvals()
  const vendored = await bundleWorkspacePackages()
  await stripVendoredFromManifest()
  process.stdout.write(
    `bundled ${tasks} task files into evals/ and ${vendored} files into dist/node_modules/@notionbench/\n`,
  )
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`)
  process.exit(1)
})
