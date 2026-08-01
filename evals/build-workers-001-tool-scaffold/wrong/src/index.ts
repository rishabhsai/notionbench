import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

// A plausible-but-wrong submission: the happy path is right and it typechecks,
// but nothing guards the empty list. `[]` yields mean = 0/0 = NaN and
// max = Math.max() = -Infinity.
worker.tool("summarize_stats", {
	title: "Summarize Stats",
	description: "Summarizes a list of numbers: count, mean, and max.",
	schema: j.object({
		values: j.array(j.number()).describe("The numbers to summarize."),
	}),
	outputSchema: j.object({
		count: j.number(),
		mean: j.number(),
		max: j.number(),
	}),
	execute: ({ values }) => {
		const total = values.reduce((sum, value) => sum + value, 0);
		return {
			count: values.length,
			mean: total / values.length,
			max: Math.max(...values),
		};
	},
});
