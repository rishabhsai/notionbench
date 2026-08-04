/**
 * Agent configs — the unit of measurement for NotionBench.
 *
 * Per docs/PLAN.md a "config" is a (harness, model, reasoningEffort?) bundle run
 * headlessly against the user's *subscription* (not an API key). The docs axis
 * (`with` / `without` Notion's AGENTS.md+skills) multiplies every config; it is
 * carried on the run cell rather than baked into the config, except when a config
 * deliberately pins itself to one condition via `docsCondition`.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_WATCHDOG_SETTINGS,
  resolveWatchdogSettings,
  type DeepPartial,
  type WatchdogSettings,
} from './watchdog.js';
import type { DocsCondition, HarnessId } from './types.js';

export interface AgentConfig {
  /** Stable slug; becomes a path segment under results/<run>/<task>/<configId>/. */
  id: string;
  /** Human label for tables/charts. */
  label: string;
  harness: HarnessId;
  /**
   * Model selector passed to the harness CLI. For claude-code this is the
   * `--model` value (alias like `opus`/`fable` or a full id like `claude-opus-5`);
   * for codex it is `-m` / `model=`.
   */
  model: string;
  /**
   * Reasoning/thinking effort. claude-code: `--effort <low|medium|high|xhigh|max>`.
   * codex: `-c model_reasoning_effort="<minimal|low|medium|high|xhigh>"`.
   */
  reasoningEffort?: string;
  /** Pin this config to a single docs condition. Normally undefined (run both). */
  docsCondition?: DocsCondition;
  /** Disabled configs are kept in the roster for documentation but never scheduled. */
  enabled: boolean;
  /**
   * Published per-token prices used for the API-equivalent cost column. Subscription
   * runs have no true per-run $; PLAN.md says report tokens + API-equivalent cost.
   * USD per 1M tokens.
   */
  pricing?: {
    inputPerMTok?: number;
    outputPerMTok?: number;
    cacheReadPerMTok?: number;
    cacheWritePerMTok?: number;
  };
  /**
   * `command-template` harness only: the executable to run. The README commits to
   * supporting any prompt-in/files-out CLI, not just the claude-code/codex presets.
   */
  command?: string;
  /**
   * `command-template` harness only: argv with placeholders `{prompt}`,
   * `{workspace}`, `{model}`, `{effort}`, `{configId}`.
   */
  argsTemplate?: string[];
  /** `command-template` harness only: deliver the prompt on stdin instead of argv. */
  promptVia?: 'argv' | 'stdin';
  /** `command-template` harness only: how to ask the CLI for its version. */
  versionArgs?: string[];
  /** Extra CLI args appended verbatim to the invocation (escape hatch). */
  extraArgs?: string[];
  /** Extra env vars for the child process. */
  env?: Record<string, string>;
  /** Free-form note surfaced in run metadata (e.g. why a config is disabled). */
  note?: string;
}

export interface RateWindowConfig {
  /**
   * Regex sources (JS syntax, matched case-insensitively unless flags given)
   * applied to the child's stderr/stdout to detect subscription usage-limit
   * exhaustion. Kept configurable because these strings drift between CLI releases.
   */
  patterns: string[];
  /** How long to pause a config after a rate-window hit. Default 30 min. */
  cooldownMs: number;
}

/**
 * Where `runtime: live` fixtures are created.
 *
 * Deliberately holds no token: `NOTION_API_TOKEN` (or `NOTIONBENCH_NOTION_TOKENS`
 * for a pool) stays in the environment, because runconfig.json is a file people
 * check in and paste into issues. The page id is not a secret — it is the one
 * page an operator shares with the integration once, under which every per-trial
 * fixture root is created and archived.
 *
 * Environment variables win over these: the file is the project's default, the
 * environment is this operator on this machine.
 */
export interface NotionConfig {
  /**
   * Page id every per-trial fixture root is created under. Overridden by
   * `NOTION_PARENT_PAGE_ID`. Never the workspace root — a workspace-level page
   * cannot be archived through the API, so a run that created one would leak an
   * un-deletable page per trial.
   */
  parentPageId?: string;
  /** API root. Default `https://api.notion.com`. Overridden by `NOTION_API_BASE`. */
  apiBase?: string;
}

