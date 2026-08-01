/**
 * Plausibly-wrong solution for investigate-db-002 — *the* failure this task
 * exists to catch.
 *
 * It reads the program row and totals whatever references the page object hands
 * back. Against api.notion.com that is 25 of the 40, because a page read caps
 * multi-reference properties at 25 and reports the rest only through a
 * `has_more` flag nobody looked at. Three confident, wrong numbers.
 *
 * One wrinkle, and it is deliberate: `fake-notion.ts` does not model the cap, so
 * at QC time the page object carries all 40. This script therefore applies the
 * documented cap itself (`slice(0, 25)`), reproducing the *agent behaviour*
 * under test — trusting a truncated payload — so CI can prove the verifier
 * rejects it. See the fixture caveat in ../EVAL.ts. Must score 0.
 */
import { writeFile } from "node:fs/promises"
import { api, env, findDatabase, props, queryAll } from "../../_lib/live/oracle-fetch.mjs"

/** What the real API returns from a page read, and no more. */
const PAGE_REFERENCE_CAP = 25

const { rootId } = env()
const programs = await findDatabase(rootId, "Programs")
const initiatives = await findDatabase(rootId, "Initiatives")

const program = (await queryAll(programs.dataSourceId)).find(
  (row) => props(row).Name === "Platform Modernization",
)

const page = await api("get", `pages/${program.id}`)
const codes = page.properties["Linked Initiatives"].multi_select
  .slice(0, PAGE_REFERENCE_CAP)
  .map((option) => option.name)

const byName = new Map()
for (const row of await queryAll(initiatives.dataSourceId)) {
  const p = props(row)
  byName.set(p.Name, p)
}

const answer = { linked_count: codes.length, at_risk_count: 0, total_effort: 0 }
for (const code of codes) {
  const initiative = byName.get(code)
  if (!initiative) continue
  if (initiative.Status === "At risk") answer.at_risk_count++
  answer.total_effort += initiative["Effort (points)"] ?? 0
}

await writeFile("answer.json", `${JSON.stringify(answer, null, 2)}\n`, "utf8")
