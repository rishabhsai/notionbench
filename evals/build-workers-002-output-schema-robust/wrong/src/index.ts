import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

// A plausible-but-wrong submission: nulls are handled, the schemas are right,
// and it typechecks — but "usable" is decided by truthiness. Whitespace-only
// strings sail through, a negative seat count is echoed back, and a real seat
// count of 0 is reported as missing.
worker.tool("normalize_contact", {
	title: "Normalize Contact",
	description: "Cleans up one scraped contact record.",
	schema: j.object({
		record: j
			.object({
				name: j.string().nullable(),
				email: j.string().nullable(),
				seats: j.number().nullable(),
			})
			.nullable(),
	}),
	outputSchema: j.object({
		display_name: j.string(),
		email: j.string(),
		seats: j.number(),
		missing: j.array(j.string()),
	}),
	execute: ({ record }) => {
		const name = record?.name ?? null;
		const email = record?.email ?? null;
		const seats = record?.seats ?? null;

		const missing: string[] = [];
		if (!name) missing.push("name");
		if (!email) missing.push("email");
		if (!seats) missing.push("seats");

		return {
			display_name: name ? name.trim() : "Unknown contact",
			email: email ? email.trim().toLowerCase() : "",
			seats: seats ?? 0,
			missing: missing.sort(),
		};
	},
});
