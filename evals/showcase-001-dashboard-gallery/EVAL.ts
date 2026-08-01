/**
 * showcase-001-dashboard-gallery — the exhibition placard. Always scores 1.
 *
 * This is not a scorer and must never behave like one. The gallery is judged by
 * people looking at screenshots; the job here is to produce the caption that
 * goes underneath one, from the workspace the agent actually built.
 *
 * Two kinds of number come out, and the split is deliberate:
 *
 *   - **subscores** are the requested-element checklist — one 0/1 per thing the
 *     prompt asked for out loud (a board view, a second database, written
 *     content, and so on). Objective, listed in the prompt, and *unscored*:
 *     `score` is 1 regardless of how many are 0. They exist so a placard can
 *     say "5 of 7 requested elements" without anyone having to count.
 *   - **counts** — pages, databases, views, blocks, rows — go into a single
 *     machine-readable `PLACARD {…}` diagnostic line rather than into
 *     subscores, because `packages/core`'s results schema constrains every
 *     subscore to [0, 1] and a workspace with 14 blocks is not a fraction.
 *     Parse that line; do not widen the schema for an exhibition.
 *
 * Failure is not a failure state. If there is no token, no root page, or the
 * workspace has been torn down already, the placard says so and the score is
 * still 1 — an exhibition entry that could not be measured is a missing
 * caption, not a lost run.
 */
import { resolveLiveContext } from "../_lib/live/context.ts"
import { isTrashed, pageIconEmoji, type NotionClient, type NotionView } from "../_lib/live/notion.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

interface Placard {
  pages: number
  databases: number
  data_sources: number
  rows: number
  /** Content blocks — child_page and child_database are structure, not content. */
  blocks: number
  views: number
  /** Views beyond the one each database is created with. */
  extra_views: number
  board_views: number
  view_types: string[]
  icons: number
  /** Deepest page nesting below the sandbox root; the root itself is 0. */
  max_depth: number
}

const EMPTY: Placard = {
  pages: 0,
  databases: 0,
  data_sources: 0,
  rows: 0,
  blocks: 0,
  views: 0,
  extra_views: 0,
  board_views: 0,
  view_types: [],
  icons: 0,
  max_depth: 0,
}

/** Walk everything the agent left under the sandbox root and count it. */
async function measure(client: NotionClient, rootId: string): Promise<Placard> {
  const placard: Placard = { ...EMPTY, view_types: [] }
  const types = new Set<string>()
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }]
  const seen = new Set<string>()

  while (queue.length > 0) {
    const { id, depth } = queue.shift() as { id: string; depth: number }
    if (seen.has(id) || depth > 8) continue
    seen.add(id)
    placard.max_depth = Math.max(placard.max_depth, depth)

    let blocks
    try {
      blocks = await client.listAllBlockChildren(id)
    } catch {
      continue
    }
    for (const block of blocks) {
      if (isTrashed(block)) continue

      if (block.type === "child_page") {
        placard.pages++
        try {
          if (pageIconEmoji(await client.getPage(block.id))) placard.icons++
        } catch {
          /* an icon we cannot read is not worth failing a placard over */
        }
        queue.push({ id: block.id, depth: depth + 1 })
        continue
      }

      if (block.type === "child_database") {
        placard.databases++
        let database
        try {
          database = await client.getDatabase(block.id)
        } catch {
          continue
        }
        if ((database.icon as { type?: string } | null)?.type === "emoji") placard.icons++
        for (const source of database.data_sources ?? []) {
          placard.data_sources++
          try {
            placard.rows += (await client.queryAllRows(source.id)).length
          } catch {
            /* a data source we cannot query still counts as a data source */
          }
        }
        let views: NotionView[] = []
        try {
          views = await client.listAllViewsFor({ database_id: database.id })
        } catch {
          /* pre-2026-03-11 deployments have no view endpoint; leave the count at 0 */
        }
        placard.views += views.length
        // Every database arrives with one view it did not ask for; anything
        // past that is a decision somebody made.
        placard.extra_views += Math.max(0, views.length - 1)
        for (const view of views) {
          types.add(String(view.type))
          if (view.type === "board") placard.board_views++
        }
        continue
      }

      placard.blocks++
    }
  }

  placard.view_types = [...types].sort()
  return placard
}

/** The elements the prompt names out loud. Reported, never enforced. */
function checklist(placard: Placard): Record<string, number> {
  return {
    home_page: placard.pages >= 1 ? 1 : 0,
    board_view: placard.board_views >= 1 ? 1 : 0,
    two_databases: placard.databases >= 2 ? 1 : 0,
    extra_views: placard.extra_views >= 1 ? 1 : 0,
    written_content: placard.blocks >= 10 ? 1 : 0,
    populated_rows: placard.rows >= 8 ? 1 : 0,
    icons: placard.icons >= 3 ? 1 : 0,
    nested_structure: placard.max_depth >= 2 ? 1 : 0,
  }
}

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []

  let placard = { ...EMPTY, view_types: [] as string[] }
  try {
    const live = await resolveLiveContext({ workspaceDir, ctx })
    diagnostics.push(`api=${live.apiBase} root=${live.rootId} (${live.source.root})`)
    placard = await measure(live.client, live.rootId)
  } catch (err) {
    diagnostics.push(
      `placard not measured: ${(err as Error).message} — the exhibition entry still stands, it just has no caption`,
    )
  }

  const checks = checklist(placard)
  const met = Object.values(checks).filter((v) => v === 1).length
  const total = Object.keys(checks).length

  diagnostics.push(`PLACARD ${JSON.stringify(placard)}`)
  diagnostics.push(
    `${placard.pages} page(s), ${placard.databases} database(s) with ${placard.rows} row(s), ` +
      `${placard.views} view(s) (${placard.view_types.join("/") || "none"}), ${placard.blocks} content block(s), ` +
      `nested ${placard.max_depth} deep`,
  )
  diagnostics.push(
    `requested elements: ${met}/${total} — ` +
      Object.entries(checks)
        .map(([name, ok]) => `${ok ? "✓" : "✗"} ${name}`)
        .join(", "),
  )
  diagnostics.push("exhibition entry: unscored by construction, judged by people")

  return { score: 1, subscores: checks, diagnostics }
}
