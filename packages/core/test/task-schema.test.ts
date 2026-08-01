import { describe, expect, it } from "vitest"
import {
  parseTaskId,
  parseTaskMeta,
  TaskMetaError,
  TaskMetaSchema,
  type TaskMetaInput,
} from "../src/task-schema.js"

const base: TaskMetaInput = {
  id: "build-nac-001-workspace-from-spec",
  suite: "benchmark",
  family: "nac",
  stage: "build",
  difficulty: "L3",
  verify: ["intents"],
}

describe("TaskMetaSchema", () => {
  it("applies defaults for optional dimensions", () => {
    const meta = parseTaskMeta(base)
    expect(meta.topics).toEqual([])
    expect(meta.runtime).toBe("offline")
    expect(meta.fixture).toBe("none")
    expect(meta.holdout).toBe(false)
    expect(meta.limits).toEqual({ time: 900, cost: 3 })
  })

  it("fills partial limits", () => {
    const meta = parseTaskMeta({ ...base, limits: { time: 600 } })
    expect(meta.limits).toEqual({ time: 600, cost: 3 })
  })

  it("rejects unknown frontmatter keys", () => {
    expect(() => parseTaskMeta({ ...base, familly: "nac" })).toThrow(TaskMetaError)
  })

  it("rejects unknown enum members", () => {
    expect(() => parseTaskMeta({ ...base, family: "database" })).toThrow(/family/)
    expect(() => parseTaskMeta({ ...base, difficulty: "L5" })).toThrow(/difficulty/)
    expect(() => parseTaskMeta({ ...base, verify: ["vibes"] })).toThrow(/verify/)
  })

  it("requires at least one verify layer", () => {
    expect(() => parseTaskMeta({ ...base, verify: [] })).toThrow(/verify/)
  })

  it("rejects malformed ids", () => {
    expect(() => parseTaskMeta({ ...base, id: "Build NAC 001" })).toThrow(/id/)
  })

  it("accepts the short family/slug id form", () => {
    const meta = parseTaskMeta({ ...base, id: "nac/idempotent-extend" })
    expect(meta.id).toBe("nac/idempotent-extend")
  })

  it("rejects an offline task with a live fixture or state verification", () => {
    expect(() => parseTaskMeta({ ...base, runtime: "offline", fixture: "live" })).toThrow(
      /live fixture/,
    )
    expect(() => parseTaskMeta({ ...base, runtime: "offline", verify: ["state"] })).toThrow(
      /state.*layer/,
    )
  })

  it("allows live tasks to use state verification", () => {
    const meta = parseTaskMeta({
      ...base,
      id: "build-cli-001-create-page-with-icon",
      family: "cli",
      runtime: "live",
      fixture: "rest",
      verify: ["state"],
    })
    expect(meta.verify).toEqual(["state"])
  })

  it("rejects an id whose stage prefix contradicts the stage field", () => {
    expect(() => parseTaskMeta({ ...base, stage: "resolve" })).toThrow(/declares stage/)
  })

  it("is exported as a plain zod schema too", () => {
    expect(TaskMetaSchema.safeParse(base).success).toBe(true)
  })
})

describe("parseTaskId", () => {
  it("parses the coverage-matrix convention", () => {
    expect(parseTaskId("resolve-nac-001-idempotent-extend")).toEqual({
      stage: "resolve",
      area: "nac",
      index: 1,
      slug: "idempotent-extend",
    })
  })

  it("returns undefined for other id shapes", () => {
    expect(parseTaskId("nac/idempotent-extend")).toBeUndefined()
    expect(parseTaskId("frobnicate-nac-001-x")).toBeUndefined()
  })
})
