import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

type NumberProperty = { type: "number"; number: number | null };
type TitleProperty = { type: "title"; title: Array<{ plain_text?: string }> };

/** Thresholds are inclusive at the bottom: exactly 1000 is Priority. */
function tierFor(total: number): "Standard" | "Priority" | "Strategic" {
	if (total >= 10_000) return "Strategic";
	if (total >= 1_000) return "Priority";
	return "Standard";
}

worker.tool("enrich_order", {
	title: "Enrich order",
	description: "Fills in Order total and Tier on one row of the Orders database.",
	schema: j.object({
		page_id: j.string().describe("Id of the row in the Orders database to enrich."),
	}),
	outputSchema: j.object({
		order: j.string(),
		order_total: j.number(),
		tier: j.string(),
	}),
	execute: async ({ page_id }, { notion }) => {
		const page = await notion.pages.retrieve({ page_id });
		const properties = (page as { properties?: Record<string, unknown> }).properties ?? {};

		const unitPrice = (properties["Unit price"] as NumberProperty | undefined)?.number ?? 0;
		const quantity = (properties.Quantity as NumberProperty | undefined)?.number ?? 0;
		const title = (properties.Order as TitleProperty | undefined)?.title ?? [];

		const orderTotal = unitPrice * quantity;
		const tier = tierFor(orderTotal);

		// Only the two derived columns: Unit price and Quantity are inputs.
		await notion.pages.update({
			page_id,
			properties: {
				"Order total": { number: orderTotal },
				Tier: { select: { name: tier } },
			},
		});

		return {
			order: title.map((part) => part.plain_text ?? "").join(""),
			order_total: orderTotal,
			tier,
		};
	},
});
