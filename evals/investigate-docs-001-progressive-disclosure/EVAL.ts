/**
 * investigate-docs-001-progressive-disclosure — answer-file exact match.
 *
 * Every answer is one token the CLI prints in its own `--help` output and
 * nowhere else: `ntn --help` for the environment variables, `ntn whoami
 * --help`, `ntn workers runs list --help`, `ntn workers exec --help`,
 * `ntn api --help`, `ntn datasources --help` for the rest. That is the whole
 * point of the task — progressive disclosure beats recall on a CLI younger
 * than any model's training data — so the check is a literal comparison, with
 * only the normalization a fair grader owes: surrounding whitespace, case for
 * flags, and the `ntn ` prefix / placeholder argument on the command.
 *
 * No worker runs here, so there is nothing to install and nothing to exec.
 */
import { promises as fs } from "node:fs"
import * as path from "node:path"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

const ANSWER = "answer.json"

type Normalizer = (value: string) => string

const trimLower: Normalizer = (v) => v.trim().toLowerCase()
const trimUpper: Normalizer = (v) => v.trim().toUpperCase()
/** `ntn datasources resolve <database-id>` and `datasources resolve` are the same answer. */
const commandForm: Normalizer = (v) =>
  v
    .trim()
    .toLowerCase()
    .replace(/[<[][^>\]]*[>\]]/g, "")
    .replace(/^\$\s*/, "")
    .replace(/^ntn\s+/, "")
    .replace(/\s+/g, " ")
    .trim()

interface Field {
  key: string
  accepts: string[]
  normalize: Normalizer
}

const FIELDS: Field[] = [
  { key: "keyring_env_var", accepts: ["NOTION_KEYRING"], normalize: trimUpper },
  { key: "keyring_disable_value", accepts: ["0"], normalize: (v) => v.trim() },
  { key: "state_root_env_var", accepts: ["NOTION_HOME"], normalize: trimUpper },
  { key: "json_flag", accepts: ["--json"], normalize: trimLower },
  { key: "plain_flag", accepts: ["--plain"], normalize: trimLower },
  { key: "local_flag", accepts: ["--local", "-l"], normalize: trimLower },
  { key: "docs_flag", accepts: ["--docs"], normalize: trimLower },
  { key: "resolve_command", accepts: ["datasources resolve"], normalize: commandForm },
]

export default async function evaluate({ workspaceDir }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  const subscores: Record<string, number> = Object.fromEntries(FIELDS.map((f) => [f.key, 0]))

  let answer: Record<string, unknown>
  try {
    const raw = await fs.readFile(path.join(workspaceDir, ANSWER), "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      diagnostics.push(`${ANSWER} is not a JSON object`)
      return { score: 0, subscores, diagnostics }
    }
    answer = parsed as Record<string, unknown>
  } catch (err) {
    diagnostics.push(`could not read ${ANSWER}: ${err instanceof Error ? err.message : String(err)}`)
    return { score: 0, subscores, diagnostics }
  }

  for (const field of FIELDS) {
    const raw = answer[field.key]
    if (typeof raw !== "string" || raw.trim() === "") {
      diagnostics.push(`${field.key}: missing (${JSON.stringify(raw)})`)
      continue
    }
    const got = field.normalize(raw)
    const ok = field.accepts.some((accepted) => field.normalize(accepted) === got)
    if (ok) {
      subscores[field.key] = 1
      diagnostics.push(`${field.key}: ${JSON.stringify(raw)} ✓`)
    } else {
      diagnostics.push(`${field.key}: ${JSON.stringify(raw)} is not what the CLI calls it`)
    }
  }

  const score = Object.values(subscores).every((v) => v === 1) ? 1 : 0
  return { score: score as 0 | 1, subscores, diagnostics }
}
