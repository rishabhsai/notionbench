/**
 * build-cli-001-create-page-with-icon — live state verification.
 *
 * Reads the fixture subtree back through the public API and asserts that
 * exactly one page named "Onboarding Checklist" exists, that it hangs off the
 * *Team Handbook* page (not the fixture root, not Archive), that its icon is the
 * 🧭 emoji, and that its body is the three unticked to-dos in order.
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
 * calls. They stand in for the *agent*, not for the CLI: what CI proves is that
 * this verifier returns 1 for a correct end state and 0 for a wrong one. The CLI
 * path itself is exercised by real runs.
 *
 * The verifier is the same code on both paths — it honors `NOTION_API_BASE` and
 * reads the workspace through the public API either way.
 */
import { blockText, isTrashed, pageIconEmoji, pageTitle } from "../_lib/live/notion.ts"
import { findPageByTitle, isChildOf, resolveLiveContext } from "../_lib/live/context.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const PAGE_TITLE = "Onboarding Checklist"
const PARENT_TITLE = "Team Handbook"
const ICON = "🧭"
const TODOS = ["Read the team handbook", "Set up the ntn CLI", "Book a 1:1 with your manager"]

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = { created: 0, parent: 0, icon: 0, body: 0 }

  const live = await resolveLiveContext({ workspaceDir, ctx })
  const { client, rootId } = live
  diagnostics.push(`api=${live.apiBase} root=${rootId} (${live.source.root})`)

  const found = await findPageByTitle(client, rootId, PAGE_TITLE)
  if (!found) {
    diagnostics.push(`no page titled "${PAGE_TITLE}" anywhere under the sandbox root`)
    return { score: 0, subscores, diagnostics }
  }
  const page = await client.getPage(found.id)
  if (isTrashed(page)) {
    diagnostics.push(`"${PAGE_TITLE}" exists but is in the trash`)
    return { score: 0, subscores, diagnostics }
  }
  subscores.created = 1
  diagnostics.push(`found "${pageTitle(page)}" (${page.id})`)

  // ---- parent --------------------------------------------------------------
  const handbook = live.idMap.handbook ?? (await findPageByTitle(client, rootId, PARENT_TITLE))?.id
  if (!handbook) {
    diagnostics.push(`the fixture's "${PARENT_TITLE}" page could not be located — fixture is damaged`)
    return { score: 0, subscores, diagnostics }
  }
  if (isChildOf(page, handbook)) {
    subscores.parent = 1
    diagnostics.push(`parented to "${PARENT_TITLE}"`)
  } else {
    const actualParentId = found.parentId
    let where = actualParentId
    try {
      where = `${pageTitle(await client.getPage(actualParentId))} (${actualParentId})`
    } catch {
      /* parent may be the root page itself; the id alone is enough */
    }
    diagnostics.push(`wrong parent: expected "${PARENT_TITLE}" (${handbook}), found ${where}`)
  }

  // ---- icon ----------------------------------------------------------------
  const emoji = pageIconEmoji(page)
  if (emoji === ICON) {
    subscores.icon = 1
    diagnostics.push(`icon is ${ICON}`)
  } else {
    diagnostics.push(
      `icon mismatch: expected the emoji ${ICON}, got ${emoji ? emoji : JSON.stringify(page.icon ?? null)}`,
    )
  }

  // ---- body ----------------------------------------------------------------
  const blocks = (await client.listAllBlockChildren(page.id)).filter((b) => !isTrashed(b))
  const todos = blocks.filter((b) => b.type === "to_do")
  const texts = todos.map(blockText)
  const checked = todos.map((b) => Boolean((b.to_do as { checked?: boolean })?.checked))

  const orderOk = texts.length === TODOS.length && TODOS.every((want, i) => texts[i] === want)
  const uncheckedOk = checked.every((c) => c === false)
  const onlyTodos = blocks.length === todos.length

  if (orderOk && uncheckedOk && onlyTodos) {
    subscores.body = 1
    diagnostics.push(`body is the three unticked to-dos, in order`)
  } else {
    if (!orderOk) {
      diagnostics.push(
        `to-do items mismatch — expected [${TODOS.join(" | ")}], got [${texts.join(" | ")}]`,
      )
    }
    if (!uncheckedOk) diagnostics.push(`some to-dos are ticked: ${JSON.stringify(checked)}`)
    if (!onlyTodos) {
      const extras = blocks.filter((b) => b.type !== "to_do").map((b) => b.type)
      diagnostics.push(`page has ${extras.length} non-to_do block(s): ${extras.join(", ")}`)
    }
  }

  const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
  return { score: score as 0 | 1, subscores, diagnostics }
}
