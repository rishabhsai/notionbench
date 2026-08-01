// Build entry: executes the user script (src/main.ts), validates the recorded
// intents, then writes them to dist/intents.json for
// `ntn notion-as-code apply`.
import { mkdirSync, writeFileSync } from "node:fs";
import "../main";
import { getIntents } from "./notion";
import { validateIntents } from "./validate";

const intents = getIntents();
validateIntents(intents);

mkdirSync("dist", { recursive: true });
writeFileSync("dist/intents.json", JSON.stringify(intents, null, 2));
