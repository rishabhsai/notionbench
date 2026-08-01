import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

// A plausible-but-wrong submission: the shared Set — the obvious culprit, and
// the one the bug report describes — is now per-call, so `unique` and
// `duplicates` are right every time. The other module-level variable is still
// there, quietly counting every address the process has ever seen.
let processedCount = 0;

worker.tool("dedupe_emails", {
	title: "Dedupe Emails",
	description:
		"Normalizes a list of email addresses and returns the distinct ones, dropping repeats.",
	schema: j.object({
		addresses: j.array(j.string()).describe("The email addresses to deduplicate."),
	}),
	outputSchema: j.object({
		unique: j.array(j.string()),
		duplicates: j.number(),
		processed: j.number(),
	}),
	execute: ({ addresses }) => {
		const seen = new Set<string>();
		const unique: string[] = [];
		for (const raw of addresses) {
			const address = raw.trim().toLowerCase();
			if (seen.has(address)) continue;
			seen.add(address);
			unique.push(address);
		}
		processedCount += addresses.length;
		return {
			unique,
			duplicates: addresses.length - unique.length,
			processed: processedCount,
		};
	},
});
