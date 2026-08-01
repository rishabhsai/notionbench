/**
 * Generic "command template" harness.
 *
 * The README commits to a v1 requirement: *any* prompt-in/files-out CLI must be
 * runnable, not just the two presets. This adapter is that escape hatch — a config
 * supplies its own `command` + `argsTemplate` with placeholders, and the runner
 * treats the CLI as a black box that reads a prompt and leaves files behind.
 *
 *   {
 *     "id": "some-other-cli",
 *     "harness": "command-template",
 *     "command": "my-agent-cli",
 *     "argsTemplate": ["run", "--model", "{model}", "--cwd", "{workspace}", "{prompt}"],
 *     "model": "vendor/some-model"
 *   }
 *
 * Placeholders: {prompt} {workspace} {model} {effort} {configId}
 * Use `promptVia: "stdin"` for CLIs that read the prompt from stdin instead.
 *
 * Token accounting is BEST EFFORT. Unlike the claude-code/codex adapters — which
 * are written against captured output from a known format — this one guesses, so it
 * reports what it found and why in `parseWarnings` and always preserves the raw
 * object. A config whose numbers matter should get a real adapter; `opencode` started
 * life here and moved to src/parsers/opencode.ts for exactly that reason.
 */

import type { AgentConfig } from '../config.js';
import type { TokenUsage } from '../types.js';
import {
  emptyParse,
  excerpt,
  isRecord,
  num,
  tryParseJson,
  type HarnessAdapter,
  type Invocation,
  type InvocationContext,
  type ParsedTranscript,
  type TranscriptInput,
} from './types.js';

/** Field-name synonyms seen across CLIs, most-specific first. */
const INPUT_KEYS = ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens'];
const OUTPUT_KEYS = ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens'];
const CACHE_READ_KEYS = [
  'cache_read_input_tokens',
  'cacheReadInputTokens',
  'cached_input_tokens',
  'cachedInputTokens',
  'cached_tokens',
];
const CACHE_WRITE_KEYS = ['cache_creation_input_tokens', 'cacheCreationInputTokens'];
const REASONING_KEYS = ['reasoning_output_tokens', 'reasoningOutputTokens', 'reasoning_tokens'];

export class CommandTemplateError extends Error {}

export const commandTemplateAdapter: HarnessAdapter = {
  id: 'command-template',
  command: 'sh',

  buildInvocation(config: AgentConfig, ctx: InvocationContext): Invocation {
    if (!config.command) {
      throw new CommandTemplateError(
        `config "${config.id}" uses harness "command-template" but sets no "command"`,
      );
    }
    const template = config.argsTemplate ?? [];
    const viaStdin = config.promptVia === 'stdin';
    if (!viaStdin && !template.some((a) => a.includes('{prompt}'))) {
      throw new CommandTemplateError(
        `config "${config.id}" has no {prompt} placeholder in argsTemplate and does not set ` +
          `promptVia:"stdin" — the agent would never receive the task`,
      );
    }

    const values: Record<string, string> = {
      prompt: ctx.prompt,
      workspace: ctx.workspaceDir,
      model: config.model,
      effort: config.reasoningEffort ?? '',
      configId: config.id,
    };
    const args = template.map((arg) => substitute(arg, values));
    if (config.extraArgs?.length) args.push(...config.extraArgs);

    return {
      command: config.command,
      args,
      stdin: viaStdin ? { write: ctx.prompt } : 'ignore',
      versionArgs: config.versionArgs ?? ['--version'],
    };
  },

  parse(input: TranscriptInput): ParsedTranscript {
    const out = emptyParse();
    const candidates: Array<{ obj: Record<string, unknown>; usage: TokenUsage }> = [];
    let jsonLines = 0;

    for (const line of input.stdoutLines) {
      const obj = tryParseJson(line);
      if (!isRecord(obj)) continue;
      jsonLines++;
      for (const found of findUsageObjects(obj)) {
        const usage = normalizeLooseUsage(found);
        if (usage) candidates.push({ obj: found, usage });
      }
    }

    if (candidates.length === 0) {
      out.parseWarnings.push(
        jsonLines === 0
          ? 'no JSON lines on stdout; this harness reports no token usage'
          : 'JSON lines found but none contained a recognizable token-usage object',
      );
      // Not an error: plenty of CLIs simply do not report tokens. Score still works;
      // the cost/tokens columns are just blank for this config.
      return out;
    }

    // Prefer the report with the largest total — a final summary object rather than
    // an early per-step one. Ties keep the last, which is the later summary.
    let best = candidates[0]!;
    for (const c of candidates) {
      if (c.usage.totalTokens >= best.usage.totalTokens) best = c;
    }
    out.usage = best.usage;
    out.usageRaw = {
      source: 'command-template heuristic',
      chosen: best.obj,
      candidateCount: candidates.length,
    };
    if (candidates.length > 1) {
      out.parseWarnings.push(
        `${candidates.length} usage-shaped objects found; picked the largest total. ` +
          `Write a dedicated adapter if these numbers are load-bearing.`,
      );
    }
    return out;
  },
};

function substitute(template: string, values: Record<string, string>): string {
  return template.replace(/\{(prompt|workspace|model|effort|configId)\}/g, (_m, key: string) =>
    values[key] ?? '',
  );
}

/** Yield every nested object that looks like it carries token counts. */
function findUsageObjects(root: Record<string, unknown>, depth = 0): Record<string, unknown>[] {
  if (depth > 6) return [];
  const out: Record<string, unknown>[] = [];
  if (looksLikeUsage(root)) out.push(root);
  for (const value of Object.values(root)) {
    if (isRecord(value)) out.push(...findUsageObjects(value, depth + 1));
  }
  return out;
}

function looksLikeUsage(obj: Record<string, unknown>): boolean {
  const hasInput = INPUT_KEYS.some((k) => typeof obj[k] === 'number');
  const hasOutput = OUTPUT_KEYS.some((k) => typeof obj[k] === 'number');
  return hasInput || hasOutput;
}

function pick(obj: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    if (typeof obj[k] === 'number') return num(obj, k);
  }
  return 0;
}

export function normalizeLooseUsage(raw: unknown): TokenUsage | null {
  if (!isRecord(raw)) return null;
  const inputTokens = pick(raw, INPUT_KEYS);
  const outputTokens = pick(raw, OUTPUT_KEYS);
  const cacheReadInputTokens = pick(raw, CACHE_READ_KEYS);
  const cacheCreationInputTokens = pick(raw, CACHE_WRITE_KEYS);
  const reasoningOutputTokens = pick(raw, REASONING_KEYS);
  if (inputTokens === 0 && outputTokens === 0) return null;

  // Unknown convention. If the reported input is already >= the cached count, assume
  // it is inclusive (the more common shape outside Anthropic) so the total is not
  // inflated; this is recorded on the row so downstream cost math stays honest.
  const inputTokensIncludeCached = cacheReadInputTokens > 0 && inputTokens >= cacheReadInputTokens;
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokensIncludeCached
      ? inputTokens + outputTokens + cacheCreationInputTokens
      : inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens,
    inputTokensIncludeCached,
  };
}

export { excerpt };
