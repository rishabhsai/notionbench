import { describe, expect, it } from "vitest"
import {
  aggregateTrials,
  avgAtK,
  combinations,
  passHatK,
  wilsonInterval,
} from "../src/stats.js"

describe("combinations", () => {
  it("matches hand-computed values", () => {
    expect(combinations(5, 0)).toBe(1)
    expect(combinations(5, 5)).toBe(1)
    expect(combinations(5, 2)).toBe(10)
    expect(combinations(10, 3)).toBe(120)
    expect(combinations(4, 2)).toBe(6)
    expect(combinations(3, 5)).toBe(0)
  })
})

describe("passHatK", () => {
  it("equals C(c,k)/C(n,k)", () => {
    // hand-computed: C(4,2)/C(5,2) = 6/10
    expect(passHatK(5, 4, 2)).toBeCloseTo(0.6, 12)
    // C(7,3)/C(10,3) = 35/120
    expect(passHatK(10, 7, 3)).toBeCloseTo(35 / 120, 12)
    // C(2,2)/C(4,2) = 1/6
    expect(passHatK(4, 2, 2)).toBeCloseTo(1 / 6, 12)
    // exhaustive cross-check against the binomial-coefficient definition
    for (let n = 1; n <= 12; n++) {
      for (let c = 0; c <= n; c++) {
        for (let k = 1; k <= n; k++) {
          expect(passHatK(n, c, k)).toBeCloseTo(combinations(c, k) / combinations(n, k), 12)
        }
      }
    }
  })

  it("is 1 when every trial passed and 0 when fewer than k passed", () => {
    expect(passHatK(5, 5, 5)).toBe(1)
    expect(passHatK(5, 0, 5)).toBe(0)
    expect(passHatK(5, 4, 5)).toBe(0)
    expect(passHatK(5, 1, 1)).toBeCloseTo(0.2, 12)
  })

  it("k=1 reduces to the empirical success rate (pass@1)", () => {
    expect(passHatK(5, 3, 1)).toBeCloseTo(0.6, 12)
    expect(passHatK(8, 5, 1)).toBeCloseTo(5 / 8, 12)
  })

  it("is monotonically non-increasing in k", () => {
    const values = [1, 2, 3, 4, 5].map((k) => passHatK(5, 4, k))
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeLessThanOrEqual(values[i - 1])
  })

  it("validates its arguments", () => {
    expect(() => passHatK(0, 0, 1)).toThrow(RangeError)
    expect(() => passHatK(5, 6, 2)).toThrow(/0 <= c <= n/)
    expect(() => passHatK(5, 3, 0)).toThrow(/1 <= k <= n/)
    expect(() => passHatK(5, 3, 6)).toThrow(/1 <= k <= n/)
    expect(() => passHatK(5.5, 3, 2)).toThrow(RangeError)
  })
})

describe("wilsonInterval", () => {
  it("matches published 95% intervals", () => {
    // 5/10 -> (0.2366, 0.7634)
    const half = wilsonInterval(5, 10)
    expect(half.low).toBeCloseTo(0.2366, 4)
    expect(half.high).toBeCloseTo(0.7634, 4)
    expect(half.center).toBeCloseTo(0.5, 10)
    // 0/10 -> (0, 0.2775)
    const none = wilsonInterval(0, 10)
    expect(none.low).toBe(0)
    expect(none.high).toBeCloseTo(0.2775, 4)
    // 10/10 -> (0.7225, 1)
    const all = wilsonInterval(10, 10)
    expect(all.low).toBeCloseTo(0.7225, 4)
    expect(all.high).toBe(1)
  })

  it("narrows as n grows", () => {
    const small = wilsonInterval(5, 10)
    const large = wilsonInterval(50, 100)
    expect(large.high - large.low).toBeLessThan(small.high - small.low)
  })

  it("widens with a larger z", () => {
    expect(wilsonInterval(5, 10, 2.576).high).toBeGreaterThan(wilsonInterval(5, 10, 1.96).high)
  })

  it("handles n = 0 and rejects impossible counts", () => {
    expect(wilsonInterval(0, 0)).toMatchObject({ low: 0, high: 1 })
    expect(() => wilsonInterval(3, 2)).toThrow(RangeError)
  })
})

