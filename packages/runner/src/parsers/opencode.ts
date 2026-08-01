/**
 * OpenCode CLI adapter.
 *
 * Headless invocation (verified against `opencode run --help`, opencode 1.18.10):
 *   opencode run "<prompt>" -m <provider/model> --format json \
 *          --dir <workspace> --title notionbench-<configId>
 *
 * `--dir` IS NOT OPTIONAL. Read this before "simplifying" it away:
 *   OpenCode does NOT take the process cwd as the project root. It re-anchors to a
 *   previously-known project directory from its own state, so a trial launched with
 *   `cwd: <trial workspace>` but no `--dir` runs the agent somewhere else entirely.
 *   This is not hypothetical — the first captured OpenCode run
 *   (results/20260801-070305/…/opencode-kimi-k3/docs-with/trial-1) escaped the trial
 *   workspace into the *benchmark repo itself*: it read
 *   `<repo>/evals/build-nac-001-workspace-from-spec/PROMPT.md`, read the task's own
 *   `expected/intents.json`, ran `cat runconfig.json`, and then WROTE the answer into
 *   `evals/…/fixture/workspace/src/main.ts`. Every other harness in the roster is
 *   confined by cwd (+ `-C` / `-s workspace-write` on codex); OpenCode is confined by
 *   `--dir` alone. spawn.ts still sets cwd, but cwd is defence in depth here, not the
 *   control.
 *
 * Other notes:
 *   - The prompt is the `run [message..]` positional and is passed as a single argv
 *     element, never through a shell. A prompt that begins with `-` would be read as a
 *     flag by OpenCode's arg parser; no task prompt does, and adding `--` changes the
 *     invocation under measurement, so this is documented rather than defended against.
 *   - `--title` keeps the operator's OpenCode session list legible (`notionbench-<configId>`).
 *   - `--variant` is OpenCode's provider-specific reasoning-effort knob (`high`, `max`,
 *     `minimal`, …); it is only emitted when a config pins `reasoningEffort`, so the
 *     default invocation stays exactly what was captured.
 *   - Deliberately NOT passed: `--auto` (the captured run wrote files and ran bash
 *     without it, so headless `run` already auto-approves) and `--pure` (it would drop
 *     the operator's plugins, which is good measurement hygiene, but it was not part of
 *     the captured run — change it only alongside a fresh capture).
 *
 * Stream shape (captured from a real run, see test/fixtures/opencode-*.jsonl):
 *   {"type":"step_start","timestamp":N,"sessionID":"ses_…","part":{"type":"step-start",…}}
 *   {"type":"tool_use","timestamp":N,"part":{"type":"tool","tool":"read","callID":"read_0",
 *                                            "state":{"status":"completed","input":{…},"output":"…"}}}
 *   {"type":"text","timestamp":N,"part":{"type":"text","text":"…"}}
 *   {"type":"step_finish","timestamp":N,"part":{"reason":"tool-calls","type":"step-finish",
 *      "tokens":{"total":N,"input":N,"output":N,"reasoning":N,"cache":{"write":N,"read":N}},
 *      "cost":0.0229}}
 *
 * TOKEN ACCOUNTING — two facts that the numbers are wrong without:
 *
 * 1. A run emits MANY `step_finish` events, one per agent step; each carries that
 *    step's own counts, NOT a running total. The captured run has 5 of them and the
 *    last one reports 38 402 total against a real run total of 151 573. They must be
 *    summed.
 *
 * 2. OpenCode's `tokens.input` EXCLUDES cached reads (the Claude Code convention, the
 *    opposite of Codex), so `inputTokensIncludeCached` is false and cached reads are a
 *    separate addend. Evidence from the captured run — for every step,
 *    `total == input + output + reasoning + cache.read + cache.write` exactly:
 *      step 2: 29 643 == 18 498 + 223 + 682 + 10 240 + 0
 *      step 3: 36 335 ==  7 207 + 197 + 259 + 28 672 + 0
 *      step 4: 36 579 ==     613 + 108 +  18 + 35 840 + 0
 *    If `input` were inclusive the identity would over-count by `cache.read` every
 *    time. Step 4 makes it obvious on magnitudes alone: 613 input against 35 840
 *    cached — an inclusive counter cannot be smaller than its own subset.
 *
 *    The same identity shows `reasoning` is a SEPARATE addend from `output`, not a
 *    subset of it (Codex/Claude Code both fold reasoning into their output count). To
 *    keep `outputTokens` meaning the same billable thing across harnesses — and to stop
 *    apiEquivalentCostUsd() silently under-billing every reasoning token — reasoning is
 *    folded into `outputTokens` here, with the raw figure preserved in
 *    `reasoningOutputTokens` as an informational subset (the Codex convention).
 *
 * OpenCode also reports a provider-computed `cost` per step. Summed, that is a better
 * number than our list-price estimate: it is what the provider actually charged. It is
 * exposed as `reportedCostUsd` (and mirrored onto `usage.costUsd`); see the note in
 * spawn.ts about which one the cost column prefers.
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

/**
 * OpenCode Go usage-window phrasing, taken from the English strings in the shipped
 * binary (opencode 1.18.10): `dialog.usageExceeded.accountRateLimit.title` = "Go limit
 * reached", `…description` = "Usage limit reached. …", the structured
 * `reason:"account_rate_limit"` that accompanies them, and
 * `ui.sessionTurn.error.freeUsageExceeded` = "Free usage exceeded".
 *
 * UNVERIFIED against a live throttled run — no OpenCode trial has hit the window yet,
 * so what `--format json` emits in that state is unknown. Matching is therefore done on
 * whatever text the stream does surface (step reasons, error events) rather than on a
 * guessed event type. "Usage limit reached" and 429 are already covered by
 * DEFAULT_RATE_LIMIT_PATTERNS; "Go limit reached" / "account_rate_limit" / "free usage
 * exceeded" were added there for OpenCode.
 */
