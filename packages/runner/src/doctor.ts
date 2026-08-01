/**
 * `notionbench doctor <runDir>` — the post-hoc audit of a finished (or halted) run.
 *
 * The watchdog (watchdog.ts) is the *live* half of the same question: it runs
 * inside the run and stops it early. This is the half you run before you write
 * anything up. It is strictly read-only, opens no checkpoint, spawns nothing,
 * and re-uses the watchdog's thresholds and diagnostic normalization so a
 * finished grid is judged by exactly the rules the live run was judged by.
 *
 * It answers, per task:
 *
 *   - who attempted it, who solved it, who failed it;
 *   - do the failures share a diagnostic once ids/paths/numbers are stripped
 *     (the signature of a verifier bug — "unexpected field `views`" across three
 *     configs — as opposed to seven different complaints, which is what a hard
 *     task looks like);
 *   - did the verifier itself ever fail to return a verdict;
 *   - did the runner abandon cells;
 *
 * and then, in plain English: **which tasks look invalid and should be
 * investigated before publishing.**
 *
 * Input is `results.jsonl` first (the record of truth), plus `state.json` for
 * cells that never produced a row at all, `rate-window.json` for blocked
 * configs, and `ALERT.json` for what the live watchdog already said.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { dedupeByCell, readResults, type TrialRecord } from '@notionbench/scoring';
import type { CellState, RunStateFile } from './checkpoint.js';
import { readRateWindowState } from './queue.js';
import {
  DEFAULT_WATCHDOG_SETTINGS,
  normalizeDiagnostic,
  readAlertFile,
  sharedEvidence,
  type AlertFile,
  type WatchdogSettings,
} from './watchdog.js';

export interface DoctorConfigRow {
  configId: string;
  attempted: number;
  solved: number;
  failed: number;
  unverified: number;
  /** Cells the runner gave up on entirely (state.json `failed`). */
  abandoned: number;
  status: 'ok' | 'blocked' | 'cooling';
}

export interface DoctorTask {
  taskId: string;
  attempted: number;
  solved: number;
  failed: number;
  /** Verifier produced no verdict — never an agent failure. */
  verifierCrashes: number;
  abandoned: number;
  /** Per trial: which configs failed, and what they said. */
  trials: Array<{
    trial: number;
    attemptedConfigs: string[];
    failedConfigs: string[];
    solvedConfigs: string[];
    /** The strongest thing the failing configs' diagnostics have in common. */
    shared?: { kind: 'exact' | 'substring'; text: string; configIds: string[] };
  }>;
  /** Distinct normalized diagnostics seen on failures, most common first. */
  diagnosticClusters: Array<{ text: string; configIds: string[]; count: number }>;
  findings: DoctorFinding[];
}

export interface DoctorFinding {
  level: 'invalid' | 'suspect' | 'note';
  kind:
    | 'cross-config-identical-failure'
    | 'verifier-crash'
    | 'total-task-failure'
    | 'abandoned-cells'
    | 'no-results';
  taskId: string;
  trial?: number;
  configIds: string[];
  evidence: string;
  detail: string[];
}

export interface DoctorReport {
  runDir: string;
  runId: string;
  generatedAt: string;
  totals: {
    rows: number;
    cells: number;
    tasks: number;
    configs: number;
    scored: number;
    solved: number;
    failed: number;
    unverified: number;
    abandoned: number;
  };
  configs: DoctorConfigRow[];
  tasks: DoctorTask[];
  /** Tasks with an `invalid`-level finding, worst first. */
  invalidTasks: string[];
  /** Tasks with a `suspect`-level finding and no `invalid` one. */
  suspectTasks: string[];
  findings: DoctorFinding[];
  /** What the live watchdog recorded, if it recorded anything. */
  alerts?: AlertFile;
  verdict: {
    level: 'clean' | 'suspect' | 'invalid';
    headline: string;
    lines: string[];
  };
  /** Problems reading the run's own files — never fatal, always reported. */
  problems: string[];
}

