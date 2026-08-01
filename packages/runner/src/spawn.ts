/**
 * One trial = one headless agent-CLI process.
 *
 * The runner shells out to the *commercial* CLIs (`claude`, `codex`) authenticated by
 * the user's subscription — see docs/PLAN.md. Everything here exists to make that
 * reproducible and auditable: fixed argv (never a shell string), an explicitly built
 * env, a lossless transcript, a hard wall-clock kill, and defensive usage parsing.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { apiEquivalentCostUsd, type AgentConfig } from './config.js';
import { getAdapter } from './parsers/index.js';
import type { ParsedTranscript, RateLimitSignal } from './parsers/types.js';
import { compilePatterns, cooldownFor, scanForRateLimit, type CompiledPatterns } from './rate-limit.js';
import { LineSplitter, TranscriptWriter } from './transcript.js';
import type { DocsCondition, TokenUsage } from './types.js';

/**
 * Env vars removed from every child. PLAN.md measures *subscription* runs; a stray
 * API key on the operator's machine would silently reroute billing and change the
 * thing being measured. Removing them is a correctness requirement, not hygiene.
 */
export const STRIPPED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORGANIZATION',
];

/** Env keys whose values must never be written to disk or logs. */
const SECRET_ENV_KEYS = new Set(['NOTION_API_TOKEN', 'NOTION_TOKEN', 'GITHUB_TOKEN']);

/** Cap on how much output we retain in memory for parsing (disk capture is uncapped). */
const MAX_RETAINED_BYTES = 64 * 1024 * 1024;

export type TrialStatus =
  | 'completed' // process exited 0 and did not look rate-limited
  | 'failed' // process exited non-zero, or the harness reported an error
  | 'timeout' // wall clock exceeded; SIGTERM/SIGKILL applied
  | 'rate_limited' // subscription usage window exhausted — NOT a task failure
  | 'spawn_error'; // could not launch the CLI at all (missing binary, EACCES, …)

export interface TrialIdentity {
  runId: string;
  taskId: string;
  configId: string;
  docsCondition: DocsCondition;
  trial: number;
}

export interface RunTrialOptions {
  config: AgentConfig;
  identity: TrialIdentity;
  /** Full task prompt text. */
  prompt: string;
  /** Prepared workspace (see @notionbench/sandbox `prepareWorkspace`). Becomes cwd. */
  workspaceDir: string;
  /** results/<runId>/<taskId>/<configId>/<docs>/trial-<n>. Created if missing. */
  trialDir: string;
  timeoutMs: number;
  killGraceMs?: number;
  /** Per-trial `NOTION_HOME` tmpdir so `ntn` state never leaks between trials. */
  notionHome?: string;
  /** Leased Notion integration token for `live` tasks. Never written to disk. */
  notionApiToken?: string;
  extraEnv?: Record<string, string>;
  ratePatterns?: CompiledPatterns;
  /** Cooldown applied when a rate window is hit and the CLI gave no reset time. */
  defaultCooldownMs?: number;
  /** Cancel an in-flight trial (used for run-level shutdown). */
  signal?: AbortSignal;
  /** Optional live tap for progress UIs. */
  onLine?: (stream: 'out' | 'err', line: string) => void;
  /** Injectable for tests. */
  now?: () => number;
}

