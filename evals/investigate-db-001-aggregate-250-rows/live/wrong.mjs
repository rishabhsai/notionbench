/**
 * Plausibly-wrong solution for investigate-db-001 — *the* failure this task
 * exists to catch.
 *
 * One query, no cursor loop. The response carries `has_more: true` and it is
 * ignored, so the totals cover the first 100 of 250 orders. Nothing errors,
 * nothing warns, and the numbers look entirely reasonable. Must score 0.
 */
import { writeFile } from "node:fs/promises"
import { env, findDatabase, props, queryOnce } from "../../_lib/live/oracle-fetch.mjs"

const { rootId } = env()
const { dataSourceId } = await findDatabase(rootId, "Q3 Orders")

const page = await queryOnce(dataSourceId, {})
const rows = page.results.map(props)

const answer = {
  row_count: rows.length,
  total_amount: 0,
  paid_amount: 0,
  region_totals: { NA: 0, EU: 0, APAC: 0 },
}

for (const row of rows) {
  const amount = row.Amount ?? 0
  answer.total_amount += amount
  if (row.Status === "Paid") answer.paid_amount += amount
  if (row.Region in answer.region_totals) answer.region_totals[row.Region] += amount
}

await writeFile("answer.json", `${JSON.stringify(answer, null, 2)}\n`, "utf8")
