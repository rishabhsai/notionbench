import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
import { listTickets } from "./deskline.js";

const worker = new Worker();
export default worker;

// A plausible-but-wrong submission: the database, the property names and the
// change shape are all right, and it looks perfect against a small test
// account — but it fetches one page and calls the cycle done, so everything
// past the first `next_cursor` never reaches Notion.
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
	execute: async () => {
		const page = await listTickets();
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
			hasMore: false,
		};
	},
});
