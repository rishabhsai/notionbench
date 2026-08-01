/**
 * Codex CLI adapter.
 *
 * Headless invocation (verified against `codex exec --help`, codex-cli 0.144.6):
 *   codex exec "<prompt>" --json --skip-git-repo-check -C <workspace> \
 *        -s workspace-write --ignore-user-config --ephemeral \
 *        -m <model> -c model_reasoning_effort="<effort>" -c approval_policy="never"
 *
 * Notes:
 *   - Reasoning effort is NOT a flag; it is a config override. `model_reasoning_effort`
 *     was confirmed as a live key (it is what ~/.codex/config.toml uses).
 *   - `--ignore-user-config` keeps the operator's personal config.toml (their model
 *     default, MCP servers, notify hooks) out of the measurement. Auth still resolves
 *     via CODEX_HOME, so subscription login keeps working.
 *   - Codex reads stdin when it is piped ("Reading additional input from stdin...")
 *     and appends it as a `<stdin>` block. spawn.ts attaches 'ignore' so the prompt
 *     is exactly the argv prompt.
 *   - `-s workspace-write` confines writes to the trial workspace. v1 relies on this
 *     plus the per-trial tmpdir for isolation (see packages/sandbox/README.md).
 *
 * Stream shape (captured from a real run, see test/fixtures/codex-*.jsonl):
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"ok"}}
 *   {"type":"turn.completed","usage":{"input_tokens":18378,"cached_input_tokens":9984,
 *                                     "output_tokens":5,"reasoning_output_tokens":0}}
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
  type TranscriptInput,
} from './types.js';

const MAX_PARSE_WARNINGS = 25;

/** item.type values that represent the agent actually doing something. */
const TOOL_ITEM_TYPES = new Set([
  'command_execution',
  'local_shell_call',
  'file_change',
  'patch_apply',
  'mcp_tool_call',
  'web_search',
  'function_call',
]);

export const codexAdapter: HarnessAdapter = {
  id: 'codex',
  command: 'codex',

  buildInvocation(config: AgentConfig, ctx: InvocationContext): Invocation {
    const args = [
      'exec',
      ctx.prompt,
      '--json',
      // Task workspaces are plain directories, not git repos.
      '--skip-git-repo-check',
      '-C',
      ctx.workspaceDir,
      // Writes confined to the workspace; no approval prompts in exec mode.
      '-s',
      'workspace-write',
      // Measurement hygiene + don't litter ~/.codex/sessions with 1000s of rollouts.
      '--ignore-user-config',
      '--ephemeral',
      '-m',
      config.model,
      '-c',
      'approval_policy="never"',
    ];
    if (config.reasoningEffort) {
      // `-c key=value` parses value as TOML; quote it so it is an explicit string.
      args.push('-c', `model_reasoning_effort="${config.reasoningEffort}"`);
    }
    if (config.extraArgs?.length) args.push(...config.extraArgs);
    return {
      command: process.env.NOTIONBENCH_CODEX_BIN || codexAdapter.command,
      args,
      stdin: 'ignore',
      versionArgs: ['--version'],
    };
  },

  parse(input: TranscriptInput): ParsedTranscript {
    const out = emptyParse();
    const usages: Record<string, unknown>[] = [];
    const errorItems: string[] = [];

    for (const line of input.stdoutLines) {
      const obj = tryParseJson(line);
      if (!isRecord(obj)) {
        // Codex interleaves tracing lines on stderr, but stdout should be pure JSONL.
        if (line.trim().length > 0 && out.parseWarnings.length < MAX_PARSE_WARNINGS) {
          out.parseWarnings.push(`non-JSON stdout line: ${excerpt(line, 160)}`);
        }
        continue;
      }
      const type = obj.type;

      if (type === 'thread.started') {
        out.sessionId = str(obj, 'thread_id') ?? out.sessionId;
        continue;
      }

      if (type === 'turn.completed') {
        if (isRecord(obj.usage)) usages.push(obj.usage);
        else out.parseWarnings.push('turn.completed without a usage object');
        continue;
      }

      if (type === 'turn.failed') {
        out.harnessError = str(obj, 'error', 'message') ?? str(obj, 'error') ?? 'turn.failed';
        if (isRecord(obj.usage)) usages.push(obj.usage);
        continue;
      }

      if (type === 'error') {
        const msg = str(obj, 'message') ?? excerpt(line);
        errorItems.push(msg);
        continue;
      }

      if (type === 'item.completed' || type === 'item.started') {
        const item = obj.item;
        if (!isRecord(item)) continue;
        const itemType = typeof item.type === 'string' ? item.type : '';
        // Count each tool item once (on completion only).
        if (type === 'item.completed') {
          if (TOOL_ITEM_TYPES.has(itemType)) {
            out.toolCalls++;
            const exitCode = item.exit_code;
            if (typeof exitCode === 'number' && exitCode !== 0) out.toolErrors++;
            else if (item.status === 'failed' || item.success === false) out.toolErrors++;
          } else if (itemType === 'error') {
            const msg = str(item, 'message') ?? excerpt(line);
            errorItems.push(msg);
            out.toolErrors++;
          } else if (itemType === 'agent_message') {
            const text = str(item, 'text');
            if (text !== undefined) out.finalText = text;
          }
        }
        continue;
      }
    }

    const reconciled = reconcileCodexUsages(usages);
    out.usage = reconciled.usage;
    out.usageRaw = { source: 'turn.completed.usage', turns: usages, mode: reconciled.mode };
    out.numTurns = usages.length || undefined;
    if (usages.length === 0) out.parseWarnings.push('no turn.completed usage found');
    if (reconciled.mode === 'cumulative') {
      out.parseWarnings.push(
        `${usages.length} usage reports looked cumulative; used the last rather than summing`,
      );
    }
    if (errorItems.length > 0) {
      out.parseWarnings.push(`codex error items: ${excerpt(errorItems.join(' | '), 400)}`);
    }
    return out;
  },
};

