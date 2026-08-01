/**
 * The watchdog's signals, against synthetic results.
 *
 * The two assertions that matter are symmetric and both are here:
 *
 *   - each signal FIRES on the shape it was written for (including the two real
 *     bugs, reproduced verbatim: "unexpected field `views`" and "missing field
 *     `type`" across three configs);
 *   - none of them fires on a plausible HEALTHY run — in particular a task two
 *     configs legitimately failed for *different* stated reasons, which is what
 *     a hard task looks like and is the single most expensive false positive
 *     available (it would halt a good multi-day grid).
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WATCHDOG_SETTINGS,
  Watchdog,
  longestCommonSubstring,
  normalizeDiagnostic,
  readAlertFile,
  renderAlertBanner,
  resolveWatchdogSettings,
  sharedEvidence,
  writeAlertFile,
  type WatchdogObservation,
  type WatchdogSettings,
} from '../src/watchdog.js';

const CONFIGS = ['opus', 'sonnet', 'sol-medium', 'sol-xhigh', 'luna', 'fable', 'kimi'];

function watchdog(over: Partial<WatchdogSettings> = {}, configIds = CONFIGS): Watchdog {
  return new Watchdog({
    settings: { ...DEFAULT_WATCHDOG_SETTINGS, ...over },
    runId: 'test-run',
    configIds,
    now: () => 1_700_000_000_000,
  });
}

function scored(
  configId: string,
  score: number,
  diagnostics: string[],
  over: Partial<WatchdogObservation> = {},
): WatchdogObservation {
  return {
    taskId: 'build-nac-004-board-view-filters',
    configId,
    trial: 1,
    kind: 'scored',
    score,
    diagnostics,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe('diagnostic normalization', () => {
  it('strips ids, uuids, urls, paths and numbers', () => {
    expect(
      normalizeDiagnostic(
        'api=https://api.notion.com root=3af6ab85-753b-819b-bed3-c1d2470369a5 (ctx.rootId)',
      ),
    ).toBe('api=<url> root=<id> (ctx.rootid)');
    expect(normalizeDiagnostic('failed after 12.4s in /tmp/nb-abc/workspace/dist')).toBe(
      'failed after <n> in <path>',
    );
    expect(normalizeDiagnostic('checked 250 rows')).toBe('checked <n> rows');
  });

  it('unifies quote styles, so two verifiers phrasing it differently still match', () => {
    expect(normalizeDiagnostic('missing field `type`')).toBe(
      normalizeDiagnostic("missing field 'type'"),
    );
    expect(normalizeDiagnostic('missing field "type"')).toBe('missing field "type"');
  });

  it('leaves the part that describes the TASK intact', () => {
    expect(
      normalizeDiagnostic('unexpected field `views` in intents[3] of 3af6ab85753b808daa60d1dd1b0c40a0'),
    ).toBe('unexpected field "views" in intents[<n>] of <id>');
  });

  it('longestCommonSubstring finds the shared complaint', () => {
    expect(longestCommonSubstring('unexpected field "views" at a', 'at b unexpected field "views"')).toBe(
      'unexpected field "views"',
    );
    expect(longestCommonSubstring('', 'abc')).toBe('');
  });
});

describe('sharedEvidence', () => {
  it('prefers an exact match across configs', () => {
    const ev = sharedEvidence(
      [
        { configId: 'a', diagnostics: ['unexpected field `views`'] },
        { configId: 'b', diagnostics: ['unexpected field `views`', 'build ok'] },
        { configId: 'c', diagnostics: ['unexpected field `views`'] },
      ],
      24,
    );
    expect(ev).toMatchObject({ kind: 'exact', text: 'unexpected field "views"' });
    expect(ev!.configIds.sort()).toEqual(['a', 'b', 'c']);
  });

  it('falls back to a long shared substring when only part of the line matches', () => {
    const ev = sharedEvidence(
      [
        { configId: 'a', diagnostics: ['intents[0]: missing field `type` (expected select)'] },
        { configId: 'b', diagnostics: ['intents[7]: missing field `type` (expected select)'] },
        { configId: 'c', diagnostics: ['intents[2]: missing field `type` (expected select)'] },
      ],
      24,
    );
    expect(ev!.kind).toBe('exact'); // normalization collapses the indices, so it matches whole
    expect(ev!.text).toContain('missing field "type"');
  });

  it('returns nothing when the configs failed for genuinely different reasons', () => {
    expect(
      sharedEvidence(
        [
          { configId: 'a', diagnostics: ['no solved.txt written'] },
          { configId: 'b', diagnostics: ['relation property points at the wrong data source'] },
          { configId: 'c', diagnostics: ['rollup aggregation is sum, expected average'] },
        ],
        24,
      ),
    ).toBeUndefined();
  });

  it('rejects a short accidental overlap', () => {
    expect(
      sharedEvidence(
        [
          { configId: 'a', diagnostics: ['failed: alpha'] },
          { configId: 'b', diagnostics: ['failed: beta'] },
        ],
        24,
      ),
    ).toBeUndefined();
  });
});

// --- (a) cross-config identical failure -------------------------------------

describe('(a) cross-config identical failure', () => {
  it('fires on the real "unexpected field `views`" shape: three configs, same diagnostic', () => {
    const w = watchdog();
    expect(w.observe(scored('opus', 0, ['unexpected field `views` at intents[2]']))).toEqual([]);
    expect(w.observe(scored('sonnet', 0, ['unexpected field `views` at intents[5]']))).toEqual([]);
    const alerts = w.observe(scored('sol-medium', 0, ['unexpected field `views` at intents[1]']));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      level: 'halt',
      kind: 'cross-config-identical-failure',
      taskId: 'build-nac-004-board-view-filters',
      trial: 1,
    });
    expect(alerts[0]!.evidence).toContain('unexpected field "views"');
    expect(alerts[0]!.configIds).toEqual(['opus', 'sol-medium', 'sonnet']);
    expect(w.halted).toBe(true);
  });

  it('fires on the real "missing field `type`" shape too, across quote styles', () => {
    const w = watchdog();
    w.observe(scored('opus', 0, ["missing field 'type' on property Status"]));
    w.observe(scored('luna', 0, ['missing field "type" on property Status']));
    const alerts = w.observe(scored('kimi', 0, ['missing field `type` on property Status']));
    expect(alerts[0]!.kind).toBe('cross-config-identical-failure');
    expect(alerts[0]!.evidence).toContain('missing field "type"');
  });

  it('does NOT fire when two configs fail with different diagnostics — that is a hard task', () => {
    const w = watchdog();
    expect(w.observe(scored('opus', 1, ['solved']))).toEqual([]);
    expect(w.observe(scored('sonnet', 0, ['no page titled "Onboarding Checklist" under the root']))).toEqual([]);
    expect(w.observe(scored('luna', 0, ['icon is an emoji, expected an external file']))).toEqual([]);
    expect(w.observe(scored('kimi', 0, ['the checklist database has no Status property']))).toEqual([]);
    expect(w.halted).toBe(false);
    expect(w.alerts).toHaveLength(0);
  });

  it('does NOT fire when only two of seven configs share a diagnostic', () => {
    const w = watchdog();
    w.observe(scored('opus', 1, ['ok']));
    w.observe(scored('sonnet', 1, ['ok']));
    w.observe(scored('sol-medium', 1, ['ok']));
    w.observe(scored('sol-xhigh', 1, ['ok']));
    w.observe(scored('luna', 1, ['ok']));
    w.observe(scored('fable', 0, ['unexpected field `views` at intents[2]']));
    w.observe(scored('kimi', 0, ['unexpected field `views` at intents[9]']));
    // 2 of 7 = 29% — below both the absolute (3) and fractional (60%) arms.
    expect(w.alerts).toHaveLength(0);
  });

  it('the fraction arm catches a narrow grid the absolute count would miss', () => {
    const w = watchdog({}, ['a', 'b', 'c']);
    w.observe(scored('a', 0, ['unexpected field `views` at intents[2]']));
    const alerts = w.observe(scored('b', 0, ['unexpected field `views` at intents[7]']));
    // 2 of 2 attempted = 100% ≥ 60%, even though 2 < the default minConfigs of 3.
    expect(alerts[0]!.kind).toBe('cross-config-identical-failure');
    expect(alerts[0]!.detail[0]).toContain('60% of the 3 config(s) in this run');
  });

  it('does not fire on the first two verdicts of a seven-config block', () => {
    // The denominator is the run's config count, not "those that have reported".
    // Otherwise the first two configs to finish are always 100% of the attempts
    // and every block whose first two verdicts rhyme halts a healthy grid.
    const w = watchdog();
    w.observe(scored('opus', 0, ['unexpected field `views` at intents[2]']));
    w.observe(scored('sonnet', 0, ['unexpected field `views` at intents[5]']));
    expect(w.alerts).toHaveLength(0);
    expect(w.halted).toBe(false);
  });

  it('does not confuse trials — the same task in trial 2 is a separate judgement', () => {
    const w = watchdog();
    w.observe(scored('opus', 0, ['unexpected field `views`'], { trial: 1 }));
    w.observe(scored('sonnet', 0, ['unexpected field `views`'], { trial: 2 }));
    w.observe(scored('luna', 0, ['unexpected field `views`'], { trial: 3 }));
    expect(w.alerts).toHaveLength(0);
  });

  it('raises the same alert once, not once per subsequent failing config', () => {
    const w = watchdog();
    for (const cfg of CONFIGS) w.observe(scored(cfg, 0, ['unexpected field `views`']));
    expect(w.alerts.filter((a) => a.kind === 'cross-config-identical-failure')).toHaveLength(1);
  });
});

// --- (b) verifier crash ------------------------------------------------------

describe('(b) verifier crash', () => {
  it('halts on the very first one', () => {
    const w = watchdog();
    const alerts = w.observe({
      taskId: 'build-nac-002-csv-seeded',
      configId: 'opus',
      trial: 1,
      kind: 'verifier-crash',
      error: 'verifier exited 1 without a result: TypeError: intents.map is not a function',
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ level: 'halt', kind: 'verifier-crash' });
    expect(alerts[0]!.detail[0]).toContain('intents.map is not a function');
    expect(w.halted).toBe(true);
  });

  it('is NOT tripped by a rate-limited or unscored cell', () => {
    const w = watchdog();
    w.observe({ taskId: 't', configId: 'opus', trial: 1, kind: 'unmeasured' });
    w.observe({ taskId: 't', configId: 'sonnet', trial: 1, kind: 'unmeasured' });
    expect(w.alerts).toHaveLength(0);
    expect(w.halted).toBe(false);
  });

  it('can be turned off without touching the other signals', () => {
    const w = watchdog({ verifierCrash: { enabled: false, minOccurrences: 1 } });
    w.observe({ taskId: 't', configId: 'opus', trial: 1, kind: 'verifier-crash', error: 'boom' });
    expect(w.halted).toBe(false);
  });
});

// --- (c) fixture provisioning ------------------------------------------------

describe('(c) fixture provisioning failure', () => {
  it('tolerates one (a Notion 500) and halts on the second for the same task', () => {
    const w = watchdog();
    const first = w.observe({
      taskId: 'build-cli-001-create-page-with-icon',
      configId: 'opus',
      trial: 1,
      kind: 'fixture-failure',
      error: 'notion 502 while creating the fixture root',
    });
    expect(first).toEqual([]);
    const second = w.observe({
      taskId: 'build-cli-001-create-page-with-icon',
      configId: 'sonnet',
      trial: 1,
      kind: 'fixture-failure',
      error: 'spec.json: unknown property type "selectx"',
    });
    expect(second[0]).toMatchObject({ level: 'halt', kind: 'fixture-provisioning-failure' });
    expect(second[0]!.evidence).toContain('build-cli-001-create-page-with-icon');
  });

  it('counts per task — one failure each on two tasks is not a pattern', () => {
    const w = watchdog();
    w.observe({ taskId: 'a', configId: 'opus', trial: 1, kind: 'fixture-failure', error: 'x' });
    w.observe({ taskId: 'b', configId: 'opus', trial: 1, kind: 'fixture-failure', error: 'y' });
    expect(w.alerts).toHaveLength(0);
  });
});

// --- (d) total-task failure --------------------------------------------------

describe('(d) total-task failure', () => {
  /** Seven genuinely different complaints — no two share a normalized substring. */
  const DISTINCT = [
    'no dist/intents.json produced',
    'relation points at the wrong data source',
    'rollup aggregation is sum, expected average',
    'board view has no group-by',
    'the schema is missing an Owner property',
    'build refused: anchor rule violated',
    'created four databases where two were asked for',
  ];

  it('WARNS (does not halt) when every config scores 0 for different reasons', () => {
    const w = watchdog();
    const raised = CONFIGS.flatMap((cfg, i) => w.observe(scored(cfg, 0, [DISTINCT[i]!])));
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ level: 'warn', kind: 'total-task-failure' });
    expect(raised[0]!.evidence).toContain('SUSPECT');
    expect(raised[0]!.detail[0]).toContain('may be broken, or may simply be very hard');
    // The crucial half: a benchmark that halted on "hard" would be censoring its
    // own headline result.
    expect(w.halted).toBe(false);
  });

  it('does not fire while any config solved it', () => {
    const w = watchdog();
    CONFIGS.slice(0, 6).forEach((cfg, i) => w.observe(scored(cfg, 0, [DISTINCT[i]!])));
    w.observe(scored('kimi', 1, ['solved']));
    expect(w.alerts.filter((a) => a.kind === 'total-task-failure')).toHaveLength(0);
  });

  it('waits until every config in the run has reported', () => {
    const w = watchdog();
    CONFIGS.slice(0, 6).forEach((cfg, i) => w.observe(scored(cfg, 0, [DISTINCT[i]!])));
    expect(w.alerts).toHaveLength(0);
    const last = w.observe(scored('kimi', 0, [DISTINCT[6]!]));
    expect(last[0]!.kind).toBe('total-task-failure');
  });

  it('does not fire below the config threshold', () => {
    const w = watchdog({}, CONFIGS.slice(0, 4));
    CONFIGS.slice(0, 4).forEach((cfg, i) => w.observe(scored(cfg, 0, [DISTINCT[i]!])));
    expect(w.alerts).toHaveLength(0);
  });

  it('can be made to halt by configuration', () => {
    const w = watchdog({ totalTaskFailure: { enabled: true, minConfigs: 5, halt: true } });
    CONFIGS.forEach((cfg, i) => w.observe(scored(cfg, 0, [DISTINCT[i]!])));
    expect(w.halted).toBe(true);
  });
});

