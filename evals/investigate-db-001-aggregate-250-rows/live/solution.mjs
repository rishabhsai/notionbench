/**
 * Oracle for investigate-db-001. QC only — never visible to an agent, never run
 * during a benchmark trial. See the header of ../EVAL.ts for why the oracle
 * uses `fetch` while the agent under test uses the `ntn` CLI.
 *
 * The one thing that matters: follow `next_cursor` until `has_more` is false.
 */
import { writeFile } from "node:fs/promises"
import { env, findDatabase, props, queryAll } from "../../_lib/live/oracle-fetch.mjs"

const { rootId } = env()
const { dataSourceId } = await findDatabase(rootId, "Q3 Orders")

const rows = (await queryAll(dataSourceId)).map(props)

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
