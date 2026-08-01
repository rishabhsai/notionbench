/**
 * investigate-search-001-find-across-workspace — an audit that only comes out
 * right if you look everywhere.
 *
 * The fixture scatters six runbooks across three sections at four different
 * depths, and puts one of the un-owned ones three levels down inside another
 * runbook. A one-level listing of the sandbox root finds nothing; a two-level
 * one finds half. `POST /v1/search` is the endpoint that makes depth irrelevant
 * — but search only matches titles, so the `Owner:` test still needs a read of
 * every candidate page. Two hops, and both have to be complete.
 *
 * Ground truth is recomputed here by walking the fixture subtree to exhaustion
 * and reading each matching page, so nothing is hard-coded and re-shaping the
 * fixture cannot invalidate the expected answer. The verifier also refuses to
 * grade a fixture whose deepest match has floated up to the surface: if no
 * runbook sits at least three levels below the root, the trap is gone and the
 * task is not worth a point.
 *
 * ── Why the QC path and the run path differ ────────────────────────────────
 * At RUN time the agent works in the trial workspace with the real `ntn` CLI,
 * authenticated by a leased token against api.notion.com. It never sees this
 * file, `fixture/spec.json`, or anything under `live/`.
 *
 * At QC time there is no Notion workspace. `evals/_lib/live/qc-live.ts` boots
 * the in-memory `fake-notion.ts` — whose `POST /v1/search` matches titles and
 * paginates the same way — provisions `fixture/spec.json` against it, and points
 * `NOTION_API_BASE` at it. `ntn` cannot be redirected that way, so the oracle
 * and the plausibly-wrong solution under `live/` are plain Node scripts issuing
 * `fetch` calls; `live/wrong.mjs` is the shallow walk. They stand in for the
 * *agent*, not for the CLI: what CI proves is that this verifier returns 1 for a
 * complete audit and 0 for one that stopped short.
 *
 * The verifier is the same code on both paths — it honors `NOTION_API_BASE` and
 * reads the workspace through the public API either way.
 */
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { blockText, isTrashed } from "../_lib/live/notion.ts"
import { resolveLiveContext } from "../_lib/live/context.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const MATCH = "Runbook"
const OWNER_PREFIX = "Owner:"
const ANSWER_FILE = "answer.json"

/** The fixture must keep at least one match this far below the root. */
const MIN_TRAP_DEPTH = 3

interface Runbook {
  id: string
  title: string
  depth: number
  hasOwner: boolean
}

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = { file: 0, runbooks_total: 0, missing_owner: 0 }

  const live = await resolveLiveContext({ workspaceDir, ctx })
  const { client, rootId } = live
  diagnostics.push(`api=${live.apiBase} root=${rootId} (${live.source.root})`)

  // ---- ground truth: every page under the root, at any depth ---------------
  const runbooks: Runbook[] = []
  const seen = new Set<string>()
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }]

  while (queue.length > 0) {
    const { id, depth } = queue.shift() as { id: string; depth: number }
    if (seen.has(id)) continue
    seen.add(id)

    let blocks
    try {
      blocks = await client.listAllBlockChildren(id)
    } catch (err) {
      diagnostics.push(`could not list children of ${id}: ${(err as Error).message}`)
      continue
    }

    for (const block of blocks) {
      if (block.type !== "child_page" || isTrashed(block)) continue
      const title = (block.child_page as { title?: string })?.title ?? ""
      queue.push({ id: block.id, depth: depth + 1 })
      if (!title.includes(MATCH)) continue

      const body = await client.listAllBlockChildren(block.id)
      const hasOwner = body
        .filter((b) => !isTrashed(b))
        .some((b) => blockText(b).trimStart().startsWith(OWNER_PREFIX))
      runbooks.push({ id: block.id, title, depth: depth + 1, hasOwner })
    }
  }

  if (runbooks.length === 0) {
    diagnostics.push(`no page under the sandbox root has "${MATCH}" in its title — fixture is damaged`)
    return { score: 0, subscores, diagnostics }
  }
  const deepest = Math.max(...runbooks.map((r) => r.depth))
  diagnostics.push(
    `ground truth: ${runbooks.length} runbook(s) at depths ${[...new Set(runbooks.map((r) => r.depth))].sort().join(", ")} ` +
      `(deepest ${deepest} levels below the root)`,
  )
  if (deepest < MIN_TRAP_DEPTH) {
    diagnostics.push(
      `every runbook sits within ${deepest} level(s) of the root — a shallow listing would find them all, so the trap is disarmed`,
    )
    return { score: 0, subscores, diagnostics }
  }

  const expectedTotal = runbooks.length
  const expectedMissing = runbooks
    .filter((r) => !r.hasOwner)
    .map((r) => r.title)
    .sort((a, b) => a.localeCompare(b, "en"))
  diagnostics.push(`ground truth: ${expectedMissing.length} without an "${OWNER_PREFIX}" line — ${expectedMissing.join(", ")}`)
  if (expectedMissing.length === 0) {
    diagnostics.push("fixture leaves no un-owned runbook — the answer would be trivially empty")
    return { score: 0, subscores, diagnostics }
  }

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

  if (answer.runbooks_total === expectedTotal) {
    subscores.runbooks_total = 1
  } else {
    diagnostics.push(
      `runbooks_total is ${JSON.stringify(answer.runbooks_total)}, expected ${expectedTotal}`,
    )
  }

  const missing = answer.missing_owner
  if (!Array.isArray(missing)) {
    diagnostics.push(`missing_owner is ${JSON.stringify(missing)}, expected an array of page titles`)
  } else {
    const got = missing.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
    const exact = got.length === expectedMissing.length && expectedMissing.every((t, i) => got[i] === t)
    if (exact) {
      subscores.missing_owner = 1
      diagnostics.push(`missing_owner matches, in alphabetical order: ${got.join(", ")}`)
    } else {
      const absent = expectedMissing.filter((t) => !got.includes(t))
      const extra = got.filter((t) => !expectedMissing.includes(t))
      if (absent.length > 0) diagnostics.push(`missing_owner is short of: ${absent.join(", ")}`)
      if (extra.length > 0) diagnostics.push(`missing_owner names pages that do have an owner: ${extra.join(", ")}`)
      if (absent.length === 0 && extra.length === 0) {
        diagnostics.push(`missing_owner has the right titles but not in alphabetical order: ${got.join(", ")}`)
      }
    }

    // The failure this task is built around, named when it is what happened.
    const shallow = runbooks.filter((r) => r.depth < MIN_TRAP_DEPTH)
    const missedDeep = runbooks.filter((r) => r.depth >= MIN_TRAP_DEPTH && !r.hasOwner && !got.includes(r.title))
    if (missedDeep.length > 0 && answer.runbooks_total === shallow.length) {
      diagnostics.push(
        `INCOMPLETE TRAVERSAL: the answer covers exactly the ${shallow.length} runbook(s) within ` +
          `${MIN_TRAP_DEPTH - 1} level(s) of the root. Nested deeper and never visited: ` +
          `${missedDeep.map((r) => `${r.title} (depth ${r.depth})`).join(", ")}.`,
      )
    }
  }

  const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
  return { score: score as 0 | 1, subscores, diagnostics }
}
