/**
 * Acknowledgments — "yes, a human looked at this failure, and it is real".
 *
 * The watchdog halts a run when several configs fail the same task with the same
 * normalized diagnostic, because that is the signature of a broken verifier
 * rather than of three independent models. It is right often enough to be worth
 * a multi-day grid's protection, and wrong exactly when the *task* is the thing
 * making every model fail the same way.
 *
 * That happened on the 798-cell run: `resolve-instructions-001-workflow-canary`
 * tells the agent that "a category nobody has expensed answers with zeros rather
 * than an error", three configs constrained their tool's input schema to an enum
 * so the SDK rejected the call (`tool_unknown_category … InvalidToolInputError`),
 * and two configs handled it correctly. Same complaint from three configs, and a
 * genuine agent failure that belongs in the results.
 *
 * Before this file the only escapes were `--no-watchdog` and
 * `--watchdog-warn-only`, which trade one reviewed failure for the protection of
 * the other 37 tasks. An acknowledgment is the surgical version:
 *
 *     --ack <taskId>[:<substring>] --ack-reason "<why you are sure>"
 *
 * and it does three things, in order of importance:
 *
 *   1. **It never hides anything.** An acknowledged signal is still detected,
 *      still recorded in ALERT.json and run-spec.json, still printed, still
 *      listed by `notionbench doctor` — at `level: "acknowledged"` with the
 *      reason attached. A run carrying acknowledgments is not a clean run; it is
 *      a run with reviewed failures, and every consumer says so.
 *   2. **It is narrow.** `--ack task:substring` matches only when the shared
 *      normalized diagnostic contains that substring, so a *different* failure
 *      mode on the same task halts the run exactly as before. The bare
 *      `--ack task` form is deliberately the discouraged one.
 *   3. **It cannot touch the apparatus.** {@link NEVER_ACKNOWLEDGEABLE_KINDS} —
 *      verifier crashes and fixture-provisioning failures — are not
 *      acknowledgeable at any syntax, by any flag. A verifier that returns no
 *      verdict is a broken measurement, never agent behaviour: the ENOSPC
 *      incident that motivated the watchdog presented as a verifier crash, and
 *      an escape hatch that could have suppressed it would have been worse than
 *      no watchdog at all. The guarantee is structural — {@link matchAck}
 *      refuses those kinds before it looks at a single acknowledgment — and it
 *      is *also* refused at parse time so the operator is told why rather than
 *      being handed a flag that silently does nothing.
 *
 * This module deliberately imports nothing. It is the vocabulary shared by the
 * watchdog (live), run-spec.json (persistence and replay) and doctor (post-hoc),
 * and none of those may end up importing each other through it.
 */

/** Alert kinds an acknowledgment may apply to. Nothing else is ever eligible. */
export const ACKNOWLEDGEABLE_KINDS = [
  'cross-config-identical-failure',
  'total-task-failure',
] as const;

/**
 * Alert kinds no acknowledgment may ever apply to, at any syntax.
 *
 * Both mean the measurement apparatus failed rather than the agent: a verifier
 * that produced no usable verdict leaves every cell of that task unmeasured, and
 * a fixture that will not provision hands the agent an empty workspace. Neither
 * can be "a legitimate failure a human reviewed", so neither is suppressible.
 */
export const NEVER_ACKNOWLEDGEABLE_KINDS = [
  'verifier-crash',
  'fixture-provisioning-failure',
] as const;

/** What the operator typed: a task, and optionally the failure mode within it. */
export interface AckSpec {
  taskId: string;
  /** Lower-cased, whitespace-collapsed substring matched against the normalized diagnostic. */
  pattern?: string;
  /** Exactly as typed, for messages: `task` or `task:pattern`. */
  raw: string;
}

/** An {@link AckSpec} plus the audit trail that makes it publishable. */
export interface Acknowledgment extends AckSpec {
  /** Mandatory (`--ack-reason`). Reproduced in ALERT.json, run-spec.json and doctor. */
  reason: string;
  /** When it was recorded. */
  at: string;
  /** argv of the invocation that recorded it — who, in the only sense a CLI has. */
  argv?: string[];
}

/** Refusals and malformed input. The CLI turns this into a usage error (exit 2). */
export class AckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AckError';
  }
}

/**
 * Spellings that name an apparatus fault.
 *
 * Checked against the pattern so `--ack task:verifier-crash` is refused with an
 * explanation instead of being accepted as a substring that would never match
 * anything. This is a courtesy on top of the real guarantee in {@link matchAck},
 * not the guarantee itself.
 */
const APPARATUS_SPELLINGS = [
  'verifier-crash',
  'verifier crash',
  'verifier_crash',
  'verifiercrash',
  'fixture-provisioning-failure',
  'fixture provisioning failure',
  'fixture-provisioning',
  'fixture provisioning',
  'fixture-failure',
  'fixture failure',
  'fixture_failure',
];

