import { describe, expect, it } from "vitest"
import {
  buildReport,
  compactNumber,
  duration,
  familyOf,
  mainTable,
  pct,
  renderReport,
  stageOf,
  usd,
} from "../src/report.js"
import type { TrialRecord } from "../src/results-store.js"

function record(patch: Partial<TrialRecord> = {}): TrialRecord {
  return {
    v: 1,
    runId: "20260731-120000",
    taskId: "build-nac-001-workspace-from-spec",
    family: "nac",
    configId: "claude-code-opus-5",
    configLabel: "Claude Code × Opus 5",
    docsCondition: "with",
    trial: 1,
    score: 1,
    scored: true,
    status: "completed",
    wallTimeMs: 60_000,
    toolCalls: 10,
    toolErrors: 1,
    tokens: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 1500,
      inputTokensIncludeCached: false,
    },
    apiEquivalentCostUsd: 0.02,
    ...patch,
  }
}

/** k trials of one task under one config, `solved` of them scoring 1. */
function cell(taskId: string, configId: string, k: number, solved: number, patch: Partial<TrialRecord> = {}) {
  return Array.from({ length: k }, (_, i) =>
    record({ taskId, configId, trial: i + 1, score: i < solved ? 1 : 0, ...patch }),
  )
}

describe("stageOf", () => {
  it("reads the stage from the task id prefix", () => {
    expect(stageOf({ taskId: "build-nac-001-x" })).toBe("build")
    expect(stageOf({ taskId: "investigate-db-002-y" })).toBe("investigate")
    expect(stageOf({ taskId: "resolve-workers-003-z" })).toBe("resolve")
    expect(stageOf({ taskId: "operate-files-001-w" })).toBe("operate")
  })

  it("falls back to the recorded frontmatter, then to 'other'", () => {
    expect(stageOf({ taskId: "weird-task", stage: "resolve" })).toBe("resolve")
    expect(stageOf({ taskId: "weird-task" })).toBe("other")
  })
})

describe("familyOf", () => {
  it("prefers the recorded family", () => {
    expect(familyOf({ taskId: "build-nac-001-x", family: "pages" })).toBe("pages")
  })

  it("otherwise reads the task id's second segment", () => {
    expect(familyOf({ taskId: "build-workers-001-x" })).toBe("workers")
    expect(familyOf({ taskId: "single" })).toBe("other")
  })
})

describe("buildReport", () => {
  it("picks k as the largest every cell supports", () => {
    const report = buildReport([
      ...cell("build-nac-001-a", "c1", 3, 3),
      ...cell("build-nac-002-b", "c1", 5, 5),
    ])
    expect(report.k).toBe(3)
  })

  it("treats a task's two docs conditions as two independent k-trial cells", () => {
    // The docs condition is part of a cell's coordinates. Keying on the task
    // alone would report k=6 over a mixture of the two conditions — and then
    // find no 6-trial cell anywhere in the per-docs breakdown.
    const report = buildReport([
      ...cell("build-nac-001-a", "c1", 3, 3, { docsCondition: "with" }),
      ...cell("build-nac-001-a", "c1", 3, 0, { docsCondition: "without" }),
    ])
    expect(report.k).toBe(3)
    expect(report.overall[0]!.tasks).toBe(1)
    expect(report.overall[0]!.cells).toBe(2)
    expect(report.overall[0]!.trials).toBe(6)
    expect(report.overall[0]!.avgScore).toBe(0.5)
    expect(report.byDocs!.rows.map((r) => [r.group, r.avgScore])).toEqual([
      ["with", 1],
      ["without", 0],
    ])
  })

  it("macro-averages avg@k over tasks and reports pass^k separately", () => {
    // One task always solved, one solved 2/3: avg = (1 + 2/3)/2, pass^3 = (1 + 0)/2.
    const report = buildReport([
      ...cell("build-nac-001-a", "c1", 3, 3),
      ...cell("build-nac-002-b", "c1", 3, 2),
    ])
    const row = report.overall[0]!
    expect(row.avgScore).toBeCloseTo((1 + 2 / 3) / 2, 10)
    expect(row.passHatK).toBeCloseTo(0.5, 10)
    expect(row.solved).toBe(5)
    expect(row.trials).toBe(6)
  })

  it("puts a Wilson interval around the solve rate", () => {
    const report = buildReport(cell("build-nac-001-a", "c1", 3, 2))
    const { ci } = report.overall[0]!
    expect(ci.point).toBeCloseTo(2 / 3, 10)
    expect(ci.low).toBeLessThan(ci.point)
    expect(ci.high).toBeGreaterThan(ci.point)
  })

  it("counts an unverifiable trial as 0 and reports it apart", () => {
    const report = buildReport([
      ...cell("build-nac-001-a", "c1", 2, 2),
      record({ taskId: "build-nac-002-b", configId: "c1", trial: 1, score: 1, scored: true }),
      record({
        taskId: "build-nac-002-b",
        configId: "c1",
        trial: 2,
        score: 0,
        scored: false,
        scoreError: "boom",
      }),
    ])
    expect(report.unscored).toBe(1)
    expect(report.overall[0]!.unscored).toBe(1)
    expect(report.overall[0]!.avgScore).toBeCloseTo((1 + 0.5) / 2, 10)
    expect(report.notes.join(" ")).toMatch(/could not be verified/)
  })

  it("drops cells with fewer than k trials and names them", () => {
    const report = buildReport(
      [...cell("build-nac-001-a", "c1", 3, 3), ...cell("build-nac-002-b", "c1", 1, 1)],
      { k: 3 },
    )
    expect(report.overall[0]!.tasks).toBe(1)
    expect(report.overall[0]!.droppedTasks).toEqual(["build-nac-002-b@docs-with"])
  })

  it("de-duplicates a replayed cell, keeping the last row", () => {
    const report = buildReport([
      record({ trial: 1, score: 0, scored: false }),
      record({ trial: 1, score: 1, scored: true }),
    ])
    expect(report.records).toBe(1)
    expect(report.overall[0]!.avgScore).toBe(1)
  })

  it("can keep replays when asked", () => {
    const report = buildReport(
      [record({ trial: 1, score: 0 }), record({ trial: 1, score: 1 })],
      { keepReplays: true },
    )
    expect(report.records).toBe(2)
  })

  it("sums tool errors, tokens, cost and wall time over counted trials only", () => {
    const report = buildReport(cell("build-nac-001-a", "c1", 3, 3))
    const row = report.overall[0]!
    expect(row.toolErrors).toBe(3)
    expect(row.toolCalls).toBe(30)
    expect(row.totalTokens).toBe(4500)
    expect(row.meanTokens).toBe(1500)
    expect(row.costUsd).toBeCloseTo(0.06, 10)
    expect(row.costKnown).toBe(true)
    expect(row.meanWallMs).toBe(60_000)
  })

  it("marks cost unknown when no config published prices", () => {
    const report = buildReport(cell("build-nac-001-a", "c1", 2, 2, { apiEquivalentCostUsd: undefined }))
    expect(report.overall[0]!.costKnown).toBe(false)
  })

  it("emits one row per config, sorted by id", () => {
    const report = buildReport([
      ...cell("build-nac-001-a", "zeta", 2, 1),
      ...cell("build-nac-001-a", "alpha", 2, 2),
    ])
    expect(report.overall.map((r) => r.configId)).toEqual(["alpha", "zeta"])
  })

  it("breaks down by family", () => {
    const report = buildReport([
      ...cell("build-nac-001-a", "c1", 2, 2, { family: "nac" }),
      ...cell("build-workers-001-b", "c1", 2, 0, { family: "workers" }),
    ])
    expect(report.byFamily.groups).toEqual(["nac", "workers"])
    expect(report.byFamily.rows.map((r) => [r.group, r.avgScore])).toEqual([
      ["nac", 1],
      ["workers", 0],
    ])
  })

  it("breaks down by stage in coverage-matrix order, from the task id", () => {
    const report = buildReport([
      ...cell("resolve-nac-001-a", "c1", 2, 1, { family: "nac", stage: undefined }),
      ...cell("build-nac-002-b", "c1", 2, 2, { family: "nac", stage: undefined }),
    ])
    expect(report.byStage.groups).toEqual(["build", "resolve"])
  })

  it("adds a docs breakdown only when both conditions are present", () => {
    const oneSided = buildReport(cell("build-nac-001-a", "c1", 2, 2))
    expect(oneSided.byDocs).toBeUndefined()

    const both = buildReport([
      ...cell("build-nac-001-a", "c1", 2, 2, { docsCondition: "with" }),
      ...cell("build-nac-001-a", "c1", 2, 0, { docsCondition: "without" }),
    ])
    expect(both.byDocs?.groups).toEqual(["with", "without"])
  })

  it("handles an empty result set without dividing by zero", () => {
    const report = buildReport([])
    expect(report.overall).toEqual([])
    expect(report.tasks).toBe(0)
    expect(renderReport(report)).toContain("NotionBench results")
  })
})

