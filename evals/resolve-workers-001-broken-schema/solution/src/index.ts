import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

worker.tool("split_name", {
	title: "Split Name",
	description: "Splits a person's full name into a first and a last name.",
	// Every property of a tool schema is required — there is no such thing as an
	// optional field here — so an argument nothing sends has to go.
	schema: j.object({
		full_name: j.string().describe("The person's full name."),
	}),
	outputSchema: j.object({
		first: j.string().describe("The first name, or an empty string."),
		last: j.string().describe("The last name, or an empty string."),
	}),
	execute: ({ full_name }) => {
		const parts = full_name.trim().split(/\s+/).filter((part) => part.length > 0);
		return {
			first: parts.length > 0 ? parts[0] : "",
			// One-word names have no last name; never hand back a hole.
			last: parts.length > 1 ? parts[parts.length - 1] : "",
		};
	},
});
