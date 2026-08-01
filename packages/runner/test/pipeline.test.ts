/**
 * End-to-end wiring: `notionbench run` does spawn -> score -> checkpoint, and
 * `notionbench score` turns what it wrote into the published table.
 *
 * The agent is a two-line shell script and the verifier is a five-line EVAL.ts,
 * so this exercises the plumbing (workspace prep, docs axis, subprocess
 * verification, results.jsonl, checkpointing, aggregation) without a model, a
 * network, or a real task fixture.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { readResults } from '@notionbench/scoring';

let scratch: string;
let evalsRoot: string;
let resultsRoot: string;
let runconfigPath: string;
let out: string[];
let restore: (() => void) | undefined;

/** A task whose oracle is "write DONE into solved.txt". */
async function writeTask(id: string, opts: { solvable: boolean }): Promise<void> {
  const dir = path.join(evalsRoot, id);
  await mkdir(path.join(dir, 'fixture', 'workspace'), { recursive: true });
  await writeFile(
    path.join(dir, 'PROMPT.md'),
    `---\nid: ${id}\nsuite: benchmark\nfamily: ${id.split('-')[1]}\nstage: ${id.split('-')[0]}\nruntime: offline\nlimits: { time: 30 }\n---\n\nWrite DONE into solved.txt.\n`,
    'utf8',
  );
  await writeFile(path.join(dir, 'fixture', 'workspace', 'README.md'), '# fixture\n', 'utf8');
  await writeFile(
    path.join(dir, 'EVAL.ts'),
    `import { readFile } from "node:fs/promises"
     import * as path from "node:path"
     export default async ({ workspaceDir }) => {
       ${opts.solvable ? '' : 'return { score: 0, subscores: { wrote: 0 }, diagnostics: ["this task is never solvable"] }'}
       try {
         const text = await readFile(path.join(workspaceDir, "solved.txt"), "utf8")
         const ok = text.trim() === "DONE"
         return { score: ok ? 1 : 0, subscores: { wrote: ok ? 1 : 0 }, diagnostics: ["read solved.txt"] }
       } catch {
         return { score: 0, subscores: { wrote: 0 }, diagnostics: ["no solved.txt"] }
       }
     }
    `,
    'utf8',
  );
}

/** A "CLI" that solves the task by writing the file the verifier looks for. */
async function writeAgent(name: string, body: string): Promise<string> {
  const file = path.join(scratch, name);
  await writeFile(file, body, 'utf8');
  await chmod(file, 0o755);
  return file;
}

function capture(): void {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  restore = () => {
    process.stdout.write = original;
  };
}

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'nb-pipeline-'));
  evalsRoot = path.join(scratch, 'evals');
  resultsRoot = path.join(scratch, 'results');
  runconfigPath = path.join(scratch, 'runconfig.json');
  out = [];
  await mkdir(evalsRoot, { recursive: true });
});

afterEach(async () => {
  restore?.();
  restore = undefined;
  await rm(scratch, { recursive: true, force: true });
});

async function writeRunconfig(agentPath: string): Promise<void> {
  await writeFile(
    runconfigPath,
    JSON.stringify({
      configs: [
        {
          id: 'fake-agent',
          label: 'Fake Agent',
          harness: 'command-template',
          command: agentPath,
          argsTemplate: ['{workspace}', '{prompt}'],
          model: 'fake-1',
          enabled: true,
          pricing: { inputPerMTok: 1, outputPerMTok: 2 },
        },
      ],
      resultsRoot,
      evalsRoot,
      concurrency: 1,
      trials: 2,
      timeoutSec: 30,
    }),
    'utf8',
  );
}

const SOLVER = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake 1.0"; exit 0; fi
printf 'DONE\\n' > "$1/solved.txt"
echo '{"usage":{"input_tokens":100,"output_tokens":50},"tool_calls":3,"tool_errors":1}'
`;

const IDLE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake 1.0"; exit 0; fi
echo '{"usage":{"input_tokens":10,"output_tokens":5}}'
`;

