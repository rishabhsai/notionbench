import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
import { j } from "@notionhq/workers/schema-builder";
import { listTickets } from "./deskline.js";

const worker = new Worker();
export default worker;

// Example agent tool that returns a greeting
// Delete this when you're ready to start building your own tools.
worker.tool("sayHello", {
	title: "Say Hello",
	description: "Returns a friendly greeting for the given name.",
	schema: j.object({
		name: j.string().describe("The name to greet."),
	}),
	execute: ({ name }) => `Hello, ${name}!`,
});

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

const desklineApi = worker.pacer("desklineApi", { allowedRequests: 10, intervalMs: 1000 });

/** What we carry between executions of one sync cycle: Deskline's cursor. */
type TicketsSyncState = { cursor: string | null };

worker.sync("ticketsSync", {
	database: supportTickets,
	mode: "replace",
	schedule: "1h",
	execute: async (state: TicketsSyncState | undefined) => {
		await desklineApi.wait();
		const page = await listTickets(state?.cursor ?? null);

		return {
			changes: page.tickets.map((ticket) => ({
				type: "upsert" as const,
				key: ticket.id,
				properties: {
					Subject: Builder.title(ticket.subject),
					"Ticket ID": Builder.richText(ticket.id),
					Status: Builder.select(ticket.status),
				},
			})),
			// One page per execution: hand the cursor back and let the platform
			// call us again rather than draining Deskline in a single run.
			hasMore: page.next_cursor !== null,
			nextState: page.next_cursor !== null ? { cursor: page.next_cursor } : undefined,
		};
	},
});