export interface DoctorOptions {
  settings?: WatchdogSettings;
  now?: Date;
}

/**
 * True for a `scored: false` row that the *verifier* failed on, as opposed to
 * one the runner deliberately never verified.
 *
 * The persisted row cannot tell the two apart — both are `scored: false` — so
 * this matches the exact reasons `cmdRun` writes for the deliberate cases. Get
 * this wrong in the permissive direction and every rate-limited cell in a
 * multi-day grid reads as a broken verifier.
 */
export function isVerifierCrash(record: TrialRecord): boolean {
  if (record.scored !== false) return false;
  const reason = record.scoreError ?? '';
  if (/^not scored: status /.test(reason)) return false;
  if (/^scoring disabled/.test(reason)) return false;
  return true;
}

export async function buildDoctorReport(
  runDir: string,
  opts: DoctorOptions = {},
): Promise<DoctorReport> {
  const settings = opts.settings ?? DEFAULT_WATCHDOG_SETTINGS;
  const generatedAt = (opts.now ?? new Date()).toISOString();
  const problems: string[] = [];

  let records: TrialRecord[] = [];
  try {
    const read = await readResults(runDir);
    records = dedupeByCell(read.records);
    for (const p of read.problems) problems.push(`results.jsonl:${p.line}: ${p.reason}`);
  } catch (err) {
    problems.push((err as Error).message);
  }

  const state = await readStateFile(runDir, problems);
  const cells = Object.values(state?.cells ?? {});
  const rateWindow = await readRateWindowState(runDir);
  const alerts = await readAlertFile(runDir);
  const runId = state?.runId ?? records[0]?.runId ?? path.basename(runDir);

  // --- per config -----------------------------------------------------------
  const configIds = [
    ...new Set([
      ...(state?.meta?.configs ?? []).map((c) => c.id),
      ...records.map((r) => r.configId),
      ...cells.map((c) => c.configId),
    ]),
  ];
  const blocked = new Set(rateWindow.blocked);
  const cooling = new Set(rateWindow.cooldowns.map((c) => c.configId));
  const abandonedBy = tally(cells.filter((c) => c.status === 'failed'), (c) => c.configId);
  const configs: DoctorConfigRow[] = configIds.map((configId) => {
    const mine = records.filter((r) => r.configId === configId);
    return {
      configId,
      attempted: mine.length,
      solved: mine.filter((r) => r.scored === true && r.score >= 1).length,
      failed: mine.filter((r) => r.scored === true && r.score < 1).length,
      unverified: mine.filter((r) => r.scored === false).length,
      abandoned: abandonedBy.get(configId) ?? 0,
      status: blocked.has(configId) ? 'blocked' : cooling.has(configId) ? 'cooling' : 'ok',
    };
  });

  // --- per task -------------------------------------------------------------
  const taskIds = [
    ...new Set([
      ...(state?.meta?.taskIds ?? []),
      ...records.map((r) => r.taskId),
      ...cells.map((c) => c.taskId),
    ]),
  ].sort();

  const tasks: DoctorTask[] = [];
  const findings: DoctorFinding[] = [];
  for (const taskId of taskIds) {
    const task = analyzeTask({
      taskId,
      records: records.filter((r) => r.taskId === taskId),
      cells: cells.filter((c) => c.taskId === taskId),
      settings,
    });
    tasks.push(task);
    findings.push(...task.findings);
  }

  const invalidTasks = [
    ...new Set(findings.filter((f) => f.level === 'invalid').map((f) => f.taskId)),
  ].sort();
  const suspectTasks = [
    ...new Set(
      findings.filter((f) => f.level === 'suspect' && !invalidTasks.includes(f.taskId)).map((f) => f.taskId),
    ),
  ].sort();

  const totals = {
    rows: records.length,
    cells: cells.length,
    tasks: taskIds.length,
    configs: configIds.length,
    scored: records.filter((r) => r.scored === true).length,
    solved: records.filter((r) => r.scored === true && r.score >= 1).length,
    failed: records.filter((r) => r.scored === true && r.score < 1).length,
    unverified: records.filter((r) => r.scored === false).length,
    abandoned: cells.filter((c) => c.status === 'failed').length,
  };

  return {
    runDir,
    runId,
    generatedAt,
    totals,
    configs,
    tasks,
    invalidTasks,
    suspectTasks,
    findings,
    alerts,
    verdict: verdictFor({ runId, invalidTasks, suspectTasks, findings, totals, alerts }),
    problems,
  };
}