export interface TrialOutcome {
  identity: TrialIdentity;
  status: TrialStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** results/<runId>/<taskId>/<configId>/docs-<cond>/trial-<n>. */
  trialDir: string;
  transcriptPath: string;
  resultPath: string;
  workspaceDir: string;
  parsed: ParsedTranscript;
  usage: TokenUsage | null;
  /**
   * Published-price estimate; subscription runs have no real per-run $.
   *
   * TODO(cost): some harnesses report a cost the *provider* computed —
   * `parsed.reportedCostUsd` (claude-code's `total_cost_usd`, opencode's summed
   * per-step `cost`). That is strictly better than a list-price estimate and the cost
   * column should prefer it when present. Not wired here because it is not a one-line
   * change: it touches this field's meaning, checkpoint.ts's cell aggregate,
   * serve.ts's run total and scoring's report, and claude-code's figure is
   * deliberately ignored today for subscription runs (see ParsedTranscript.reportedCostUsd).
   * `parsed.reportedCostUsd` is already persisted into result.json, so no data is lost
   * in the meantime.
   */
  apiEquivalentCostUsd?: number;
  rateLimit: {
    detected: boolean;
    signals: RateLimitSignal[];
    /** Suggested pause for this config, ms. Only set when detected. */
    cooldownMs?: number;
  };
  invocation: {
    command: string;
    args: string[];
    cwd: string;
    /** Env var NAMES only — values may contain the leased Notion token. */
    envKeys: string[];
    cliVersion?: string;
  };
  stdoutBytes: number;
  stderrBytes: number;
  /** True when output exceeded the in-memory retention cap (disk copy is complete). */
  truncatedInMemory: boolean;
  error?: string;
}

export interface BuildEnvOptions {
  notionHome?: string;
  notionApiToken?: string;
  configEnv?: Record<string, string>;
  extraEnv?: Record<string, string>;
  base?: NodeJS.ProcessEnv;
}

/** Build the child env: base minus API keys, plus per-trial Notion isolation. */
export function buildTrialEnv(opts: BuildEnvOptions = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(opts.base ?? process.env) };
  for (const k of STRIPPED_ENV_KEYS) delete env[k];

  // Non-interactive, deterministic-ish output.
  env.CI = '1';
  env.NO_COLOR = '1';
  env.TERM = 'dumb';

  // Per-trial `ntn` isolation (docs/PLAN.md "Fixtures & isolation").
  if (opts.notionHome) env.NOTION_HOME = opts.notionHome;
  // Never touch the operator's OS keychain from a benchmark trial.
  env.NOTION_KEYRING = '0';
  if (opts.notionApiToken) env.NOTION_API_TOKEN = opts.notionApiToken;

  if (opts.configEnv) Object.assign(env, opts.configEnv);
  if (opts.extraEnv) Object.assign(env, opts.extraEnv);
  return env;
}

/** Env var names, with secret-bearing names marked so nothing leaks into results. */
export function redactedEnvKeys(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .sort()
    .map((k) => (SECRET_ENV_KEYS.has(k) ? `${k}=<redacted>` : k));
}

const versionCache = new Map<string, string>();

/** `<cli> --version`, cached per process. Pinned into run metadata (PLAN.md). */
export async function getCliVersion(command: string, versionArgs: string[]): Promise<string | undefined> {
  const key = `${command} ${versionArgs.join(' ')}`;
  const cached = versionCache.get(key);
  if (cached !== undefined) return cached || undefined;
  const version = await new Promise<string>((resolve) => {
    let out = '';
    let done = false;
    const finish = (v: string) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let child: ChildProcess;
    try {
      child = spawn(command, versionArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      finish('');
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(out.trim());
    }, 15_000);
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish('');
    });
    child.on('close', () => {
      clearTimeout(timer);
      finish(out.trim().split('\n')[0] ?? '');
    });
  });
  versionCache.set(key, version);
  return version || undefined;
}

/** Reset the version cache (tests). */
export function clearVersionCache(): void {
  versionCache.clear();
}

