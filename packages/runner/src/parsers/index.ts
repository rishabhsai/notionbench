import type { HarnessId } from '../types.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import type { HarnessAdapter } from './types.js';

export * from './types.js';
export { claudeCodeAdapter, normalizeClaudeUsage } from './claude-code.js';
export { codexAdapter, normalizeCodexUsage, reconcileCodexUsages } from './codex.js';

const ADAPTERS = new Map<string, HarnessAdapter>([
  [claudeCodeAdapter.id, claudeCodeAdapter],
  [codexAdapter.id, codexAdapter],
  // TODO(tera/luna): register adapters once their headless CLIs are confirmed to
  // exist and `<cli> --help` has been captured. See V1_ROSTER notes in config.ts.
]);

export class UnknownHarnessError extends Error {
  constructor(harness: string) {
    super(
      `no adapter registered for harness "${harness}". ` +
        `Known: ${[...ADAPTERS.keys()].join(', ')}. ` +
        `Placeholder configs (tera/luna) must stay disabled until an adapter exists.`,
    );
    this.name = 'UnknownHarnessError';
  }
}

export function getAdapter(harness: HarnessId | string): HarnessAdapter {
  const a = ADAPTERS.get(harness);
  if (!a) throw new UnknownHarnessError(harness);
  return a;
}

export function hasAdapter(harness: HarnessId | string): boolean {
  return ADAPTERS.has(harness);
}

/** Test seam: register a stub adapter. */
export function registerAdapter(adapter: HarnessAdapter): void {
  ADAPTERS.set(adapter.id, adapter);
}