describe("renderReport", () => {
  const report = buildReport(
    [
      ...cell("build-nac-001-a", "claude-code-opus-5", 3, 3),
      ...cell("build-workers-001-b", "claude-code-opus-5", 3, 1, { family: "workers" }),
    ],
    { runId: "20260731-120000", generatedAt: new Date("2026-07-31T12:00:00Z") },
  )

  it("renders the README-style config table", () => {
    const md = mainTable(report)
    expect(md).toContain("| Config | avg@3 (95% CI) | pass^3 | Tool errors | Tokens/trial | API-equiv cost | Wall time/trial |")
    expect(md).toContain("Claude Code × Opus 5")
    expect(md).toContain("$0.12")
    expect(md).toContain("1.5k")
    expect(md).toContain("1m00s")
  })

  it("includes the run id, the axes, and every breakdown", () => {
    const md = renderReport(report)
    expect(md).toContain("run `20260731-120000`")
    expect(md).toContain("2 task(s) × 1 config(s) · k=3")
    expect(md).toContain("## By product area")
    expect(md).toContain("## By stage")
    expect(md).toMatch(/\|\s*nac\s*\|/)
    expect(md).toMatch(/\|\s*build\s*\|/)
  })

  it("names cells excluded for having too few trials", () => {
    const partial = buildReport(
      [...cell("build-nac-001-a", "c1", 3, 3), ...cell("build-nac-002-b", "c1", 1, 0)],
      { k: 3 },
    )
    expect(renderReport(partial)).toContain(
      "Cells excluded for having fewer than k=3 trials: build-nac-002-b@docs-with",
    )
  })
})

describe("formatting", () => {
  it("formats percentages, money, counts and durations", () => {
    expect(pct(0.6666)).toBe("66.7%")
    expect(usd(0)).toBe("$0.00")
    expect(usd(0.0004)).toBe("$0.0004")
    expect(usd(12.345)).toBe("$12.35")
    expect(compactNumber(0)).toBe("0")
    expect(compactNumber(950)).toBe("950")
    expect(compactNumber(41_200)).toBe("41.2k")
    expect(compactNumber(2_400_000)).toBe("2.4M")
    expect(duration(0)).toBe("0s")
    expect(duration(45_000)).toBe("45s")
    expect(duration(192_000)).toBe("3m12s")
    expect(duration(7_320_000)).toBe("2h02m")
  })
})