// --- (e) infrastructure ------------------------------------------------------

describe('(e) infrastructure', () => {
  const base = { pendingCells: 40, inFlightCells: 2, cooldownConfigIds: [], blockedConfigIds: [] };

  it('halts when nothing completed inside the stall window', () => {
    const w = watchdog();
    expect(w.checkInfrastructure({ ...base, now: 1_700_000_000_000 + 59 * 60_000 })).toEqual([]);
    const alerts = w.checkInfrastructure({ ...base, now: 1_700_000_000_000 + 61 * 60_000 });
    expect(alerts[0]).toMatchObject({ level: 'halt', kind: 'infrastructure-stall' });
  });

  it('does not call a legitimate all-configs cooldown a stall', () => {
    const w = watchdog();
    const alerts = w.checkInfrastructure({
      ...base,
      now: 1_700_000_000_000 + 120 * 60_000,
      cooldownConfigIds: CONFIGS,
    });
    expect(alerts.map((a) => a.kind)).not.toContain('infrastructure-stall');
    // It is noted, but only as a warning: this is the normal shape of a paced grid.
    expect(alerts[0]).toMatchObject({ level: 'warn', kind: 'infrastructure-all-configs-blocked' });
  });

  it('halts when every config is blocked rather than merely cooling', () => {
    const w = watchdog();
    const alerts = w.checkInfrastructure({
      ...base,
      now: 1_700_000_000_000,
      blockedConfigIds: CONFIGS,
    });
    expect(alerts[0]).toMatchObject({ level: 'halt', kind: 'infrastructure-all-configs-blocked' });
  });

  it('halts on low disk', () => {
    const w = watchdog();
    const alerts = w.checkInfrastructure({
      ...base,
      now: 1_700_000_000_000,
      freeDiskBytes: 2 * 1024 ** 3,
    });
    expect(alerts[0]).toMatchObject({ level: 'halt', kind: 'infrastructure-low-disk' });
    expect(alerts[0]!.evidence).toContain('2.0 GB free');
  });

  it('is quiet on a healthy machine', () => {
    const w = watchdog();
    expect(
      w.checkInfrastructure({ ...base, now: 1_700_000_000_000, freeDiskBytes: 400 * 1024 ** 3 }),
    ).toEqual([]);
  });
});

