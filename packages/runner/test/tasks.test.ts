import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverTasks,
  globToRegExp,
  matchesAny,
  parseFrontmatter,
  promptBody,
  readPrompt,
} from '../src/tasks.js';
import { LineSplitter, parseTranscript } from '../src/transcript.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nb-tasks-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function task(id: string, frontmatter: string, body = 'Do the thing.'): Promise<void> {
  const dir = path.join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'PROMPT.md'), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8');
}

describe('globToRegExp', () => {
  it('matches within a segment with *', () => {
    expect(globToRegExp('build-nac-*').test('build-nac-001-workspace')).toBe(true);
    expect(globToRegExp('build-nac-*').test('resolve-nac-001')).toBe(false);
    expect(globToRegExp('build-*').test('build/nested')).toBe(false);
  });

  it('crosses segments with **', () => {
    expect(globToRegExp('nac/**').test('nac/deep/nested-task')).toBe(true);
    expect(globToRegExp('**/idempotent-*').test('nac/resolve/idempotent-extend')).toBe(true);
    // `**/` must also match zero segments.
    expect(globToRegExp('**/idempotent-*').test('idempotent-extend')).toBe(true);
  });

  it('supports ? and {a,b} alternation', () => {
    expect(globToRegExp('task-00?').test('task-001')).toBe(true);
    expect(globToRegExp('{build,resolve}-nac-*').test('resolve-nac-001')).toBe(true);
    expect(globToRegExp('{build,resolve}-nac-*').test('operate-nac-001')).toBe(false);
  });

  it('treats regex metacharacters in the pattern as literals', () => {
    expect(globToRegExp('build.cli').test('build.cli')).toBe(true);
    expect(globToRegExp('build.cli').test('buildXcli')).toBe(false);
  });

  it('matchesAny with no patterns selects everything', () => {
    expect(matchesAny('anything', [])).toBe(true);
    expect(matchesAny('a', ['b', 'a'])).toBe(true);
    expect(matchesAny('c', ['a', 'b'])).toBe(false);
  });
});

describe('parseFrontmatter', () => {
  it('parses the shape docs/PLAN.md specifies', () => {
    const fm = parseFrontmatter(
      [
        '---',
        'id: nac/idempotent-extend',
        'suite: benchmark',
        'family: nac',
        'stage: resolve',
        'topics: [resource-ids, idempotency]',
        'difficulty: L3',
        'fixture: none',
        'verify: [static, intents]',
        'limits: {time: 900, cost: 3.0}',
        '---',
        '',
        'body',
      ].join('\n'),
    );
    expect(fm).toMatchObject({
      id: 'nac/idempotent-extend',
      suite: 'benchmark',
      topics: ['resource-ids', 'idempotency'],
      verify: ['static', 'intents'],
      limits: { time: 900, cost: 3 },
    });
  });

  it('handles quotes, booleans, comments and empty values', () => {
    const fm = parseFrontmatter(
      ['---', 'id: "quoted/id"', 'live: true', 'holdout: false', 'note:   # trailing', '---'].join('\n'),
    );
    expect(fm.id).toBe('quoted/id');
    expect(fm.live).toBe(true);
    expect(fm.holdout).toBe(false);
    expect(fm.note).toBe('');
  });

  it('returns an empty object when there is no frontmatter', () => {
    expect(parseFrontmatter('# Just a prompt\n')).toEqual({});
  });

  it('does not misparse nested block content as a top-level key', () => {
    const fm = parseFrontmatter(['---', 'limits:', '  time: 900', 'id: x', '---'].join('\n'));
    expect(fm.id).toBe('x');
    expect(fm.limits).toBe('');
  });
});

describe('promptBody', () => {
  it('strips frontmatter so the agent never sees the grading metadata', () => {
    const text = '---\nid: t\nverify: [static]\n---\n\nCreate a page titled Roadmap.\n';
    const body = promptBody(text);
    expect(body).toBe('Create a page titled Roadmap.');
    expect(body).not.toContain('verify');
    expect(body).not.toContain('id: t');
  });

  it('passes through a prompt with no frontmatter', () => {
    expect(promptBody('Just do it.\n')).toBe('Just do it.');
  });
});

