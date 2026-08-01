/**
 * `notionbench doctor` over fabricated run directories.
 *
 * The point of the command is the verdict sentence a human reads before writing
 * a run up, so that is what is asserted: a healthy grid must say "safe to
 * publish", and a grid containing either of the two real verifier bugs must name
 * the task, quote the shared diagnostic, and hand back the one command that
 * re-runs only that task.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { buildDoctorReport, isVerifierCrash, renderDoctorReport } from '../src/doctor.js';
import { cellKey, type CellState, type RunStateFile } from '../src/checkpoint.js';
import type { TrialRecord } from '@notionbench/scoring';

let scratch: string;
let runDir: string;

const CONFIGS = ['opus', 'sonnet', 'sol-medium', 'sol-xhigh', 'luna', 'fable', 'kimi'];

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'nb-doctor-'));
  runDir = path.join(scratch, 'results', '20260801-085000');
  await mkdir(runDir, { recursive: true });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function row(over: Partial<TrialRecord> & Pick<TrialRecord, 'taskId' | 'configId'>): TrialRecord {
  return {
    v: 1,
    runId: '20260801-085000',
    docsCondition: 'with',
    trial: 1,
    score: 1,
    scored: true,
    status: 'completed',
    wallTimeMs: 1000,
    finishedAt: '2026-08-01T09:00:00.000Z',
    ...over,
  } as TrialRecord;
}

async function writeRun(rows: TrialRecord[], extraCells: CellState[] = []): Promise<void> {
  await writeFile(
    path.join(runDir, 'results.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  );
  const cells: Record<string, CellState> = {};
  for (const r of rows) {
    cells[cellKey(r)] = {
      taskId: r.taskId,
      configId: r.configId,
      docsCondition: 'with',
      trial: r.trial,
      status: 'done',
      attempts: 1,
      rateLimitedAttempts: 0,
      score: r.score,
      scored: r.scored,
      history: [],
    };
  }
  for (const c of extraCells) cells[cellKey(c)] = c;
  const state: RunStateFile = {
    version: 1,
    runId: '20260801-085000',
    createdAt: '2026-08-01T08:50:00.000Z',
    updatedAt: '2026-08-01T09:30:00.000Z',
    meta: {
      concurrency: 2,
      trials: 1,
      docsConditions: ['with'],
      maxAttempts: 3,
      cooldownMs: 1_800_000,
      evalsRoot: 'evals',
      resultsRoot: 'results',
      configs: CONFIGS.map((id) => ({ id, harness: 'claude-code', model: id })),
      taskIds: [...new Set(rows.map((r) => r.taskId))],
    },
    cells,
  };
  await writeFile(path.join(runDir, 'state.json'), JSON.stringify(state), 'utf8');
}

// ---------------------------------------------------------------------------

describe('a healthy run', () => {
  /** The shape of the real pilot: everything solved except one config on one task. */
  const HEALTHY: TrialRecord[] = [
    ...CONFIGS.map((configId) =>
      row({ taskId: 'build-nac-001-workspace-from-spec', configId, diagnostics: ['build ok — 6 intents compiled'] }),
    ),
    ...CONFIGS.map((configId) =>
      configId === 'sonnet'
        ? row({
            taskId: 'build-cli-001-create-page-with-icon',
            configId,
            score: 0,
            diagnostics: ['no page titled "Onboarding Checklist" anywhere under the sandbox root'],
          })
        : row({ taskId: 'build-cli-001-create-page-with-icon', configId, diagnostics: ['found "Onboarding Checklist"'] }),
    ),
  ];

  it('says so, and exits 0', async () => {
    await writeRun(HEALTHY);
    const report = await buildDoctorReport(runDir);
    expect(report.verdict.level).toBe('clean');
    expect(report.verdict.headline).toBe('no invalid tasks detected');
    expect(report.invalidTasks).toEqual([]);
    expect(report.suspectTasks).toEqual([]);
    expect(report.totals).toMatchObject({ rows: 14, solved: 13, failed: 1, unverified: 0 });
    const text = renderDoctorReport(report);
    expect(text).toContain('Safe to publish as far as task validity goes');
  });

  it('does not flag a task two configs failed for DIFFERENT reasons', async () => {
    await writeRun([
      ...CONFIGS.slice(0, 5).map((configId) =>
        row({ taskId: 'build-nac-003-relations-rollup', configId, diagnostics: ['ok'] }),
      ),
      row({
        taskId: 'build-nac-003-relations-rollup',
        configId: 'fable',
        score: 0,
        diagnostics: ['rollup aggregation is sum, expected average'],
      }),
      row({
        taskId: 'build-nac-003-relations-rollup',
        configId: 'kimi',
        score: 0,
        diagnostics: ['relation property points at the wrong data source'],
      }),
    ]);
    const report = await buildDoctorReport(runDir);
    expect(report.verdict.level).toBe('clean');
    expect(report.findings).toEqual([]);
  });
});

