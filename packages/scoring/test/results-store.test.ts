import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import {
  RESULTS_FILENAME,
  appendResult,
  dedupeByCell,
  readResults,
  recordCellKey,
  resultsPath,
  type TrialRecord,
} from "../src/results-store.js"

const roots: string[] = []
let runDir: string

beforeEach(async () => {
  runDir = await mkdtemp(path.join(os.tmpdir(), "nb-results-"))
  roots.push(runDir)
})

afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
})

function record(patch: Partial<TrialRecord> = {}): TrialRecord {
  return {
    v: 1,
    runId: "20260731-120000",
    taskId: "build-nac-001-workspace-from-spec",
    family: "nac",
    stage: "build",
    configId: "claude-code-opus-5",
    docsCondition: "with",
    trial: 1,
    score: 1,
    scored: true,
    status: "completed",
    wallTimeMs: 1000,
    ...patch,
  }
}

describe("appendResult", () => {
  it("writes one JSON object per line and creates the run dir", async () => {
    const nested = path.join(runDir, "20260731-120000")
    await appendResult(nested, record())
    await appendResult(nested, record({ trial: 2, score: 0 }))
    const raw = await readFile(resultsPath(nested), "utf8")
    expect(raw.split("\n").filter(Boolean)).toHaveLength(2)
    expect(raw.endsWith("\n")).toBe(true)
    expect(JSON.parse(raw.split("\n")[1]!).trial).toBe(2)
  })

  it("names the file results.jsonl", () => {
    expect(path.basename(resultsPath(runDir))).toBe(RESULTS_FILENAME)
  })

  it("round-trips through readResults", async () => {
    await appendResult(runDir, record({ subscores: { build: 1 }, diagnostics: ["ok"] }))
    const { records, problems } = await readResults(runDir)
    expect(problems).toEqual([])
    expect(records).toHaveLength(1)
    expect(records[0]!.subscores).toEqual({ build: 1 })
    expect(records[0]!.diagnostics).toEqual(["ok"])
  })

  it("appends concurrently without interleaving lines", async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => appendResult(runDir, record({ trial: i + 1 }))),
    )
    const { records, problems } = await readResults(runDir)
    expect(problems).toEqual([])
    expect(records).toHaveLength(25)
    expect(new Set(records.map((r) => r.trial)).size).toBe(25)
  })
})

describe("readResults", () => {
  it("explains an absent file rather than throwing ENOENT", async () => {
    await expect(readResults(runDir)).rejects.toThrow(/has this run scored anything yet/)
  })

  it("survives a torn final line and keeps every complete record", async () => {
    await appendResult(runDir, record({ trial: 1 }))
    await appendResult(runDir, record({ trial: 2 }))
    await appendFile(resultsPath(runDir), '{"taskId":"half-writ', "utf8")
    const { records, problems } = await readResults(runDir)
    expect(records.map((r) => r.trial)).toEqual([1, 2])
    expect(problems).toHaveLength(1)
    expect(problems[0]!.line).toBe(3)
    expect(problems[0]!.reason).toMatch(/invalid JSON/)
  })

  it("ignores blank lines", async () => {
    await appendResult(runDir, record())
    await appendFile(resultsPath(runDir), "\n   \n", "utf8")
    const { records, problems } = await readResults(runDir)
    expect(records).toHaveLength(1)
    expect(problems).toEqual([])
  })

  it("rejects rows missing their coordinates", async () => {
    await appendFile(resultsPath(runDir), `${JSON.stringify({ taskId: "t", score: 1 })}\n`, "utf8")
    const { records, problems } = await readResults(runDir)
    expect(records).toEqual([])
    expect(problems[0]!.reason).toMatch(/configId/)
  })

  it("rejects an out-of-range score", async () => {
    await appendFile(resultsPath(runDir), `${JSON.stringify({ ...record(), score: 4 })}\n`, "utf8")
    const { problems } = await readResults(runDir)
    expect(problems[0]!.reason).toMatch(/score out of range/)
  })
})

describe("dedupeByCell", () => {
  it("keeps the last row per cell and leaves other cells alone", () => {
    const rows = [
      record({ trial: 1, score: 0, status: "timeout" }),
      record({ trial: 2, score: 1 }),
      record({ trial: 1, score: 1, status: "completed" }),
    ]
    const deduped = dedupeByCell(rows)
    expect(deduped).toHaveLength(2)
    expect(deduped.find((r) => r.trial === 1)!.status).toBe("completed")
  })

  it("treats docs conditions and configs as different cells", () => {
    const rows = [
      record({ docsCondition: "with" }),
      record({ docsCondition: "without" }),
      record({ configId: "codex-gpt-5.6-sol-high" }),
    ]
    expect(dedupeByCell(rows)).toHaveLength(3)
  })

  it("builds a stable cell key", () => {
    expect(recordCellKey(record())).toBe(
      "build-nac-001-workspace-from-spec::claude-code-opus-5::with::1",
    )
  })
})