describe('discoverTasks', () => {
  it('finds tasks recursively and derives ids from the path', async () => {
    await task('build-cli-001-create-page', 'suite: benchmark\nfamily: cli\nruntime: live');
    await task('nac/idempotent-extend', 'suite: regression\nfamily: nac\nruntime: offline');

    const tasks = await discoverTasks(root);
    expect(tasks.map((t) => t.id)).toEqual(['build-cli-001-create-page', 'nac/idempotent-extend']);
    expect(tasks[1]).toMatchObject({ suite: 'regression', family: 'nac', runtime: 'offline' });
    expect(tasks[1]!.promptPath).toBe(path.join(root, 'nac/idempotent-extend', 'PROMPT.md'));
  });

  it('prefers the frontmatter id over the directory path', async () => {
    await task('some-dir', 'id: canonical/name');
    const tasks = await discoverTasks(root);
    expect(tasks[0]!.id).toBe('canonical/name');
  });

  it('filters by glob against both the frontmatter id and the directory id', async () => {
    await task('build-nac-001-a', 'family: nac');
    await task('build-nac-002-b', 'family: nac');
    await task('resolve-workers-001-c', 'family: workers');

    expect((await discoverTasks(root, ['build-nac-*'])).map((t) => t.id)).toEqual([
      'build-nac-001-a',
      'build-nac-002-b',
    ]);
    expect((await discoverTasks(root, ['*workers*'])).map((t) => t.id)).toEqual([
      'resolve-workers-001-c',
    ]);
    expect(await discoverTasks(root, ['no-such-*'])).toEqual([]);
  });

  it('does not descend into a task directory once PROMPT.md is found', async () => {
    await task('outer', 'family: nac');
    const nested = path.join(root, 'outer', 'fixture', 'workspace');
    await mkdir(nested, { recursive: true });
    // A fixture may legitimately contain its own PROMPT.md; it is not a task.
    await writeFile(path.join(nested, 'PROMPT.md'), '---\nid: decoy\n---\n', 'utf8');

    const tasks = await discoverTasks(root);
    expect(tasks.map((t) => t.id)).toEqual(['outer']);
  });

  it('skips node_modules and dotted directories', async () => {
    await task('real', 'family: cli');
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'pkg', 'PROMPT.md'), '---\nid: vendor\n---\n', 'utf8');

    expect((await discoverTasks(root)).map((t) => t.id)).toEqual(['real']);
  });

  it('returns an empty list for a missing evals root instead of throwing', async () => {
    expect(await discoverTasks(path.join(root, 'nope'))).toEqual([]);
  });

  it('reads the prompt body for a discovered task', async () => {
    await task('t', 'id: t\nlimits: {time: 60}', 'Aggregate all 250 rows.');
    const [spec] = await discoverTasks(root);
    expect(await readPrompt(spec!)).toBe('Aggregate all 250 rows.');
    expect(spec!.limits?.time).toBe(60);
  });
});

describe('LineSplitter', () => {
  it('holds a partial line until the rest of the chunk arrives', () => {
    const s = new LineSplitter();
    expect(s.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(s.push('2}\n')).toEqual(['{"b":2}']);
    expect(s.flush()).toEqual([]);
  });

  it('flushes a trailing line that never got a newline', () => {
    const s = new LineSplitter();
    expect(s.push('no newline here')).toEqual([]);
    expect(s.flush()).toEqual(['no newline here']);
    expect(s.flush()).toEqual([]);
  });

  it('strips CR so CRLF output does not corrupt JSON parsing', () => {
    const s = new LineSplitter();
    expect(s.push('{"a":1}\r\n')).toEqual(['{"a":1}']);
  });

  it('splits a chunk containing many lines at once', () => {
    const s = new LineSplitter();
    expect(s.push('a\nb\nc\n')).toEqual(['a', 'b', 'c']);
  });
});

describe('parseTranscript', () => {
  it('separates stdout, stderr and meta records', () => {
    const text = [
      '{"t":0,"s":"meta","event":"start"}',
      '{"t":5,"s":"out","raw":"{\\"type\\":\\"result\\"}"}',
      '{"t":6,"s":"err","raw":"warning"}',
      '{"t":9,"s":"meta","event":"end","status":"completed"}',
    ].join('\n');
    const t = parseTranscript(text);
    expect(t.stdoutLines).toEqual(['{"type":"result"}']);
    expect(t.stderrLines).toEqual(['warning']);
    expect(t.meta.map((m) => m.event)).toEqual(['start', 'end']);
    expect(t.malformed).toBe(0);
  });

  it('counts corrupt records instead of throwing, so a killed run stays readable', () => {
    const t = parseTranscript('{"t":0,"s":"out","raw":"ok"}\n{"t":1,"s":"out","raw":');
    expect(t.stdoutLines).toEqual(['ok']);
    expect(t.malformed).toBe(1);
  });
});