// --- switches ---------------------------------------------------------------

describe('switches', () => {
  it('--no-watchdog observes nothing at all', () => {
    const w = watchdog({ enabled: false });
    for (const cfg of CONFIGS) w.observe(scored(cfg, 0, ['unexpected field `views`']));
    expect(w.alerts).toHaveLength(0);
    expect(w.halted).toBe(false);
  });

  it('--watchdog-warn-only records the alert but never halts', () => {
    const w = watchdog({ warnOnly: true });
    for (const cfg of ['opus', 'sonnet', 'luna']) w.observe(scored(cfg, 0, ['unexpected field `views`']));
    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0]!.level).toBe('warn');
    expect(w.halted).toBe(false);
  });

  it('runconfig thresholds merge over the defaults, field by field', () => {
    const merged = resolveWatchdogSettings({ crossConfig: { minConfigs: 5 } });
    expect(merged.crossConfig.minConfigs).toBe(5);
    expect(merged.crossConfig.minFraction).toBe(DEFAULT_WATCHDOG_SETTINGS.crossConfig.minFraction);
    expect(merged.infrastructure.stallMinutes).toBe(60);
    expect(resolveWatchdogSettings(undefined)).toEqual(DEFAULT_WATCHDOG_SETTINGS);
  });
});

// --- the alert file ----------------------------------------------------------

