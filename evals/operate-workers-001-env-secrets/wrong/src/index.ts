import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import { requestQuote } from "./meridian.js";

const worker = new Worker();
export default worker;

// The plausible mistake: the placeholders were the bug, so the sandbox values
// went where the placeholders were. `convert_amount` now works perfectly — and
// the key is in the repo, in a file the template does not gitignore, where the
// next `git push` publishes it and rotating it means editing source.
const MERIDIAN_API_BASE = "https://sandbox.meridian-fx.test";
const MERIDIAN_API_KEY = "mfx_sandbox_7Qb3xR9tKw2ZmY6h";

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
		const quote = requestQuote(MERIDIAN_API_BASE, MERIDIAN_API_KEY, {
			from,
			to,
			amount_cents,
		});
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
