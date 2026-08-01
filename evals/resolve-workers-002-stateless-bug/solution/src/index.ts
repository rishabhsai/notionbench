import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

worker.tool("dedupe_emails", {
	title: "Dedupe Emails",
	description:
		"Normalizes a list of email addresses and returns the distinct ones, dropping repeats.",
	schema: j.object({
		addresses: j.array(j.string()).describe("The email addresses to deduplicate."),
	}),
	outputSchema: j.object({
		unique: j.array(j.string()).describe("The distinct addresses, in the order they first appear."),
		duplicates: j.number().describe("How many of the given addresses were repeats."),
		processed: j.number().describe("How many addresses this call was handed."),
	}),
	execute: ({ addresses }) => {
		// Everything here is per-invocation: a handler that remembers anything
		// between calls answers a different question the second time.
		const seen = new Set<string>();
		const unique: string[] = [];
		for (const raw of addresses) {
			const address = raw.trim().toLowerCase();
			if (seen.has(address)) continue;
			seen.add(address);
			unique.push(address);
		}
		return {
			unique,
			duplicates: addresses.length - unique.length,
			processed: addresses.length,
		};
	},
});