export async function runTrial(opts: RunTrialOptions): Promise<TrialOutcome> {
  const now = opts.now ?? (() => Date.now());
  const adapter = getAdapter(opts.config.harness);
  const invocation = adapter.buildInvocation(opts.config, {
    prompt: opts.prompt,
    workspaceDir: opts.workspaceDir,
  });
  const env = buildTrialEnv({
    notionHome: opts.notionHome,
    notionApiToken: opts.notionApiToken,
    configEnv: opts.config.env,
    extraEnv: opts.extraEnv,
  });
  const patterns = opts.ratePatterns ?? compilePatterns();
  const killGraceMs = opts.killGraceMs ?? 10_000;

  await mkdir(opts.trialDir, { recursive: true });
  const transcriptPath = path.join(opts.trialDir, 'transcript.jsonl');
  const resultPath = path.join(opts.trialDir, 'result.json');

  const t0 = now();
  const startedAt = new Date(t0).toISOString();
  const writer = new TranscriptWriter(transcriptPath, t0);
  await writer.open();

  const cliVersion = await getCliVersion(invocation.command, invocation.versionArgs);

  writer.write({
    s: 'meta',
    event: 'start',
    startedAt,
    identity: opts.identity,
    config: {
      id: opts.config.id,
      harness: opts.config.harness,
      model: opts.config.model,
      reasoningEffort: opts.config.reasoningEffort ?? null,
    },
    invocation: {
      command: invocation.command,
      args: invocation.args,
      cwd: opts.workspaceDir,
      cliVersion: cliVersion ?? null,
    },
    // Names only. NOTION_API_TOKEN's value must never reach the results tree.
    envKeys: redactedEnvKeys(env),
    timeoutMs: opts.timeoutMs,
    promptBytes: Buffer.byteLength(opts.prompt, 'utf8'),
  });

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncatedInMemory = false;
  let timedOut = false;
  let spawnError: Error | undefined;

  const outSplit = new LineSplitter();
  const errSplit = new LineSplitter();

  const retain = (bucket: string[], line: string, bytes: number): void => {
    if (bytes > MAX_RETAINED_BYTES) {
      truncatedInMemory = true;
      return;
    }
    bucket.push(line);
  };

  let child: ChildProcess | undefined;
  try {
    child = spawn(invocation.command, invocation.args, {
      cwd: opts.workspaceDir,
      env,
      // 'ignore' on stdin for the presets: codex would otherwise read piped stdin
      // and append it as a <stdin> block, mutating the prompt under measurement.
      // A command-template config can instead ask for the prompt on stdin.
      stdio: [invocation.stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      // Own process group so a timeout kills the CLI's grandchildren (the agent's
      // own `bash` tool calls) rather than orphaning them.
      detached: true,
      windowsHide: true,
    });
  } catch (err) {
    spawnError = err as Error;
  }

  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;

  if (child && !spawnError) {
    const c = child;
    c.stdout?.setEncoding('utf8');
    c.stderr?.setEncoding('utf8');

    if (invocation.stdin !== 'ignore' && c.stdin) {
      // Close immediately after writing so the child never waits for more input.
      c.stdin.on('error', () => {
        /* child may exit before draining; not a trial failure */
      });
      c.stdin.end(invocation.stdin.write, 'utf8');
    }

    c.stdout?.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, 'utf8');
      for (const line of outSplit.push(chunk)) {
        writer.line('out', line);
        retain(stdoutLines, line, stdoutBytes);
        opts.onLine?.('out', line);
      }
    });
    c.stderr?.on('data', (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk, 'utf8');
      for (const line of errSplit.push(chunk)) {
        writer.line('err', line);
        retain(stderrLines, line, stderrBytes);
        opts.onLine?.('err', line);
      }
    });

    let killTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      timedOut = false;
      killTree(c, 'SIGTERM');
      graceTimer = setTimeout(() => killTree(c, 'SIGKILL'), killGraceMs);
    };

    killTimer = setTimeout(() => {
      timedOut = true;
      writer.write({ s: 'meta', event: 'timeout', action: 'SIGTERM', timeoutMs: opts.timeoutMs });
      killTree(c, 'SIGTERM');
      graceTimer = setTimeout(() => {
        writer.write({ s: 'meta', event: 'timeout', action: 'SIGKILL', graceMs: killGraceMs });
        killTree(c, 'SIGKILL');
      }, killGraceMs);
    }, opts.timeoutMs);

    opts.signal?.addEventListener('abort', onAbort, { once: true });

    await new Promise<void>((resolve) => {
      c.on('error', (err) => {
        spawnError = err;
        resolve();
      });
      c.on('close', (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        resolve();
      });
    });

    if (killTimer) clearTimeout(killTimer);
    if (graceTimer) clearTimeout(graceTimer);
    opts.signal?.removeEventListener('abort', onAbort);
  }

  // Flush partial trailing lines.
  for (const line of outSplit.flush()) {
    writer.line('out', line);
    retain(stdoutLines, line, stdoutBytes);
  }
  for (const line of errSplit.flush()) {
    writer.line('err', line);
    retain(stderrLines, line, stderrBytes);
  }

  const parsed = spawnError
    ? {
        usage: null,
        usageRaw: null,
        toolCalls: 0,
        toolErrors: 0,
        rateLimitSignals: [],
        parseWarnings: [`process never produced output: ${spawnError.message}`],
      }
    : adapter.parse({ stdoutLines, stderrLines });

  // Where to look for rate-window evidence. Deliberately NOT the whole transcript:
  // a task about rate limits (operate-batch-001) would otherwise self-trip.
  const textToScan = [...stderrLines];
  if (parsed.finalText) textToScan.push(parsed.finalText);
  if (parsed.harnessError) textToScan.push(parsed.harnessError);
  const textSignals = scanForRateLimit(textToScan, 'stderr-text', patterns);
  const structuralSignals = parsed.rateLimitSignals;

  const failedish = exitCode !== 0 || parsed.harnessError !== undefined || timedOut;
  // Structured evidence is trusted on its own; free text only counts when the run
  // also went wrong (an agent may legitimately *print* the word "rate limit").
  const rateLimited = structuralSignals.length > 0 || (textSignals.length > 0 && failedish);
  const signals = [...structuralSignals, ...(rateLimited ? textSignals : [])];

  const finishedAtMs = now();
  let status: TrialStatus;
  if (spawnError) status = 'spawn_error';
  else if (rateLimited) status = 'rate_limited';
  else if (timedOut) status = 'timeout';
  else if (exitCode === 0 && parsed.harnessError === undefined) status = 'completed';
  else status = 'failed';

  const usage = parsed.usage;
  const outcome: TrialOutcome = {
    identity: opts.identity,
    status,
    exitCode,
    signal: exitSignal,
    timedOut,
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - t0,
    trialDir: opts.trialDir,
    transcriptPath,
    resultPath,
    workspaceDir: opts.workspaceDir,
    parsed,
    usage,
    apiEquivalentCostUsd: usage ? apiEquivalentCostUsd(opts.config, usage) : undefined,
    rateLimit: {
      detected: rateLimited,
      signals,
      cooldownMs: rateLimited
        ? cooldownFor(signals, opts.defaultCooldownMs ?? 30 * 60 * 1000, finishedAtMs)
        : undefined,
    },
    invocation: {
      command: invocation.command,
      args: invocation.args,
      cwd: opts.workspaceDir,
      envKeys: redactedEnvKeys(env),
      cliVersion,
    },
    stdoutBytes,
    stderrBytes,
    truncatedInMemory,
    error: spawnError?.message,
  };

  writer.write({
    s: 'meta',
    event: 'end',
    status,
    exitCode,
    signal: exitSignal,
    timedOut,
    durationMs: outcome.durationMs,
    usage,
    usageRaw: parsed.usageRaw,
    toolCalls: parsed.toolCalls,
    toolErrors: parsed.toolErrors,
    rateLimit: outcome.rateLimit,
    parseWarnings: parsed.parseWarnings,
    stdoutBytes,
    stderrBytes,
  });
  await writer.close();

  await writeJsonAtomic(resultPath, outcome);
  return outcome;
}

/** Kill the child's whole process group, falling back to the child alone. */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    // Negative pid targets the group created by `detached: true`.
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/** Crash-safe write: temp file then rename (atomic on the same filesystem). */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, filePath);
}
