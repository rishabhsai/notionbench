import type { HarnessId } from '../types.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { commandTemplateAdapter } from './command-template.js';
import type { HarnessAdapter } from './types.js';

export * from './types.js';
export { claudeCodeAdapter, normalizeClaudeUsage } from './claude-code.js';
export { codexAdapter, normalizeCodexUsage, reconcileCodexUsages } from './codex.js';
export {
  CommandTemplateError,
  commandTemplateAdapter,
  normalizeLooseUsage,
} from './command-template.js';

const ADAPTERS = new Map<string, HarnessAdapter>([
  [claudeCodeAdapter.id, claudeCodeAdapter],
  [codexAdapter.id, codexAdapter],
  // Any other prompt-in/files-out CLI goes through the generic template harness.
  [commandTemplateAdapter.id, commandTemplateAdapter],
  // TODO(tera/luna): give these first-class adapters once their headless CLIs are
  // confirmed to exist and `<cli> --help` has been captured. Until then they can be
  // driven through `command-template` at the cost of heuristic token accounting.
  // See V1_ROSTER notes in config.ts.
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
