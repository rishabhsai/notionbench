import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import { requestQuote } from "./meridian.js";

const worker = new Worker();
export default worker;

/**
 * Read one piece of Meridian configuration from the environment.
 *
 * `.env` in the project root is loaded automatically by `ntn workers exec
 * --local`; the deployed worker reads the same names after `ntn workers env
 * push`. Nothing about Meridian is compiled into this file, so rotating the key
 * is a `.env` edit rather than a code change.
 */
function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(
			`${name} is not set. Add it to .env for local runs, then \`ntn workers env push\` before deploying.`,
		);
	}
	return value;
}

worker.tool("convert_amount", {
	title: "Convert Amount",
	description: "Converts a cash amount between currencies using a Meridian FX quote.",
	schema: j.object({
		from: j.string().describe("ISO 4217 code to convert from, e.g. USD."),
		to: j.string().describe("ISO 4217 code to convert to, e.g. EUR."),
		amount_cents: j.number().describe("Amount to convert, in minor units."),
	}),
	outputSchema: j.object({
		from: j.string(),
		to: j.string(),
		rate: j.number(),
		converted_cents: j.number(),
		quote_id: j.string(),
	}),
	execute: ({ from, to, amount_cents }) => {
		const quote = requestQuote(
			requireEnv("MERIDIAN_API_BASE"),
			requireEnv("MERIDIAN_API_KEY"),
			{ from, to, amount_cents },
		);
		if (quote.status !== 200) {
			throw new Error(`Meridian FX quote failed (${quote.status} ${quote.error}).`);
		}
		return {
			from,
			to,
			rate: quote.rate as number,
			converted_cents: quote.converted_cents as number,
			quote_id: quote.quote_id as string,
		};
	},
});
