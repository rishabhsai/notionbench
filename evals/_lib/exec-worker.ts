/**
 * Behavioral driver for Notion Workers tasks (verify layer `exec-local`).
 *
 * Two execution paths, tried in order:
 *
 *  1. **`ntn workers exec <key> --local -d '<json>'`** — the real developer
 *     command from the template's AGENTS.md. `--local` runs the worker through
 *     tsx on this machine; it needs no auth, no deploy, and no Business plan.
 *     `ntn` is a native binary distributed on npm, so we accept it either from
 *     `PATH` or via `npx --yes ntn@<pinned>` (which needs network on first use).
 *
 *  2. **in-process driver** — a tiny script written into the trial workspace and
 *     run with the template's own `tsx`. It imports `src/index.ts`, then calls
 *     `worker.run(key, input)`, which is exactly what path 1 does under the
 *     hood. Fully offline, and it can additionally introspect the registered
 *     capabilities (`worker.capabilities`) to assert things the CLI does not
 *     surface, such as whether a tool declared an `outputSchema`.
 *
 * Path 2 is the default when `ntn` is not installed, so scoring never depends
 * on a network round-trip. Set `NOTIONBENCH_EXEC_MODE=ntn|driver` to force one.
 */
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { NPX, exists, run, type RunResult } from "./proc.ts"

/** Pinned so a CLI release cannot silently change scoring behavior. */
export const NTN_VERSION = "0.21.6"

export type ExecMode = "ntn" | "driver"

export interface ExecOutcome {
  ok: boolean
  /** Parsed tool output when `ok`. */
  output?: unknown
  /** How it ran, for the run log. */
  mode: ExecMode
  /** The exact command line used (verbatim, for reproduction). */
  command: string
  error?: string
  raw?: RunResult
}

const DRIVER_NAME = ".notionbench-exec.ts"

const DRIVER_SOURCE = `// Written by notionbench; safe to delete.
// Mirrors what \`ntn workers exec <key> --local\` does: load the worker module
// and invoke the capability handler in-process.
const [mode, key, encoded] = process.argv.slice(2);
const mod = await import("./src/index.ts");
const worker = (mod as { default: any }).default;

function emit(value: unknown) {
  process.stdout.write("__NOTIONBENCH__" + JSON.stringify(value) + "\\n");
}

if (mode === "inspect") {
  emit({
    ok: true,
    capabilities: worker.capabilities.map((c: any) => ({
      key: c.key,
      tag: c._tag,
      title: c.config?.title ?? null,
      description: c.config?.description ?? null,
      schema: c.config?.schema ?? null,
      outputSchema: c.config?.outputSchema ?? null,
    })),
  });
} else {
  const input = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  try {
    const result = await worker.run(key, input);
    if (result && typeof result === "object" && "_tag" in result) {
      if (result._tag === "success") emit({ ok: true, output: result.value });
      else emit({ ok: false, error: result.error?.message ?? "tool returned an error" });
    } else {
      emit({ ok: true, output: result });
    }
  } catch (err) {
    emit({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
export {};
`

