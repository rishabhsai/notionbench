/**
 * Subprocess entrypoint for a task verifier. Not a public API — `runTaskScorer`
 * in `run-eval.ts` is the only supported caller.
 *
 *     node <dist>/eval-harness.js <requestPath> <responsePath>
 *
 * It imports `<taskDir>/EVAL.ts` (Node >= 22.18 strips the types natively — the
 * same thing `evals/_lib/qc.ts` relies on), awaits its default export, and
 * writes the normalized result to `responsePath` as JSON.
 *
 * ## Why a subprocess at all
 *
 * A verifier is arbitrary task-authored code that shells out to `npm run build`,
 * loads the agent's modules, and monkeypatches whatever it needs to. Importing
 * it into the runner would let one bad task take down a multi-day grid: a
 * `process.exit()`, an unhandled rejection, a leaked global, an OOM, or simply a
 * module that never resolves. Out of process, all of those are just a non-zero
 * exit on one cell.
 *
 * The result travels through a *file*, not stdout: verifiers print freely (npm
 * does too), and the runner wants that output as failure evidence rather than
 * as a parsing hazard.
 */
import { readFile, rename, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

/** What the parent asks for. Mirrors `EvalArgs` plus enough to locate the module. */
interface EvalRequest {
  taskDir: string
  workspaceDir: string
  evalFilename: string
  ctx: Record<string, unknown>
}

/** What the parent reads back. `ok:false` means the verifier never returned. */
interface EvalResponse {
  ok: boolean
  score: number
  subscores: Record<string, number>
  diagnostics: string[]
  error?: string
}

type ScorerModule = {
  default?: (args: { workspaceDir: string; ctx?: Record<string, unknown> }) => unknown
}

function fail(error: string): EvalResponse {
  return { ok: false, score: 0, subscores: {}, diagnostics: [], error }
}

/**
 * Coerce whatever the verifier returned into the response shape.
 *
 * Deliberately strict about `score`: the contract is a number in [0,1], and a
 * verifier that returns `undefined`, `NaN` or `2` has a bug the run must
 * surface rather than round down to a silent zero.
 */
function normalize(value: unknown): EvalResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(`verifier resolved to ${describe(value)}; expected { score, diagnostics }`)
  }
  const raw = value as Record<string, unknown>
  const score = raw.score
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
    return fail(`verifier returned score=${JSON.stringify(score)}; expected a number in [0,1]`)
  }

  const subscores: Record<string, number> = {}
  if (raw.subscores !== null && typeof raw.subscores === "object" && !Array.isArray(raw.subscores)) {
    for (const [key, v] of Object.entries(raw.subscores as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) subscores[key] = v
    }
  }

  const diagnostics = Array.isArray(raw.diagnostics)
    ? raw.diagnostics.map((d) => (typeof d === "string" ? d : JSON.stringify(d) ?? String(d)))
    : []

  return { ok: true, score, subscores, diagnostics }
}

function describe(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  return `a ${typeof value}`
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`
  return String(err)
}

async function writeAtomic(filePath: string, text: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}`
  await writeFile(tmp, text, "utf8")
  await rename(tmp, filePath)
}

async function main(): Promise<number> {
  const [requestPath, responsePath] = process.argv.slice(2)
  if (!requestPath || !responsePath) {
    process.stderr.write("eval-harness: usage: eval-harness.js <requestPath> <responsePath>\n")
    return 2
  }

  let response: EvalResponse
  try {
    const request = JSON.parse(await readFile(requestPath, "utf8")) as EvalRequest
    const modulePath = path.join(request.taskDir, request.evalFilename)
    const mod = (await import(pathToFileURL(modulePath).href)) as ScorerModule
    if (typeof mod.default !== "function") {
      response = fail(`${request.evalFilename} has no default-exported function`)
    } else {
      // `taskDir` is what lets a verifier find its own expected/ and baseline/
      // fixtures; an explicit ctx entry from the runner still wins.
      const ctx = { taskDir: request.taskDir, ...request.ctx }
      response = normalize(await mod.default({ workspaceDir: request.workspaceDir, ctx }))
    }
  } catch (err) {
    response = fail(errorText(err))
  }

  try {
    await writeAtomic(responsePath, JSON.stringify(response))
  } catch (err) {
    process.stderr.write(`eval-harness: could not write the response: ${errorText(err)}\n`)
    return 3
  }
  return response.ok ? 0 : 1
}

// A verifier may leave timers or sockets behind (a stray `npm` child, an open
// watcher). The result is already durable on disk at this point, so exit hard
// rather than let the event loop hold the process open until the parent's
// timeout kills it.
main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`eval-harness: ${errorText(err)}\n`)
    process.exit(3)
  },
)
