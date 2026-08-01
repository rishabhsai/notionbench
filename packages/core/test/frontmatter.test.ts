import { describe, expect, it } from "vitest"
import {
  FrontmatterError,
  parseFrontmatter,
  parsePromptFile,
} from "../src/frontmatter.js"
import { TaskMetaError } from "../src/task-schema.js"

const VALID = `---
id: build-nac-001-workspace-from-spec
suite: benchmark
family: nac
stage: build
topics: [resource-ids, idempotency]
difficulty: L3
runtime: offline
fixture: none
verify: [static, intents]
limits: {time: 900, cost: 3.0}
---

# Build a workspace

Do the thing.
`

describe("parseFrontmatter", () => {
  it("splits YAML frontmatter from the markdown body", () => {
    const { data, body } = parseFrontmatter(VALID)
    expect((data as Record<string, unknown>).id).toBe("build-nac-001-workspace-from-spec")
    expect(body.startsWith("# Build a workspace")).toBe(true)
  })

  it("handles CRLF line endings and a BOM", () => {
    const crlf = "﻿" + VALID.replace(/\n/g, "\r\n")
    const { data, body } = parseFrontmatter(crlf)
    expect((data as Record<string, unknown>).suite).toBe("benchmark")
    expect(body).toContain("Do the thing.")
    expect(body).not.toContain("\r")
  })

  it("accepts an empty frontmatter block", () => {
    const { data, body } = parseFrontmatter("---\n---\nbody\n")
    expect(data).toEqual({})
    expect(body).toBe("body\n")
  })

  it("rejects a file with no frontmatter", () => {
    expect(() => parseFrontmatter("# no frontmatter\n")).toThrow(FrontmatterError)
  })

  it("rejects a file whose frontmatter does not start on line 1", () => {
    expect(() => parseFrontmatter("\n---\nid: x\n---\n")).toThrow(/must start with/)
  })

  it("rejects an unterminated block", () => {
    expect(() => parseFrontmatter("---\nid: x\nbody\n")).toThrow(/unterminated/)
  })

  it("rejects invalid YAML", () => {
    expect(() => parseFrontmatter("---\nid: [unclosed\n---\nbody\n")).toThrow(/invalid YAML/)
  })

  it("rejects non-mapping frontmatter", () => {
    expect(() => parseFrontmatter("---\n- a\n- b\n---\nbody\n")).toThrow(/must be a YAML mapping/)
  })

  it("includes the source in the error message", () => {
    expect(() => parseFrontmatter("nope", "PROMPT.md")).toThrow(/^PROMPT\.md:/)
  })
})

describe("parsePromptFile", () => {
  it("returns validated metadata and the trimmed prompt", () => {
    const { meta, prompt, raw } = parsePromptFile(VALID)
    expect(meta.id).toBe("build-nac-001-workspace-from-spec")
    expect(meta.topics).toEqual(["resource-ids", "idempotency"])
    expect(meta.limits).toEqual({ time: 900, cost: 3.0 })
    expect(prompt).toBe("# Build a workspace\n\nDo the thing.")
    expect((raw as Record<string, unknown>).holdout).toBeUndefined()
  })

  it("rejects an empty body", () => {
    const src = VALID.slice(0, VALID.indexOf("# Build")) + "\n"
    expect(() => parsePromptFile(src)).toThrow(/prompt body is empty/)
  })

  it("propagates schema errors", () => {
    expect(() => parsePromptFile(VALID.replace("suite: benchmark", "suite: nope"))).toThrow(
      TaskMetaError,
    )
  })
})