describe('a run containing a broken verifier', () => {
  it('names the task and quotes the shared diagnostic', async () => {
    await writeRun([
      ...CONFIGS.slice(0, 3).map((configId, i) =>
        row({
          taskId: 'build-nac-004-board-view-filters',
          configId,
          score: 0,
          diagnostics: [`unexpected field \`views\` at intents[${i}]`],
        }),
      ),
      ...CONFIGS.slice(3).map((configId) =>
        row({ taskId: 'build-nac-004-board-view-filters', configId, diagnostics: ['ok'] }),
      ),
    ]);
    const report = await buildDoctorReport(runDir);
    expect(report.verdict.level).toBe('invalid');
    expect(report.invalidTasks).toEqual(['build-nac-004-board-view-filters']);
    const finding = report.findings.find((f) => f.kind === 'cross-config-identical-failure')!;
    expect(finding.evidence).toContain('unexpected field "views"');
    expect(finding.configIds).toEqual(['opus', 'sol-medium', 'sonnet']);

    const text = renderDoctorReport(report);
    expect(text).toContain('These tasks look INVALID');
    expect(text).toContain(
      'notionbench run --resume 20260801-085000 --redo build-nac-004-board-view-filters',
    );
  });

  it('flags a verifier crash even when only one cell hit it', async () => {
    await writeRun([
      row({
        taskId: 'build-nac-002-csv-seeded',
        configId: 'opus',
        score: 0,
        scored: false,
        scoreError: 'verifier exited 1 without a result: TypeError: intents.map is not a function',
      }),
      ...CONFIGS.slice(1).map((configId) => row({ taskId: 'build-nac-002-csv-seeded', configId })),
    ]);
    const report = await buildDoctorReport(runDir);
    expect(report.verdict.level).toBe('invalid');
    const finding = report.findings.find((f) => f.kind === 'verifier-crash')!;
    expect(finding.detail.join(' ')).toContain('intents.map is not a function');
  });

  it('does NOT read a rate-limited or --no-score row as a verifier crash', async () => {
    expect(
      isVerifierCrash(row({ taskId: 't', configId: 'a', scored: false, score: 0, scoreError: 'not scored: status rate_limited' })),
    ).toBe(false);
    expect(
      isVerifierCrash(row({ taskId: 't', configId: 'a', scored: false, score: 0, scoreError: 'scoring disabled (--no-score)' })),
    ).toBe(false);
    expect(
      isVerifierCrash(row({ taskId: 't', configId: 'a', scored: false, score: 0, scoreError: 'verifier timed out' })),
    ).toBe(true);

    await writeRun(
      CONFIGS.map((configId) =>
        row({
          taskId: 'build-nac-001-workspace-from-spec',
          configId,
          scored: false,
          score: 0,
          scoreError: 'not scored: status rate_limited',
        }),
      ),
    );
    const report = await buildDoctorReport(runDir);
    expect(report.findings.filter((f) => f.kind === 'verifier-crash')).toEqual([]);
    expect(report.verdict.level).toBe('clean');
  });
});

