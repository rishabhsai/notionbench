import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

// ---------------------------------------------------------------------------
// Support tickets, mirrored from Deskline.
// ---------------------------------------------------------------------------

/** Snapshot of the vendor account; the hosted client lands next sprint. */
const DESKLINE_TICKETS = [
	{ id: "DL-1041", subject: "Password reset email never arrives", status: "open" },
	{ id: "DL-1042", subject: "Invoice PDF is missing the tax line", status: "pending" },
	{ id: "DL-1043", subject: "SSO login loops back to the sign-in page", status: "open" },
	{ id: "DL-1044", subject: "Exported CSV has the columns in the wrong order", status: "closed" },
	{ id: "DL-1045", subject: "Webhook retries stop after the first failure", status: "open" },
	{ id: "DL-1046", subject: "Seat count on the billing page is stale", status: "pending" },
	{ id: "DL-1047", subject: "Mobile app crashes when opening attachments", status: "open" },
	{ id: "DL-1048", subject: "Search returns archived records", status: "closed" },
	{ id: "DL-1049", subject: "Timezone on scheduled reports is off by an hour", status: "pending" },
	{ id: "DL-1050", subject: "Bulk import silently drops rows past 500", status: "open" },
	{ id: "DL-1051", subject: "Cannot remove a deactivated teammate", status: "closed" },
	{ id: "DL-1052", subject: "API key rotation invalidates active sessions", status: "open" },
];

const PAGE_SIZE = 5;

const supportTickets = worker.database("supportTickets", {
	type: "managed",
	initialTitle: "Support Tickets",
	primaryKeyProperty: "Ticket ID",
	schema: {
		properties: {
			Subject: Schema.title(),
			"Ticket ID": Schema.richText(),
			Status: Schema.select([{ name: "open" }, { name: "pending" }, { name: "closed" }]),
		},
	},
});

worker.sync("ticketsSync", {
	database: supportTickets,
	mode: "replace",
	schedule: "1h",
	execute: async (state: { offset?: number } | undefined) => {
		const offset = state?.offset ?? 0;
		const page = DESKLINE_TICKETS.slice(offset, offset + PAGE_SIZE);
		const next = offset + page.length;
		return {
			changes: page.map((ticket) => ({
				type: "upsert" as const,
				key: ticket.id,
				properties: {
					Subject: Builder.title(ticket.subject),
					"Ticket ID": Builder.richText(ticket.id),
					Status: Builder.select(ticket.status),
				},
			})),
			hasMore: next < DESKLINE_TICKETS.length,
			nextState: next < DESKLINE_TICKETS.length ? { offset: next } : undefined,
		};
	},
});

// ---------------------------------------------------------------------------
// Who is carrying what.
// ---------------------------------------------------------------------------

worker.tool("assignee_load", {
	title: "Assignee Load",
	description:
		"Groups open tickets by assignee and reports how many tickets and how many minutes each person is carrying.",
	schema: j.object({
		tickets: j
			.array(
				j.object({
					id: j.string().describe("The ticket id."),
					assignee: j
						.string()
						.nullable()
						.describe("Who the ticket is assigned to, or null when nobody has picked it up."),
					minutes: j.number().describe("Minutes logged against the ticket so far."),
				}),
			)
			.describe("The tickets to summarize."),
	}),
	outputSchema: j.object({
		load: j
			.array(
				j.object({
					assignee: j.string(),
					open_tickets: j.number(),
					minutes: j.number(),
				}),
			)
			.describe("One entry per assignee, busiest first."),
	}),
	execute: ({ tickets }) => {
		const byAssignee = new Map<string, { open_tickets: number; minutes: number }>();
		for (const ticket of tickets) {
			// Nobody owns these yet, so leave them out of the per-person totals.
			if (ticket.assignee === null) continue;
			const name = ticket.assignee.trim();
			const bucket = byAssignee.get(name) ?? { open_tickets: 0, minutes: 0 };
			bucket.open_tickets += 1;
			bucket.minutes += ticket.minutes;
			byAssignee.set(name, bucket);
		}
		const load = [...byAssignee.entries()].map(([assignee, bucket]) => ({
			assignee,
			open_tickets: bucket.open_tickets,
			minutes: bucket.minutes,
		}));
		load.sort((a, b) => b.minutes - a.minutes || a.assignee.localeCompare(b.assignee));
		return { load };
	},
});