const OPENCODE_RATE_LIMIT_TEXT =
  /account[_ -]?rate[_ -]?limit|go limit reached|usage limit reached|free usage exceeded|rate[_ -]?limit/i;

/** Event types the parser understands; anything else is reported as drift. */
const KNOWN_EVENT_TYPES = new Set([
  'step_start',
  'step_finish',
  'tool_use',
  'text',
  'reasoning',
  'error',
  'session_error',
]);

export const opencodeAdapter: HarnessAdapter = {
  id: 'opencode',
  command: 'opencode',

  buildInvocation(config: AgentConfig, ctx: InvocationContext): Invocation {
    const args = [
      'run',
      // `run [message..]` positional; one argv element, never a shell string.
      ctx.prompt,
      '-m',
      config.model,
      // Raw JSON events on stdout instead of the formatted TUI-ish output.
      '--format',
      'json',
      // REQUIRED. Without it OpenCode ignores cwd and re-anchors to a previously
      // known project directory — see the escape documented at the top of this file.
      '--dir',
      ctx.workspaceDir,
      '--title',
      `notionbench-${config.id}`,
    ];
    if (config.reasoningEffort) {
      // OpenCode calls this a model "variant"; values are provider-specific.
      args.push('--variant', config.reasoningEffort);
    }
    if (config.extraArgs?.length) args.push(...config.extraArgs);
    return {
      command: process.env.NOTIONBENCH_OPENCODE_BIN || opencodeAdapter.command,
      args,
      stdin: 'ignore',
      versionArgs: ['--version'],
    };
  },

  parse(input: TranscriptInput): ParsedTranscript {
    const out = emptyParse();
    const steps: Record<string, unknown>[] = [];
    const toolErrorMessages: string[] = [];
    const unknownTypes = new Set<string>();
    let reportedCostUsd = 0;
    let sawCost = false;
    let firstTimestamp: number | undefined;
    let lastTimestamp: number | undefined;

    for (const line of input.stdoutLines) {
      const obj = tryParseJson(line);
      if (!isRecord(obj)) {
        // OpenCode puts logs on stderr (and only with --print-logs), so stdout under
        // --format json should be pure JSONL. Anything else is drift worth recording.
        if (line.trim().length > 0 && out.parseWarnings.length < MAX_PARSE_WARNINGS) {
          out.parseWarnings.push(`non-JSON stdout line: ${excerpt(line, 160)}`);
        }
        continue;
      }

      const timestamp = num(obj, 'timestamp');
      if (timestamp > 0) {
        if (firstTimestamp === undefined) firstTimestamp = timestamp;
        lastTimestamp = timestamp;
      }
      // Present on every event; `part.sessionID` is the same value.
      out.sessionId = str(obj, 'sessionID') ?? out.sessionId;

      const type = typeof obj.type === 'string' ? obj.type : '';
      if (!KNOWN_EVENT_TYPES.has(type)) {
        unknownTypes.add(type || '<missing type>');
        continue;
      }

      if (type === 'step_finish') {
        const partTokens = isRecord(obj.part) ? obj.part.tokens : undefined;
        if (isRecord(partTokens)) steps.push(partTokens);
        else out.parseWarnings.push('step_finish without a part.tokens object');
        const cost = num(obj, 'part', 'cost');
        if (cost > 0) {
          reportedCostUsd += cost;
          sawCost = true;
        }
        // Not observed in a healthy run (`reason` is "tool-calls" / "stop"), but a
        // throttled step is the most likely place for the window to surface.
        const reason = str(obj, 'part', 'reason');
        if (reason && OPENCODE_RATE_LIMIT_TEXT.test(reason)) {
          out.rateLimitSignals.push({
            source: 'stdout-structured',
            matched: `step_finish.part.reason=${reason}`,
            excerpt: excerpt(line),
          });
        }
        continue;
      }

      if (type === 'tool_use') {
        out.toolCalls++;
        const status = str(obj, 'part', 'state', 'status');
        // Anything that is not an explicit "completed" is a failed call — the observed
        // failure status is "error", but treat unknown/missing the same way rather
        // than silently reporting a clean run.
        if (status !== 'completed') {
          out.toolErrors++;
          const message =
            str(obj, 'part', 'state', 'error') ??
            str(obj, 'part', 'state', 'output') ??
            `status=${status ?? 'missing'}`;
          toolErrorMessages.push(`${str(obj, 'part', 'tool') ?? 'tool'}: ${message}`);
        }
        continue;
      }

      if (type === 'text') {
        // Last text part is the agent's closing message.
        const text = str(obj, 'part', 'text');
        if (text !== undefined) out.finalText = text;
        continue;
      }

      if (type === 'error' || type === 'session_error') {
        const message =
          str(obj, 'part', 'error') ??
          str(obj, 'error', 'message') ??
          str(obj, 'error') ??
          str(obj, 'message') ??
          excerpt(line);
        out.harnessError = message;
        if (OPENCODE_RATE_LIMIT_TEXT.test(message)) {
          out.rateLimitSignals.push({
            source: 'stdout-structured',
            matched: `${type}: opencode usage-window phrasing`,
            excerpt: excerpt(line),
          });
        }
        continue;
      }
    }

    out.usage = sumOpencodeSteps(steps);
    out.usageRaw = {
      source: 'step_finish.part.tokens',
      steps,
      stepCount: steps.length,
      // Provider-computed, summed across steps. More accurate than our list-price
      // estimate because it is what the provider actually charged.
      reportedCostUsd: sawCost ? reportedCostUsd : undefined,
      costSource: 'step_finish.part.cost',
    };
    out.numTurns = steps.length || undefined;
    if (sawCost) {
      out.reportedCostUsd = reportedCostUsd;
      if (out.usage) out.usage.costUsd = reportedCostUsd;
    }
    if (firstTimestamp !== undefined && lastTimestamp !== undefined && lastTimestamp > firstTimestamp) {
      // Span of the agent's own events. Not the trial wall clock (which also covers
      // process start-up and OpenCode's server boot) — spawn.ts records that separately.
      out.durationMs = lastTimestamp - firstTimestamp;
    }
    if (steps.length === 0) out.parseWarnings.push('no step_finish token reports found');
    if (unknownTypes.size > 0) {
      out.parseWarnings.push(
        `unrecognized opencode event type(s): ${[...unknownTypes].sort().join(', ')}`,
      );
    }
    if (toolErrorMessages.length > 0) {
      out.parseWarnings.push(
        `opencode tool errors: ${excerpt(toolErrorMessages.join(' | '), 400)}`,
      );
    }
    return out;
  },
};

/**
 * Sum the per-step `part.tokens` objects into one normalized TokenUsage.
 *
 * See the file header for why `inputTokensIncludeCached` is false and why `reasoning`
 * is folded into `outputTokens`. `totalTokens` computed this way reproduces the sum of
 * OpenCode's own per-step `tokens.total` exactly.
 */
export function sumOpencodeSteps(steps: unknown[]): TokenUsage | null {
  if (steps.length === 0) return null;
  let inputTokens = 0;
  let rawOutputTokens = 0;
  let reasoningOutputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  for (const step of steps) {
    if (!isRecord(step)) continue;
    inputTokens += num(step, 'input');
    rawOutputTokens += num(step, 'output');
    reasoningOutputTokens += num(step, 'reasoning');
    cacheReadInputTokens += num(step, 'cache', 'read');
    cacheCreationInputTokens += num(step, 'cache', 'write');
  }
  const outputTokens = rawOutputTokens + reasoningOutputTokens;
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
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens,
    inputTokensIncludeCached: false,
  };
}
