/**
 * `--ack` — acknowledging a known-legitimate failure without blinding the
 * watchdog everywhere else.
 *
 * The case throughout is the real one from the 798-cell grid:
 * `resolve-instructions-001-workflow-canary` asks the agent to answer with zeros
 * for a category nobody has expensed; three configs pinned their tool's input
 * schema to an enum, so the SDK rejected the call and all three failed with the
 * same `InvalidToolInputError`. That is the watchdog's halt signature and a
 * genuine agent failure — the task is fine and the result belongs in the paper.
 *
 * Four properties are asserted, and the third is the one that matters most:
 *
 *   1. an ack turns that halt into a recorded `acknowledged` alert and the grid
 *      keeps running;
 *   2. a DIFFERENT failure mode on the SAME task still halts, and another task
 *      is untouched;
 *   3. verifier crashes and fixture-provisioning failures can never be
 *      acknowledged — not by a pattern, not by a bare task ack, not by any
 *      spelling of the flag;
 *   4. nothing hides: the acknowledgment and its mandatory reason are in
 *      run-spec.json, in ALERT.json, in `--dry-run`, and in `doctor`, which
 *      stops calling the run clean.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readResults } from '@notionbench/scoring';
import {
  AckError,
  ackFlag,
  ackKey,
  buildAcknowledgments,
  matchAck,
  mergeAcknowledgments,
  newAcknowledgments,
  parseAckFlags,
  requireAckReason,
} from '../src/ack.js';
import { main } from '../src/cli.js';
import { buildDoctorReport, renderDoctorReport } from '../src/doctor.js';
import { createRunSpec, readRunSpec, recordAcks, writeRunSpec } from '../src/run-spec.js';
import type { AlertFile } from '../src/watchdog.js';
import type { RunSpecFile } from '../src/run-spec.js';

const CANARY = 'resolve-instructions-001-workflow-canary';
const REASON =
  'reviewed 2026-08-01: the prompt states an unexpensed category answers with zeros rather ' +
  'than an error; these configs pinned the tool input schema to an enum, so the SDK rejects ' +
  'the call. Two configs handled it. Genuine agent failure.';

// ---------------------------------------------------------------------------
// The grammar, and what it refuses
// ---------------------------------------------------------------------------

describe('--ack parsing', () => {
  it('takes a bare task id, and repeatable/comma-separated values', () => {
    expect(parseAckFlags([CANARY])).toEqual([{ taskId: CANARY, pattern: undefined, raw: CANARY }]);
    expect(parseAckFlags(['a,b', ' c ']).map((s) => s.taskId)).toEqual(['a', 'b', 'c']);
    expect(parseAckFlags(undefined)).toEqual([]);
    // The same signature twice is one acknowledgment, not two.
    expect(parseAckFlags([`${CANARY},${CANARY}`])).toHaveLength(1);
  });

  it('splits the pattern on the FIRST colon and normalizes it for matching', () => {
    const [spec] = parseAckFlags([`${CANARY}:InvalidToolInputError:  input   schema`]);
    expect(spec).toMatchObject({
      taskId: CANARY,
      pattern: 'invalidtoolinputerror: input schema',
    });
    expect(ackFlag(spec!)).toBe(`${CANARY}:invalidtoolinputerror: input schema`);
    expect(ackKey(spec!)).toContain('::invalidtoolinputerror');
    expect(ackKey({ taskId: CANARY })).toBe(`${CANARY}::*`);
  });

  it('rejects an empty task id or a trailing colon with no pattern', () => {
    expect(() => parseAckFlags([':nope'])).toThrow(AckError);
    expect(() => parseAckFlags([`${CANARY}:`])).toThrow(/ends in a colon/);
  });

  // The safety property, at the syntax level.
  it('REFUSES to acknowledge a verifier crash, naming why', () => {
    for (const flag of [
      `${CANARY}:verifier-crash`,
      `${CANARY}:verifier crash`,
      'verifier-crash',
      `${CANARY}:VERIFIER_CRASH`,
    ]) {
      let err: unknown;
      try {
        parseAckFlags([flag]);
      } catch (e) {
        err = e;
      }
      expect(err, flag).toBeInstanceOf(AckError);
      expect((err as Error).message).toMatch(/can never be acknowledged/);
      expect((err as Error).message).toMatch(/measurement\s+apparatus failing, never agent behaviour/);
      expect((err as Error).message).toContain('cross-config-identical-failure');
    }
  });

  it('REFUSES to acknowledge a fixture-provisioning failure, naming why', () => {
    for (const flag of [
      `${CANARY}:fixture-provisioning-failure`,
      `${CANARY}:fixture failure`,
      `${CANARY}:fixture-provisioning`,
    ]) {
      let err: unknown;
      try {
        parseAckFlags([flag]);
      } catch (e) {
        err = e;
      }
      expect(err, flag).toBeInstanceOf(AckError);
      expect((err as Error).message).toMatch(/can never be acknowledged/);
      expect((err as Error).message).toMatch(/fixture\/spec\.json could not be built/);
    }
  });

  it('requires --ack-reason whenever --ack is passed', () => {
    const specs = parseAckFlags([CANARY]);
    expect(() => requireAckReason(specs, undefined)).toThrow(/requires --ack-reason/);
    expect(() => requireAckReason(specs, '   ')).toThrow(/requires --ack-reason/);
    expect(requireAckReason(specs, `  ${REASON} `)).toBe(REASON);
    // …and refuses a reason with nothing to be a reason for.
    expect(() => requireAckReason([], 'why not')).toThrow(/only applies with --ack/);
    expect(requireAckReason([], undefined)).toBe('');
  });

  it('merges by signature, keeping the first record so resumes do not rewrite history', () => {
    const first = buildAcknowledgments(parseAckFlags([`${CANARY}:enum`]), {
      reason: 'first',
      now: new Date('2026-08-01T00:00:00.000Z'),
    });
    const again = buildAcknowledgments(parseAckFlags([`${CANARY}:enum`, 'other-task']), {
      reason: 'second',
      now: new Date('2026-08-02T00:00:00.000Z'),
    });
    const merged = mergeAcknowledgments(first, again);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.reason).toBe('first');
    expect(newAcknowledgments(first, again).map((a) => a.taskId)).toEqual(['other-task']);
  });
});

describe('matchAck', () => {
  const ack = buildAcknowledgments(parseAckFlags([`${CANARY}:invalidtoolinputerror`]), {
    reason: REASON,
  });
  const bare = buildAcknowledgments(parseAckFlags([CANARY]), { reason: REASON });
  const shared = 'tool_unknown_category: invalidtoolinputerror: input does not match the schema';

  it('matches the acknowledgeable kinds on the named task', () => {
    for (const kind of ['cross-config-identical-failure', 'total-task-failure']) {
      expect(matchAck(ack, { kind, taskId: CANARY, normalizedTexts: [shared] })).toBeDefined();
      expect(matchAck(bare, { kind, taskId: CANARY, normalizedTexts: [] })).toBeDefined();
    }
  });

  it('never matches an apparatus fault, even under a bare task ack', () => {
    for (const kind of ['verifier-crash', 'fixture-provisioning-failure']) {
      expect(matchAck(bare, { kind, taskId: CANARY, normalizedTexts: [shared] })).toBeUndefined();
      expect(matchAck(ack, { kind, taskId: CANARY, normalizedTexts: [shared] })).toBeUndefined();
    }
  });

  it('is narrow: wrong task, or a diagnostic without the pattern, does not match', () => {
    const kind = 'cross-config-identical-failure';
    expect(matchAck(ack, { kind, taskId: 'another-task', normalizedTexts: [shared] })).toBeUndefined();
    expect(
      matchAck(ack, { kind, taskId: CANARY, normalizedTexts: ['the month total is wrong'] }),
    ).toBeUndefined();
    // A patterned ack needs something to match against.
    expect(matchAck(ack, { kind, taskId: CANARY, normalizedTexts: [] })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// run-spec.json: acknowledgments are run metadata and survive a round trip
// ---------------------------------------------------------------------------

describe('run-spec.json', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), 'nb-ack-spec-'));
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  function spec(acknowledgments = buildAcknowledgments(parseAckFlags([`${CANARY}:enum`]), {
    reason: REASON,
    argv: ['run', '--ack', `${CANARY}:enum`],
  })): RunSpecFile {
    return createRunSpec({
      runId: '20260801-090000',
      grid: { taskIds: [CANARY], configIds: ['opus'], docsConditions: ['with'], trials: 1 },
      configs: [{ id: 'opus', label: 'opus', harness: 'claude-code', model: 'opus-5', enabled: true }],
      execution: {
        concurrency: 1,
        maxAttempts: 3,
        cooldownMs: 0,
        defaultTimeoutSec: 30,
        killGraceMs: 0,
        evalsRoot: 'evals',
        resultsRoot: path.join(scratch, 'results'),
        scoring: { enabled: true, timeoutMs: 1000 },
      },
      argv: ['run', '--ack', `${CANARY}:enum`],
      acknowledgments,
    });
  }

  it('records them at creation with who/when/why, and round-trips through disk', async () => {
    const resultsRoot = path.join(scratch, 'results');
    await mkdir(path.join(resultsRoot, '20260801-090000'), { recursive: true });
    const created = spec();
    expect(created.acknowledgments).toHaveLength(1);
    expect(created.acknowledgments![0]).toMatchObject({ taskId: CANARY, pattern: 'enum', reason: REASON });
    expect(created.acknowledgments![0]!.at).toMatch(/^\d{4}-/);
    expect(created.acknowledgments![0]!.argv).toContain('--ack');
    const entry = created.history.find((h) => h.event === 'acknowledged');
    expect(entry!.detail).toContain(REASON);
    expect(entry!.acknowledgments).toHaveLength(1);

    await writeRunSpec(resultsRoot, created);
    const read = await readRunSpec(resultsRoot, '20260801-090000');
    expect(read!.acknowledgments).toEqual(created.acknowledgments);
  });

  it('appends a new signature to the history and is idempotent for a known one', () => {
    const base = spec();
    const same = recordAcks(base, {
      acknowledgments: buildAcknowledgments(parseAckFlags([`${CANARY}:enum`]), { reason: 'again' }),
      argv: ['run', '--resume', 'x'],
    });
    // Re-passing the same flag on every overnight resume must not grow the file.
    expect(same).toBe(base);

    const grown = recordAcks(base, {
      acknowledgments: buildAcknowledgments(parseAckFlags(['other-task:boom']), { reason: 'why' }),
      argv: ['run', '--resume', 'x', '--ack', 'other-task:boom'],
    });
    expect(grown.acknowledgments).toHaveLength(2);
    expect(grown.history.filter((h) => h.event === 'acknowledged')).toHaveLength(2);
    expect(grown.history.at(-1)!.argv).toContain('other-task:boom');
  });

  it('a spec with no acknowledgments stays exactly as it was', () => {
    const bare = spec([]);
    expect(bare.acknowledgments).toBeUndefined();
    expect(bare.history.some((h) => h.event === 'acknowledged')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End to end, through the real CLI
// ---------------------------------------------------------------------------

describe('notionbench run --ack (end to end)', () => {
  let scratch: string;
  let evalsRoot: string;
  let resultsRoot: string;
  let runconfigPath: string;
  let out: string[];

  const CONFIG_IDS = ['cfg-a', 'cfg-b', 'cfg-c'];

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), 'nb-ack-'));
    evalsRoot = path.join(scratch, 'evals');
    resultsRoot = path.join(scratch, 'results');
    runconfigPath = path.join(scratch, 'runconfig.json');
    out = [];
    await mkdir(evalsRoot, { recursive: true });
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function run(args: string[]): Promise<number> {
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
    process.stderr.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stderr.write;
    try {
      return await main(args);
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }
  }

  function printed(): string {
    return out.join('');
  }

  function runIdFrom(text: string): string {
    const id = /run (\d{8}-\d{6})/.exec(text)?.[1];
    if (!id) throw new Error(`no run id in output:\n${text}`);
    return id;
  }

  /** The real failure: every config rejects the unexpensed category at the tool boundary. */
  const ENUM_FAILURE = `  return { score: 0, subscores: {}, diagnostics: [
    "tool_unknown_category: InvalidToolInputError: tool \\"expense_summary\\" rejected input " +
    "(category not one of the enum values) after " + ctx.configId.length + "ms"
  ] }`;
  /** A DIFFERENT identical-across-configs failure on the same task. */
  const MONTH_FAILURE = `  return { score: 0, subscores: {}, diagnostics: [
    "summary.json totals the wrong month: expected 2026-07, got 2026-0" + ctx.configId.length
  ] }`;
  /** The verifier itself blows up — never an agent failure, never acknowledgeable. */
  const CRASHES = `  throw new Error("ENOSPC: no space left on device, write")`;
  const FINE = `  const { readFile } = await import("node:fs/promises")
  const path = await import("node:path")
  try {
    const text = await readFile(path.join(workspaceDir, "solved.txt"), "utf8")
    return { score: text.trim() === "DONE" ? 1 : 0, subscores: {}, diagnostics: ["read solved.txt"] }
  } catch { return { score: 0, subscores: {}, diagnostics: ["no solved.txt"] } }`;

  const AGENT = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake 1.0"; exit 0; fi