const APPARATUS_REFUSAL =
  'A verifier crash means the verifier returned no usable verdict, and a fixture-provisioning ' +
  'failure means the task\'s fixture/spec.json could not be built — both are the measurement ' +
  'apparatus failing, never agent behaviour, so neither can ever be acknowledged. (The disk-full ' +
  'incident this watchdog was written for presented as a verifier crash.) Acknowledgments apply ' +
  `only to: ${ACKNOWLEDGEABLE_KINDS.join(', ')}. Fix the verifier or the fixture, then ` +
  '`notionbench run --resume <runId> --redo <taskId>`.';

/** The (taskId, pattern) pair every ack is identified and displayed by. */
export type AckSignature = Pick<AckSpec, 'taskId' | 'pattern'>;

/** `taskId` or `taskId:pattern` — the flag value that would re-create this ack. */
export function ackFlag(ack: AckSignature): string {
  return ack.pattern ? `${ack.taskId}:${ack.pattern}` : ack.taskId;
}

/** Identity of an acknowledgment: the signature it covers, not when it was added. */
export function ackKey(ack: AckSignature): string {
  return `${ack.taskId}::${ack.pattern ?? '*'}`;
}

/**
 * Parse `--ack` values: repeatable, comma-separated, `taskId[:pattern]`.
 *
 * Split on the FIRST colon only, so a pattern may contain colons (task ids may
 * not). Commas separate acks and therefore cannot appear inside a pattern —
 * normalized diagnostics rarely need one, and the alternative is a quoting
 * grammar nobody would get right at 3am.
 */
export function parseAckFlags(values: string[] | undefined): AckSpec[] {
  const out: AckSpec[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    for (const piece of value.split(',')) {
      const raw = piece.trim();
      if (raw.length === 0) continue;
      const spec = parseAckSpec(raw);
      const key = ackKey(spec);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(spec);
    }
  }
  return out;
}

export function parseAckSpec(raw: string): AckSpec {
  const colon = raw.indexOf(':');
  const taskId = (colon === -1 ? raw : raw.slice(0, colon)).trim();
  const rest = colon === -1 ? undefined : raw.slice(colon + 1).trim();

  if (taskId.length === 0) {
    throw new AckError(
      `--ack "${raw}" has no task id. Expected --ack <taskId>[:<substring of the shared diagnostic>].`,
    );
  }
  if (colon !== -1 && (rest === undefined || rest.length === 0)) {
    throw new AckError(
      `--ack "${raw}" ends in a colon with no pattern. Either drop the colon to acknowledge ` +
        `${ACKNOWLEDGEABLE_KINDS.join(' and ')} for the whole task, or give the substring of the ` +
        'shared diagnostic you reviewed.',
    );
  }

  const pattern = rest ? rest.toLowerCase().replace(/\s+/g, ' ') : undefined;
  assertAcknowledgeable(raw, taskId, pattern);
  return { taskId, pattern, raw };
}

/**
 * Refuse, loudly, anything that names an apparatus fault.
 *
 * Checked on the pattern and on the task id, because `--ack verifier-crash` (a
 * plausible mis-reading of the flag as taking a signal name) must not quietly
 * become an acknowledgment of a task called `verifier-crash`.
 */
function assertAcknowledgeable(raw: string, taskId: string, pattern: string | undefined): void {
  const hay = [taskId.toLowerCase(), pattern ?? ''];
  for (const spelling of APPARATUS_SPELLINGS) {
    if (!hay.some((h) => h.includes(spelling))) continue;
    throw new AckError(
      `--ack "${raw}" names "${spelling}", which can never be acknowledged.\n${APPARATUS_REFUSAL}`,
    );
  }
  for (const kind of NEVER_ACKNOWLEDGEABLE_KINDS) {
    if (!hay.some((h) => h.includes(kind))) continue;
    throw new AckError(
      `--ack "${raw}" names the ${kind} signal, which can never be acknowledged.\n${APPARATUS_REFUSAL}`,
    );
  }
}

/**
 * The mandatory reason.
 *
 * A suppression without a stated reason is indistinguishable from a suppression
 * nobody thought about, and this whole mechanism only earns its place if a
 * reader of the published run can see which failures were reviewed and why.
 */
export function requireAckReason(specs: AckSpec[], reason: string | undefined): string {
  const text = (reason ?? '').trim();
  if (specs.length === 0) {
    if (reason !== undefined) {
      throw new AckError(
        '--ack-reason only applies with --ack: it records WHY a known-legitimate failure was ' +
          'acknowledged, so there has to be an acknowledgment for it to be about.',
      );
    }
    return '';
  }
  if (text.length === 0) {
    throw new AckError(
      `--ack ${specs.map(ackFlag).join(', ')} requires --ack-reason "<text>".\n` +
        'An acknowledgment stops the watchdog halting on a failure signature, so it is recorded ' +
        'in run-spec.json and ALERT.json and listed by `notionbench doctor` — a reader of the ' +
        'published run must be able to see exactly what was suppressed and why a human decided ' +
        'it was a real agent failure.\n' +
        'e.g. --ack-reason "reviewed: the prompt asks for zeros on an unknown category; these ' +
        'configs pinned the tool schema to an enum, so the SDK rejects the call. Genuine miss."',
    );
  }
  return text;
}

