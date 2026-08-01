/**
 * Subscription rate-window detection.
 *
 * Runs go through 5-hour / weekly subscription caps (docs/PLAN.md "Pacing"), so a
 * trial that dies because the window is exhausted is NOT a task failure — it must
 * not be scored, and the config must be paused rather than burned through its
 * attempt budget. The strings CLIs print for this drift between releases, so the
 * pattern list is configuration, not code.
 */

import { DEFAULT_RATE_LIMIT_PATTERNS } from './config.js';
import { excerpt, type RateLimitSignal } from './parsers/types.js';

export interface CompiledPatterns {
  sources: string[];
  regexes: RegExp[];
}

export function compilePatterns(sources: string[] = DEFAULT_RATE_LIMIT_PATTERNS): CompiledPatterns {
  const regexes: RegExp[] = [];
  const kept: string[] = [];
  for (const src of sources) {
    try {
      regexes.push(new RegExp(src, 'i'));
      kept.push(src);
    } catch {
      // A bad pattern in someone's runconfig must not take down a multi-day run.
      continue;
    }
  }
  return { sources: kept, regexes };
}

/**
 * Scan text lines for usage-limit evidence.
 *
 * Deliberately conservative about *where* it looks: only the lines given. Callers
 * pass stderr plus the final result text — not the entire transcript — because an
 * agent that merely *reads about* rate limits (we have a whole
 * `operate-batch-001-rate-limited-writes` task!) would otherwise trip this.
 */
export function scanForRateLimit(
  lines: string[],
  source: RateLimitSignal['source'],
  patterns: CompiledPatterns,
): RateLimitSignal[] {
  const out: RateLimitSignal[] = [];
  for (const line of lines) {
    for (let i = 0; i < patterns.regexes.length; i++) {
      const re = patterns.regexes[i]!;
      if (re.test(line)) {
        out.push({ source, matched: patterns.sources[i]!, excerpt: excerpt(line) });
        break; // one signal per line is enough
      }
    }
  }
  return out;
}

/**
 * How long to pause a config, preferring a CLI-supplied reset time over the
 * configured cooldown. Clamped so a bogus far-future reset can't stall a run
 * forever and a past reset can't cause a hot loop.
 */
export function cooldownFor(
  signals: RateLimitSignal[],
  defaultCooldownMs: number,
  nowMs: number,
  maxCooldownMs = 6 * 60 * 60 * 1000,
): number {
  let best: number | undefined;
  for (const s of signals) {
    if (s.resetsAtEpochSec === undefined) continue;
    const deltaMs = s.resetsAtEpochSec * 1000 - nowMs;
    if (deltaMs > 0 && (best === undefined || deltaMs < best)) best = deltaMs;
  }
  const chosen = best ?? defaultCooldownMs;
  return Math.max(60_000, Math.min(chosen, maxCooldownMs));
}
