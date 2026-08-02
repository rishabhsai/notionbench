#!/usr/bin/env node
/**
 * Run one live task's oracle and foil against the REAL Notion API.
 *
 * `qc:live` proves a verifier is self-consistent against `fake-notion.ts`, and
 * that is all it can prove: the fake is necessarily more permissive and more
 * uniform than api.notion.com, so an assertion that encodes a wrong belief
 * about Notion's behaviour passes QC and then fails every live cell. Three
 * separate bugs shipped past a green `qc:live` this way:
 *
 *   - views report a filter/group_by property as an opaque id, not a name;
 *   - the schema percent-encodes those ids while views reference them raw;
 *   - `GET /pages/{id}/markdown` never renders the page title into the body.
 *
 * Each cost a full round of the grid. This script is the missing check: it
 * provisions the real fixture, runs the real oracle against it, and asserts the
 * verifier scores it 1 (and scores the foil 0). It costs real API calls and a
 * real workspace, so it is not part of CI — run it whenever a live task's
 * verifier or its fixture changes.
 *
 *   node scripts/verify-live-task.mjs <taskId> [<taskId> …]
 *   node scripts/verify-live-task.mjs --all
 *
 * Requires NOTION_API_TOKEN and NOTION_PARENT_PAGE_ID (see ~/.notionbench.env).
 * The fixture is torn down on every path, including failure.
 */
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EVALS = path.join(ROOT, "evals")
const LIB = path.join(EVALS, "_lib", "live")

const { provisionFixture, teardownFixture, specPathFor, writeWorkspacePointer } = await import(
  pathToFileURL(path.join(LIB, "provision.ts")).href
)
const { NotionClient } = await import(pathToFileURL(path.join(LIB, "notion.ts")).href)

/**
 * teardownFixture takes (client, rootId) — calling it with the ProvisionResult
 * alone fails silently and leaks the fixture. A leaked fixture is not merely
 * untidy: its databases stay searchable workspace-wide, so a later task that
 * resolves a data source by name can match a dead run's copy.
 */
async function teardown(provisioned) {
  const result = await teardownFixture(new NotionClient(), provisioned.rootId)
  if (!result?.ok) {
    console.log(`   (teardown failed, leaked ${provisioned.rootId}: ${result?.error ?? "unknown"})`)
  }
}

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** Tasks with a `fixture/spec.json` and an oracle — i.e. the live ones. */
async function liveTasks() {
  const out = []
  for (const entry of await fs.readdir(EVALS, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue
    const dir = path.join(EVALS, entry.name)
    try {
      await fs.access(specPathFor(dir))
      await fs.access(path.join(dir, "live", "solution.mjs"))
      out.push(entry.name)
    } catch {
      // offline task, or a live task with no oracle — not ours to check
    }
  }
  return out.sort()
}

/** Run one oracle/foil script in its own workspace, then score that workspace. */
async function runCandidate(taskDir, scriptName, provisioned) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "nb-verify-"))
  // Mirror what the runner and qc:live hand an agent: the fixture's workspace
  // files plus the sandbox pointer. Without these a task whose deliverable is a
  // seeded script has nothing to open.
  const fixtureWorkspace = path.join(taskDir, "fixture", "workspace")
  if (await exists(fixtureWorkspace)) {
    await fs.cp(fixtureWorkspace, workspaceDir, { recursive: true })
  }
  await writeWorkspacePointer(workspaceDir, provisioned)
  const saved = { cwd: process.cwd(), env: { ...process.env } }
  try {
    process.env.NOTIONBENCH_ROOT_ID = provisioned.rootId
    process.env.NOTIONBENCH_ID_MAP = JSON.stringify(provisioned.idMap ?? {})
    process.chdir(workspaceDir)
    // Cache-bust: the same oracle runs once per fixture, and ESM caches modules.
    await import(`${pathToFileURL(path.join(taskDir, "live", scriptName)).href}?t=${Date.now()}`)
  } finally {
    process.chdir(saved.cwd)
    process.env = saved.env
  }
  const evaluate = (await import(pathToFileURL(path.join(taskDir, "EVAL.ts")).href)).default
  return {
    workspaceDir,
    result: await evaluate({
      workspaceDir,
      ctx: { rootId: provisioned.rootId, idMap: provisioned.idMap ?? {} },
    }),
  }
}

async function verify(taskId) {
  const taskDir = path.join(EVALS, taskId)
  const spec = JSON.parse(await fs.readFile(specPathFor(taskDir), "utf8"))
  const failures = []

  // A FRESH fixture per variant, exactly as qc:live does. Sharing one fixture
  // between the oracle and the foil lets the oracle's correct work stand in for
  // the foil's missing work — build-cli-003's foil omits option colours, and on
  // a schema the oracle had already coloured it scored a clean 1.
  for (const [scriptName, want] of [
    ["solution.mjs", 1],
    ["wrong.mjs", 0],
  ]) {
    try {
      await fs.access(path.join(taskDir, "live", scriptName))
    } catch {
      continue // a task may ship no foil
    }
    const provisioned = await provisionFixture({ spec, label: `verify-${taskId}` })
    try {
      const { result } = await runCandidate(taskDir, scriptName, provisioned)
      const ok = result.score === want
      console.log(
        `   ${ok ? "PASS" : "FAIL"}  ${scriptName.replace(".mjs", "").padEnd(8)} ` +
          `expected ${want}, score=${result.score}  ${JSON.stringify(result.subscores ?? {})}`,
      )
      if (!ok) {
        failures.push(`${taskId} / ${scriptName}`)
        for (const d of result.diagnostics ?? []) console.log(`          - ${String(d).slice(0, 220)}`)
      }
    } finally {
      await teardown(provisioned)
    }
  }
  return failures
}

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error("usage: node scripts/verify-live-task.mjs <taskId> […] | --all")
  process.exit(2)
}
if (!process.env.NOTION_API_TOKEN) {
  console.error("NOTION_API_TOKEN is not set — this script talks to the real api.notion.com")
  process.exit(2)
}
// Guard against pointing this at the fake and learning nothing.
const base = process.env.NOTION_API_BASE ?? "https://api.notion.com"
if (!base.includes("api.notion.com")) {
  console.error(`NOTION_API_BASE is ${base} — this check is only meaningful against the real API`)
  process.exit(2)
}

const targets = args.includes("--all") ? await liveTasks() : args
const allFailures = []
for (const taskId of targets) {
  console.log(`\n── ${taskId}`)
  try {
    allFailures.push(...(await verify(taskId)))
  } catch (err) {
    console.log(`   ERROR  ${err.message}`)
    allFailures.push(`${taskId} / provisioning`)
  }
}

console.log(
  allFailures.length === 0
    ? `\n${targets.length} task(s) verified against the real API`
    : `\n${allFailures.length} failure(s): ${allFailures.join(", ")}`,
)
process.exit(allFailures.length === 0 ? 0 : 1)
