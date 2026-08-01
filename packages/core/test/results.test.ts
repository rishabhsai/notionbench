import { describe, expect, it } from "vitest"
import { isSolved, parseTrialResult, trialKey, type TrialResult } from "../src/results.js"

const raw = {
  taskId: "build-nac-001-workspace-from-spec",
  config: { id: "claude-code-opus-5", harness: "claude-code", model: "opus-5" },
  trial: 0,
  docsCondition: "provided",
  score: { total: 1, subscores: { static: 1, intents: 1 } },
  tokens: { input: 12000, output: 3400 },
  toolErrors: 2,
  wallTime: 91234,
  transcriptPath: "claude-code-opus-5/provided/build-nac-001/0.jsonl",
}

describe("TrialResultSchema", () => {
  it("parses a complete result", () => {
    const r = parseTrialResult(raw)
    expect(r.score.total).toBe(1)
    expect(r.tokens.input).toBe(12000)
  })

  it("defaults subscores to an empty map", () => {
    const r = parseTrialResult({ ...raw, score: { total: 0.5 } })
    expect(r.score.subscores).toEqual({})
  })

  it("rejects out-of-range scores and unknown docs conditions", () => {
    expect(() => parseTrialResult({ ...raw, score: { total: 1.5 } })).toThrow()
    expect(() => parseTrialResult({ ...raw, docsCondition: "partial" })).toThrow()
  })

  it("rejects unknown keys", () => {
    expect(() => parseTrialResult({ ...raw, cost: 1.2 })).toThrow()
  })

  it("treats an errored rollout as unsolved even with a score", () => {
    const r = parseTrialResult({ ...raw, error: "timeout" }) as TrialResult
    expect(isSolved(r)).toBe(false)
    expect(isSolved(parseTrialResult(raw))).toBe(true)
    expect(isSolved(parseTrialResult({ ...raw, score: { total: 0.75 } }), 0.5)).toBe(true)
  })

  it("builds a stable checkpoint key", () => {
    expect(trialKey(parseTrialResult(raw))).toBe(
      "claude-code-opus-5|provided|build-nac-001-workspace-from-spec|0",
    )
  })
})