describe("avgAtK", () => {
  it("averages the first k trials", () => {
    expect(avgAtK([1, 0, 1, 1, 0])).toBeCloseTo(0.6, 12)
    expect(avgAtK([1, 0, 1, 1, 0], 3)).toBeCloseTo(2 / 3, 12)
    expect(avgAtK([0.5, 0.5])).toBeCloseTo(0.5, 12)
  })

  it("validates k", () => {
    expect(() => avgAtK([1], 2)).toThrow(RangeError)
    expect(() => avgAtK([1], 0)).toThrow(RangeError)
  })
})

describe("aggregateTrials", () => {
  const entries = [
    { taskId: "build-nac-001", family: "nac", scores: [1, 1, 1, 1, 1] },
    { taskId: "build-nac-002", family: "nac", scores: [1, 0, 1, 0, 1] },
    { taskId: "build-workers-001", family: "workers", scores: [0, 0, 0, 0, 0] },
    { taskId: "resolve-workers-001", family: "workers", scores: [1, 1, 1, 1, 0] },
  ]

  it("computes overall avg@k, solve rate and pass^k", () => {
    const { overall } = aggregateTrials(entries)
    expect(overall.k).toBe(5)
    expect(overall.tasks).toBe(4)
    expect(overall.trials).toBe(20)
    expect(overall.solved).toBe(12)
    expect(overall.avgScore).toBeCloseTo((1 + 0.6 + 0 + 0.8) / 4, 12)
    expect(overall.solveRate).toBeCloseTo(12 / 20, 12)
    // pass^5 per task: 1, 0, 0, 0
    expect(overall.passHatK).toBeCloseTo(0.25, 12)
    expect(overall.ci.low).toBeLessThan(overall.solveRate)
    expect(overall.ci.high).toBeGreaterThan(overall.solveRate)
  })

  it("groups by family", () => {
    const { byFamily } = aggregateTrials(entries)
    expect(Object.keys(byFamily)).toEqual(["nac", "workers"])
    expect(byFamily.nac.avgScore).toBeCloseTo(0.8, 12)
    expect(byFamily.nac.passHatK).toBeCloseTo(0.5, 12)
    expect(byFamily.workers.avgScore).toBeCloseTo(0.4, 12)
    expect(byFamily.workers.passHatK).toBe(0)
  })

  it("honours an explicit k and reports per-task detail sorted by id", () => {
    const result = aggregateTrials(entries, { k: 3 })
    expect(result.overall.k).toBe(3)
    expect(result.overall.trials).toBe(12)
    expect(result.byTask.map((t) => t.taskId)).toEqual([
      "build-nac-001",
      "build-nac-002",
      "build-workers-001",
      "resolve-workers-001",
    ])
    // first 3 trials of resolve-workers-001 are all successes -> pass^3 = 1
    expect(result.byTask[3].passHatK).toBe(1)
  })

  it("supports partial credit via a threshold", () => {
    const partial = [{ taskId: "t", family: "nac", scores: [0.75, 0.75, 0.75] }]
    expect(aggregateTrials(partial).overall.solved).toBe(0)
    expect(aggregateTrials(partial, { threshold: 0.5 }).overall.solved).toBe(3)
    expect(aggregateTrials(partial, { threshold: 0.5 }).overall.passHatK).toBe(1)
  })

  it("defaults k to the smallest trial count", () => {
    const uneven = [
      { taskId: "a", family: "nac", scores: [1, 1, 1] },
      { taskId: "b", family: "nac", scores: [1, 0] },
    ]
    expect(aggregateTrials(uneven).overall.k).toBe(2)
  })

  it("rejects too few trials and out-of-range scores", () => {
    expect(() => aggregateTrials(entries, { k: 6 })).toThrow(/fewer than k/)
    expect(() =>
      aggregateTrials([{ taskId: "a", family: "nac", scores: [1.5] }]),
    ).toThrow(/out-of-range/)
  })

  it("handles an empty input", () => {
    const result = aggregateTrials([])
    expect(result.overall.tasks).toBe(0)
    expect(result.byFamily).toEqual({})
    expect(result.byTask).toEqual([])
  })
})
