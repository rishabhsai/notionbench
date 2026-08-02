#!/usr/bin/env node
/**
 * Publish a Markdown file as a Notion page, through Notion's own API.
 *
 * The writeup about the developer platform is published *with* the developer
 * platform: `POST /v1/pages` accepts Markdown directly, and
 * `PATCH /v1/pages/{id}/markdown` with `replace_content` swaps the whole body,
 * so re-publishing updates the same page rather than minting a new URL.
 *
 * Round-trip fidelity is better than the endpoint's reputation suggests —
 * verified against the real API before this script was written: GFM tables
 * become real Notion tables, fenced code keeps its language, nested lists,
 * blockquotes, links and inline formatting all survive.
 *
 *   node scripts/publish-post.mjs                 # publish/update docs/POST.md
 *   node scripts/publish-post.mjs --file X.md     # a different file
 *   node scripts/publish-post.mjs --new           # force a fresh page
 *   node scripts/publish-post.mjs --dry-run       # print what would be sent
 *
 * The page id is recorded in `docs/.notion-post.json` so the next publish is an
 * update. That file holds no secret — a page id is not a credential, and the
 * parent page id already lives in runconfig.json.
 *
 * The page is created under NOTION_PARENT_PAGE_ID, which is private to the
 * workspace. This script never shares a page publicly; that stays a deliberate
 * click in Notion.
 */
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const { NotionClient } = await import(
  pathToFileURL(path.join(ROOT, "evals/_lib/live/notion.ts")).href
)

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const file = path.resolve(ROOT, value("file", "docs/POST.md"))
const statePath = path.join(ROOT, "docs/.notion-post.json")

/**
 * Join hard-wrapped paragraph lines into one line each.
 *
 * The source is wrapped at 80 columns for reviewing diffs; Notion treats those
 * newlines as real line breaks, so the published page renders with ragged
 * 80-character breaks. Worse, a wrap inside an emphasis span breaks it — a
 * paragraph opening with `*Draft` and closing `written.*` on the next line
 * arrives as two literal asterisks, because neither line closes what it opened.
 *
 * Only prose is joined. Fenced code, tables, headings, list items, blockquote
 * markers and rules keep their own lines, since there the newline is the
 * meaning.
 */
function unwrapParagraphs(markdown) {
  const lines = markdown.split("\n")
  const out = []
  let fenced = false
  /** A line that must start a block of its own rather than continue prose. */
  const isBlockStart = (line) =>
    line.trim() === "" ||
    /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|---|===|\[\^)/.test(line) ||
    /^\s{4,}\S/.test(line)

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      out.push(line)
      continue
    }
    const previous = out[out.length - 1]
    const continuesProse =
      !fenced &&
      !isBlockStart(line) &&
      previous !== undefined &&
      !isBlockStart(previous) &&
      previous.trim() !== ""
    if (continuesProse) out[out.length - 1] = `${previous.replace(/\s+$/, "")} ${line.trim()}`
    else out.push(line)
  }
  return out.join("\n")
}

/**
 * Split the leading `# Title` off the body: Notion carries the title as a page
 * property, so leaving it in the Markdown renders it twice.
 */
function splitTitle(markdown, fallbackTitle) {
  const lines = markdown.split("\n")
  const i = lines.findIndex((l) => l.trim().length > 0)
  if (i >= 0 && /^#\s+/.test(lines[i])) {
    const title = lines[i].replace(/^#\s+/, "").trim()
    return { title, body: lines.slice(i + 1).join("\n").replace(/^\n+/, "") }
  }
  return { title: fallbackTitle, body: markdown }
}

const raw = await fs.readFile(file, "utf8")
const { title, body: wrapped } = splitTitle(raw, path.basename(file, ".md"))
const body = unwrapParagraphs(wrapped)

if (flag("dry-run")) {
  console.log(`title: ${title}`)
  console.log(`body:  ${body.length} chars, ${body.split("\n").length} lines`)
  console.log(`target: ${flag("new") ? "a new page" : "the recorded page, if any"}`)
  process.exit(0)
}

const token = process.env.NOTION_API_TOKEN
const parentPageId = process.env.NOTION_PARENT_PAGE_ID
if (!token) {
  console.error("NOTION_API_TOKEN is not set (see ~/.notionbench.env)")
  process.exit(2)
}
if (!parentPageId) {
  console.error("NOTION_PARENT_PAGE_ID is not set (see ~/.notionbench.env)")
  process.exit(2)
}

const client = new NotionClient({ token, apiBase: process.env.NOTION_API_BASE })

/** The page this file was last published to, if it still exists. */
async function recordedPage() {
  if (flag("new")) return undefined
  let state
  try {
    state = JSON.parse(await fs.readFile(statePath, "utf8"))
  } catch {
    return undefined
  }
  const entry = state[path.relative(ROOT, file)]
  if (!entry?.pageId) return undefined
  try {
    const page = await client.request("get", `pages/${entry.pageId}`)
    // A page in the trash is not somewhere to publish into.
    if (page.in_trash || page.archived) return undefined
    return entry.pageId
  } catch {
    return undefined
  }
}

const existing = await recordedPage()
let pageId
let url

if (existing) {
  await client.request("patch", `pages/${existing}/markdown`, {
    body: {
      type: "replace_content",
      // The post is prose; nothing beneath it should be a child page or
      // database, so allowing deletion here cannot take out anything else.
      replace_content: { new_str: body, allow_deleting_content: true },
    },
  })
  // Keep the title in step with the file's H1.
  const page = await client.request("patch", `pages/${existing}`, {
    body: { properties: { title: { title: [{ text: { content: title } }] } } },
  })
  pageId = existing
  url = page.url
  console.log(`updated: ${title}`)
} else {
  const page = await client.createPage({
    parent: { type: "page_id", page_id: parentPageId },
    properties: { title: [{ text: { content: title } }] },
    markdown: body,
  })
  pageId = page.id
  url = page.url
  console.log(`created: ${title}`)
}

let state = {}
try {
  state = JSON.parse(await fs.readFile(statePath, "utf8"))
} catch {
  // first publish
}
state[path.relative(ROOT, file)] = { pageId, url, publishedAt: new Date().toISOString() }
await fs.mkdir(path.dirname(statePath), { recursive: true })
await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8")

console.log(`   ${url}`)
console.log(`   re-run this command to update the same page`)