describe('run: spawn -> score -> checkpoint', () => {
  it('scores every trial and appends one results.jsonl row each', async () => {
    await writeTask('build-fake-001-writes-a-file', { solvable: true });
    await writeRunconfig(await writeAgent('solver.sh', SOLVER));
    capture();

    const code = await main([
      'run',
      '--runconfig',
      runconfigPath,
      '--docs',
      'with',
      '--trials',
      '2',
    ]);
    restore?.();
    expect(code).toBe(0);

    const runId = /run (\d{8}-\d{6})/.exec(out.join(''))?.[1];
    expect(runId).toBeTruthy();
    const runDir = path.join(resultsRoot, runId!);

    const { records, problems } = await readResults(runDir);
    expect(problems).toEqual([]);
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.scored).toBe(true);
      expect(r.score).toBe(1);
      expect(r.status).toBe('completed');
      expect(r.subscores).toEqual({ wrote: 1 });
      expect(r.taskId).toBe('build-fake-001-writes-a-file');
      expect(r.configId).toBe('fake-agent');
      expect(r.docsCondition).toBe('with');
      expect(r.wallTimeMs).toBeGreaterThanOrEqual(0);
    }
    expect(records.map((r) => r.trial).sort()).toEqual([1, 2]);
  });

  it('mirrors the verdict into the checkpoint, after the row is durable', async () => {
    await writeTask('build-fake-001-writes-a-file', { solvable: true });
    await writeRunconfig(await writeAgent('solver.sh', SOLVER));
    capture();
    await main(['run', '--runconfig', runconfigPath, '--docs', 'with', '--trials', '1']);
    restore?.();

    const runId = /run (\d{8}-\d{6})/.exec(out.join(''))!.at(1)!;
    const state = JSON.parse(
      await readFile(path.join(resultsRoot, runId, 'state.json'), 'utf8'),
    ) as { cells: Record<string, { status: string; score?: number; scored?: boolean }> };
    const cell = Object.values(state.cells)[0]!;
    expect(cell.status).toBe('done');
    expect(cell.scored).toBe(true);
    expect(cell.score).toBe(1);
  });

  it('records a failing agent as a real 0, not as an error', async () => {
    await writeTask('build-fake-001-writes-a-file', { solvable: true });
    await writeRunconfig(await writeAgent('idle.sh', IDLE));
    capture();
    await main(['run', '--runconfig', runconfigPath, '--docs', 'with', '--trials', '1']);
    restore?.();

    const runId = /run (\d{8}-\d{6})/.exec(out.join(''))!.at(1)!;
    const { records } = await readResults(path.join(resultsRoot, runId));
    expect(records[0]!.scored).toBe(true);
    expect(records[0]!.score).toBe(0);
    expect(records[0]!.diagnostics).toEqual(['no solved.txt']);
  });

  it('--no-score records the rollout and marks it unverified', async () => {
    await writeTask('build-fake-001-writes-a-file', { solvable: true });
    await writeRunconfig(await writeAgent('solver.sh', SOLVER));
    capture();
    await main([
      'run',
      '--runconfig',
      runconfigPath,
      '--docs',
      'with',
      '--trials',
      '1',
      '--no-score',
    ]);
    restore?.();

    const runId = /run (\d{8}-\d{6})/.exec(out.join(''))!.at(1)!;
    const { records } = await readResults(path.join(resultsRoot, runId));
    expect(records[0]!.scored).toBe(false);
    expect(records[0]!.scoreError).toContain('--no-score');
    expect(records[0]!.status).toBe('completed');
  });

  it('points results/latest at the run just started', async () => {
    await writeTask('build-fake-001-writes-a-file', { solvable: true });
    await writeRunconfig(await writeAgent('solver.sh', SOLVER));
    capture();
    await main(['run', '--runconfig', runconfigPath, '--docs', 'with', '--trials', '1']);
    restore?.();
    const { records } = await readResults(path.join(resultsRoot, 'latest'));
    expect(records).toHaveLength(1);
  });
});

