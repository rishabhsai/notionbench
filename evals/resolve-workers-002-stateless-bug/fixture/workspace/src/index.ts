import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

/** Addresses we've already handed back, so we never emit one twice. */
const seenAddresses = new Set<string>();

/** Running tally, handy for the "how much did you look at" line in the answer. */
let processedCount = 0;

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
		processed: j.number().describe("How many addresses were looked at."),
	}),
	execute: ({ addresses }) => {
		const unique: string[] = [];
		for (const raw of addresses) {
			const address = raw.trim().toLowerCase();
			if (seenAddresses.has(address)) continue;
			seenAddresses.add(address);
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
