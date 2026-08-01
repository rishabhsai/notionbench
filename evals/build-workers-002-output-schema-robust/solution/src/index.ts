import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

// Example agent tool that returns a greeting
// Delete this when you're ready to start building your own tools.
worker.tool("sayHello", {
	title: "Say Hello",
	description: "Returns a friendly greeting for the given name.",
	schema: j.object({
		name: j.string().describe("The name to greet."),
	}),
	execute: ({ name }) => `Hello, ${name}!`,
});

worker.tool("normalize_contact", {
	title: "Normalize Contact",
	description:
		"Cleans up one scraped contact record and reports which of its fields were unusable.",
	// Every property of a tool schema is required, so "the agent has no value
	// for this" has to be spelled `null` — including for the record itself.
	schema: j.object({
		record: j
			.object({
				name: j.string().nullable().describe("The contact's name, or null."),
				email: j.string().nullable().describe("The contact's email address, or null."),
				seats: j.number().nullable().describe("How many seats the contact has, or null."),
			})
			.nullable()
			.describe("The scraped record, or null when nothing was found."),
	}),
	outputSchema: j.object({
		display_name: j.string().describe('The trimmed name, or "Unknown contact".'),
		email: j.string().describe("The trimmed, lower-cased email, or an empty string."),
		seats: j.number().describe("The seat count, or 0 when it was unusable."),
		missing: j
			.array(j.string())
			.describe("Which of name/email/seats were unusable, alphabetically."),
	}),
	execute: ({ record }) => {
		const missing: string[] = [];

		const rawName = record?.name ?? "";
		const name = rawName.trim();
		if (name === "") missing.push("name");

		const rawEmail = record?.email ?? "";
		const email = rawEmail.trim().toLowerCase();
		if (email === "") missing.push("email");

		// 0 is a real seat count, so this cannot be a truthiness test.
		const rawSeats = record?.seats;
		const seatsUsable = typeof rawSeats === "number" && Number.isFinite(rawSeats) && rawSeats >= 0;
		if (!seatsUsable) missing.push("seats");

		return {
			display_name: name === "" ? "Unknown contact" : name,
			email,
			seats: seatsUsable ? rawSeats : 0,
			missing: missing.sort(),
		};
	},
});