function parseSentinel(stdout: string): { ok: boolean; [key: string]: unknown } | undefined {
  for (const line of stdout.split("\n")) {
    if (line.startsWith("__NOTIONBENCH__")) {
      try {
        return JSON.parse(line.slice("__NOTIONBENCH__".length)) as { ok: boolean }
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

async function writeDriver(workspaceDir: string): Promise<string> {
  const file = path.join(workspaceDir, DRIVER_NAME)
  await fs.writeFile(file, DRIVER_SOURCE, "utf8")
  return file
}

/** Remove the driver again so the scored workspace is left as the agent left it. */
export async function cleanupDriver(workspaceDir: string): Promise<void> {
  await fs.rm(path.join(workspaceDir, DRIVER_NAME), { force: true })
}

async function ntnCommand(forced?: ExecMode): Promise<{ cmd: string; prefix: string[] } | undefined> {
  const mode = forced ?? process.env.NOTIONBENCH_EXEC_MODE
  if (mode === "driver") return undefined
  const probe = await run(process.platform === "win32" ? "where" : "which", ["ntn"], {
    cwd: process.cwd(),
    timeoutMs: 10_000,
  })
  if (probe.code === 0 && probe.stdout.trim()) return { cmd: "ntn", prefix: [] }
  if (mode === "ntn") return { cmd: NPX, prefix: ["--yes", `ntn@${NTN_VERSION}`] }
  return undefined
}

/**
 * Execute one worker capability with `input` and return its output.
 * Uses `ntn workers exec --local` when available, else the in-process driver.
 */
export async function execCapability(
  workspaceDir: string,
  key: string,
  input: unknown,
  opts: {
    timeoutMs?: number
    /**
     * Extra environment for the capability process.
     *
     * A *live* Workers task needs `NOTION_API_TOKEN` and `NOTION_API_BASE_URL`
     * — the two variables `createCapabilityContext` reads to build
     * `context.notion` — pointed at the per-trial fixture, and those are
     * per-invocation values, not ambient ones.
     */
    env?: NodeJS.ProcessEnv
    /** Pin the execution path instead of probing for `ntn`. */
    mode?: ExecMode
  } = {},
): Promise<ExecOutcome> {
  const timeoutMs = opts.timeoutMs ?? 120_000
  const data = JSON.stringify(input)

  const ntn = await ntnCommand(opts.mode)
  if (ntn) {
    const args = [...ntn.prefix, "workers", "exec", key, "--local", "-d", data]
    const command = `${ntn.cmd} ${args.join(" ")}`
    const result = await run(ntn.cmd, args, { cwd: workspaceDir, timeoutMs, env: opts.env })
    if (result.code === 0) {
      try {
        return { ok: true, output: JSON.parse(result.stdout), mode: "ntn", command, raw: result }
      } catch {
        return {
          ok: false,
          mode: "ntn",
          command,
          error: `stdout was not JSON: ${result.stdout.slice(0, 400)}`,
          raw: result,
        }
      }
    }
    return {
      ok: false,
      mode: "ntn",
      command,
      error: (result.stderr || result.stdout).trim().slice(0, 1000) || `exit ${result.code}`,
      raw: result,
    }
  }

  const driver = await writeDriver(workspaceDir)
  const encoded = Buffer.from(data, "utf8").toString("base64")
  const args = ["tsx", path.basename(driver), "exec", key, encoded]
  const command = `${NPX} ${args.join(" ")}`
  const result = await run(NPX, args, { cwd: workspaceDir, timeoutMs, env: opts.env })
  const parsed = parseSentinel(result.stdout)
  if (!parsed) {
    return {
      ok: false,
      mode: "driver",
      command,
      error: (result.stderr || result.stdout).trim().slice(0, 1000) || `exit ${result.code}`,
      raw: result,
    }
  }
  return {
    ok: parsed.ok,
    output: parsed.output,
    mode: "driver",
    command,
    error: typeof parsed.error === "string" ? parsed.error : undefined,
    raw: result,
  }
}

export interface CapabilityInfo {
  key: string
  tag: string
  title: string | null
  description: string | null
  schema: unknown
  outputSchema: unknown
}

/**
 * List the capabilities the worker registers, with their JSON schemas.
 * Always uses the in-process driver: the CLI has no equivalent read-only view.
 */
export async function inspectCapabilities(
  workspaceDir: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; capabilities: CapabilityInfo[]; error?: string; command: string }> {
  const driver = await writeDriver(workspaceDir)
  const args = ["tsx", path.basename(driver), "inspect"]
  const command = `${NPX} ${args.join(" ")}`
  const result = await run(NPX, args, { cwd: workspaceDir, timeoutMs: opts.timeoutMs ?? 120_000 })
  const parsed = parseSentinel(result.stdout)
  if (!parsed?.ok) {
    return {
      ok: false,
      capabilities: [],
      command,
      error: (result.stderr || result.stdout).trim().slice(0, 1000) || `exit ${result.code}`,
    }
  }
  return { ok: true, capabilities: (parsed.capabilities as CapabilityInfo[]) ?? [], command }
}

/** True when the workspace has an installed `tsx` (the driver's only need). */
export async function hasTsx(workspaceDir: string): Promise<boolean> {
  return exists(path.join(workspaceDir, "node_modules", ".bin", "tsx"))
}
