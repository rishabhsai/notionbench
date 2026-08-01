/**
 * operate-workers-001-env-secrets — did the credential actually leave the code?
 *
 * The tool works or it doesn't, and the key is loose or it isn't, and those are
 * two independent questions. Pasting the sandbox values over the placeholders
 * makes `convert_amount` quote perfectly and is exactly the outcome the task is
 * about avoiding, so a purely behavioral verifier would score it 1.
 *
 * Four layers, all of which must hold:
 *
 *  - **config state** — `.env` in the project root (the file the template's
 *    AGENTS.md, README and auth-guide skill all name: it is loaded
 *    automatically by `ntn workers exec --local`, it is what `ntn workers env
 *    push/pull` moves, and the template already gitignores it) carries both
 *    variables with the values the prompt handed over;
 *  - **static** — the key literal appears in no other file in the project, and
 *    `npm run check` stays clean;
 *  - **behavior** — with that `.env` loaded, the tool really does quote: three
 *    currency pairs, checked against rates and a quote id this verifier derives
 *    itself rather than reading out of the fixture;
 *  - **behavior, negative** — run with a bogus base, or a bogus key, the tool
 *    must stop producing the right answer. This is what separates "reads its
 *    configuration from the environment" from "has the values baked in and also
 *    happens to have written a `.env`", and it catches it in either direction
 *    without caring whether the source spells it `process.env.X` or something
 *    cleverer. A defensive `?? "https://…"` fallback is not punished: the probe
 *    sets the variable, so a fallback never fires.
 *
 * `execCapability` is handed the parsed contents of the agent's `.env` rather
 * than the expected values, so a `.env` with a typo in it fails behaviorally
 * too — the same way it would on the developer's machine. For the negative
 * probes the file is moved aside for the duration of the run, so the outcome
 * does not depend on whether the execution path is the CLI (which loads `.env`
 * on its own) or the in-process driver (which does not).
 */
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { NPM, ensureDeps, exists, head, run } from "../_lib/proc.ts"
import { cleanupDriver, execCapability, inspectCapabilities } from "../_lib/exec-worker.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const TOOL = "convert_amount"
const ENV_FILE = ".env"

const BASE_VAR = "MERIDIAN_API_BASE"
const KEY_VAR = "MERIDIAN_API_KEY"

/** The two values the prompt handed the agent. */
const BASE = "https://sandbox.meridian-fx.test"
const KEY = "mfx_sandbox_7Qb3xR9tKw2ZmY6h"

/** Meridian's pinned sandbox rates, restated so this does not read the fixture. */
const RATES: Record<string, number> = {
  "USD:EUR": 0.9134,
  "GBP:USD": 1.2817,
  "USD:JPY": 156.42,
}

interface Case {
  name: string
  from: string
  to: string
  amount_cents: number
}

const CASES: Case[] = [
  { name: "quote_usd_eur", from: "USD", to: "EUR", amount_cents: 250_000 },
  { name: "quote_gbp_usd", from: "GBP", to: "USD", amount_cents: 48_175 },
  { name: "quote_usd_jpy", from: "USD", to: "JPY", amount_cents: 1_299 },
]

/** The quote Meridian returns for `input`, for a caller holding `apiKey`. */
function expectedQuote(apiKey: string, { from, to, amount_cents }: Case) {
  const pair = `${from}:${to}`
  const rate = RATES[pair]
  return {
    rate,
    converted_cents: Math.round(amount_cents * rate),
    quote_id: `q_${createHash("sha256")
      .update(`${apiKey}|${pair}|${amount_cents}`)
      .digest("hex")
      .slice(0, 12)}`,
  }
}

/** Dotenv, to the extent `.env` files are a format: `KEY=value`, `#` comments. */
function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === "" || line.startsWith("#")) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    const quoted =
      value.length > 1 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    if (quoted) {
      value = value.slice(1, -1)
    } else {
      const comment = value.indexOf(" #")
      if (comment >= 0) value = value.slice(0, comment).trim()
    }
    out.set(match[1], value)
  }
  return out
}

/** Trailing slashes are not a meaningful difference in a base URL. */
function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "")
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"])
/** The verifier's own scratch file; never the agent's doing. */
const SKIP_FILES = new Set([".notionbench-exec.ts"])
/** Nothing in this project is a legitimate megabyte of text. */
const MAX_SCAN_BYTES = 2 * 1024 * 1024

