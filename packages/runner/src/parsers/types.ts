import type { AgentConfig } from '../config.js';
import type { HarnessId, TokenUsage } from '../types.js';

export interface InvocationContext {
  /** The task prompt, passed as an argv element (never through a shell). */
  prompt: string;
  /** Absolute path to the prepared trial workspace; becomes the child's cwd. */
  workspaceDir: string;
}

export interface Invocation {
  command: string;
  args: string[];
  /**
   * What to attach to the child's stdin. Codex reads stdin when it is piped and
   * appends it as a `<stdin>` block, so it MUST be closed/ignored or the child
   * blocks on an interactive terminal.
   */
  stdin: 'ignore';
  /** Args that make the CLI print its version, recorded into run metadata. */
  versionArgs: string[];
}

export interface RateLimitSignal {
  source: 'stdout-structured' | 'stdout-text' | 'stderr-text' | 'exit-code';
  /** The matched pattern source or structured field path. */
  matched: string;
  /** Excerpt of the offending line, truncated. */
  excerpt: string;
  /** Epoch seconds when the window is known to reset, when the CLI tells us. */
  resetsAtEpochSec?: number;
}

export interface ParsedTranscript {
  /** Normalized usage, or null when nothing parseable was found. */
  usage: TokenUsage | null;
  /**
   * The raw object(s) usage was derived from, stored verbatim so format drift is
   * recoverable after the fact without re-running trials.
   */
  usageRaw: unknown;
  sessionId?: string;
  /** The agent's final assistant message, when the format exposes one. */
  finalText?: string;
  numTurns?: number;
  toolCalls: number;
  toolErrors: number;
  durationMs?: number;
  apiDurationMs?: number;
  /** Harness-reported dollar figure, if any. Not used for subscription runs. */
  reportedCostUsd?: number;
  /** Set when the harness itself reported failure (vs. the task failing). */
  harnessError?: string;
  /** Structured rate-window evidence found in the JSON stream. */
  rateLimitSignals: RateLimitSignal[];
  /** Non-fatal parse problems (unknown line shapes, drifted fields, …). */
  parseWarnings: string[];
}

export interface TranscriptInput {
  stdoutLines: string[];
  stderrLines: string[];
}

export interface HarnessAdapter {
  id: HarnessId;
  /** Executable name looked up on PATH (overridable via config.extraArgs/env). */
  command: string;
  buildInvocation(config: AgentConfig, ctx: InvocationContext): Invocation;
  parse(input: TranscriptInput): ParsedTranscript;
}

export function emptyParse(): ParsedTranscript {
  return {
    usage: null,
    usageRaw: null,
    toolCalls: 0,
    toolErrors: 0,
    rateLimitSignals: [],
    parseWarnings: [],
  };
}

/** Safe JSON.parse that never throws. */
export function tryParseJson(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read a nested numeric field defensively; returns 0 when absent/not a number. */
export function num(obj: unknown, ...pathParts: string[]): number {
  let cur: unknown = obj;
  for (const p of pathParts) {
    if (!isRecord(cur)) return 0;
    cur = cur[p];
  }
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : 0;
}

export function str(obj: unknown, ...pathParts: string[]): string | undefined {
  let cur: unknown = obj;
  for (const p of pathParts) {
    if (!isRecord(cur)) return undefined;
    cur = cur[p];
  }
  return typeof cur === 'string' ? cur : undefined;
}

export function excerpt(s: string, max = 300): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