export interface RunConfigFile {
  /** Configs to schedule. */
  configs: AgentConfig[];
  /** Live-fixture destination. Only consulted when live tasks are in the grid. */
  notion?: NotionConfig;
  /** Global in-flight trial cap across all configs. Default 2. */
  concurrency?: number;
  /** Default trials per (task, config, docsCondition) cell. Default 5. */
  trials?: number;
  /** Default per-trial wall clock timeout in seconds; tasks may override. */
  timeoutSec?: number;
  /** Grace period between SIGTERM and SIGKILL, ms. Default 10_000. */
  killGraceMs?: number;
  /** Max attempts per cell before it is marked failed for good. Default 3. */
  maxAttempts?: number;
  rateWindow?: Partial<RateWindowConfig>;
  /**
   * Thresholds for the in-process run watchdog (watchdog.ts). Every field is
   * optional and merges over the documented defaults; omitting the block
   * entirely is the same as accepting them.
   */
  watchdog?: DeepPartial<WatchdogSettings>;
  /** Where results trees are written. Default `results/`. */
  resultsRoot?: string;
  /** Where task directories live. Default `evals/`. */
  evalsRoot?: string;
}

export const DEFAULT_RATE_LIMIT_PATTERNS: string[] = [
  // Claude Code
  'rate[ _-]?limit(ed|ing)?\\b',
  '\\b(five|5)[- ]hour limit',
  'weekly limit (reached|exceeded)',
  'usage limit (reached|exceeded)',
  "you'?ve (hit|reached) your usage limit",
  'upgrade to increase your usage limit',
  'claude usage limit reached',
  // Codex / OpenAI
  "you'?ve hit your usage limit",
  'usage_limit_reached',
  'quota exceeded',
  'insufficient_quota',
  'too many requests',
  // OpenCode Go. Taken from the English strings in opencode 1.18.10:
  // dialog.usageExceeded.accountRateLimit.title = "Go limit reached" (its
  // .description = "Usage limit reached. …" is already covered above), the structured
  // reason that accompanies it, and ui.sessionTurn.error.freeUsageExceeded.
  // Additive only — none of the patterns above changed.
  'go limit reached',
  'account_rate_limit',
  'free usage exceeded',
  // Generic HTTP surface both CLIs bubble up
  '\\b429\\b',
  'retry[- ]after',
];

/** 30 minutes — a subscription 5h window rarely clears faster than this. */
export const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_TRIALS = 5;
export const DEFAULT_TIMEOUT_SEC = 900;
export const DEFAULT_KILL_GRACE_MS = 10_000;
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * v1 roster (docs/PLAN.md "Configs").
 *
 * Model ids/aliases verified against the CLIs installed on the authoring machine:
 *   claude 2.1.220  — `--model` accepts aliases (`opus`, `fable`, `sonnet`) or full names.
 *   codex-cli 0.144.6 — `-m gpt-5.6-sol`, effort via `-c model_reasoning_effort=...`.
 * Pin the exact CLI versions into run metadata (spawn.ts records them).
 */
export const V1_ROSTER: AgentConfig[] = [
  {
    id: 'claude-code-opus-5',
    label: 'Claude Code × Opus 5',
    harness: 'claude-code',
    model: 'opus',
    enabled: true,
    pricing: {
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheReadPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
    },
  },
  {
    id: 'claude-code-fable-5',
    label: 'Claude Code × Fable 5',
    harness: 'claude-code',
    model: 'fable',
    enabled: true,
    pricing: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    },
    // TODO(pricing): confirm published Fable 5 per-token rates before publishing
    // the cost-Pareto chart; these are placeholders.
  },
  {
    id: 'codex-gpt-5.6-sol-medium',
    label: 'Codex × GPT-5.6 Sol (medium)',
    harness: 'codex',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    enabled: true,
    // TODO(pricing): fill from OpenAI's published GPT-5.6 Sol rates.
  },
  {
    id: 'codex-gpt-5.6-sol-high',
    label: 'Codex × GPT-5.6 Sol (high)',
    harness: 'codex',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    enabled: true,
  },
  {
    id: 'claude-code-haiku-4-5',
    label: 'Claude Code × Haiku 4.5 (budget)',
    harness: 'claude-code',
    model: 'haiku',
    enabled: false,
    note: 'Budget config for the cost-Pareto story (PLAN.md). Enable once the main grid has headroom in the rate window.',
  },
  {
    id: 'tera',
    label: 'Tera (placeholder)',
    harness: 'tera',
    model: 'TODO',
    enabled: false,
    note:
      'TODO(invocation): no Tera CLI is installed on the authoring machine, so the ' +
      'headless invocation is unverified. Before enabling: (1) confirm a subscription ' +
      'or affordable API path exists at all — PLAN.md says cut this config otherwise; ' +
      '(2) capture `<cli> --help` and fill in a harness adapter in src/parsers/ that ' +
      'returns argv + a usage parser; (3) pin the CLI version. Scheduling this config ' +
      'without an adapter throws by design rather than silently producing null usage.',
  },
  {
    id: 'luna',
    label: 'Luna (placeholder)',
    harness: 'luna',
    model: 'TODO',
    enabled: false,
    note:
      'TODO(invocation): same as `tera` — unverified headless syntax, no adapter yet. ' +
      'Confirm model id + pricing (PLAN.md open item) before enabling.',
  },
];

