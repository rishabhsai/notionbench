/**
 * Northgate Warehouse API — local stand-in.
 *
 * Same request/response shapes and the same rate-limiting behavior as the
 * hosted API, reading a snapshot of our inventory instead of the network. The
 * real API allows a burst and then starts returning 429 with a `Retry-After`;
 * this stub reproduces that on the same cadence so integrations can be
 * exercised without a vendor sandbox.
 *
 * Don't edit this file — it mirrors the vendor's contract.
 */

/** Thrown for a `429 Too Many Requests`, carrying the vendor's Retry-After. */
export class WarehouseRateLimitError extends Error {
	readonly status = 429;

	constructor(readonly retryAfterMs: number) {
		super(`Northgate responded 429 Too Many Requests; retry after ${retryAfterMs}ms`);
		this.name = "WarehouseRateLimitError";
	}
}

/** One stock line. */
export interface WarehouseSku {
	sku: string;
	units: number;
}

/** One page of `GET /v1/inventory`. */
export interface WarehouseInventoryPage {
	skus: WarehouseSku[];
	/** Pass back as `cursor` for the next page; null on the last page. */
	next_cursor: string | null;
}

const INVENTORY: WarehouseSku[] = [
	{ sku: "WH-101", units: 120 },
	{ sku: "WH-102", units: 45 },
	{ sku: "WH-103", units: 4 },
	{ sku: "WH-104", units: 63 },
	{ sku: "WH-105", units: 18 },
	{ sku: "WH-106", units: 210 },
	{ sku: "WH-107", units: 0 },
	{ sku: "WH-108", units: 31 },
	{ sku: "WH-109", units: 77 },
	{ sku: "WH-110", units: 12 },
	{ sku: "WH-111", units: 9 },
	{ sku: "WH-112", units: 150 },
	{ sku: "WH-113", units: 26 },
	{ sku: "WH-114", units: 2 },
];

const PAGE_SIZE = 4;
const CURSOR_PREFIX = "ng_";
const RETRY_AFTER_MS = 25;

/** Requests served by this process, including the ones we turn away. */
let requestCount = 0;

function decodeCursor(cursor: string | null | undefined): number {
	if (cursor === null || cursor === undefined) return 0;
	if (!cursor.startsWith(CURSOR_PREFIX)) {
		throw new Error(`Northgate: malformed cursor "${cursor}"`);
	}
	const offset = Number(cursor.slice(CURSOR_PREFIX.length));
	if (!Number.isInteger(offset) || offset < 0) {
		throw new Error(`Northgate: malformed cursor "${cursor}"`);
	}
	return offset;
}

/**
 * `GET /v1/inventory?cursor=<cursor>` — one page of stock lines.
 *
 * Throws {@link WarehouseRateLimitError} when the account is over its burst
 * budget, exactly as the hosted API does. Callers are expected to wait
 * `retryAfterMs` and try the same request again.
 */
export async function listSkus(cursor?: string | null): Promise<WarehouseInventoryPage> {
	requestCount += 1;
	if (requestCount % 3 === 2) {
		throw new WarehouseRateLimitError(RETRY_AFTER_MS);
	}

	const offset = decodeCursor(cursor);
	const skus = INVENTORY.slice(offset, offset + PAGE_SIZE);
	const next = offset + skus.length;
	return {
		skus,
		next_cursor: next < INVENTORY.length ? `${CURSOR_PREFIX}${next}` : null,
	};
}
