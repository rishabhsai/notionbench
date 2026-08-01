/**
 * operate-files-001-list-audit — two surfaces, one inventory.
 *
 * A storage audit cannot be done from one endpoint. Where the files *are* comes
 * from walking the block tree (file blocks on pages) and querying every
 * database under it (`files` properties on rows); how big they are comes from
 * `GET /v1/file_uploads`, because a file object on a property carries a name
 * and a url and no size at all. The answer is the join of the two.
 *
 * The failure this is built around is depth. A traversal that stops one level
 * short returns a well-formed inventory with a plausible total that is quietly
 * missing whatever was filed deepest — which, in every real workspace, is
 * exactly where the forgotten material lives.
 *
 * Grading is exact match against ground truth the verifier computes itself, by
 * walking the same tree to exhaustion. Nothing is hard-coded, so editing
 * `fixture/spec.json` cannot silently invalidate the expected answer.
 *
 * ── Why the QC path and the run path differ ────────────────────────────────
 * At RUN time the agent works in the trial workspace with the real `ntn` CLI,
 * authenticated by a leased token against api.notion.com. It never sees this
 * file, `fixture/spec.json`, or anything under `live/`.
 *
 * At QC time there is no Notion workspace. `evals/_lib/live/qc-live.ts` boots
 * the in-memory `fake-notion.ts`, provisions `fixture/spec.json` against it —
 * seeding the attachments through real two-step uploads, so their byte lengths
 * are real — and points `NOTION_API_BASE` at it. `ntn` cannot be redirected
 * that way, so the oracle and the plausibly-wrong solution under `live/` are
 * plain Node scripts issuing `fetch` calls; `live/wrong.mjs` is the shallow
 * walk. They stand in for the *agent*, not for the CLI: what CI proves is that
 * this verifier returns 1 for a complete inventory and 0 for one that stopped
 * short.
 *
 * The verifier is the same code on both paths — it honors `NOTION_API_BASE` and
 * reads the workspace through the public API either way.
 */
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { resolveLiveContext } from "../_lib/live/context.ts"
import {
  isTrashed,
  pageTitle,
  readFileBlock,
  readFilesProperty,
  type NotionClient,
} from "../_lib/live/notion.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const ANSWER_FILE = "answer.json"

interface AuditEntry {
  name: string
  size_bytes: number
  parent: string
}

/** Every attachment under `rootId`, on pages and on database rows alike. */
async function collectAttachments(
  client: NotionClient,
  rootId: string,
): Promise<Array<{ name: string; parent: string }>> {
  const found: Array<{ name: string; parent: string }> = []
  const queue: string[] = [rootId]
  const seen = new Set<string>()

  while (queue.length > 0) {
    const pageId = queue.shift() as string
    if (seen.has(pageId)) continue
    seen.add(pageId)

    let title = ""
    try {
      title = pageTitle(await client.getPage(pageId))
    } catch {
      continue
    }

    let blocks
    try {
      blocks = await client.listAllBlockChildren(pageId)
    } catch {
      continue
    }
    for (const block of blocks) {
      if (isTrashed(block)) continue
      if (block.type === "child_page") {
        queue.push(block.id)
        continue
      }
      if (block.type === "child_database") {
        const db = await client.getDatabase(block.id)
        for (const source of db.data_sources ?? []) {
          const rows = await client.queryAllRows(source.id)
          for (const row of rows) {
            const rowTitle = pageTitle(row)
            for (const value of Object.values(row.properties ?? {})) {
              if ((value as { type?: string })?.type !== "files") continue
              for (const file of readFilesProperty(value)) found.push({ name: file.name, parent: rowTitle })
            }
          }
        }
        continue
      }
      const attachment = readFileBlock(block)
      if (attachment) found.push({ name: attachment.name, parent: title })
    }
  }
  return found
}

function sortEntries(entries: AuditEntry[]): AuditEntry[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name, "en"))
}

