/**
 * investigate-users-001-bot-identity — a bot is a user, but not one of the users.
 *
 * Two endpoints answer two different questions. `GET /v1/users/me` returns the
 * *integration*: a user object of `type: "bot"` whose `bot.owner`,
 * `bot.workspace_name` and `bot.workspace_id` describe the connection.
 * `GET /v1/users` returns the workspace's membership, in which the bot is one
 * entry among the people. Both are lists of user objects with ids that look
 * identical, and an agent asked "who am I" that reaches for the membership list
 * lands on a human being.
 *
 * That confusion is the failure mode this grades, so the fixture keeps several
 * people in the workspace and the verifier says so by name when the reported
 * `bot_id` turns out to belong to one of them.
 *
 * Ground truth is read from the API at scoring time — no ids are hard-coded, so
 * pointing this at a different workspace changes the expected answer rather
 * than breaking the task.
 *
 * ── Why the QC path and the run path differ ────────────────────────────────
 * At RUN time the agent works in the trial workspace with the real `ntn` CLI,
 * authenticated by a leased token against api.notion.com. It never sees this
 * file, `fixture/spec.json`, or anything under `live/`.
 *
 * At QC time there is no Notion workspace. `evals/_lib/live/qc-live.ts` boots
 * the in-memory `fake-notion.ts` — which serves a bot from `users/me` and a
 * membership list containing that bot plus several people — provisions
 * `fixture/spec.json` against it, and points `NOTION_API_BASE` at it. `ntn`
 * cannot be redirected that way, so the oracle and the plausibly-wrong solution
 * under `live/` are plain Node scripts issuing `fetch` calls. They stand in for
 * the *agent*, not for the CLI: what CI proves is that this verifier returns 1
 * for the integration's own identity and 0 for a member's.
 *
 * The verifier is the same code on both paths — it honors `NOTION_API_BASE` and
 * reads the workspace through the public API either way.
 */
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { resolveLiveContext } from "../_lib/live/context.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const ANSWER_FILE = "answer.json"

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = {
    file: 0,
    bot_id: 0,
    bot_name: 0,
    owner_type: 0,
    workspace: 0,
    person_count: 0,
  }

  const live = await resolveLiveContext({ workspaceDir, ctx })
  const { client } = live
  diagnostics.push(`api=${live.apiBase} root=${live.rootId} (${live.source.root})`)

  // ---- ground truth --------------------------------------------------------
  const me = await client.me()
  const members = await client.listAllUsers()
  const people = members.filter((u) => u.type === "person")
  const expected = {
    bot_id: String(me.id),
    bot_name: String(me.name ?? ""),
    owner_type: String(me.bot?.owner?.type ?? ""),
    workspace_id: String(me.bot?.workspace_id ?? ""),
    workspace_name: String(me.bot?.workspace_name ?? ""),
    person_count: people.length,
  }
  diagnostics.push(
    `ground truth: bot ${expected.bot_id} "${expected.bot_name}" owned by ${expected.owner_type}, ` +
      `workspace "${expected.workspace_name}" (${expected.workspace_id}), ${expected.person_count} people`,
  )
  if (me.type !== "bot") {
    diagnostics.push(`users/me returned a ${String(me.type)}, not a bot — the token is not an integration`)
    return { score: 0, subscores, diagnostics }
  }
  if (people.length === 0) {
    diagnostics.push("the workspace has no people in it, so bot-vs-person cannot be confused — trap disarmed")
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

  const check = (subscore: string, key: keyof typeof expected): boolean => {
    if (answer[key] === expected[key]) {
      subscores[subscore] = 1
      return true
    }
    diagnostics.push(`${key} is ${JSON.stringify(answer[key])}, expected ${JSON.stringify(expected[key])}`)
    return false
  }

  const botIdOk = check("bot_id", "bot_id")
  check("bot_name", "bot_name")
  check("owner_type", "owner_type")
  check("person_count", "person_count")

  const workspaceIdOk = answer.workspace_id === expected.workspace_id
  const workspaceNameOk = answer.workspace_name === expected.workspace_name
  if (workspaceIdOk && workspaceNameOk) {
    subscores.workspace = 1
  } else {
    if (!workspaceIdOk) {
      diagnostics.push(
        `workspace_id is ${JSON.stringify(answer.workspace_id)}, expected ${JSON.stringify(expected.workspace_id)}`,
      )
    }
    if (!workspaceNameOk) {
      diagnostics.push(
        `workspace_name is ${JSON.stringify(answer.workspace_name)}, expected ${JSON.stringify(expected.workspace_name)}`,
      )
    }
  }

  if (!botIdOk) {
    // The failure this task was built to catch. Name it explicitly.
    const impostor = members.find((u) => u.id === answer.bot_id)
    if (impostor && impostor.type === "person") {
      diagnostics.push(
        `BOT vs PERSON: ${String(answer.bot_id)} is ${String(impostor.name)}, a human member of the workspace, ` +
          `not the integration. GET /v1/users lists everyone the token can see; the token's own identity only ` +
          `comes from GET /v1/users/me.`,
      )
    }
  }

  const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
  if (score === 1) diagnostics.push("integration identity and workspace recorded correctly")
  return { score: score as 0 | 1, subscores, diagnostics }
}