function analyzeTask(args: {
  taskId: string;
  records: TrialRecord[];
  cells: CellState[];
  settings: WatchdogSettings;
}): DoctorTask {
  const { taskId, records, cells, settings } = args;
  const findings: DoctorFinding[] = [];

  const crashes = records.filter(isVerifierCrash);
  const graded = records.filter((r) => r.scored === true);
  const solved = graded.filter((r) => r.score >= 1);
  const failed = graded.filter((r) => r.score < 1);
  const abandoned = cells.filter((c) => c.status === 'failed');

  // Per trial: the unit the cross-config comparison is meaningful over.
  const trialNumbers = [...new Set(graded.map((r) => r.trial))].sort((a, b) => a - b);
  const trials: DoctorTask['trials'] = [];
  for (const trial of trialNumbers) {
    const inTrial = graded.filter((r) => r.trial === trial);
    const failedHere = inTrial.filter((r) => r.score < 1);
    const solvedHere = inTrial.filter((r) => r.score >= 1);
    const attemptedConfigs = [...new Set(inTrial.map((r) => r.configId))].sort();
    const failedConfigs = [...new Set(failedHere.map((r) => r.configId))].sort();
    const shared =
      failedConfigs.length >= 2
        ? sharedEvidence(
            failedConfigs.map((configId) => ({
              configId,
              diagnostics: failedHere
                .filter((r) => r.configId === configId)
                .flatMap((r) => r.diagnostics ?? []),
            })),
            settings.crossConfig.minSharedChars,
          )
        : undefined;
    trials.push({
      trial,
      attemptedConfigs,
      failedConfigs,
      solvedConfigs: [...new Set(solvedHere.map((r) => r.configId))].sort(),
      shared,
    });

    if (shared) {
      const matched = shared.configIds.length;
      const attempted = attemptedConfigs.length;
      const byCount = matched >= Math.max(2, settings.crossConfig.minConfigs);
      const byFraction =
        matched >= 2 && attempted > 0 && matched / attempted >= settings.crossConfig.minFraction;
      if (byCount || byFraction) {
        findings.push({
          level: 'invalid',
          kind: 'cross-config-identical-failure',
          taskId,
          trial,
          configIds: [...shared.configIds].sort(),
          evidence:
            `${matched} of ${attempted} config(s) failed trial ${trial} with the ` +
            `${shared.kind === 'exact' ? 'same' : 'same underlying'} diagnostic: "${truncate(shared.text, 160)}"`,
          detail: failedConfigs.map(
            (configId) =>
              `${configId}: ${truncate(
                failedHere
                  .filter((r) => r.configId === configId)
                  .flatMap((r) => r.diagnostics ?? [])
                  .join(' · ') || '(no diagnostics)',
                200,
              )}`,
          ),
        });
      }
    }

    if (
      settings.totalTaskFailure.enabled &&
      solvedHere.length === 0 &&
      failedConfigs.length >= Math.max(2, settings.totalTaskFailure.minConfigs) &&
      !shared
    ) {
      findings.push({
        level: 'suspect',
        kind: 'total-task-failure',
        taskId,
        trial,
        configIds: failedConfigs,
        evidence: `every one of the ${attemptedConfigs.length} config(s) that attempted trial ${trial} scored 0, with no shared diagnostic`,
        detail: [
          'may be a broken task, may be a genuinely very hard one — read the diagnostics before publishing',
        ],
      });
    }
  }

  if (crashes.length > 0) {
    findings.push({
      level: 'invalid',
      kind: 'verifier-crash',
      taskId,
      configIds: [...new Set(crashes.map((r) => r.configId))].sort(),
      evidence: `the verifier returned no usable verdict on ${crashes.length} cell(s) — never an agent failure`,
      detail: [
        ...new Set(crashes.map((r) => truncate(r.scoreError ?? 'no error text recorded', 200))),
      ],
    });
  }

  if (abandoned.length > 0) {
    findings.push({
      level: 'note',
      kind: 'abandoned-cells',
      taskId,
      configIds: [...new Set(abandoned.map((c) => c.configId))].sort(),
      evidence: `${abandoned.length} cell(s) were abandoned by the runner after exhausting their attempts`,
      detail: [...new Set(abandoned.map((c) => truncate(c.lastError ?? 'no error recorded', 200)))],
    });
  }

  if (records.length === 0 && cells.length > 0) {
    findings.push({
      level: 'note',
      kind: 'no-results',
      taskId,
      configIds: [],
      evidence: `${cells.length} cell(s) enumerated but no scored row was ever written`,
      detail: ['the run has not reached this task, or every cell failed before scoring'],
    });
  }

  return {
    taskId,
    attempted: records.length,
    solved: solved.length,
    failed: failed.length,
    verifierCrashes: crashes.length,
    abandoned: abandoned.length,
    trials,
    diagnosticClusters: clusterDiagnostics(failed),
    findings,
  };
}

