/**
 * Claude Code adapter.
 *
 * Headless invocation (verified against `claude --help`, claude 2.1.220):
 *   claude -p "<prompt>" --output-format stream-json --verbose --model <alias|id> \
 *          [--effort <low|medium|high|xhigh|max>] --permission-mode bypassPermissions \
 *          --strict-mcp-config --setting-sources project --no-session-persistence
 *
 * Notes that cost real debugging time if forgotten:
 *   - `--verbose` is required alongside `-p --output-format stream-json`; without it
 *     the stream is suppressed.
 *   - `--strict-mcp-config` + `--setting-sources project` keep the *operator's*
 *     personal MCP servers, plugins and skills out of the measurement. The task
 *     workspace's own project files (AGENTS.md / CLAUDE.md / .claude/skills) still
 *     load — which is exactly what the docs axis manipulates.
 *   - Auth comes from the user's subscription. spawn.ts strips ANTHROPIC_API_KEY
 *     from the child env so a stray key can't silently switch billing to the API.
 *
 * Stream shape (captured from a real run, see test/fixtures/claude-code-*.jsonl):
 *   {"type":"system","subtype":"init",...}
 *   {"type":"assistant","message":{...,"content":[...],"usage":{...}},...}
 *   {"type":"user","message":{"content":[{"type":"tool_result","is_error":true,...}]}}
 *   {"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":...}}
 *   {"type":"result","subtype":"success","usage":{...},"total_cost_usd":...,"result":"..."}
 */

import type { AgentConfig } from '../config.js';
import type { TokenUsage } from '../types.js';
import {
  emptyParse,
  excerpt,
  isRecord,
  num,
  str,
  tryParseJson,
  type HarnessAdapter,
  type Invocation,
  type InvocationContext,
  type ParsedTranscript,
  type RateLimitSignal,
  type TranscriptInput,
} from './types.js';

const MAX_PARSE_WARNINGS = 25;