export interface BuildAckOptions {
  reason: string;
  argv?: string[];
  now?: Date;
}

export function buildAcknowledgments(specs: AckSpec[], opts: BuildAckOptions): Acknowledgment[] {
  const at = (opts.now ?? new Date()).toISOString();
  return specs.map((spec) => ({
    ...spec,
    reason: opts.reason,
    at,
    argv: opts.argv ? [...opts.argv] : undefined,
  }));
}

/**
 * Union of the acknowledgments a run already carries and the ones this
 * invocation added, first record of a signature winning.
 *
 * Keeping the *earliest* record means an overnight resume that re-passes the
 * same flag does not rewrite the audit trail's timestamps, and the history entry
 * appended by run-spec.ts stays a record of decisions rather than of re-runs.
 */
export function mergeAcknowledgments(
  existing: readonly Acknowledgment[],
  added: readonly Acknowledgment[],
): Acknowledgment[] {
  const out: Acknowledgment[] = [];
  const seen = new Set<string>();
  for (const ack of [...existing, ...added]) {
    const key = ackKey(ack);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ack);
  }
  return out;
}

/** The acknowledgments in `added` that `existing` does not already cover. */
export function newAcknowledgments(
  existing: readonly Acknowledgment[],
  added: readonly Acknowledgment[],
): Acknowledgment[] {
  const known = new Set(existing.map(ackKey));
  return added.filter((a) => !known.has(ackKey(a)));
}

/** Only ever true for the two acknowledgeable kinds. */
export function isAcknowledgeableKind(kind: string): boolean {
  return (ACKNOWLEDGEABLE_KINDS as readonly string[]).includes(kind);
}

export interface AckTarget {
  /** The alert kind. Anything outside {@link ACKNOWLEDGEABLE_KINDS} never matches. */
  kind: string;
  taskId: string;
  /**
   * The already-normalized diagnostic text(s) this alert rests on. A patterned
   * ack matches only when EVERY one of them contains the pattern, so a pattern
   * always describes something the failing configs genuinely share.
   */
  normalizedTexts: string[];
}

/**
 * The acknowledgment covering this alert, if any.
 *
 * The kind check comes first and is not configurable: this is the one place the
 * "verifier crashes and fixture failures are never suppressible" guarantee is
 * enforced, and it is enforced on the alert's own kind rather than on anything
 * the operator typed.
 */
export function matchAck(
  acks: readonly Acknowledgment[],
  target: AckTarget,
): Acknowledgment | undefined {
  if (!isAcknowledgeableKind(target.kind)) return undefined;
  for (const ack of acks) {
    if (ack.taskId !== target.taskId) continue;
    if (!ack.pattern) return ack;
    const texts = target.normalizedTexts.filter((t) => t.length > 0);
    if (texts.length === 0) continue;
    if (texts.every((t) => t.toLowerCase().includes(ack.pattern!))) return ack;
  }
  return undefined;
}

/** One line: what was acknowledged, and why. */
export function describeAck(ack: Acknowledgment): string {
  return `${ackFlag(ack)} — "${ack.reason}" (recorded ${ack.at})`;
}

/**
 * The block printed by `run`, `--dry-run` and the ALERT banner.
 *
 * Always says out loud that these are recorded rather than hidden; the failure
 * modes of this feature are all "someone forgot a suppression was in force".
 */
export function renderAcknowledgments(acks: readonly Acknowledgment[], indent = '  '): string[] {
  if (acks.length === 0) return [];
  const lines = [
    `acknowledgments (${acks.length}) — these failure signature(s) are RECORDED, not hidden, and ` +
      'will not halt the run:',
  ];
  for (const ack of acks) {
    lines.push(`${indent}${ackFlag(ack)}`);
    lines.push(`${indent}  reason: ${ack.reason}`);
    lines.push(
      `${indent}  recorded ${ack.at}${ack.argv && ack.argv.length > 0 ? `  ·  ${ack.argv.join(' ')}` : ''}`,
    );
    if (!ack.pattern) {
      lines.push(
        `${indent}  NOTE: no pattern — this acknowledges ${ACKNOWLEDGEABLE_KINDS.join(' and ')} ` +
          'for the whole task, including failure modes nobody has looked at yet. Prefer ' +
          `--ack ${ack.taskId}:<substring of the diagnostic>.`,
      );
    }
  }
  lines.push(
    `${indent}verifier crashes and fixture-provisioning failures still halt this run — they are ` +
      'never acknowledgeable.',
  );
  return lines;
}
