# AGENTS.md

This is a **Notion as Code** project. A Notion workspace is described in local
TypeScript; running the build compiles that description into a JSON *intent*
document that `ntn notion-as-code apply` later submits to Notion.

Notion as Code is experimental alpha.

## Directory map

- `src/main.ts` — the workspace description. This is the file you edit.
- `src/lib/notion.ts` — vendored stub runtime. `notion.*` calls record intents
  instead of hitting the API. **Do not edit.**
- `src/lib/types.d.ts` — vendored ambient types: every resource, property,
  view, filter, and helper the runtime accepts. This is the source of truth for
  what is expressible. **Do not edit.**
- `src/lib/entry.ts` — build entry point; runs `src/main.ts`, validates the
  recorded intents, and writes `dist/intents.json`. **Do not edit.**
- `src/lib/validate.ts` — vendored build-time validation. Rules `apply` enforces
  server-side, checked locally so a project that cannot be applied fails at
  build time. **Do not edit.**
- `dist/intents.json` — build output (gitignored).

## Commands

```bash
npm install        # once
npm run typecheck  # tsc --noEmit
npm run build      # typecheck, bundle, and write dist/intents.json
```

## Resource ids

Every resource carries a `resourceId` that you choose. It is the stable name
for that resource across runs: `apply` maps each `resourceId` to a real Notion
object and remembers the mapping in a session-state file. Cross-references
(parents, relation targets, rollup sources, view `groupBy`, formula `prop(...)`
tokens, relation property values) are all written in terms of `resourceId`s.

Changing the `resourceId` of a resource that has already been applied makes the
next `apply` treat it as a brand-new resource, so keep them stable once written.

## Notes

- Property values are set with the `notion.*` helpers (`notion.text`,
  `notion.select`, `notion.status`, `notion.date`, `notion.checkbox`,
  `notion.relation`, `notion.file`, ...).
- Page content is written in Notion-flavored Markdown; the full spec is in
  `src/lib/types.d.ts` (`NOTION_AS_CODE_MARKDOWN_SPEC`).
- A script may span multiple files under `src/`; the build bundles them.
