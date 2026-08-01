/**
 * Per-trial workspace preparation.
 *
 * Every trial gets a fresh copy of the task's fixture workspace in a temp
 * directory, plus a sibling `notion-home/` used as `NOTION_HOME` so the `ntn` CLI's
 * state never leaks between trials (docs/PLAN.md "Fixtures & isolation").
 *
 * The docs axis — the original contribution of this benchmark — is applied here:
 *   `with`    → Notion's own AGENTS.md / skills docs are copied into the workspace
 *   `without` → any such docs are recursively stripped, including ones the fixture
 *               inherited from a cloned template
 *
 * Pure fs. No Docker required (see README.md for why v1 runs agents on the host).
 */

import type { Dirent } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type DocsCondition = 'with' | 'without';

/** Where the Docker image preinstalls the upstream Notion templates. */
export const DEFAULT_TEMPLATES_DIR = process.env.NOTIONBENCH_TEMPLATES_DIR ?? '/opt/templates';

export const TEMPLATE_DIRS = {
  workers: 'workers-template',
  nac: 'notion-as-code-template',
} as const;

export type DocsBundle = keyof typeof TEMPLATE_DIRS;

/**
 * Files/directories that constitute "agent docs" for the purposes of the docs axis.
 * Matched by exact basename, at any depth inside the workspace.
 *
 * Intentionally conservative: it does NOT include a bare `docs/` directory, because
 * task fixtures legitimately ship product documentation that is part of the task
 * (e.g. investigate-* tasks that hand the agent a log dump).
 */
export const DOC_ARTIFACT_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'SKILLS.md',
  '.cursorrules',
  'GEMINI.md',
];

export const DOC_ARTIFACT_DIRS = ['.claude', '.agents', '.cursor', '.codex', '.github/agents'];

export interface PrepareWorkspaceOptions {
  /** `evals/<task-id>` — must contain `fixture/workspace/` (may be empty/missing). */
  taskDir: string;
  docsCondition: DocsCondition;
  /** Parent dir for the temp workspace. Default: OS temp dir. */
  tmpRoot?: string;
  /** Where the preinstalled template clones live. Default: /opt/templates. */
  templatesDir?: string;
  /**
   * Which template's docs to inject in the `with` condition. Defaults to whatever
   * `<taskDir>/fixture/docs/` provides; if that is absent, nothing is injected
   * unless a bundle is named here.
   */
  docsBundle?: DocsBundle;
  /** Short label folded into the temp directory name for debuggability. */
  label?: string;
  /** Leave the directory behind on cleanup(). */
  keep?: boolean;
  /** Override the strip lists (e.g. a task that legitimately ships an AGENTS.md). */
  docArtifactFiles?: string[];
  docArtifactDirs?: string[];
}

export interface PreparedWorkspace {
  /** The directory the agent CLI runs in (its cwd). */
  dir: string;
  /** Sibling directory to export as `NOTION_HOME`. */
  notionHome: string;
  /** The temp root that `cleanup()` removes. */
  root: string;
  taskDir: string;
  docsCondition: DocsCondition;
  /** Workspace-relative paths added by the docs injection. */
  docsInjected: string[];
  /** Workspace-relative paths removed by the docs strip. */
  docsStripped: string[];
  /** Idempotent; refuses to delete anything outside its own temp root. */
  cleanup(): Promise<void>;
}

export function fixtureWorkspaceDir(taskDir: string): string {
  return path.join(taskDir, 'fixture', 'workspace');
}

export function fixtureDocsDir(taskDir: string): string {
  return path.join(taskDir, 'fixture', 'docs');
}