/**
 * Where to look for tasks when nothing said otherwise.
 *
 * Installed from npm there is no `./evals` to find, so the CLI would report
 * "no tasks found" out of the box; the suite is vendored into the package at
 * prepack (see scripts/bundle-evals.mjs) and this is what locates it.
 *
 * A checkout's own `./evals` is preferred over the bundled copy so that editing
 * a task and re-running is still immediate — otherwise a developer with the repo
 * open would silently score the packaged snapshot instead of their edits.
 */
export function defaultEvalsRoot(): string {
  const override = process.env.NOTIONBENCH_EVALS;
  if (override) return override;

  const cwdEvals = path.resolve('evals');
  if (existsSync(cwdEvals)) return cwdEvals;

  // dist/config.js -> <package>/evals. Probed via _lib rather than the directory
  // itself: an interrupted pack (or a sync client racing postpack) can leave an
  // empty evals/ behind, and extracting that would report zero tasks rather than
  // falling through to the error that names the directory to create.
  const bundled = fileURLToPath(new URL('../evals', import.meta.url));
  if (existsSync(path.join(bundled, '_lib'))) return materializeBundledEvals(bundled);

  // Nothing found: keep the historical relative default so the error message
  // points at the directory the user most likely meant to create.
  return cwdEvals;
}

/**
 * Copy the bundled suite out of `node_modules` and return the copy's path.
 *
 * Node refuses to strip types from any file under `node_modules` — not even with
 * `--experimental-strip-types` — and every verifier is a TypeScript `EVAL.ts`
 * that the harness imports in place. Left where npm installs it the suite lists
 * and plans fine but fails to score, so the tasks have to live somewhere else.
 *
 * They are copied rather than compiled to JS at publish time on purpose: a
 * published score only means the same thing as a local one if the exact same
 * verifier bytes produced it, and a build step between the two is a place for
 * them to diverge silently.
 *
 * Falls back to the in-package path if the cache cannot be written — `tasks` and
 * `run --dry-run` only read PROMPT.md and still work from there.
 */
function materializeBundledEvals(bundled: string): string {
  const version = bundledVersion(bundled);
  const cacheHome =
    process.env.NOTIONBENCH_CACHE ??
    process.env.XDG_CACHE_HOME ??
    path.join(homedir(), '.cache');
  const dest = path.join(cacheHome, 'notionbench', `evals-${version}`);

  // The stamp is written last and only on a fully populated copy, so a run
  // interrupted mid-copy re-does it instead of scoring a half-present suite.
  const stamp = path.join(dest, '.notionbench-complete');
  if (existsSync(stamp)) return dest;

  try {
    mkdirSync(path.dirname(dest), { recursive: true });
    // Stage then rename: two concurrent runs must never observe a partial tree.
    const staged = mkdtempSync(`${dest}.tmp-`);
    cpSync(bundled, staged, { recursive: true });
    vendorScoringInto(staged);
    writeFileSync(path.join(staged, '.notionbench-complete'), version);
    rmSync(dest, { recursive: true, force: true });
    renameSync(staged, dest);
    return dest;
  } catch {
    return bundled;
  }
}

