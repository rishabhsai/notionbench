import { createHash } from "node:crypto";
import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

/**
 * Short, stable fingerprint of a receipt. Finance reconciles against the same
 * digest on their side, so the recipe is fixed: line count, total, then the
 * SKUs in the order they were charged.
 */
function receiptDigest(lineCount: number, totalCents: number, skus: string[]): string {
	const canonical = `${lineCount}:${totalCents}:${skus.join("|")}`;
	return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

worker.tool("receipt_digest", {
	title: "Receipt Digest",
	description:
		"Totals the lines of a receipt and fingerprints it so finance can reconcile against their copy.",
	schema: j.object({
		lines: j
			.array(
				j.object({
					sku: j.string().describe("The SKU charged."),
					qty: j.number().describe("How many units."),
					unit_cents: j.number().describe("Price per unit, in cents."),
				}),
			)
			.describe("The receipt's line items, in the order they were charged."),
	}),
	outputSchema: j.object({
		line_count: j.number().describe("How many line items the receipt has."),
		total_cents: j.number().describe("The receipt total, in cents."),
		digest: j.string().describe("The receipt fingerprint."),
	}),
	execute: ({ lines }) => {
		const totalCents = lines.reduce((sum, line) => sum + line.qty * line.unit_cents, 0);
		return {
			line_count: lines.length,
			total_cents: totalCents,
			digest: receiptDigest(
				lines.length,
				totalCents,
				lines.map((line) => line.sku),
			),
		};
	},
});
