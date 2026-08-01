import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import { listSkus, type WarehouseSku } from "./warehouse.js";

const worker = new Worker();
export default worker;

/** Anything under this many units is worth flagging to the ops channel. */
const LOW_STOCK_THRESHOLD = 10;

worker.tool("warehouse_totals", {
	title: "Warehouse Totals",
	description:
		"Reads the whole Northgate inventory and reports the SKU count, the total units, and anything running low.",
	schema: j.object({}),
	outputSchema: j.object({
		sku_count: j.number().describe("How many SKUs the warehouse holds."),
		total_units: j.number().describe("Total units across every SKU."),
		low_stock: j.array(j.string()).describe("SKUs under the low-stock threshold, sorted."),
	}),
	execute: async () => {
		const all: WarehouseSku[] = [];
		let cursor: string | null = null;
		do {
			const page = await listSkus(cursor);
			all.push(...page.skus);
			cursor = page.next_cursor;
		} while (cursor !== null);

		return {
			sku_count: all.length,
			total_units: all.reduce((sum, line) => sum + line.units, 0),
			low_stock: all
				.filter((line) => line.units < LOW_STOCK_THRESHOLD)
				.map((line) => line.sku)
				.sort(),
		};
	},
});