/**
 * Give the extracted suite its own `node_modules/@notionbench/scoring`.
 *
 * Every verifier imports the scoring helpers by name, and Node resolves that by
 * walking up from the task directory. In the workspace that lands on
 * `evals/node_modules` (a pnpm symlink); once the suite is copied to the cache
 * it would walk up into the user's home directory and find nothing, so the same
 * layout is reproduced here.
 *
 * Copied, not symlinked: the cache outlives any single `npx` invocation, and a
 * link into a temporary install tree would dangle the moment npm cleaned it up.
 */
function vendorScoringInto(evalsDir: string): void {
  const entry = createRequire(import.meta.url).resolve('@notionbench/scoring');
  let root = path.dirname(entry);
  while (!existsSync(path.join(root, 'package.json'))) {
    const parent = path.dirname(root);
    if (parent === root) return;
    root = parent;
  }
  const dest = path.join(evalsDir, 'node_modules', '@notionbench', 'scoring');
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(root, dest, { recursive: true, dereference: true });
}

/** Version of the installed package, used to invalidate the extracted copy. */
function bundledVersion(bundled: string): string {
  try {
    const manifest = path.resolve(bundled, '../package.json');
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    const version = (parsed as { version?: unknown }).version;
    if (typeof version === 'string' && version.length > 0) return version;
  } catch {
    // fall through
  }
  return 'unknown';
}

export function defaultRunConfig(): Required<Omit<RunConfigFile, 'rateWindow' | 'watchdog'>> & {
  rateWindow: RateWindowConfig;
  watchdog: WatchdogSettings;
} {
  return {
    configs: V1_ROSTER,
    watchdog: DEFAULT_WATCHDOG_SETTINGS,
    concurrency: DEFAULT_CONCURRENCY,
    trials: DEFAULT_TRIALS,
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    killGraceMs: DEFAULT_KILL_GRACE_MS,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    resultsRoot: 'results',
    evalsRoot: defaultEvalsRoot(),
    // Empty by default: an offline grid needs no Notion workspace at all, and a
    // live grid is expected to configure this via the environment.
    notion: {},
    rateWindow: {
      patterns: DEFAULT_RATE_LIMIT_PATTERNS,
      cooldownMs: DEFAULT_COOLDOWN_MS,
    },
  };
}

export type ResolvedRunConfig = ReturnType<typeof defaultRunConfig>;

export class ConfigError extends Error {}

/** Merge a partial runconfig.json over the built-in defaults + v1 roster. */
export function resolveRunConfig(file: Partial<RunConfigFile> = {}): ResolvedRunConfig {
  const base = defaultRunConfig();
  const configs = file.configs && file.configs.length > 0 ? file.configs.map(normalizeConfig) : base.configs;
  assertUniqueIds(configs);
  return {
    configs,
    concurrency: positive(file.concurrency, base.concurrency, 'concurrency'),
    trials: positive(file.trials, base.trials, 'trials'),
    timeoutSec: positive(file.timeoutSec, base.timeoutSec, 'timeoutSec'),
    killGraceMs: positive(file.killGraceMs, base.killGraceMs, 'killGraceMs'),
    maxAttempts: positive(file.maxAttempts, base.maxAttempts, 'maxAttempts'),
    resultsRoot: file.resultsRoot ?? base.resultsRoot,
    evalsRoot: file.evalsRoot ?? base.evalsRoot,
    notion: normalizeNotion(file.notion),
    watchdog: resolveWatchdogSettings(file.watchdog),
    rateWindow: {
      patterns: file.rateWindow?.patterns ?? base.rateWindow.patterns,
      cooldownMs: positive(file.rateWindow?.cooldownMs, base.rateWindow.cooldownMs, 'rateWindow.cooldownMs'),
    },
  };
}

