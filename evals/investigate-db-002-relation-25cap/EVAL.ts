/**
 * investigate-db-002-relation-25cap — the reference-truncation trap.
 *
 * `GET /v1/pages/{id}` returns at most 25 references for a multi-reference page
 * property. Past that the payload is silently short: no error, no exception,
 * just a plausible list that happens to stop at 25. The only complete read is
 * `GET /v1/pages/{id}/properties/{property_id}`, which is what this verifier
 * uses for its own ground truth — a verifier that read the page object would be
 * as wrong as the agent it is grading.
 *
 * The three numbers are chosen so a truncated read is wrong on all of them: the
 * count, the `At risk` tally and the effort total all move when the tail 15
 * initiatives drop off. When a submitted answer matches the 25-reference
 * aggregate exactly, the verifier says so in as many words — that diagnostic is
 * the point of the task.
 *
 * ── Fixture caveat: multi_select stands in for a relation ──────────────────
 * The task the suite wants here is a 40-entry **relation**. It cannot be built
 * yet, and the gap is in the fixture layer rather than the API layer:
 * `_lib/live/spec.ts` has no `relation` property type, and `provision.ts`'s
 * `toSchema` throws on one, so no `fixture/spec.json` can express "relate this
 * row to those forty rows". `Linked Initiatives` is therefore a `multi_select`
 * of initiative codes, joined to the Initiatives database by name — the same
 * two-hop investigation, the same three numbers, the same endpoint under test.
 *
 * A second gap sits underneath it: `fake-notion.ts` does not implement the
 * 25-reference cap or `has_more` on property items, so at QC time a page read
 * returns all forty. `live/wrong.mjs` therefore truncates explicitly, and says
 * so in its header. What CI proves is that this verifier rejects a
 * 25-reference answer; that the real API produces one is documented behaviour.
 *
 * When `relation` support lands in `spec.ts`/`provision.ts` and the cap lands in
 * `fake-notion.ts`, this fixture should become a real relation: the property
 * name, the join and every number in the answer stay exactly as they are.
 *
 * ── Why the QC path and the run path differ ────────────────────────────────
 * At RUN time the agent works in the trial workspace with the real `ntn` CLI,
 * authenticated by a leased token against api.notion.com. It never sees this
 * file, `fixture/spec.json`, or anything under `live/`.
 *
 * At QC time there is no Notion workspace. `evals/_lib/live/qc-live.ts` boots
 * the in-memory `fake-notion.ts`, provisions `fixture/spec.json` against it, and
 * points `NOTION_API_BASE` at it. `ntn` cannot be redirected that way — it is a
 * native binary that talks to the real service — so the oracle and the
 * plausibly-wrong solution under `live/` are plain Node scripts issuing `fetch`
 * calls. They stand in for the *agent*, not for the CLI.
 *
 * The verifier is the same code on both paths — it honors `NOTION_API_BASE` and
 * reads the workspace through the public API either way.
 */
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { readProperties } from "../_lib/live/notion.ts"
import { findDatabase, resolveLiveContext } from "../_lib/live/context.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const PROGRAMS = "Programs"
const INITIATIVES = "Initiatives"
const PROGRAM_ROW = "Platform Modernization"
const LINK_PROPERTY = "Linked Initiatives"
const AT_RISK = "At risk"
const EFFORT = "Effort (points)"
const ANSWER_FILE = "answer.json"

/** The cap the real API applies to references on a page object. */
const REFERENCE_CAP = 25

interface Answer {
  linked_count: number
  at_risk_count: number
  total_effort: number
}

