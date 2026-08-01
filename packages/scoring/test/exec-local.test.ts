import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { execLocal, parseJsonStdout, runBuild, runCommand, readIntentsFile } from "../src/exec-local.js"

/**
 * The drivers are exercised against fake `ntn` / `npm` shims placed on PATH, so
 * the tests never need the real CLI (or the network).
 */
let tmp: string
let binDir: string
let projectDir: string
let env: NodeJS.ProcessEnv

const NTN_SHIM = `#!/usr/bin/env node
const argv = process.argv.slice(2)
// expected: workers exec <key> -d <json> --local --json
const key = argv[2]
const data = JSON.parse(argv[4] ?? "{}")
if (key === "echo") {
  process.stdout.write(JSON.stringify({ ok: true, echo: data, flags: argv.slice(7) }))
  process.exit(0)
}
if (key === "noisy") {
  process.stderr.write("[ntn] running tool locally...\\n")
  process.stdout.write("warming up\\n")
  process.stdout.write(JSON.stringify({ ok: true, value: data.n * 2 }) + "\\n")
  process.exit(0)
}
if (key === "fail") {
  process.stderr.write("Error: tool 'fail' threw\\n")
  process.exit(2)
}
if (key === "notjson") {
  process.stdout.write("this is not json at all")
  process.exit(0)
}
if (key === "hang") {
  setInterval(() => {}, 1000)
  return
}
process.stderr.write("unknown key " + key + "\\n")
process.exit(3)
`