describe('score', () => {
  async function runTwoTasks(): Promise<string> {
    await writeTask('build-fake-001-writes-a-file', { solvable: true });
    await writeTask('resolve-other-001-impossible', { solvable: false });
    await writeRunconfig(await writeAgent('solver.sh', SOLVER));
    capture();
    await main(['run', '--runconfig', runconfigPath, '--docs', 'with', '--trials', '2']);
    const runId = /run (\d{8}-\d{6})/.exec(out.join(''))!.at(1)!;
    out = [];
    return runId;
  }

  it('renders the README table and writes summary.md', async () => {
    const runId = await runTwoTasks();
    const code = await main(['score', path.join(resultsRoot, runId), '--results', resultsRoot]);
    restore?.();
    expect(code).toBe(0);

    const printed = out.join('');
    expect(printed).toContain('| Config | avg@2 (95% CI) | pass^2 | Tool errors |');
    expect(printed).toContain('Fake Agent');
    // One task always solved, one never: avg@2 = 50%, pass^2 = 50%.
    expect(printed).toMatch(/\|\s*50\.0%\s*\[/);

    const summary = await readFile(path.join(resultsRoot, runId, 'summary.md'), 'utf8');
    expect(summary).toBe(printed.slice(0, summary.length));
    expect(summary).toContain('## By product area');
    expect(summary).toContain('## By stage');
  });

  it('groups by the stage in the task id', async () => {
    const runId = await runTwoTasks();
    await main(['score', path.join(resultsRoot, runId), '--results', resultsRoot]);
    restore?.();
    const printed = out.join('');
    expect(printed).toMatch(/\|\s*build\s*\|/);
    expect(printed).toMatch(/\|\s*resolve\s*\|/);
    expect(printed).toMatch(/\|\s*fake\s*\|/);
    expect(printed).toMatch(/\|\s*other\s*\|/);
  });

  it('defaults to the newest run when given no argument', async () => {
    await runTwoTasks();
    const code = await main(['score', '--results', resultsRoot]);
    restore?.();
    expect(code).toBe(0);
    expect(out.join('')).toContain('| Config |');
  });

  it('emits JSON on request without writing summary.md', async () => {
    const runId = await runTwoTasks();
    await main(['score', path.join(resultsRoot, runId), '--results', resultsRoot, '--json']);
    restore?.();
    const report = JSON.parse(out.join('')) as { k: number; overall: Array<{ avgScore: number }> };
    expect(report.k).toBe(2);
    expect(report.overall[0]!.avgScore).toBeCloseTo(0.5, 10);
    await expect(readFile(path.join(resultsRoot, runId, 'summary.md'), 'utf8')).rejects.toThrow();
  });

  it('exits non-zero with a clean message when a run has no results yet', async () => {
    await mkdir(path.join(resultsRoot, 'empty'), { recursive: true });
    const errors: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await main(['score', path.join(resultsRoot, 'empty')])).toBe(1);
    } finally {
      process.stderr.write = original;
    }
    expect(errors.join('')).toMatch(/has this run scored anything yet/);
    expect(errors.join('')).not.toContain('at Module');
  });

  it('exits non-zero when the run directory does not exist', async () => {
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(await main(['score', path.join(resultsRoot, 'nope'), '--results', resultsRoot])).toBe(2);
    } finally {
      process.stderr.write = original;
    }
  });
});

describe('run --dry-run', () => {
  it('prints the plan and creates nothing', async () => {
    await writeTask('build-fake-001-writes-a-file', { solvable: true });
    await writeRunconfig(await writeAgent('solver.sh', SOLVER));
    capture();
    const code = await main(['run', '--runconfig', runconfigPath, '--dry-run', '--trials', '3']);
    restore?.();

    expect(code).toBe(0);
    const printed = out.join('');
    expect(printed).toContain('DRY RUN');
    expect(printed).toContain('1 task(s) × 1 config(s) × with/without docs × 3 trial(s) = 6 cell(s)');
    expect(printed).toContain('build-fake-001-writes-a-file');
    expect(printed).toContain('EVAL.ts');
    expect(printed).toContain('{prompt}');
    await expect(readFile(path.join(resultsRoot, 'x'), 'utf8')).rejects.toThrow();
  });

  it('is machine-readable with --json', async () => {
    await writeTask('build-fake-001-writes-a-file', { solvable: true });
    await writeRunconfig(await writeAgent('solver.sh', SOLVER));
    capture();
    await main(['run', '--runconfig', runconfigPath, '--dry-run', '--json']);
    restore?.();
    const plan = JSON.parse(out.join('')) as { totalCells: number; tasks: unknown[] };
    expect(plan.totalCells).toBe(4);
    expect(plan.tasks).toHaveLength(1);
  });
});