function aggregate(codes: string[], initiatives: Map<string, { status: string; effort: number }>): Answer {
  const answer: Answer = { linked_count: codes.length, at_risk_count: 0, total_effort: 0 }
  for (const code of codes) {
    const initiative = initiatives.get(code)
    if (!initiative) continue
    if (initiative.status === AT_RISK) answer.at_risk_count++
    answer.total_effort += initiative.effort
  }
  return answer
}

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    file: 0,
    linked_count: 0,
    at_risk_count: 0,
    total_effort: 0,
  }

  const live = await resolveLiveContext({ workspaceDir, ctx })
  const { client, rootId } = live
  diagnostics.push(`api=${live.apiBase} root=${rootId} (${live.source.root})`)

  const programsDs =
    live.idMap["programs.ds"] ?? (await findDatabase(client, rootId, PROGRAMS))?.dataSourceId
  const initiativesDs =
    live.idMap["initiatives.ds"] ?? (await findDatabase(client, rootId, INITIATIVES))?.dataSourceId
  if (!programsDs || !initiativesDs) {
    diagnostics.push(
      `could not locate both databases under the sandbox root (programs=${Boolean(programsDs)}, initiatives=${Boolean(initiativesDs)}) — fixture is damaged`,
    )
    return { score: 0, subscores, diagnostics }
  }

  // ---- the program row and its link property id ----------------------------
  const programRows = await client.queryAllRows(programsDs)
  const program = programRows.find((row) => readProperties(row).Name === PROGRAM_ROW)
  if (!program) {
    diagnostics.push(`no "${PROGRAM_ROW}" row in the ${PROGRAMS} database — fixture is damaged`)
    return { score: 0, subscores, diagnostics }
  }
  const schema = await client.getDataSource(programsDs)
  const propertyId = (schema.properties ?? {})[LINK_PROPERTY]?.id
  if (typeof propertyId !== "string") {
    diagnostics.push(`the ${PROGRAMS} data source has no "${LINK_PROPERTY}" property — fixture is damaged`)
    return { score: 0, subscores, diagnostics }
  }

  // The complete read. A page object would stop at REFERENCE_CAP references,
  // which is exactly the mistake being graded — the verifier must not make it.
  const item = await client.request<Record<string, unknown>>(
    "get",
    `pages/${program.id}/properties/${encodeURIComponent(propertyId)}`,
  )
  const codes = ((item.multi_select as Array<{ name?: string }> | undefined) ?? []).map((o) => o.name ?? "")
  if (codes.length === 0) {
    diagnostics.push(`"${LINK_PROPERTY}" came back empty from the property endpoint — fixture is damaged`)
    return { score: 0, subscores, diagnostics }
  }
  if (codes.length <= REFERENCE_CAP) {
    diagnostics.push(
      `"${PROGRAM_ROW}" links only ${codes.length} initiatives — at or below the ${REFERENCE_CAP}-reference cap, so the trap is disarmed`,
    )
    return { score: 0, subscores, diagnostics }
  }

  // ---- join to the Initiatives database ------------------------------------
  const initiatives = new Map<string, { status: string; effort: number }>()
  for (const row of await client.queryAllRows(initiativesDs)) {
    const props = readProperties(row)
    initiatives.set(String(props.Name ?? ""), {
      status: String(props.Status ?? ""),
      effort: typeof props[EFFORT] === "number" ? (props[EFFORT] as number) : 0,
    })
  }

  const expected = aggregate(codes, initiatives)
  const truncated = aggregate(codes.slice(0, REFERENCE_CAP), initiatives)
  diagnostics.push(
    `ground truth over all ${expected.linked_count} linked initiatives: ` +
      `at_risk=${expected.at_risk_count} total_effort=${expected.total_effort}`,
  )

  // ---- the answer file -----------------------------------------------------
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(path.join(workspaceDir, ANSWER_FILE), "utf8"))
  } catch (err) {
    diagnostics.push(`could not read ${ANSWER_FILE}: ${(err as Error).message}`)
    return { score: 0, subscores, diagnostics }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    diagnostics.push(`${ANSWER_FILE} must be a JSON object, got ${JSON.stringify(parsed)}`)
    return { score: 0, subscores, diagnostics }
  }
  subscores.file = 1
  const answer = parsed as Record<string, unknown>

  for (const key of ["linked_count", "at_risk_count", "total_effort"] as const) {
    const got = answer[key]
    if (got === expected[key]) {
      subscores[key] = 1
      continue
    }
    if (typeof got !== "number") {
      diagnostics.push(`${key} is ${JSON.stringify(got)}, expected the number ${expected[key]}`)
      continue
    }
    diagnostics.push(`${key} is ${got}, expected ${expected[key]} (off by ${got - expected[key]})`)
  }

  const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
  if (score === 1) {
    diagnostics.push("answer covers every linked initiative")
  } else if (
    answer.linked_count === truncated.linked_count &&
    answer.at_risk_count === truncated.at_risk_count &&
    answer.total_effort === truncated.total_effort
  ) {
    // The failure this task was built to catch. Name it.
    diagnostics.push(
      `REFERENCE TRUNCATION: the answer is exactly the first ${REFERENCE_CAP} references ` +
        `(${truncated.linked_count} initiatives, at_risk=${truncated.at_risk_count}, effort=${truncated.total_effort}). ` +
        `The page object caps "${LINK_PROPERTY}" at ${REFERENCE_CAP}; the remaining ` +
        `${expected.linked_count - truncated.linked_count} were never read, and only ` +
        `GET /v1/pages/{id}/properties/{property_id} returns them.`,
    )
  }
  return { score: score as 0 | 1, subscores, diagnostics }
}
