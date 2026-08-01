import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

worker.tool("split_name", {
	title: "Split Name",
	description: "Splits a person's full name into a first and a last name.",
	schema: j.object({
		full_name: j.string().describe("The person's full name."),
		keep_middle: j
			.boolean()
			.describe("Whether to keep middle names as part of the last name."),
	}),
	outputSchema: j.object({
		first: j.string().describe("The first name."),
		last: j.string().describe("The last name."),
	}),
	execute: ({ full_name, keep_middle }) => {
		const parts = full_name.split(" ");
		return {
			first: parts[0],
			last: keep_middle ? parts.slice(1).join(" ") : parts[1],
		};
	},
});
