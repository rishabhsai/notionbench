/**
 * Deskline API — local stand-in.
 *
 * The real Deskline support API is behind our vendor account, so this module
 * talks to a snapshot of the ticket list in `data/tickets.json` instead. The
 * request/response shape, the page size, and the cursor semantics are the same
 * as the hosted API, which means code written against this module works
 * unchanged once the base URL is pointed at api.deskline.example.
 *
 * Don't edit this file — it mirrors the vendor's contract.
 */
import { readFile } from "node:fs/promises";

/** One support ticket, exactly as Deskline returns it. */
export interface DesklineTicket {
	id: string;
	subject: string;
	status: "open" | "pending" | "closed";
}

/** One page of `GET /v2/tickets`. */
export interface DesklineTicketPage {
	tickets: DesklineTicket[];
	/** Pass back as `cursor` to fetch the next page; null on the last page. */
	next_cursor: string | null;
}

/** Deskline serves tickets 5 at a time and does not let you change that. */
const PAGE_SIZE = 5;

const CURSOR_PREFIX = "dl_cursor_";

async function readSnapshot(): Promise<DesklineTicket[]> {
	const file = new URL("../data/tickets.json", import.meta.url);
	const parsed = JSON.parse(await readFile(file, "utf8")) as { tickets: DesklineTicket[] };
	return parsed.tickets;
}

function decodeCursor(cursor: string | null | undefined): number {
	if (cursor === null || cursor === undefined) return 0;
	if (!cursor.startsWith(CURSOR_PREFIX)) {
		throw new Error(`Deskline: malformed cursor "${cursor}"`);
	}
	const offset = Number(cursor.slice(CURSOR_PREFIX.length));
	if (!Number.isInteger(offset) || offset < 0) {
		throw new Error(`Deskline: malformed cursor "${cursor}"`);
	}
	return offset;
}

/**
 * `GET /v2/tickets?cursor=<cursor>` — one page of tickets, newest id last.
 *
 * @param cursor - `next_cursor` from the previous page, or null/undefined for
 *   the first page.
 */
export async function listTickets(cursor?: string | null): Promise<DesklineTicketPage> {
	const all = await readSnapshot();
	const offset = decodeCursor(cursor);
	const tickets = all.slice(offset, offset + PAGE_SIZE);
	const next = offset + tickets.length;
	return {
		tickets,
		next_cursor: next < all.length ? `${CURSOR_PREFIX}${next}` : null,
	};
}
