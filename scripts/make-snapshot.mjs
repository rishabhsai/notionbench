#!/usr/bin/env node
/**
 * Freeze a running `notionbench serve` into `web/data/results.json`.
 *
 * The site has two modes: with `#api=…` it polls a live run, and with no hash
 * it loads this file once. The published site is the second, so publishing means
 * turning today's live payload into a static one — the same schema, with the
 * run marked finished rather than in flight.
 *
 *   node scripts/make-snapshot.mjs --api <url> --key <token>
 *   node scripts/make-snapshot.mjs --api <url> --key <token> --out web/data/results.json
 *
 * Configs are marked `done` because publishing a snapshot asserts the run is
 * over; a row still labelled "running" on a static page is a lie that never
 * resolves. Any config that did not finish its trials keeps its real cell count,
 * so the table's own "fewer cells" markers still fire.
 */
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const api = arg("api")
const key = arg("key")
const out = path.resolve(ROOT, arg("out", "web/data/results.json"))
if (!api) {
  console.error("usage: make-snapshot.mjs --api <url> [--key <token>] [--out <file>]")
  process.exit(2)
}

const res = await fetch(`${api.replace(/\/$/, "")}/api/status`, {
  headers: key ? { Authorization: `Bearer ${key}` } : {},
})
if (!res.ok) {
  console.error(`GET /api/status → ${res.status}`)
  process.exit(1)
}
const data = await res.json()

data.mode = "final"
for (const c of data.configs ?? []) c.status = "done"
// Alerts are an operational artifact of the run, not something a reader of the
// published page can act on; doctor and the results tree keep the full record.
delete data.alerts
data.generatedAt = new Date().toISOString()

await fs.mkdir(path.dirname(out), { recursive: true })
await fs.writeFile(out, `${JSON.stringify(data)}\n`, "utf8")

const cells = (data.results ?? []).reduce((a, r) => a + (r.trials?.length ?? 0), 0)
console.log(
  `${path.relative(ROOT, out)} ← ${api}\n` +
    `   ${data.configs?.length ?? 0} configs · ${data.results?.length ?? 0} task rows · ` +
    `${cells} trials · ${(JSON.stringify(data).length / 1024).toFixed(0)} KB`,
)