/**
 * Every regular file in the project except the config file itself.
 * Symlinks are left alone: the template's `AGENTS.md`/`CLAUDE.md` point at
 * `.agents/INSTRUCTIONS.md`, which is walked on its own.
 */
async function* walk(dir: string, root: string): AsyncGenerator<string> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walk(full, root)
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue
      if (path.relative(root, full) === ENV_FILE) continue
      yield full
    }
  }
}

/**
 * Run `fn` with `.env` temporarily out of the way, so an execution path that
 * loads it by itself sees the same environment the driver does.
 */
async function withoutEnvFile<T>(workspaceDir: string, fn: () => Promise<T>): Promise<T> {
  const file = path.join(workspaceDir, ENV_FILE)
  const stashed = path.join(workspaceDir, ".env.notionbench-stash")
  const present = await exists(file)
  if (present) await fs.rename(file, stashed)
  try {
    return await fn()
  } finally {
    if (present) await fs.rename(stashed, file)
  }
}

/** A successful quote, shaped and valued as Meridian would return it. */
function checkQuote(output: unknown, testCase: Case, expect: ReturnType<typeof expectedQuote>): string | undefined {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return `expected an object, got ${JSON.stringify(output)}`
  }
  const got = output as Record<string, unknown>
  if (got.rate !== expect.rate) return `rate is ${JSON.stringify(got.rate)}; expected ${expect.rate}`
  if (got.converted_cents !== expect.converted_cents) {
    return `converted_cents is ${JSON.stringify(got.converted_cents)}; expected ${expect.converted_cents}`
  }
  if (got.quote_id !== expect.quote_id) {
    return `quote_id is ${JSON.stringify(got.quote_id)}; expected ${JSON.stringify(expect.quote_id)}`
  }
  if (got.from !== testCase.from || got.to !== testCase.to) {
    return `from/to is ${JSON.stringify(got.from)}/${JSON.stringify(got.to)}; expected ${testCase.from}/${testCase.to}`
  }
  return undefined
}

