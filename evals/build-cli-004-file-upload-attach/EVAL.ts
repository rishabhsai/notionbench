/**
 * build-cli-004-file-upload-attach — an attachment is not a link.
 *
 * Getting a local file into a Notion property is three steps, not one:
 * `POST /v1/file_uploads` to reserve one, a `multipart/form-data` POST of the
 * bytes to the `upload_url` that came back, and only then a page update
 * carrying `{type: "file_upload", file_upload: {id}}`. Skip the middle step and
 * the attach is rejected; skip all three and paste a URL instead and the attach
 * *succeeds* — the row shows a file called `v2.4.0.md`, and nothing about the
 * property, the row or the database looks any different at a glance.
 *
 * The difference survives exactly one place: on read-back an uploaded file is
 * `type: "file"` with a Notion-hosted url, and a pasted one is
 * `type: "external"`. So this verifier checks the kind, and independently
 * confirms that a file upload of the right name and the right byte length
 * actually exists — the bytes have to have crossed the wire, not just the name.
 *
 * ── Why the QC path and the run path differ ────────────────────────────────
 * At RUN time the agent works in the trial workspace with the real `ntn` CLI,
 * authenticated by a leased token against api.notion.com. It never sees this
 * file, `fixture/spec.json`, or anything under `live/`.
 *
 * At QC time there is no Notion workspace. `evals/_lib/live/qc-live.ts` boots
 * the in-memory `fake-notion.ts` — which implements the three-step flow,
 * refuses to attach an upload whose bytes never arrived, and rewrites an
 * attached reference into the `{type: "file"}` shape reads hand back —
 * provisions `fixture/spec.json` against it, and points `NOTION_API_BASE` at
 * it. `ntn` cannot be redirected that way, so the oracle and the
 * plausibly-wrong solution under `live/` are plain Node scripts issuing `fetch`
 * calls; `live/wrong.mjs` is the external link. They stand in for the *agent*,
 * not for the CLI: what CI proves is that this verifier returns 1 for a real
 * upload and 0 for a link.
 *
 * The verifier is the same code on both paths — it honors `NOTION_API_BASE` and
 * reads the workspace through the public API either way.
 */
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { findDatabase, resolveLiveContext } from "../_lib/live/context.ts"
import { pageTitle, readFilesProperty, readProperties } from "../_lib/live/notion.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const DATABASE_TITLE = "Release Log"
const TARGET_ROW = "v2.4.0"
const FILENAME = "v2.4.0.md"
const SOURCE_FILE = path.join("release-notes", "v2.4.0.md")
const PROPERTY = "Assets"

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    attached: 0,
    uploaded_not_linked: 0,
    bytes_match: 0,
    others_untouched: 0,
  }

  const live = await resolveLiveContext({ workspaceDir, ctx })
  const { client, rootId } = live
  diagnostics.push(`api=${live.apiBase} root=${rootId} (${live.source.root})`)

  let sourceBytes: number
  try {
    sourceBytes = (await fs.readFile(path.join(workspaceDir, SOURCE_FILE))).byteLength
  } catch (err) {
    diagnostics.push(`the fixture's ${SOURCE_FILE} is missing: ${(err as Error).message}`)
    return { score: 0, subscores, diagnostics }
  }
  diagnostics.push(`${SOURCE_FILE} is ${sourceBytes} bytes`)

  const dataSourceId =
    live.idMap["releases.ds"] ?? (await findDatabase(client, rootId, DATABASE_TITLE))?.dataSourceId
  if (!dataSourceId) {
    diagnostics.push(`the fixture's "${DATABASE_TITLE}" database could not be located — fixture is damaged`)
    return { score: 0, subscores, diagnostics }
  }

  const rows = await client.queryAllRows(dataSourceId)
  const target = rows.find((row) => pageTitle(row) === TARGET_ROW)
  if (!target) {
    diagnostics.push(`no row titled "${TARGET_ROW}" in ${DATABASE_TITLE} — fixture is damaged`)
    return { score: 0, subscores, diagnostics }
  }

  // ---- the attachment ------------------------------------------------------
  const attachments = readFilesProperty(target.properties[PROPERTY])
  if (attachments.length !== 1) {
    diagnostics.push(
      `${TARGET_ROW}.${PROPERTY} holds ${attachments.length} attachment(s), expected exactly 1` +
        (attachments.length > 0 ? `: ${attachments.map((a) => `${a.name} (${a.kind})`).join(", ")}` : ""),
    )
  } else if (attachments[0].name !== FILENAME) {
    diagnostics.push(`the attachment is named "${attachments[0].name}", expected "${FILENAME}"`)
  } else {
    subscores.attached = 1
    diagnostics.push(`"${FILENAME}" is attached to ${TARGET_ROW}.${PROPERTY}`)
  }

  const attachment = attachments[0]
  if (attachment) {
    if (attachment.kind === "file") {
      subscores.uploaded_not_linked = 1
      diagnostics.push("the attachment is a Notion-hosted file")
    } else {
      // The failure this task was built to catch. Name it explicitly.
      diagnostics.push(
        `LINKED, NOT UPLOADED: the attachment is type "external" pointing at ${attachment.url}. ` +
          `The row displays a file either way, but nothing was ever sent to Notion — when this checkout ` +
          `goes away the row points at nothing. A real attachment needs POST /v1/file_uploads, the ` +
          `multipart send of the bytes, and only then the reference on the property.`,
      )
    }
  }

  // ---- the bytes really crossed the wire -----------------------------------
  let uploads: Array<{ filename: string | null; content_length: number | null; status: string }> = []
  try {
    uploads = await client.listAllFileUploads()
  } catch (err) {
    diagnostics.push(`could not list file uploads: ${(err as Error).message}`)
  }
  const match = uploads.find((u) => u.filename === FILENAME && u.status === "uploaded")
  if (!match) {
    diagnostics.push(
      `no completed file upload named "${FILENAME}" exists` +
        (uploads.length > 0
          ? ` (uploads present: ${uploads.map((u) => `${u.filename}:${u.status}`).join(", ")})`
          : " (there are no file uploads at all)"),
    )
  } else if (match.content_length !== sourceBytes) {
    diagnostics.push(
      `the uploaded "${FILENAME}" is ${String(match.content_length)} bytes; ${SOURCE_FILE} is ${sourceBytes}` +
        ` — the file that went up is not the file on disk`,
    )
  } else {
    subscores.bytes_match = 1
    diagnostics.push(`upload of "${FILENAME}" completed at ${sourceBytes} bytes`)
  }

  // ---- blast radius --------------------------------------------------------
  const others = rows.filter((row) => row !== target)
  const dirty = others.filter((row) => readFilesProperty(row.properties[PROPERTY]).length > 0)
  const targetProps = readProperties(target)
  const shippedOk = targetProps.Shipped === "2026-08-04" && targetProps.Status === "Shipped"
  if (dirty.length === 0 && shippedOk) {
    subscores.others_untouched = 1
    diagnostics.push(`the other ${others.length} release(s) still have no assets`)
  } else {
    if (dirty.length > 0) {
      diagnostics.push(`other rows also gained attachments: ${dirty.map(pageTitle).join(", ")}`)
    }
    if (!shippedOk) {
      diagnostics.push(
        `${TARGET_ROW}'s other properties changed: Shipped=${JSON.stringify(targetProps.Shipped)}, ` +
          `Status=${JSON.stringify(targetProps.Status)}`,
      )
    }
  }

  const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
  return { score: score as 0 | 1, subscores, diagnostics }
}
