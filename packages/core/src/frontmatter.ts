/**
 * PROMPT.md frontmatter parsing.
 *
 * A task prompt is a Markdown file that opens with a YAML frontmatter block:
 *
 * ```
 * ---
 * id: build-nac-001-workspace-from-spec
 * suite: benchmark
 * ---
 *
 * # Task body in Markdown
 * ```
 *
 * The parser is deliberately strict about the opening delimiter (it must be the
 * very first line, modulo a UTF-8 BOM) so that a missing frontmatter block is a
 * loud error rather than a silently empty metadata object.
 */
import { parse as parseYaml, YAMLParseError } from "yaml"
import { parseTaskMeta, type TaskMeta } from "./task-schema.js"

export class FrontmatterError extends Error {
  constructor(
    message: string,
    readonly source?: string,
  ) {
    super(source ? `${source}: ${message}` : message)
    this.name = "FrontmatterError"
  }
}

export interface FrontmatterResult {
  /** Raw YAML document value (usually a plain object). */
  data: unknown
  /** Markdown body with the frontmatter block and its trailing newline removed. */
  body: string
}

const DELIM = /^---[ \t]*$/

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Split a document into its YAML frontmatter and Markdown body.
 * Throws `FrontmatterError` when the block is missing, unterminated, or invalid
 * YAML.
 */
export function parseFrontmatter(text: string, source?: string): FrontmatterResult {
  const normalized = stripBom(text).replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")
  if (lines.length === 0 || !DELIM.test(lines[0])) {
    throw new FrontmatterError(
      "missing YAML frontmatter block (file must start with `---`)",
      source,
    )
  }
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (DELIM.test(lines[i])) {
      end = i
      break
    }
  }
  if (end === -1) {
    throw new FrontmatterError("unterminated YAML frontmatter block (no closing `---`)", source)
  }

  const yamlText = lines.slice(1, end).join("\n")
  const body = lines.slice(end + 1).join("\n")

  let data: unknown
  try {
    data = parseYaml(yamlText, { prettyErrors: false })
  } catch (err) {
    const detail = err instanceof YAMLParseError ? err.message : String(err)
    throw new FrontmatterError(`invalid YAML frontmatter: ${detail}`, source)
  }
  if (data === null || data === undefined) data = {}
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new FrontmatterError("frontmatter must be a YAML mapping", source)
  }

  return { data, body: stripLeadingBlankLines(body) }
}

function stripLeadingBlankLines(body: string): string {
  return body.replace(/^(?:[ \t]*\n)+/, "")
}

export interface ParsedPrompt {
  meta: TaskMeta
  /** Markdown instructions handed to the agent. */
  prompt: string
  /** Frontmatter exactly as written, before schema defaults were applied. */
  raw: unknown
}

/**
 * Parse a full PROMPT.md: frontmatter validated against the task schema, plus
 * the Markdown body. Throws `FrontmatterError` / `TaskMetaError`.
 */
export function parsePromptFile(text: string, source?: string): ParsedPrompt {
  const { data, body } = parseFrontmatter(text, source)
  const meta = parseTaskMeta(data, source)
  const prompt = body.trim()
  if (prompt.length === 0) {
    throw new FrontmatterError("prompt body is empty", source)
  }
  return { meta, prompt, raw: data }
}