function sameEntry(a: unknown, b: AuditEntry): boolean {
  if (a === null || typeof a !== "object" || Array.isArray(a)) return false
  const got = a as Record<string, unknown>
  return got.name === b.name && got.size_bytes === b.size_bytes && got.parent === b.parent
}

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = { file: 0, file_count: 0, total_bytes: 0, entries: 0, order: 0 }

  const live = await resolveLiveContext({ workspaceDir, ctx })
  const { client, rootId } = live
  diagnostics.push(`api=${live.apiBase} root=${rootId} (${live.source.root})`)

  // ---- ground truth: where the files are, joined with how big they are -----
  const attachments = await collectAttachments(client, rootId)
  const uploads = await client.listAllFileUploads()
  const sizes = new Map<string, number>()
  for (const upload of uploads) {
    if (upload.filename && typeof upload.content_length === "number") {
      sizes.set(upload.filename, upload.content_length)
    }
  }
  const unsized = attachments.filter((a) => !sizes.has(a.name))
  if (unsized.length > 0) {
    diagnostics.push(
      `no file upload record for ${unsized.map((a) => a.name).join(", ")} — the fixture is damaged, ` +
        `sizes cannot be established`,
    )
    return { score: 0, subscores, diagnostics }
  }

  const expected = sortEntries(
    attachments.map((a) => ({ name: a.name, size_bytes: sizes.get(a.name) as number, parent: a.parent })),
  )
  const expectedBytes = expected.reduce((sum, e) => sum + e.size_bytes, 0)
  diagnostics.push(
    `ground truth: ${expected.length} file(s), ${expectedBytes} bytes — ` +
      expected.map((e) => `${e.name} (${e.size_bytes}B, on "${e.parent}")`).join(", "),
  )
  if (expected.length < 2) {
    diagnostics.push(`fixture holds only ${expected.length} attachment(s); there is nothing to miss`)
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

  if (answer.file_count === expected.length) subscores.file_count = 1
  else diagnostics.push(`file_count is ${JSON.stringify(answer.file_count)}, expected ${expected.length}`)

  if (answer.total_bytes === expectedBytes) subscores.total_bytes = 1
  else diagnostics.push(`total_bytes is ${JSON.stringify(answer.total_bytes)}, expected ${expectedBytes}`)

  const files = answer.files
  if (!Array.isArray(files)) {
    diagnostics.push(`files is ${JSON.stringify(files)}, expected an array`)
    return { score: 0, subscores, diagnostics }
  }

  // Compare as a set first, so "missed one" and "got one wrong" read differently.
  const problems: string[] = []
  for (const want of expected) {
    const hit = files.find((got) => sameEntry(got, want))
    if (hit) continue
    const byName = files.find(
      (got) => (got as Record<string, unknown> | null)?.name === want.name,
    ) as Record<string, unknown> | undefined
    problems.push(
      byName
        ? `"${want.name}" is reported as ${JSON.stringify(byName.size_bytes)} bytes on ` +
          `${JSON.stringify(byName.parent)}, expected ${want.size_bytes} on "${want.parent}"`
        : `"${want.name}" (${want.size_bytes}B, on "${want.parent}") is missing from the inventory`,
    )
  }
  const expectedNames = new Set(expected.map((e) => e.name))
  for (const got of files) {
    const name = (got as Record<string, unknown> | null)?.name
    if (typeof name === "string" && !expectedNames.has(name)) {
      problems.push(`"${name}" is in the inventory but is not attached anywhere under the sandbox`)
    }
  }
  if (problems.length === 0) subscores.entries = 1
  else for (const problem of problems) diagnostics.push(problem)

  const names = files.map((f) => (f as Record<string, unknown> | null)?.name)
  const ordered = [...names].sort((a, b) => String(a).localeCompare(String(b), "en"))
  if (names.every((n, i) => n === ordered[i])) {
    subscores.order = 1
  } else {
    diagnostics.push(`files is not sorted by name: got [${names.join(", ")}]`)
  }

  const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
  if (score === 1) {
    diagnostics.push(`inventory matches all ${expected.length} attachments`)
  } else if (problems.length > 0 && problems.every((p) => p.endsWith("is missing from the inventory"))) {
    // The failure this task was built to catch. Name it explicitly.
    diagnostics.push(
      `INCOMPLETE TRAVERSAL: every reported file is correct and ${problems.length} ` +
        `${problems.length === 1 ? "more was" : "more were"} never found. ` +
        `Nothing errored — a walk that stops short just returns fewer rows, with a total that looks like a total.`,
    )
  }
  return { score: score as 0 | 1, subscores, diagnostics }
}