export async function prepareWorkspace(opts: PrepareWorkspaceOptions): Promise<PreparedWorkspace> {
  const taskDir = path.resolve(opts.taskDir);
  const tmpRoot = path.resolve(opts.tmpRoot ?? os.tmpdir());
  await mkdir(tmpRoot, { recursive: true });

  const label = sanitizeLabel(opts.label ?? path.basename(taskDir));
  const root = await mkdtemp(path.join(tmpRoot, `nb-${label}-`));
  const dir = path.join(root, 'workspace');
  const notionHome = path.join(root, 'notion-home');
  await mkdir(dir, { recursive: true });
  // 0700: the leased Notion token lands in here; nothing else on the box needs it.
  await mkdir(notionHome, { recursive: true, mode: 0o700 });

  const fixture = fixtureWorkspaceDir(taskDir);
  if (await exists(fixture)) {
    await cp(fixture, dir, { recursive: true, dereference: false, force: true });
  }

  let docsInjected: string[] = [];
  let docsStripped: string[] = [];
  if (opts.docsCondition === 'with') {
    docsInjected = await injectDocs({
      workspaceDir: dir,
      taskDir,
      templatesDir: path.resolve(opts.templatesDir ?? DEFAULT_TEMPLATES_DIR),
      bundle: opts.docsBundle,
    });
  } else {
    docsStripped = await stripDocs(dir, {
      files: opts.docArtifactFiles ?? DOC_ARTIFACT_FILES,
      dirs: opts.docArtifactDirs ?? DOC_ARTIFACT_DIRS,
    });
  }

  let cleaned = false;
  return {
    dir,
    notionHome,
    root,
    taskDir,
    docsCondition: opts.docsCondition,
    docsInjected,
    docsStripped,
    async cleanup(): Promise<void> {
      if (cleaned || opts.keep) return;
      cleaned = true;
      assertInside(root, tmpRoot);
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Copy agent docs into the workspace for the `with` condition.
 *
 * Precedence (first match wins per artifact):
 *   1. `<taskDir>/fixture/docs/**` — a task-authored bundle, copied verbatim.
 *   2. The named template's AGENTS.md / skills directories under `templatesDir`.
 */
export async function injectDocs(args: {
  workspaceDir: string;
  taskDir: string;
  templatesDir: string;
  bundle?: DocsBundle;
}): Promise<string[]> {
  const injected: string[] = [];

  const taskDocs = fixtureDocsDir(args.taskDir);
  if (await exists(taskDocs)) {
    for (const rel of await listTree(taskDocs)) {
      await copyInto(path.join(taskDocs, rel), path.join(args.workspaceDir, rel));
      injected.push(rel);
    }
  }

  if (args.bundle) {
    const templateRoot = path.join(args.templatesDir, TEMPLATE_DIRS[args.bundle]);
    for (const rel of [...DOC_ARTIFACT_FILES, ...DOC_ARTIFACT_DIRS, 'skills']) {
      const from = path.join(templateRoot, rel);
      const to = path.join(args.workspaceDir, rel);
      if (injected.includes(rel)) continue; // task bundle wins
      if (!(await exists(from))) continue;
      await copyInto(from, to);
      injected.push(rel);
    }
  }

  injected.sort();
  return injected;
}

/**
 * Remove agent docs for the `without` condition, recursively — a fixture cloned
 * from an upstream template carries AGENTS.md files in subdirectories, and missing
 * one would quietly contaminate the headline docs-axis chart.
 */
export async function stripDocs(
  workspaceDir: string,
  lists: { files: string[]; dirs: string[] } = { files: DOC_ARTIFACT_FILES, dirs: DOC_ARTIFACT_DIRS },
): Promise<string[]> {
  const removed: string[] = [];
  const fileSet = new Set(lists.files);
  // Multi-segment entries (e.g. '.github/agents') are handled as path suffixes.
  const dirNames = new Set(lists.dirs.filter((d) => !d.includes('/')));
  const dirPaths = lists.dirs.filter((d) => d.includes('/'));

  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = toPosix(path.relative(workspaceDir, full));
      if (e.isDirectory()) {
        if (dirNames.has(e.name)) {
          await rm(full, { recursive: true, force: true });
          removed.push(rel);
          continue;
        }
        if (e.name === 'node_modules' || e.name === '.git') continue;
        await walk(full);
        continue;
      }
      if (fileSet.has(e.name)) {
        await rm(full, { force: true });
        removed.push(rel);
      }
    }
  };

  if (!(await exists(workspaceDir))) return removed;
  await walk(workspaceDir);

  for (const rel of dirPaths) {
    const full = path.join(workspaceDir, rel);
    if (await exists(full)) {
      await rm(full, { recursive: true, force: true });
      removed.push(toPosix(rel));
    }
  }

  removed.sort();
  return removed;
}

/** Top-level entries of a directory tree, relative and posix-separated. */
async function listTree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.map((e) => e.name);
}

async function copyInto(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, force: true, dereference: false });
}

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40) || 'task';
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Guard against a misconfigured tmpRoot turning cleanup() into `rm -rf` on real data. */
function assertInside(target: string, root: string): void {
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.length === 0) {
    throw new Error(`refusing to remove ${target}: not inside temp root ${root}`);
  }
}
