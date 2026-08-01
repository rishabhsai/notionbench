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

worker.tool("summarize_stats", {
	title: "Summarize Stats",
	description: "Summarizes a list of numbers: how many there are, their mean, and the largest.",
	schema: j.object({
		values: j.array(j.number()).describe("The numbers to summarize."),
	}),
	outputSchema: j.object({
		count: j.number().describe("How many numbers were provided."),
		mean: j.number().describe("The arithmetic mean, or 0 when there are no numbers."),
		max: j.number().describe("The largest number, or 0 when there are no numbers."),
	}),
	execute: ({ values }) => {
		// An empty list has no mean and no maximum; report zeros rather than
		// letting NaN / -Infinity reach the model.
		if (values.length === 0) {
			return { count: 0, mean: 0, max: 0 };
		}
		const total = values.reduce((sum, value) => sum + value, 0);
		return {
			count: values.length,
			mean: total / values.length,
			max: values.reduce((largest, value) => (value > largest ? value : largest), values[0]),
		};
	},
});