export const claudeCodeAdapter: HarnessAdapter = {
  id: 'claude-code',
  command: 'claude',

  buildInvocation(config: AgentConfig, ctx: InvocationContext): Invocation {
    const args = [
      '-p',
      ctx.prompt,
      '--output-format',
      'stream-json',
      // Required for the stream to be emitted at all under -p.
      '--verbose',
      '--model',
      config.model,
      // Non-interactive: the agent must never block on a permission prompt.
      '--permission-mode',
      'bypassPermissions',
      // Measurement hygiene: no operator MCP servers / user settings / plugins.
      '--strict-mcp-config',
      '--setting-sources',
      'project',
      // Don't litter the operator's session store with thousands of rollouts.
      '--no-session-persistence',
    ];
    if (config.reasoningEffort) {
      args.push('--effort', config.reasoningEffort);
    }
    if (config.extraArgs?.length) args.push(...config.extraArgs);
    return {
      command: process.env.NOTIONBENCH_CLAUDE_BIN || claudeCodeAdapter.command,
      args,
      stdin: 'ignore',
      versionArgs: ['--version'],
    };
  },

  parse(input: TranscriptInput): ParsedTranscript {
    const out = emptyParse();
    let resultObj: Record<string, unknown> | undefined;
    let lastAssistantUsage: unknown;
    const rateLimitEvents: unknown[] = [];

    for (const line of input.stdoutLines) {
      const obj = tryParseJson(line);
      if (!isRecord(obj)) {
        if (line.trim().length > 0 && out.parseWarnings.length < MAX_PARSE_WARNINGS) {
          out.parseWarnings.push(`non-JSON stdout line: ${excerpt(line, 160)}`);
        }
        continue;
      }
      const type = obj.type;

      if (type === 'result') {
        // Last one wins; a well-formed stream has exactly one.
        if (resultObj) out.parseWarnings.push('multiple result messages; using the last');
        resultObj = obj;
        continue;
      }

      if (type === 'system' && obj.subtype === 'init') {
        out.sessionId = str(obj, 'session_id') ?? out.sessionId;
        continue;
      }

      if (type === 'rate_limit_event') {
        rateLimitEvents.push(obj);
        const status = str(obj, 'rate_limit_info', 'status');
        // "allowed" is the happy path and is emitted on every single turn.
        if (status && status !== 'allowed') {
          const resetsAt = num(obj, 'rate_limit_info', 'resetsAt');
          out.rateLimitSignals.push({
            source: 'stdout-structured',
            matched: `rate_limit_info.status=${status}`,
            excerpt: excerpt(line),
            resetsAtEpochSec: resetsAt > 0 ? resetsAt : undefined,
          });
        }
        continue;
      }

      if (type === 'assistant') {
        const message = obj.message;
        if (isRecord(message)) {
          if (isRecord(message.usage)) lastAssistantUsage = message.usage;
          out.toolCalls += countBlocks(message.content, 'tool_use');
        }
        continue;
      }

      if (type === 'user') {
        const message = obj.message;
        if (isRecord(message)) {
          out.toolErrors += countErrorToolResults(message.content);
        }
        continue;
      }
    }

    if (resultObj) {
      out.usage = normalizeClaudeUsage(resultObj.usage);
      out.usageRaw = { source: 'result.usage', usage: resultObj.usage, modelUsage: resultObj.modelUsage };
      out.finalText = typeof resultObj.result === 'string' ? resultObj.result : undefined;
      out.numTurns = num(resultObj, 'num_turns') || undefined;
      out.durationMs = num(resultObj, 'duration_ms') || undefined;
      out.apiDurationMs = num(resultObj, 'duration_api_ms') || undefined;
      out.sessionId = str(resultObj, 'session_id') ?? out.sessionId;
      const cost = num(resultObj, 'total_cost_usd');
      if (cost > 0) out.reportedCostUsd = cost;
      if (resultObj.is_error === true || (typeof resultObj.subtype === 'string' && resultObj.subtype !== 'success')) {
        out.harnessError =
          str(resultObj, 'api_error_status') ??
          str(resultObj, 'subtype') ??
          'result reported is_error';
      }
      const permissionDenials = resultObj.permission_denials;
      if (Array.isArray(permissionDenials) && permissionDenials.length > 0) {
        out.parseWarnings.push(`${permissionDenials.length} permission denial(s) in result`);
      }
    } else if (lastAssistantUsage) {
      // Format drift / truncated stream: fall back to the last assistant usage so a
      // killed-on-timeout trial still yields token numbers.
      out.usage = normalizeClaudeUsage(lastAssistantUsage);
      out.usageRaw = { source: 'assistant.message.usage (fallback)', usage: lastAssistantUsage };
      out.parseWarnings.push('no result message; fell back to last assistant usage');
    } else {
      out.parseWarnings.push('no result message and no assistant usage found');
    }

    if (rateLimitEvents.length > 0 && out.usageRaw === null) {
      out.usageRaw = { rateLimitEvents };
    }
    return out;
  },
};

function countBlocks(content: unknown, blockType: string): number {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (isRecord(b) && b.type === blockType) n++;
  }
  return n;
}

function countErrorToolResults(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (isRecord(b) && b.type === 'tool_result' && b.is_error === true) n++;
  }
  return n;
}

/**
 * Claude Code's `input_tokens` EXCLUDES cache reads and cache writes — they are
 * reported as separate counters. Total is therefore the sum of all four.
 */
export function normalizeClaudeUsage(raw: unknown): TokenUsage | null {
  if (!isRecord(raw)) return null;
  const inputTokens = num(raw, 'input_tokens');
  const outputTokens = num(raw, 'output_tokens');
  const cacheReadInputTokens = num(raw, 'cache_read_input_tokens');
  const cacheCreationInputTokens = num(raw, 'cache_creation_input_tokens');
  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheReadInputTokens === 0 &&
    cacheCreationInputTokens === 0
  ) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    reasoningOutputTokens: 0, // not separately reported; included in output_tokens
    totalTokens: inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens,
    inputTokensIncludeCached: false,
  };
}

/** Exposed for tests / diagnostics. */
export type { RateLimitSignal };
