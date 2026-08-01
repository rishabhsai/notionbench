import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

// A plausible-but-wrong submission: the dead argument is gone, so the
// InvalidToolInputError stops, and `last` is never missing any more, so the
// mononym crash stops too — but "last name" is still "the second word", which
// is only the last name when there are exactly two of them.
worker.tool("split_name", {
	title: "Split Name",
	description: "Splits a person's full name into a first and a last name.",
	schema: j.object({
		full_name: j.string().describe("The person's full name."),
	}),
	outputSchema: j.object({
		first: j.string(),
		last: j.string(),
	}),
	execute: ({ full_name }) => {
		const parts = full_name.trim().split(/\s+/);
		return {
			first: parts[0] ?? "",
			last: parts[1] ?? "",
		};
	},
});
