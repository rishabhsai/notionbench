import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshotWorkspace } from '../src/artifacts.js';

let root: string;
let ws: string;
let dest: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nb-artifacts-'));
  ws = path.join(root, 'workspace');
  dest = path.join(root, 'trial');
  await fs.mkdir(ws, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const write = async (rel: string, body: string) => {
  const p = path.join(ws, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body, 'utf8');
};

describe('snapshotWorkspace', () => {
  it('captures the artifacts a re-score would need', async () => {
    await write('answer.json', '{"view_count":6}');
    await write('dist/intents.json', '[{"type":"database"}]');
    await write('src/index.ts', 'export default 1');

    const manifest = await snapshotWorkspace(ws, dest);

    expect(manifest.files.sort()).toEqual(
      ['answer.json', 'dist/intents.json', 'src/index.ts'].map((p) => path.normalize(p)),
    );
    expect(
      await fs.readFile(path.join(dest, 'workspace', 'dist', 'intents.json'), 'utf8'),
    ).toBe('[{"type":"database"}]');
  });

  it('writes a manifest next to the copy', async () => {
    await write('answer.json', '{}');
    await snapshotWorkspace(ws, dest);
    const manifest = JSON.parse(await fs.readFile(path.join(dest, 'artifacts.json'), 'utf8'));
    expect(manifest.files).toContain('answer.json');
    expect(manifest.bytes).toBeGreaterThan(0);
  });

  it('never copies node_modules', async () => {
    await write('node_modules/left-pad/index.js', 'module.exports = 1');
    await write('answer.json', '{}');
    const manifest = await snapshotWorkspace(ws, dest);
    expect(manifest.files.join(' ')).not.toContain('node_modules');
    expect(manifest.files).toContain('answer.json');
  });

  it('skips a file over the per-file ceiling, and says so', async () => {
    await write('big.bin', 'x'.repeat(2000));
    await write('answer.json', '{}');
    const manifest = await snapshotWorkspace(ws, dest, { maxFileBytes: 1000 });
    expect(manifest.files).toContain('answer.json');
    expect(manifest.skipped).toContainEqual({ path: 'big.bin', reason: 'too-large' });
  });

  it('stops at the total budget rather than filling the disk', async () => {
    for (const n of ['a', 'b', 'c']) await write(`${n}.txt`, 'x'.repeat(400));
    const manifest = await snapshotWorkspace(ws, dest, { maxTotalBytes: 900 });
    expect(manifest.bytes).toBeLessThanOrEqual(900);
    expect(manifest.skipped.some((s) => s.reason === 'budget-exhausted')).toBe(true);
  });

  it('does not throw when the workspace is already gone', async () => {
    await expect(
      snapshotWorkspace(path.join(root, 'missing'), dest),
    ).resolves.toMatchObject({ files: [] });
  });
});
