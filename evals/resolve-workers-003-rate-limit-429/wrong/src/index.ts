import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import { listSkus, WarehouseRateLimitError, type WarehouseSku } from "./warehouse.js";

const worker = new Worker();
export default worker;

/** Anything under this many units is worth flagging to the ops channel. */
const LOW_STOCK_THRESHOLD = 10;

// A plausible-but-wrong submission: the 429 no longer crashes the tool, so the
// ToolExecutionError in the ticket is gone and every call "succeeds" — but a
// rate-limited page is simply skipped, so the totals quietly describe part of
// the warehouse.
worker.tool("warehouse_totals", {
	title: "Warehouse Totals",
	description:
		"Reads the whole Northgate inventory and reports the SKU count, the total units, and anything running low.",
	schema: j.object({}),
	outputSchema: j.object({
		sku_count: j.number(),
		total_units: j.number(),
		low_stock: j.array(j.string()),
	}),
	execute: async () => {
		const all: WarehouseSku[] = [];
		let cursor: string | null = null;
		do {
			try {
				const page = await listSkus(cursor);
				all.push(...page.skus);
				cursor = page.next_cursor;
			} catch (err) {
				if (!(err instanceof WarehouseRateLimitError)) throw err;
				console.warn("Northgate rate-limited us; stopping here.");
				break;
			}
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