const NPM_SHIM = `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const argv = process.argv.slice(2)
if (argv[0] !== "run" || argv[1] !== "build") {
  process.stderr.write("unsupported npm invocation\\n")
  process.exit(1)
}
const mode = process.env.FAKE_BUILD_MODE ?? "ok"
process.stdout.write("> notion-as-code-project build\\n")
if (mode === "fail") {
  process.stderr.write("src/main.ts(3,5): error TS2322: Type error\\n")
  process.exit(1)
}
if (mode === "empty") process.exit(0)
fs.mkdirSync(path.join(process.cwd(), "dist"), { recursive: true })
fs.writeFileSync(
  path.join(process.cwd(), "dist", "intents.json"),
  JSON.stringify([{ type: "space", resourceId: "sp", name: "Built" }], null, 2),
)
process.exit(0)
`

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "notionbench-exec-"))
  binDir = path.join(tmp, "bin")
  projectDir = path.join(tmp, "project")
  await fs.mkdir(binDir, { recursive: true })
  await fs.mkdir(projectDir, { recursive: true })
  await fs.writeFile(path.join(binDir, "ntn"), NTN_SHIM, { mode: 0o755 })
  await fs.writeFile(path.join(binDir, "npm"), NPM_SHIM, { mode: 0o755 })
  env = { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` }
})

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe("runCommand", () => {
  it("captures stdout and stderr separately", async () => {
    const result = await runCommand("ntn", ["workers", "exec", "noisy", "-d", "{}"], {
      cwd: projectDir,
      env,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("warming up")
    expect(result.stderr).toContain("[ntn] running tool locally")
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("reports a missing binary instead of throwing", async () => {
    const result = await runCommand("definitely-not-a-real-binary", [], { cwd: projectDir, env })
    expect(result.spawnError).toMatch(/ENOENT/)
    expect(result.exitCode).toBeNull()
  })
})

describe("execLocal", () => {
  it("builds the documented command line and parses stdout JSON", async () => {
    const result = await execLocal("echo", { hello: "world" }, { cwd: projectDir, env })
    expect(result.ok).toBe(true)
    expect(result.args).toEqual([
      "workers",
      "exec",
      "echo",
      "-d",
      '{"hello":"world"}',
      "--local",
      "--json",
    ])
    expect(result.output).toEqual({ ok: true, echo: { hello: "world" }, flags: [] })
    expect(result.stderr).toBe("")
  })

  it("passes extra args through", async () => {
    const result = await execLocal(
      "echo",
      {},
      { cwd: projectDir, env, extraArgs: ["--verbose"] },
    )
    expect((result.output as { flags: string[] }).flags).toEqual(["--verbose"])
  })

  it("finds the JSON payload amid log noise, keeping stderr separate", async () => {
    const result = await execLocal("noisy", { n: 21 }, { cwd: projectDir, env })
    expect(result.ok).toBe(true)
    expect(result.output).toEqual({ ok: true, value: 42 })
    expect(result.stderr).toContain("running tool locally")
    expect(result.stdout).toContain("warming up")
  })

  it("reports a non-zero exit as not ok, preserving stderr", async () => {
    const result = await execLocal("fail", {}, { cwd: projectDir, env })
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("tool 'fail' threw")
    expect(result.output).toBeUndefined()
  })

  it("reports unparseable output", async () => {
    const result = await execLocal("notjson", {}, { cwd: projectDir, env })
    expect(result.ok).toBe(false)
    expect(result.parseError).toMatch(/not JSON/)
  })

  it("kills a hanging process at the timeout", async () => {
    const result = await execLocal("hang", {}, { cwd: projectDir, env, timeoutMs: 300 })
    expect(result.timedOut).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.durationMs).toBeGreaterThanOrEqual(250)
  }, 15_000)

  it("fails cleanly when the CLI is not installed", async () => {
    const result = await execLocal("echo", {}, { cwd: projectDir, env: { PATH: "" }, command: "ntn" })
    expect(result.ok).toBe(false)
    expect(result.spawnError).toBeDefined()
  })
})

describe("parseJsonStdout", () => {
  it("parses a bare payload", () => {
    expect(parseJsonStdout('{"a":1}')).toEqual({ value: { a: 1 } })
    expect(parseJsonStdout("[1,2]\n")).toEqual({ value: [1, 2] })
  })

  it("parses the last JSON line when the CLI logs first", () => {
    expect(parseJsonStdout('starting\n{"a":1}\n')).toEqual({ value: { a: 1 } })
  })

  it("falls back to the first balanced block", () => {
    expect(parseJsonStdout('noise {"a":1} trailing')).toEqual({ value: { a: 1 } })
  })

  it("errors on empty or non-JSON output", () => {
    expect(parseJsonStdout("   ")).toEqual({ error: "no output on stdout" })
    expect(parseJsonStdout("nope")).toMatchObject({ error: expect.stringContaining("not JSON") })
  })
})

describe("runBuild", () => {
  it("returns the path to dist/intents.json on success", async () => {
    const cwd = path.join(tmp, "nac-ok")
    await fs.mkdir(cwd, { recursive: true })
    const result = await runBuild(cwd, { env })
    expect(result.ok).toBe(true)
    expect(result.intentsPath).toBe(path.join(cwd, "dist", "intents.json"))
    expect(result.stdout).toContain("notion-as-code-project build")
    const intents = await readIntentsFile(result.intentsPath!)
    expect(intents).toEqual([{ type: "space", resourceId: "sp", name: "Built" }])
  })

  it("reports a failing build with its compiler output", async () => {
    const cwd = path.join(tmp, "nac-fail")
    await fs.mkdir(cwd, { recursive: true })
    const result = await runBuild(cwd, { env: { ...env, FAKE_BUILD_MODE: "fail" } })
    expect(result.ok).toBe(false)
    expect(result.failure).toMatch(/exited with code 1/)
    expect(result.stderr).toContain("error TS2322")
    expect(result.intentsPath).toBeUndefined()
  })

  it("reports a build that produced no intents file", async () => {
    const cwd = path.join(tmp, "nac-empty")
    await fs.mkdir(cwd, { recursive: true })
    const result = await runBuild(cwd, { env: { ...env, FAKE_BUILD_MODE: "empty" } })
    expect(result.ok).toBe(false)
    expect(result.failure).toMatch(/produced no dist\/intents\.json/)
  })

  it("reports a missing package manager", async () => {
    const cwd = path.join(tmp, "nac-nonpm")
    await fs.mkdir(cwd, { recursive: true })
    const result = await runBuild(cwd, { env: { PATH: "" } })
    expect(result.ok).toBe(false)
    expect(result.failure).toMatch(/ENOENT/)
  })
})