/**
 * Codex `exec` normally emits exactly one `turn.completed`. Compaction / retries can
 * produce more, and it is not documented whether those numbers are per-turn or
 * cumulative for the thread. Guess defensively: if every field of the last report is
 * >= every field of all the others, treat it as cumulative and take it; otherwise sum.
 * Either way the raw per-turn objects are preserved in `usageRaw`.
 */
export function reconcileCodexUsages(usages: Record<string, unknown>[]): {
  usage: TokenUsage | null;
  mode: 'none' | 'single' | 'summed' | 'cumulative';
} {
  if (usages.length === 0) return { usage: null, mode: 'none' };
  if (usages.length === 1) return { usage: normalizeCodexUsage(usages[0]!), mode: 'single' };

  const fields = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
  const last = usages[usages.length - 1]!;
  const looksCumulative = usages.slice(0, -1).every((u) => fields.every((f) => num(last, f) >= num(u, f)));
  if (looksCumulative) return { usage: normalizeCodexUsage(last), mode: 'cumulative' };

  const summed: Record<string, unknown> = {};
  for (const f of fields) {
    summed[f] = usages.reduce((acc, u) => acc + num(u, f), 0);
  }
  return { usage: normalizeCodexUsage(summed), mode: 'summed' };
}

/**
 * Codex's `input_tokens` INCLUDES `cached_input_tokens` (opposite of Claude Code).
 * Total is therefore input + output only — adding the cached count would double-count.
 */
export function normalizeCodexUsage(raw: unknown): TokenUsage | null {
  if (!isRecord(raw)) return null;
  const inputTokens = num(raw, 'input_tokens');
  const outputTokens = num(raw, 'output_tokens');
  const cacheReadInputTokens = num(raw, 'cached_input_tokens');
  const reasoningOutputTokens = num(raw, 'reasoning_output_tokens');
  if (inputTokens === 0 && outputTokens === 0 && cacheReadInputTokens === 0) return null;
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens: 0, // codex does not bill/report cache writes separately
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens,
    inputTokensIncludeCached: true,
  };
}