export default async function evaluate({ workspaceDir }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    typecheck: 0,
    env_file: 0,
    secret_only_in_env_file: 0,
    registered: 0,
    ...Object.fromEntries(CASES.map((c) => [c.name, 0])),
    base_read_from_env: 0,
    key_read_from_env: 0,
  }

  try {
    const install = await ensureDeps(workspaceDir)
    if (install.result && install.result.code !== 0) {
      diagnostics.push(`npm install failed:\n${head(install.result.stderr || install.result.stdout)}`)
      return { score: 0, subscores, diagnostics }
    }

    // ---- static: the type-checker ------------------------------------------
    const check = await run(NPM, ["run", "check"], { cwd: workspaceDir, timeoutMs: 180_000 })
    if (check.code === 0) {
      subscores.typecheck = 1
      diagnostics.push("npm run check clean")
    } else {
      diagnostics.push(`\`npm run check\` exited ${check.code}:\n${head(check.stderr || check.stdout, 15)}`)
    }

    // ---- config state: .env holds both settings ----------------------------
    let fromEnvFile = new Map<string, string>()
    try {
      fromEnvFile = parseEnvFile(await fs.readFile(path.join(workspaceDir, ENV_FILE), "utf8"))
      const problems: string[] = []
      const base = fromEnvFile.get(BASE_VAR)
      const key = fromEnvFile.get(KEY_VAR)
      if (base === undefined) problems.push(`${BASE_VAR} is not set in ${ENV_FILE}`)
      else if (!sameUrl(base, BASE)) problems.push(`${BASE_VAR} is ${JSON.stringify(base)}; expected ${BASE}`)
      if (key === undefined) problems.push(`${KEY_VAR} is not set in ${ENV_FILE}`)
      else if (key !== KEY) problems.push(`${KEY_VAR} in ${ENV_FILE} is not the key the prompt gave`)
      if (problems.length === 0) {
        subscores.env_file = 1
        diagnostics.push(`${ENV_FILE} sets ${BASE_VAR} and ${KEY_VAR}`)
      } else {
        for (const problem of problems) diagnostics.push(problem)
      }
    } catch {
      diagnostics.push(`no ${ENV_FILE} in the project root`)
    }

    // ---- static: the key is nowhere else -----------------------------------
    const leaks: string[] = []
    for await (const file of walk(workspaceDir, workspaceDir)) {
      let source: string
      try {
        const stat = await fs.stat(file)
        if (stat.size > MAX_SCAN_BYTES) continue
        source = await fs.readFile(file, "utf8")
      } catch {
        continue
      }
      const at = source.indexOf(KEY)
      if (at < 0) continue
      const line = source.slice(0, at).split("\n").length
      leaks.push(`${path.relative(workspaceDir, file)}:${line} still contains the Meridian key`)
    }
    if (leaks.length === 0) {
      subscores.secret_only_in_env_file = 1
      diagnostics.push(`the key appears in no file but ${ENV_FILE}`)
    } else {
      for (const leak of leaks.slice(0, 8)) diagnostics.push(leak)
    }

    // ---- the tool is still there -------------------------------------------
    const inspection = await inspectCapabilities(workspaceDir)
    if (!inspection.ok) {
      diagnostics.push(`could not load the worker (${inspection.command}):\n${head(inspection.error ?? "", 15)}`)
      return { score: 0, subscores, diagnostics }
    }
    const tool = inspection.capabilities.find((c) => c.key === TOOL)
    if (tool?.tag === "tool") {
      subscores.registered = 1
    } else {
      diagnostics.push(
        `no tool named "${TOOL}" (registered: ${
          inspection.capabilities.map((c) => `${c.key}:${c.tag}`).join(", ") || "none"
        })`,
      )
      return { score: 0, subscores, diagnostics }
    }

    // ---- behavior: what `.env` says is what the tool runs with --------------
    const liveEnv = {
      [BASE_VAR]: fromEnvFile.get(BASE_VAR) ?? "",
      [KEY_VAR]: fromEnvFile.get(KEY_VAR) ?? "",
    }
    let commandLogged = false
    for (const testCase of CASES) {
      const input = { from: testCase.from, to: testCase.to, amount_cents: testCase.amount_cents }
      const outcome = await execCapability(workspaceDir, TOOL, input, { env: liveEnv })
      if (!commandLogged) {
        diagnostics.push(`exec path: ${outcome.mode} — ${outcome.command}`)
        commandLogged = true
      }
      if (!outcome.ok) {
        diagnostics.push(`${testCase.name}: ${TOOL} failed: ${head(outcome.error ?? "unknown error", 8)}`)
        continue
      }
      const problem = checkQuote(outcome.output, testCase, expectedQuote(KEY, testCase))
      if (problem) {
        diagnostics.push(`${testCase.name}: ${JSON.stringify(outcome.output)} — ${problem}`)
        continue
      }
      subscores[testCase.name] = 1
      diagnostics.push(`${testCase.name}: ${JSON.stringify(outcome.output)}`)
    }

    // ---- behavior, negative: both settings really come from the environment -
    const probeCase = CASES[0]
    const probeInput = {
      from: probeCase.from,
      to: probeCase.to,
      amount_cents: probeCase.amount_cents,
    }
    const rightAnswer = expectedQuote(KEY, probeCase)

    await withoutEnvFile(workspaceDir, async () => {
      const probes: Array<{ subscore: string; env: Record<string, string>; what: string }> = [
        {
          subscore: "base_read_from_env",
          env: { [BASE_VAR]: "https://not-meridian.example", [KEY_VAR]: KEY },
          what: `${BASE_VAR} pointed somewhere else`,
        },
        {
          subscore: "key_read_from_env",
          env: { [BASE_VAR]: BASE, [KEY_VAR]: "mfx_sandbox_000000000000000000" },
          what: `${KEY_VAR} set to a different sandbox key`,
        },
      ]
      for (const probe of probes) {
        const outcome = await execCapability(workspaceDir, TOOL, probeInput, { env: probe.env })
        const stillRight =
          outcome.ok && checkQuote(outcome.output, probeCase, rightAnswer) === undefined
        if (stillRight) {
          diagnostics.push(
            `with ${probe.what}, ${TOOL} still returned ${JSON.stringify(rightAnswer.quote_id)}` +
              " — the setting is baked into the code, not read from the environment",
          )
          continue
        }
        subscores[probe.subscore] = 1
        diagnostics.push(
          `with ${probe.what}, ${TOOL} ${
            outcome.ok ? `answered ${JSON.stringify(outcome.output)}` : `failed: ${head(outcome.error ?? "", 3)}`
          }`,
        )
      }
    })

    const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
    return { score: score as 0 | 1, subscores, diagnostics }
  } finally {
    await cleanupDriver(workspaceDir)
  }
}