describe('a run where every config scored 0 for different reasons', () => {
  it('is SUSPECT, not INVALID — that is also what a very hard task looks like', async () => {
    const reasons = [
      'no dist/intents.json produced',
      'relation points at the wrong data source',
      'rollup aggregation is sum, expected average',
      'board view has no group-by',
      'the schema is missing an Owner property',
      'build refused: anchor rule violated',
      'created four databases where two were asked for',
    ];
    await writeRun(
      CONFIGS.map((configId, i) =>
        row({ taskId: 'build-nac-006-custom-agent', configId, score: 0, diagnostics: [reasons[i]!] }),
      ),
    );
    const report = await buildDoctorReport(runDir);
    expect(report.verdict.level).toBe('suspect');
    expect(report.suspectTasks).toEqual(['build-nac-006-custom-agent']);
    expect(report.invalidTasks).toEqual([]);
    expect(renderDoctorReport(report)).toContain('SUSPECT');
  });
});

describe('the CLI', () => {
  async function run(args: string[]): Promise<{ code: number; out: string }> {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: string) => (chunks.push(String(c)), true)) as typeof process.stdout.write;
    process.stderr.write = ((c: string) => (chunks.push(String(c)), true)) as typeof process.stderr.write;
    try {
      const code = await main(args);
      return { code, out: chunks.join('') };
    } finally {
      process.stdout.write = original;
      process.stderr.write = originalErr;
    }
  }

  it('exits 0 on a clean run, 3 on an invalid one, so it works as a publish gate', async () => {
    await writeRun(CONFIGS.map((configId) => row({ taskId: 'build-nac-001-workspace-from-spec', configId })));
    const clean = await run(['doctor', runDir, '--results', path.join(scratch, 'results')]);
    expect(clean.code).toBe(0);
    expect(clean.out).toContain('verdict: no invalid tasks detected');

    await writeRun([
      ...CONFIGS.slice(0, 3).map((configId) =>
        row({ taskId: 'build-nac-004-board-view-filters', configId, score: 0, diagnostics: ['unexpected field `views`'] }),
      ),
      ...CONFIGS.slice(3).map((configId) => row({ taskId: 'build-nac-004-board-view-filters', configId })),
    ]);
    const broken = await run(['doctor', runDir, '--results', path.join(scratch, 'results')]);
    expect(broken.code).toBe(3);
    expect(broken.out).toContain('build-nac-004-board-view-filters');
  });

  it('emits the whole report as JSON', async () => {
    await writeRun(CONFIGS.map((configId) => row({ taskId: 'build-nac-001-workspace-from-spec', configId })));
    const { out } = await run(['doctor', runDir, '--json', '--results', path.join(scratch, 'results')]);
    const report = JSON.parse(out) as { verdict: { level: string }; tasks: unknown[] };
    expect(report.verdict.level).toBe('clean');
    expect(report.tasks).toHaveLength(1);
  });

  it('refuses a directory that is not a run', async () => {
    const { code } = await run(['doctor', path.join(scratch, 'nope'), '--results', path.join(scratch, 'results')]);
    expect(code).toBe(2);
  });

  it('reports abandoned cells and a torn results line without failing', async () => {
    await writeRun(
      CONFIGS.slice(0, 2).map((configId) => row({ taskId: 'build-nac-001-workspace-from-spec', configId })),
      [
        {
          taskId: 'build-nac-001-workspace-from-spec',
          configId: 'kimi',
          docsCondition: 'with',
          trial: 1,
          status: 'failed',
          attempts: 3,
          rateLimitedAttempts: 0,
          lastError: 'workspace prep exploded',
          history: [],
        },
      ],
    );
    await writeFile(
      path.join(runDir, 'results.jsonl'),
      `${JSON.stringify(row({ taskId: 'build-nac-001-workspace-from-spec', configId: 'opus' }))}\n{"torn":`,
      'utf8',
    );
    const report = await buildDoctorReport(runDir);
    expect(report.problems.join(' ')).toContain('invalid JSON');
    expect(report.totals.abandoned).toBe(1);
    const finding = report.findings.find((f) => f.kind === 'abandoned-cells')!;
    expect(finding.detail.join(' ')).toContain('workspace prep exploded');
  });
});
