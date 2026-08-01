/**
 * Task discovery.
 *
 * A task is a directory under `evals/` containing a `PROMPT.md` whose YAML
 * frontmatter follows docs/PLAN.md ("Task frontmatter format"). The task id is the
 * directory path relative to `evals/`, so `evals/nac/idempotent-extend/PROMPT.md`
 * has id `nac/idempotent-extend`.
 *
 * TODO(unify): the canonical loader (with full schema validation and verifier-module
 * wiring) belongs in `@notionbench/core`. This is the minimal, dependency-free
 * subset the runner needs to select and launch trials; swap it out when core lands.
 */

import type { Dirent } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { TaskSpec } from './types.js';

export const PROMPT_FILENAME = 'PROMPT.md';

/**
 * Translate a shell-ish glob to a RegExp.
 * Supports `**` (any depth, including none), `*` (within one segment), `?`, and
 * `{a,b}` alternation. Everything else is literal.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        // `**/` should also match zero segments.
        if (pattern[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    if (ch === '{') {
      const close = pattern.indexOf('}', i);
      if (close !== -1) {
        const alts = pattern
          .slice(i + 1, close)
          .split(',')
          .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        out += `(?:${alts.join('|')})`;
        i = close;
        continue;
      }
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}

export function matchesAny(id: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((p) => globToRegExp(p).test(id));
}

/**
 * Minimal YAML-frontmatter reader for the flat subset PLAN.md specifies:
 * scalars, inline lists `[a, b]`, and inline maps `{time: 900, cost: 3.0}`.
 * Block sequences/maps are deliberately unsupported — the format is fixed and a
 * silent misparse would be worse than a loud one, so unknown shapes stay strings.
 */
export function parseFrontmatter(text: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if (!match) return {};
  const body = match[1]!;
  const out: Record<string, unknown> = {};
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trimEnd();
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(rawLine)) continue; // nested block content: unsupported, skipped
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key.length === 0) continue;
    out[key] = parseScalar(value);
  }
  return out;
}

function parseScalar(value: string): unknown {
  if (value.length === 0) return '';
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return inner.split(',').map((v) => parseScalar(v.trim()));
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const inner = value.slice(1, -1).trim();
    const obj: Record<string, unknown> = {};
    if (inner.length === 0) return obj;
    for (const part of splitTopLevel(inner)) {
      const c = part.indexOf(':');
      if (c === -1) continue;
      obj[part.slice(0, c).trim()] = parseScalar(part.slice(c + 1).trim());
    }
    return obj;
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/** Split on commas that are not nested inside braces/brackets. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.filter((p) => p.trim().length > 0);
}

export function taskSpecFromFrontmatter(args: {
  dir: string;
  promptPath: string;
  fallbackId: string;
  frontmatter: Record<string, unknown>;
}): TaskSpec {
  const fm = args.frontmatter;
  const limits = typeof fm.limits === 'object' && fm.limits !== null ? (fm.limits as Record<string, unknown>) : {};
  const topics = Array.isArray(fm.topics) ? fm.topics.map(String) : undefined;
  const verify = Array.isArray(fm.verify) ? fm.verify.map(String) : undefined;
  return {
    id: typeof fm.id === 'string' && fm.id.length > 0 ? fm.id : args.fallbackId,
    dir: args.dir,
    promptPath: args.promptPath,
    suite: typeof fm.suite === 'string' ? (fm.suite as TaskSpec['suite']) : undefined,
    family: typeof fm.family === 'string' ? fm.family : undefined,
    stage: typeof fm.stage === 'string' ? (fm.stage as TaskSpec['stage']) : undefined,
    runtime: typeof fm.runtime === 'string' ? (fm.runtime as TaskSpec['runtime']) : undefined,
    difficulty: typeof fm.difficulty === 'string' ? fm.difficulty : undefined,
    topics,
    fixture: typeof fm.fixture === 'string' ? fm.fixture : undefined,
    verify,
    limits: {
      time: typeof limits.time === 'number' ? limits.time : undefined,
      cost: typeof limits.cost === 'number' ? limits.cost : undefined,
    },
  };
}

/** Read one task directory. Returns undefined if it has no PROMPT.md. */
export async function loadTask(dir: string, id: string): Promise<TaskSpec | undefined> {
  const promptPath = path.join(dir, PROMPT_FILENAME);
  let text: string;
  try {
    text = await readFile(promptPath, 'utf8');
  } catch {
    return undefined;
  }
  return taskSpecFromFrontmatter({
    dir,
    promptPath,
    fallbackId: id,
    frontmatter: parseFrontmatter(text),
  });
}

/** The prompt body with frontmatter stripped — this is what the agent receives. */
export function promptBody(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\s*\r?\n?/.exec(text);
  return (match ? text.slice(match[0].length) : text).trim();
}

export async function readPrompt(task: TaskSpec): Promise<string> {
  return promptBody(await readFile(task.promptPath, 'utf8'));
}

/** Recursively find every task under `evalsRoot` whose id matches one of `patterns`. */
export async function discoverTasks(evalsRoot: string, patterns: string[] = []): Promise<TaskSpec[]> {
  const root = path.resolve(evalsRoot);
  const found: TaskSpec[] = [];
  const seen = new Set<string>();

  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const hasPrompt = entries.some((e) => e.isFile() && e.name === PROMPT_FILENAME);
    if (hasPrompt) {
      const id = toPosix(path.relative(root, dir));
      const task = await loadTask(dir, id);
      if (task && !seen.has(task.id)) {
        seen.add(task.id);
        if (matchesAny(task.id, patterns) || matchesAny(id, patterns)) found.push(task);
      }
      // A task directory's fixtures may themselves contain markdown; don't recurse.
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      await walk(path.join(dir, e.name));
    }
  };

  try {
    const s = await stat(root);
    if (!s.isDirectory()) return [];
  } catch {
    return [];
  }
  await walk(root);
  found.sort((a, b) => a.id.localeCompare(b.id));
  return found;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
