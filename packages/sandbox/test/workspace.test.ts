import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DOC_ARTIFACT_FILES,
  exists,
  injectDocs,
  prepareWorkspace,
  stripDocs,
} from '../src/workspace.js';

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'nb-sandbox-test-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function write(p: string, content: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, content, 'utf8');
}

/** Build a task dir with a fixture workspace and (optionally) a docs bundle. */
async function makeTask(
  id: string,
  files: Record<string, string>,
  docs: Record<string, string> = {},
): Promise<string> {
  const taskDir = path.join(scratch, 'evals', id);
  for (const [rel, content] of Object.entries(files)) {
    await write(path.join(taskDir, 'fixture', 'workspace', rel), content);
  }
  for (const [rel, content] of Object.entries(docs)) {
    await write(path.join(taskDir, 'fixture', 'docs', rel), content);
  }
  return taskDir;
}

describe('prepareWorkspace', () => {
  it('copies the fixture workspace into a fresh temp dir and leaves the fixture untouched', async () => {
    const taskDir = await makeTask('build-nac-001', {
      'package.json': '{"name":"fixture"}',
      'src/index.ts': 'export const x = 1;\n',
    });

    const ws = await prepareWorkspace({
      taskDir,
      docsCondition: 'without',
      tmpRoot: path.join(scratch, 'tmp'),
    });

    expect(ws.dir).not.toBe(path.join(taskDir, 'fixture', 'workspace'));
    expect(await exists(path.join(ws.dir, 'package.json'))).toBe(true);
    expect(await exists(path.join(ws.dir, 'src', 'index.ts'))).toBe(true);

    // Mutating the trial workspace must not touch the fixture.
    await writeFile(path.join(ws.dir, 'package.json'), 'CLOBBERED', 'utf8');
    const fixture = await readdir(path.join(taskDir, 'fixture', 'workspace'));
    expect(fixture.sort()).toEqual(['package.json', 'src']);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(path.join(taskDir, 'fixture', 'workspace', 'package.json'), 'utf8')).toBe(
      '{"name":"fixture"}',
    );

    await ws.cleanup();
  });

  it('creates a per-trial NOTION_HOME sibling that is not inside the agent workspace', async () => {
    const taskDir = await makeTask('t', { 'a.txt': 'a' });
    const ws = await prepareWorkspace({
      taskDir,
      docsCondition: 'without',
      tmpRoot: path.join(scratch, 'tmp'),
    });

    expect(await exists(ws.notionHome)).toBe(true);
    // The agent must not be able to read the leased token by listing its own cwd.
    expect(path.relative(ws.dir, ws.notionHome).startsWith('..')).toBe(true);
    expect(path.dirname(ws.notionHome)).toBe(ws.root);

    const st = await stat(ws.notionHome);
    // 0700 — only the runner's user.
    expect(st.mode & 0o077).toBe(0);

    await ws.cleanup();
  });

  it('tolerates a task with no fixture workspace at all', async () => {
    const taskDir = path.join(scratch, 'evals', 'offline-only');
    await mkdir(taskDir, { recursive: true });

    const ws = await prepareWorkspace({
      taskDir,
      docsCondition: 'without',
      tmpRoot: path.join(scratch, 'tmp'),
    });
    expect(await exists(ws.dir)).toBe(true);
    expect(await readdir(ws.dir)).toEqual([]);
    await ws.cleanup();
  });

  it('cleanup removes the whole temp root and is idempotent', async () => {
    const taskDir = await makeTask('t', { 'a.txt': 'a' });
    const ws = await prepareWorkspace({
      taskDir,
      docsCondition: 'without',
      tmpRoot: path.join(scratch, 'tmp'),
    });
    const root = ws.root;
    await ws.cleanup();
    expect(await exists(root)).toBe(false);
    await expect(ws.cleanup()).resolves.toBeUndefined();
  });

  it('keep:true leaves the workspace behind for debugging', async () => {
    const taskDir = await makeTask('t', { 'a.txt': 'a' });
    const ws = await prepareWorkspace({
      taskDir,
      docsCondition: 'without',
      tmpRoot: path.join(scratch, 'tmp'),
      keep: true,
    });
    await ws.cleanup();
    expect(await exists(ws.root)).toBe(true);
  });

  it('gives concurrent trials of the same task disjoint workspaces', async () => {
    const taskDir = await makeTask('t', { 'a.txt': 'a' });
    const opts = { taskDir, docsCondition: 'without' as const, tmpRoot: path.join(scratch, 'tmp') };
    const [a, b] = await Promise.all([prepareWorkspace(opts), prepareWorkspace(opts)]);
    expect(a.dir).not.toBe(b.dir);
    await writeFile(path.join(a.dir, 'a.txt'), 'mutated-by-a', 'utf8');
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(path.join(b.dir, 'a.txt'), 'utf8')).toBe('a');
    await a.cleanup();
    await b.cleanup();
  });
});

