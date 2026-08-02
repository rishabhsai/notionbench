/**
 * Snapshot what the agent produced, next to the verdict it produced it for.
 *
 * A trial's workspace is deleted as soon as the cell is scored, so the only
 * durable record of an agent's work has been the score and the verifier's
 * diagnostics. That is enough right up until the verifier itself turns out to
 * be wrong — and on this suite it has been wrong four times, always the same
 * way: the SDK permits two spellings, the oracle picks one, and the
 * canonicalizer reads the other as a wrong answer. Each time, fixing the
 * comparison meant re-running every affected cell, because the artifact that
 * would have been re-scored for free was already gone.
 *
 * So: copy the agent's output files into the trial directory before cleanup.
 * `dist/intents.json` and `answer.json` are the ones that matter — a few KB
 * each — but the rule is deliberately general rather than a list of blessed
 * paths, because the next verifier bug will be in a task nobody has written.
 *
 * What is skipped, and why:
 *  - `node_modules`, `.git`, and the docs bundles: not the agent's output, and
 *    they dwarf everything that is.
 *  - files over `maxFileBytes`, and everything past `maxTotalBytes`: a snapshot
 *    that can fill the disk is a snapshot that stops the run. Truncation is
 *    recorded in the manifest rather than passed over in silence.
 *
 * This is a debugging and re-scoring aid, not evidence for publication: it is
 * best-effort and never fails a cell.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Directory names never worth copying — none of them are agent output. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.pnpm',
  '.venv',
  '__pycache__',
  '.claude',
  '.agents',
  '.cursor',
  '.codex',
]);

export interface SnapshotOptions {
  /** Per-file ceiling. Default 256 KiB. */
  maxFileBytes?: number;
  /** Whole-snapshot ceiling. Default 2 MiB. */
  maxTotalBytes?: number;
}

export interface SnapshotManifest {
  /** Workspace-relative paths actually copied. */
  files: string[];
  bytes: number;
  /** Paths left out, with the reason — an empty snapshot must not look complete. */
  skipped: Array<{ path: string; reason: 'too-large' | 'budget-exhausted' | 'unreadable' }>;
}

/** Every file under `root`, workspace-relative, depth-first and sorted. */
async function walk(root: string, rel = ''): Promise<string[]> {
  const here = path.join(root, rel);
  let entries;
  try {
    entries = await fs.readdir(here, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await walk(root, child)));
    } else if (entry.isFile()) {
      out.push(child);
    }
    // Symlinks are skipped: they point outside the snapshot or at node_modules.
  }
  return out;
}

/**
 * Copy the agent's output from `workspaceDir` into `destDir/workspace/`, and
 * write `destDir/artifacts.json`. Never throws: a failed snapshot is a lost
 * debugging aid, not a lost cell.
 */
export async function snapshotWorkspace(
  workspaceDir: string,
  destDir: string,
  opts: SnapshotOptions = {},
): Promise<SnapshotManifest> {
  const maxFileBytes = opts.maxFileBytes ?? 256 * 1024;
  const maxTotalBytes = opts.maxTotalBytes ?? 2 * 1024 * 1024;
  const manifest: SnapshotManifest = { files: [], bytes: 0, skipped: [] };

  try {
    const rels = await walk(workspaceDir);
    const outRoot = path.join(destDir, 'workspace');
    for (const rel of rels) {
      const src = path.join(workspaceDir, rel);
      let size: number;
      try {
        size = (await fs.stat(src)).size;
      } catch {
        manifest.skipped.push({ path: rel, reason: 'unreadable' });
        continue;
      }
      if (size > maxFileBytes) {
        manifest.skipped.push({ path: rel, reason: 'too-large' });
        continue;
      }
      if (manifest.bytes + size > maxTotalBytes) {
        manifest.skipped.push({ path: rel, reason: 'budget-exhausted' });
        continue;
      }
      const dst = path.join(outRoot, rel);
      try {
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.copyFile(src, dst);
      } catch {
        manifest.skipped.push({ path: rel, reason: 'unreadable' });
        continue;
      }
      manifest.files.push(rel);
      manifest.bytes += size;
    }
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(
      path.join(destDir, 'artifacts.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // Best effort by construction — see the module docblock.
  }
  return manifest;
}