describe('ALERT.json', () => {
  it('round-trips, and reads as undefined when absent or torn', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nb-alert-'));
    try {
      expect(await readAlertFile(dir)).toBeUndefined();

      const w = watchdog();
      for (const cfg of ['opus', 'sonnet', 'luna']) w.observe(scored(cfg, 0, ['unexpected field `views`']));
      await writeAlertFile(dir, w.snapshot());

      const read = await readAlertFile(dir);
      expect(read!.halted).toBe(true);
      expect(read!.alerts).toHaveLength(1);
      expect(read!.halting!.kind).toBe('cross-config-identical-failure');
      expect(read!.runId).toBe('test-run');

      await writeFile(path.join(dir, 'ALERT.json'), '{"alerts":[', 'utf8');
      expect(await readAlertFile(dir)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the banner names the task, the evidence and the re-run command', async () => {
    const w = watchdog();
    for (const cfg of ['opus', 'sonnet', 'luna']) w.observe(scored(cfg, 0, ['unexpected field `views`']));
    const banner = renderAlertBanner(w.snapshot(), '/results/test-run');
    expect(banner).toContain('WATCHDOG HALT');
    expect(banner).toContain('build-nac-004-board-view-filters');
    expect(banner).toContain('unexpected field "views"');
    expect(banner).toContain('in-flight cells were allowed to finish');
    expect(banner).toContain(
      '--resume test-run --redo build-nac-004-board-view-filters',
    );
    expect(banner).toContain('notionbench doctor /results/test-run');
    // Prove the file the banner points at is the one that gets written.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nb-alert2-'));
    try {
      await writeAlertFile(dir, w.snapshot());
      expect(JSON.parse(await readFile(path.join(dir, 'ALERT.json'), 'utf8')).halted).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