/** Distinct normalized failure diagnostics for a task, most widely-shared first. */
function clusterDiagnostics(failed: TrialRecord[]): DoctorTask['diagnosticClusters'] {
  const byText = new Map<string, { configIds: Set<string>; count: number }>();
  for (const r of failed) {
    for (const raw of r.diagnostics ?? []) {
      const text = normalizeDiagnostic(raw);
      if (text.length < 4) continue;
      const bucket = byText.get(text) ?? { configIds: new Set<string>(), count: 0 };
      bucket.configIds.add(r.configId);
      bucket.count++;
      byText.set(text, bucket);
    }
  }
  return [...byText]
    .map(([text, b]) => ({ text, configIds: [...b.configIds].sort(), count: b.count }))
    .sort((a, b) => b.configIds.length - a.configIds.length || b.count - a.count)
    .slice(0, 10);
}

function verdictFor(args: {
  runId: string;
  invalidTasks: string[];
  suspectTasks: string[];
  findings: DoctorFinding[];
  totals: DoctorReport['totals'];
  alerts?: AlertFile;
}): DoctorReport['verdict'] {
  const { invalidTasks, suspectTasks, findings, totals } = args;
  const lines: string[] = [];

  if (invalidTasks.length > 0) {
    lines.push(
      `These tasks look INVALID — investigate before publishing: ${invalidTasks.join(', ')}.`,
    );
    for (const f of findings.filter((x) => x.level === 'invalid')) {
      lines.push(`  ${f.taskId}: ${f.evidence}`);
    }
    lines.push(
      'Several independent frontier models failing the same task with the same complaint is a ' +
        'property of the verifier or the fixture, not of the models.',
    );
    lines.push(
      `Fix the task, then re-run only its cells: notionbench run --resume ${args.runId} --redo ${invalidTasks[0]}`,
    );
  }
  if (suspectTasks.length > 0) {
    lines.push(
      `These tasks are SUSPECT — every config scored 0, but for different stated reasons: ${suspectTasks.join(', ')}.`,
    );
    lines.push(
      'That is what a very hard task and a broken task both look like. Read one failing trial\'s ' +
        'transcript before deciding.',
    );
  }
  if (invalidTasks.length === 0 && suspectTasks.length === 0) {
    lines.push(
      'No task shows a cross-config failure signature: where configs failed, they failed for ' +
        'different stated reasons, which is what genuine agent misses look like.',
    );
    if (totals.unverified > 0) {
      lines.push(
        `${totals.unverified} row(s) are unverified — check they are rate-window/spawn artefacts, not verifier crashes.`,
      );
    }
    lines.push('Safe to publish as far as task validity goes.');
  }

  const level = invalidTasks.length > 0 ? 'invalid' : suspectTasks.length > 0 ? 'suspect' : 'clean';
  const headline =
    level === 'invalid'
      ? `${invalidTasks.length} task(s) look INVALID`
      : level === 'suspect'
        ? `${suspectTasks.length} task(s) are SUSPECT`
        : 'no invalid tasks detected';
  return { level, headline, lines };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderDoctorReport(r: DoctorReport): string {
  const out: string[] = [];
  const line = (s = ''): void => void out.push(s);

  line(`notionbench doctor — ${r.runDir}`);
  line(`  run ${r.runId}  ·  read-only  ·  ${r.generatedAt}`);
  line(
    `  ${r.totals.rows} scored row(s) over ${r.totals.tasks} task(s) × ${r.totals.configs} config(s); ` +
      `${r.totals.solved} solved, ${r.totals.failed} failed, ${r.totals.unverified} unverified, ` +
      `${r.totals.abandoned} abandoned`,
  );
  line();

  if (r.alerts && r.alerts.alerts.length > 0) {
    line(`live watchdog (ALERT.json) — ${r.alerts.halted ? 'THIS RUN WAS HALTED' : 'alerts raised, run continued'}`);
    for (const a of r.alerts.alerts) {
      line(`  [${a.level.toUpperCase()}] ${a.kind}${a.taskId ? ` ${a.taskId}` : ''}: ${a.evidence}`);
    }
    line();
  }

  line('configs');
  for (const c of r.configs) {
    line(
      `  ${pad(c.configId, 28)} attempted ${pad(String(c.attempted), 4)} solved ${pad(String(c.solved), 4)} ` +
        `failed ${pad(String(c.failed), 4)} unverified ${pad(String(c.unverified), 4)} ` +
        `abandoned ${pad(String(c.abandoned), 4)} ${c.status === 'ok' ? '' : c.status.toUpperCase()}`.trimEnd(),
    );
  }
  line();

  line('tasks');
  for (const t of r.tasks) {
    const worst = t.findings.find((f) => f.level === 'invalid')
      ? 'INVALID?'
      : t.findings.find((f) => f.level === 'suspect')
        ? 'SUSPECT'
        : '';
    line(
      `  ${pad(t.taskId, 44)} ${pad(`${t.solved}/${t.attempted} solved`, 16)}` +
        `${t.verifierCrashes > 0 ? ` ${t.verifierCrashes} VERIFIER CRASH` : ''}` +
        `${t.abandoned > 0 ? ` ${t.abandoned} abandoned` : ''}` +
        (worst ? `  ${worst}` : ''),
    );
    for (const f of t.findings) {
      if (f.level === 'note' && f.kind === 'no-results') continue;
      line(`      ${f.level === 'invalid' ? '!!' : f.level === 'suspect' ? '?' : '-'} ${f.evidence}`);
      for (const d of f.detail.slice(0, 8)) line(`         ${d}`);
    }
    if (t.failed > 0 && t.diagnosticClusters.length > 0 && t.findings.length === 0) {
      for (const cluster of t.diagnosticClusters.slice(0, 3)) {
        line(`      - ${cluster.configIds.length} config(s): "${truncate(cluster.text, 120)}"`);
      }
    }
  }
  line();

  if (r.problems.length > 0) {
    line('problems reading this run');
    for (const p of r.problems) line(`  ! ${p}`);
    line();
  }

  line(`verdict: ${r.verdict.headline}`);
  for (const l of r.verdict.lines) line(`  ${l}`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------

async function readStateFile(runDir: string, problems: string[]): Promise<RunStateFile | undefined> {
  try {
    return JSON.parse(await readFile(path.join(runDir, 'state.json'), 'utf8')) as RunStateFile;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') problems.push(`state.json: ${(err as Error).message}`);
    return undefined;
  }
}

function tally<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) out.set(key(item), (out.get(key(item)) ?? 0) + 1);
  return out;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