printf 'DONE\\n' > "$1/solved.txt"
echo '{"usage":{"input_tokens":10,"output_tokens":5}}'
`;

  async function writeTask(id: string, verdict: string): Promise<void> {
    const dir = path.join(evalsRoot, id);
    await mkdir(path.join(dir, 'fixture', 'workspace'), { recursive: true });
    await writeFile(
      path.join(dir, 'PROMPT.md'),
      `---\nid: ${id}\nsuite: benchmark\nfamily: nac\nstage: build\nruntime: offline\n` +
        `limits: { time: 30 }\n---\n\nWrite DONE into solved.txt.\n`,
      'utf8',
    );
    await writeFile(path.join(dir, 'fixture', 'workspace', 'README.md'), '# fixture\n', 'utf8');
    await writeFile(
      path.join(dir, 'EVAL.ts'),
      `export default async ({ workspaceDir, ctx }) => {\n${verdict}\n}\n`,
      'utf8',
    );
  }

  async function writeRunconfig(): Promise<void> {
    const agent = path.join(scratch, 'agent.sh');
    await writeFile(agent, AGENT, 'utf8');
    await chmod(agent, 0o755);
    await writeFile(
      runconfigPath,
      JSON.stringify({
        configs: CONFIG_IDS.map((id) => ({
          id,
          label: id,
          harness: 'command-template',
          command: agent,
          argsTemplate: ['{workspace}', '{prompt}'],
          model: 'fake-1',
          enabled: true,
        })),
        resultsRoot,
        evalsRoot,
        concurrency: 3,
        trials: 1,
        timeoutSec: 30,
      }),
      'utf8',
    );
  }

  async function readAlert(runId: string): Promise<AlertFile> {
    return JSON.parse(
      await readFile(path.join(resultsRoot, runId, 'ALERT.json'), 'utf8'),
    ) as AlertFile;
  }
  async function readSpec(runId: string): Promise<RunSpecFile> {
    return JSON.parse(
      await readFile(path.join(resultsRoot, runId, 'run-spec.json'), 'utf8'),
    ) as RunSpecFile;
  }

  const BASE = () => ['run', '--runconfig', runconfigPath, '--docs', 'with', '--trials', '1'];
  const ACK = [`--ack`, `${CANARY}:invalidtoolinputerror`, '--ack-reason', REASON];

  it('the same grid halts without --ack and completes with it', async () => {
    await writeTask(CANARY, ENUM_FAILURE);
    await writeTask('zz-build-nac-002-fine', FINE);
    await writeRunconfig();

    // Without the ack: the halt signature stops the grid.
    expect(await run(BASE())).toBe(3);
    const halted = runIdFrom(printed());
    expect((await readAlert(halted)).halting!.kind).toBe('cross-config-identical-failure');

    // With it: the alert is still raised and recorded, the run finishes.
    out = [];
    expect(await run([...BASE(), ...ACK])).toBe(0);
    const runId = runIdFrom(printed());
    const alert = await readAlert(runId);
    expect(alert.halted).toBe(false);
    const ack = alert.alerts.find((a) => a.kind === 'cross-config-identical-failure')!;
    expect(ack.level).toBe('acknowledged');
    expect(ack.evidence).toContain('invalidtoolinputerror');
    expect(ack.acknowledgment!.reason).toBe(REASON);
    expect(alert.acknowledgments).toHaveLength(1);
    // The failure is still a failure: every cell is scored 0 and recorded.
    const { records } = await readResults(path.join(resultsRoot, runId));
    expect(records.filter((r) => r.taskId === CANARY)).toHaveLength(3);
    expect(records.filter((r) => r.taskId === CANARY).every((r) => r.score === 0)).toBe(true);
    // …and the whole grid ran, unlike --no-watchdog it protected everything else.
    expect(records).toHaveLength(6);
    expect(printed()).toContain('acknowledged');
    expect(printed()).toContain(REASON);
  });

  it('a DIFFERENT diagnostic on the SAME task still halts under that ack', async () => {
    await writeTask(CANARY, MONTH_FAILURE);
    await writeTask('zz-build-nac-002-fine', FINE);
    await writeRunconfig();

    expect(await run([...BASE(), ...ACK])).toBe(3);
    const alert = await readAlert(runIdFrom(printed()));
    expect(alert.halted).toBe(true);
    expect(alert.halting!.taskId).toBe(CANARY);
    expect(alert.halting!.evidence).toContain('wrong month');
    expect(alert.halting!.level).toBe('halt');
    // The acknowledgment is still on record — it simply did not apply.
    expect(alert.acknowledgments).toHaveLength(1);
  });

  it('a verifier crash on the acknowledged task halts even under a bare --ack', async () => {
    await writeTask(CANARY, CRASHES);
    await writeTask('zz-build-nac-002-fine', FINE);
    await writeRunconfig();

    const code = await run([
      ...BASE(),
      '--ack',
      CANARY,
      '--ack-reason',
      'trying (and failing) to wave through a broken measurement',
    ]);
    expect(code).toBe(3);
    const alert = await readAlert(runIdFrom(printed()));
    expect(alert.halting!.kind).toBe('verifier-crash');
    expect(alert.halting!.level).toBe('halt');
    expect(alert.halting!.acknowledgment).toBeUndefined();
  });

  it('refuses --ack without --ack-reason, and refuses to name an apparatus fault', async () => {
    await writeTask(CANARY, ENUM_FAILURE);
    await writeRunconfig();

    expect(await run([...BASE(), '--ack', CANARY])).toBe(2);
    expect(printed()).toContain('requires --ack-reason');
    out = [];

    expect(
      await run([...BASE(), '--ack', `${CANARY}:verifier-crash`, '--ack-reason', 'no']),
    ).toBe(2);
    expect(printed()).toContain('can never be acknowledged');
    expect(printed()).toContain('never agent behaviour');
    out = [];

    expect(
      await run([...BASE(), '--ack', `${CANARY}:fixture-provisioning-failure`, '--ack-reason', 'no']),
    ).toBe(2);
    expect(printed()).toContain('can never be acknowledged');
    out = [];

    // A typo'd task id is refused rather than silently acknowledging nothing.
    expect(await run([...BASE(), '--ack', 'resolve-typo-001', '--ack-reason', 'x'])).toBe(2);
    expect(printed()).toContain('is not a task in this grid');
    // None of the refusals started a run.
    await expect(readFile(path.join(resultsRoot, 'latest', 'state.json'), 'utf8')).rejects.toThrow();
  });

  it('persists through --resume and is replayed without re-passing the flag', async () => {
    await writeTask('aa-build-nac-001-fine', FINE);
    await writeTask(CANARY, ENUM_FAILURE);
    await writeTask('zz-build-nac-003-fine', FINE);
    await writeRunconfig();

    // Pass 1, no ack: halts on the canary, leaving the last task pending.
    expect(await run(BASE())).toBe(3);
    const runId = runIdFrom(printed());
    out = [];

    // Pass 2 adds the acknowledgment; it is recorded in the spec's history.
    expect(await run(['run', '--runconfig', runconfigPath, '--resume', runId, ...ACK])).toBe(0);
    const spec = await readSpec(runId);
    expect(spec.acknowledgments).toHaveLength(1);
    expect(spec.acknowledgments![0]).toMatchObject({
      taskId: CANARY,
      pattern: 'invalidtoolinputerror',
      reason: REASON,
    });
    expect(spec.acknowledgments![0]!.argv).toContain('--resume');
    const entry = spec.history.find((h) => h.event === 'acknowledged');
    expect(entry!.acknowledgments![0]!.reason).toBe(REASON);
    out = [];

    // Pass 3 re-runs the canary's cells and does NOT pass --ack. The recorded
    // acknowledgment is replayed, so the identical failure is recorded and the
    // unattended resume does not re-halt on something already reviewed.
    expect(
      await run(['run', '--runconfig', runconfigPath, '--resume', runId, '--redo', CANARY]),
    ).toBe(0);
    expect(printed()).toContain('1 acknowledgment(s)');
    expect(printed()).toContain(REASON);
    const alert = await readAlert(runId);
    expect(alert.halted).toBe(false);
    expect(
      alert.alerts.find((a) => a.kind === 'cross-config-identical-failure')!.level,
    ).toBe('acknowledged');
    // Only one acknowledgment on record: re-resuming does not duplicate it.
    expect((await readSpec(runId)).acknowledgments).toHaveLength(1);
    expect(
      (await readSpec(runId)).history.filter((h) => h.event === 'acknowledged'),
    ).toHaveLength(1);
  });

  it('--dry-run prints the acknowledgments in force, including inherited ones', async () => {
    await writeTask(CANARY, ENUM_FAILURE);
    await writeTask('zz-build-nac-002-fine', FINE);
    await writeRunconfig();

    // Typed on this command line.
    expect(await run([...BASE(), ...ACK, '--dry-run'])).toBe(0);
    expect(printed()).toContain('acknowledgments (1)');
    expect(printed()).toContain(`${CANARY}:invalidtoolinputerror`);
    expect(printed()).toContain(REASON);
    expect(printed()).toContain('will NOT halt the run');
    // A dry run writes nothing at all, acknowledgment or otherwise.
    await expect(readFile(path.join(resultsRoot, 'latest', 'state.json'), 'utf8')).rejects.toThrow();
    out = [];

    // Inherited from the run's own spec, with no --ack on the command line.
    expect(await run([...BASE(), ...ACK])).toBe(0);
    const runId = runIdFrom(printed());
    out = [];
    expect(await run(['run', '--runconfig', runconfigPath, '--resume', runId, '--dry-run'])).toBe(0);
    expect(printed()).toContain('acknowledgments (1)');
    expect(printed()).toContain(REASON);
  });

  it('doctor lists the acknowledgment, refuses to call the run clean, and still exits 0', async () => {
    await writeTask(CANARY, ENUM_FAILURE);
    await writeTask('zz-build-nac-002-fine', FINE);
    await writeRunconfig();

    expect(await run([...BASE(), ...ACK])).toBe(0);
    const runId = runIdFrom(printed());
    const runDir = path.join(resultsRoot, runId);
    out = [];

    const report = await buildDoctorReport(runDir);
    expect(report.verdict.level).toBe('acknowledged');
    expect(report.verdict.headline).toContain('ACKNOWLEDGED');
    expect(report.verdict.headline).toContain('not clean');
    expect(report.acknowledgments).toHaveLength(1);
    expect(report.acknowledgments[0]).toMatchObject({
      taskId: CANARY,
      pattern: 'invalidtoolinputerror',
      reason: REASON,
      cells: 3,
      matched: true,
    });
    expect(report.acknowledgments[0]!.configIds).toEqual(CONFIG_IDS);
    // The cross-config finding is not silently dropped: it is downgraded, keeps
    // its evidence, and carries the reason it was accepted.
    const finding = report.findings.find((f) => f.kind === 'cross-config-identical-failure')!;
    expect(finding.level).toBe('acknowledged');
    expect(finding.acknowledgment!.reason).toBe(REASON);
    expect(report.invalidTasks).toEqual([]);

    const text = renderDoctorReport(report);
    expect(text).toContain('ACKNOWLEDGMENTS (1)');
    expect(text).toContain('this run is NOT clean');
    expect(text).toContain(REASON);
    expect(text).toContain('3 failed cell(s)');
    expect(text).toContain('never acknowledgeable');
    expect(text).not.toContain('verdict: no invalid tasks detected\n');

    // As a publish gate: reviewed, so it passes — loudly.
    expect(await run(['doctor', runDir, '--results', resultsRoot])).toBe(0);
    expect(printed()).toContain('ACKNOWLEDGMENTS (1)');
  });

  it('doctor still reports an unacknowledged task as INVALID alongside the ack', async () => {
    await writeTask(CANARY, ENUM_FAILURE);
    await writeTask('zz-build-nac-002-broken', MONTH_FAILURE);
    await writeRunconfig();

    // warn-only so the whole grid runs and doctor has both tasks to look at.
    await run([...BASE(), ...ACK, '--watchdog-warn-only']);
    const runDir = path.join(resultsRoot, runIdFrom(printed()));
    const report = await buildDoctorReport(runDir);
    expect(report.verdict.level).toBe('invalid');
    expect(report.invalidTasks).toEqual(['zz-build-nac-002-broken']);
    expect(report.acknowledgments).toHaveLength(1);
    // Both facts are in the verdict a human reads.
    const text = renderDoctorReport(report);
    expect(text).toContain('ACKNOWLEDGMENTS (1)');
    expect(text).toContain('look INVALID');
  });
});