/** Load runconfig.json from disk; missing file falls back to built-in defaults. */
export async function loadRunConfig(filePath?: string): Promise<ResolvedRunConfig> {
  if (!filePath) return resolveRunConfig();
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new ConfigError(`runconfig not found: ${path.resolve(filePath)}`);
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`runconfig is not valid JSON (${filePath}): ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`runconfig must be a JSON object (${filePath})`);
  }
  return resolveRunConfig(parsed as Partial<RunConfigFile>);
}

function normalizeConfig(c: AgentConfig): AgentConfig {
  if (!c || typeof c.id !== 'string' || c.id.length === 0) {
    throw new ConfigError('every config needs a non-empty string id');
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(c.id)) {
    throw new ConfigError(`config id "${c.id}" must be filesystem-safe (letters, digits, . _ -)`);
  }
  if (typeof c.harness !== 'string' || c.harness.length === 0) {
    throw new ConfigError(`config "${c.id}" needs a harness`);
  }
  if (typeof c.model !== 'string' || c.model.length === 0) {
    throw new ConfigError(`config "${c.id}" needs a model`);
  }
  return { ...c, label: c.label ?? c.id, enabled: c.enabled !== false };
}

/**
 * Validate the `notion` block eagerly.
 *
 * A typo here is only discovered ~hours into a live grid otherwise — every cell
 * failing to provision against a page id that is actually the string "undefined"
 * — so the cheap check happens at config load.
 */
function normalizeNotion(notion: NotionConfig | undefined): NotionConfig {
  if (notion === undefined) return {};
  if (typeof notion !== 'object' || notion === null || Array.isArray(notion)) {
    throw new ConfigError('notion must be an object, e.g. { "parentPageId": "…" }');
  }
  const out: NotionConfig = {};
  if (notion.parentPageId !== undefined) {
    if (typeof notion.parentPageId !== 'string' || notion.parentPageId.trim().length === 0) {
      throw new ConfigError('notion.parentPageId must be a non-empty string (a Notion page id)');
    }
    out.parentPageId = notion.parentPageId.trim();
  }
  if (notion.apiBase !== undefined) {
    if (typeof notion.apiBase !== 'string' || !/^https?:\/\//i.test(notion.apiBase.trim())) {
      throw new ConfigError(
        `notion.apiBase must be an http(s) URL (got ${JSON.stringify(notion.apiBase)})`,
      );
    }
    out.apiBase = notion.apiBase.trim().replace(/\/+$/, '');
  }
  if ('token' in notion || 'apiToken' in notion) {
    throw new ConfigError(
      'notion.token is not supported: the integration token belongs in NOTION_API_TOKEN ' +
        '(or NOTIONBENCH_NOTION_TOKENS), never in a checked-in runconfig.json',
    );
  }
  return out;
}

function assertUniqueIds(configs: AgentConfig[]): void {
  const seen = new Set<string>();
  for (const c of configs) {
    if (seen.has(c.id)) throw new ConfigError(`duplicate config id: ${c.id}`);
    seen.add(c.id);
  }
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive number (got ${String(value)})`);
  }
  return value;
}

/** Look up configs by id, erroring loudly on typos and disabled configs. */
export function selectConfigs(
  all: AgentConfig[],
  ids: string[] | undefined,
  opts: { includeDisabled?: boolean } = {},
): AgentConfig[] {
  if (!ids || ids.length === 0) {
    return all.filter((c) => c.enabled || opts.includeDisabled);
  }
  const byId = new Map(all.map((c) => [c.id, c]));
  const out: AgentConfig[] = [];
  for (const id of ids) {
    const c = byId.get(id);
    if (!c) {
      throw new ConfigError(
        `unknown config "${id}". Known: ${all.map((x) => x.id).join(', ')}`,
      );
    }
    if (!c.enabled && !opts.includeDisabled) {
      throw new ConfigError(
        `config "${id}" is disabled${c.note ? `: ${c.note}` : ''}. Pass --include-disabled to force.`,
      );
    }
    out.push(c);
  }
  return out;
}

/** USD estimate from published per-token prices (subscription runs have no real $). */
export function apiEquivalentCostUsd(
  config: AgentConfig,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    inputTokensIncludeCached: boolean;
  },
): number | undefined {
  const p = config.pricing;
  if (!p) return undefined;
  const perM = (n: number, rate?: number) => (rate === undefined ? 0 : (n / 1_000_000) * rate);
  // Avoid double-counting cached input for harnesses whose input count is inclusive.
  const freshInput = usage.inputTokensIncludeCached
    ? Math.max(0, usage.inputTokens - usage.cacheReadInputTokens)
    : usage.inputTokens;
  return (
    perM(freshInput, p.inputPerMTok) +
    perM(usage.outputTokens, p.outputPerMTok) +
    perM(usage.cacheReadInputTokens, p.cacheReadPerMTok) +
    perM(usage.cacheCreationInputTokens, p.cacheWritePerMTok)
  );
}
