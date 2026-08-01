#!/usr/bin/env node
// Dev-only mock of the runner's status endpoint, for exercising live mode:
//   node web/dev/mock-server.mjs [port] [token]
// then open  web/index.html#api=http://localhost:8377&key=<token>
// Serves ../data/results.live.json at /api/status with CORS + bearer auth.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.argv[2] || 8377);
const TOKEN = process.argv[3] || "abc";
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "results.live.json");

createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (new URL(req.url, "http://x").pathname !== "/api/status")
    return res.writeHead(404).end("not found");
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`)
    return res.writeHead(401).end("unauthorized");
  const body = JSON.parse(readFileSync(FIXTURE, "utf8"));
  body.generatedAt = new Date().toISOString(); // look alive on every poll
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}).listen(PORT, () => console.log(`mock status server → http://localhost:${PORT}/api/status (token: ${TOKEN})`));