describe('docs axis: without', () => {
  it('strips agent docs recursively, including ones inherited from a template', async () => {
    const taskDir = await makeTask('t', {
      'AGENTS.md': '# root instructions',
      'CLAUDE.md': '# claude',
      'packages/worker/AGENTS.md': '# nested instructions',
      '.claude/skills/notion/SKILL.md': '# skill',
      '.cursorrules': 'rules',
      'src/index.ts': 'export const x = 1;\n',
      'docs/runbook.md': '# task material, must survive',
    });

    const ws = await prepareWorkspace({
      taskDir,
      docsCondition: 'without',
      tmpRoot: path.join(scratch, 'tmp'),
    });

    expect(ws.docsStripped).toEqual(
      ['.claude', '.cursorrules', 'AGENTS.md', 'CLAUDE.md', 'packages/worker/AGENTS.md'].sort(),
    );
    for (const gone of ['AGENTS.md', 'CLAUDE.md', 'packages/worker/AGENTS.md', '.claude', '.cursorrules']) {
      expect(await exists(path.join(ws.dir, gone))).toBe(false);
    }
    // Task material must survive: `docs/` is NOT an agent-docs artifact.
    expect(await exists(path.join(ws.dir, 'docs', 'runbook.md'))).toBe(true);
    expect(await exists(path.join(ws.dir, 'src', 'index.ts'))).toBe(true);

    await ws.cleanup();
  });

  it('does not descend into node_modules or .git when stripping', async () => {
    const dir = path.join(scratch, 'ws');
    await write(path.join(dir, 'node_modules', 'pkg', 'AGENTS.md'), 'vendor');
    await write(path.join(dir, '.git', 'AGENTS.md'), 'history');
    await write(path.join(dir, 'AGENTS.md'), 'real');

    const removed = await stripDocs(dir);
    expect(removed).toEqual(['AGENTS.md']);
    expect(await exists(path.join(dir, 'node_modules', 'pkg', 'AGENTS.md'))).toBe(true);
  });

  it('honours a custom artifact list', async () => {
    const dir = path.join(scratch, 'ws');
    await write(path.join(dir, 'AGENTS.md'), 'keep me');
    await write(path.join(dir, 'HINTS.md'), 'remove me');

    const removed = await stripDocs(dir, { files: ['HINTS.md'], dirs: [] });
    expect(removed).toEqual(['HINTS.md']);
    expect(await exists(path.join(dir, 'AGENTS.md'))).toBe(true);
  });

  it('is a no-op on a workspace with no docs', async () => {
    const dir = path.join(scratch, 'ws');
    await write(path.join(dir, 'src', 'a.ts'), 'x');
    expect(await stripDocs(dir)).toEqual([]);
  });
});

