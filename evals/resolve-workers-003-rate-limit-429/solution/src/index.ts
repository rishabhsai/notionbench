import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import {
	listSkus,
	WarehouseRateLimitError,
	type WarehouseInventoryPage,
	type WarehouseSku,
} from "./warehouse.js";

const worker = new Worker();
export default worker;

/** Anything under this many units is worth flagging to the ops channel. */
const LOW_STOCK_THRESHOLD = 10;

/** How many times we'll wait out a 429 for the same page before giving up. */
const MAX_ATTEMPTS = 5;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch one page, waiting out Northgate's rate limiter rather than failing.
 * Their `Retry-After` is authoritative; back off a little further on each
 * repeat so a sustained limit doesn't turn into a hot loop.
 */
async function fetchPage(cursor: string | null): Promise<WarehouseInventoryPage> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			return await listSkus(cursor);
		} catch (err) {
			if (!(err instanceof WarehouseRateLimitError)) throw err;
			lastError = err;
			await sleep(err.retryAfterMs * attempt);
		}
	}
	throw lastError;
}

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
			const page = await fetchPage(cursor);
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