describe('docs axis: with', () => {
  it('copies the task-authored docs bundle into the workspace root', async () => {
    const taskDir = await makeTask(
      't',
      { 'src/index.ts': 'x' },
      { 'AGENTS.md': '# notion platform instructions', 'skills/ntn/SKILL.md': '# ntn skill' },
    );

    const ws = await prepareWorkspace({
      taskDir,
      docsCondition: 'with',
      tmpRoot: path.join(scratch, 'tmp'),
    });

    expect(ws.docsInjected).toEqual(['AGENTS.md', 'skills']);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(path.join(ws.dir, 'AGENTS.md'), 'utf8')).toBe(
      '# notion platform instructions',
    );
    expect(await exists(path.join(ws.dir, 'skills', 'ntn', 'SKILL.md'))).toBe(true);
    expect(ws.docsStripped).toEqual([]);

    await ws.cleanup();
  });

  it('falls back to the preinstalled template docs when the task ships none', async () => {
    const templatesDir = path.join(scratch, 'templates');
    await write(path.join(templatesDir, 'workers-template', 'AGENTS.md'), '# workers template');
    await write(path.join(templatesDir, 'workers-template', 'skills', 's', 'SKILL.md'), '# s');
    await write(path.join(templatesDir, 'workers-template', 'src', 'index.ts'), 'not docs');

    const taskDir = await makeTask('t', { 'src/index.ts': 'x' });
    const ws = await prepareWorkspace({
      taskDir,
      docsCondition: 'with',
      tmpRoot: path.join(scratch, 'tmp'),
      templatesDir,
      docsBundle: 'workers',
    });

    expect(ws.docsInjected).toEqual(['AGENTS.md', 'skills']);
    expect(await exists(path.join(ws.dir, 'AGENTS.md'))).toBe(true);
    // Only docs artifacts come across, not the template's source.
    expect(await exists(path.join(ws.dir, 'src', 'index.ts'))).toBe(true);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(path.join(ws.dir, 'src', 'index.ts'), 'utf8')).toBe('x');

    await ws.cleanup();
  });

  it('lets a task-authored bundle win over the template', async () => {
    const templatesDir = path.join(scratch, 'templates');
    await write(path.join(templatesDir, 'notion-as-code-template', 'AGENTS.md'), 'FROM TEMPLATE');

    const taskDir = await makeTask('t', {}, { 'AGENTS.md': 'FROM TASK' });
    const injected = await injectDocs({
      workspaceDir: await (async () => {
        const d = path.join(scratch, 'ws-inject');
        await mkdir(d, { recursive: true });
        return d;
      })(),
      taskDir,
      templatesDir,
      bundle: 'nac',
    });
    expect(injected).toEqual(['AGENTS.md']);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(path.join(scratch, 'ws-inject', 'AGENTS.md'), 'utf8')).toBe('FROM TASK');
  });

  it('does not fail when the templates dir is missing entirely', async () => {
    const taskDir = await makeTask('t', { 'a.txt': 'a' });
    const ws = await prepareWorkspace({
      taskDir,
      docsCondition: 'with',
      tmpRoot: path.join(scratch, 'tmp'),
      templatesDir: path.join(scratch, 'does-not-exist'),
      docsBundle: 'workers',
    });
    expect(ws.docsInjected).toEqual([]);
    await ws.cleanup();
  });

  it('with-condition workspaces keep docs the without-condition would strip', async () => {
    // Guards the docs axis itself: the two conditions must actually differ.
    const files = { 'AGENTS.md': '# instructions', 'src/a.ts': 'x' };
    const taskDir = await makeTask('t', files);
    const tmpRoot = path.join(scratch, 'tmp');

    const withDocs = await prepareWorkspace({ taskDir, docsCondition: 'with', tmpRoot });
    const withoutDocs = await prepareWorkspace({ taskDir, docsCondition: 'without', tmpRoot });

    expect(await exists(path.join(withDocs.dir, 'AGENTS.md'))).toBe(true);
    expect(await exists(path.join(withoutDocs.dir, 'AGENTS.md'))).toBe(false);

    await withDocs.cleanup();
    await withoutDocs.cleanup();
  });
});

describe('DOC_ARTIFACT_FILES', () => {
  it('covers the agent-instruction filenames the major CLIs read', () => {
    expect(DOC_ARTIFACT_FILES).toContain('AGENTS.md');
    expect(DOC_ARTIFACT_FILES).toContain('CLAUDE.md');
  });
});
