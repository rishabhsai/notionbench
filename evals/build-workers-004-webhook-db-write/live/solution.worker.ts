import { Worker } from "@notionhq/workers";

const worker = new Worker();
export default worker;

/**
 * The worker runs against whichever workspace it is deployed into, so the
 * database is resolved by name at run time rather than by a baked-in id.
 */
const DATABASE_NAME = "Incidents";

worker.webhook("onIncidentAlert", {
	title: "Incident alert",
	description:
		"Applies an incident status change from the alerting tool to the matching row of the Incidents database.",
	execute: async (events, { notion }) => {
		let dataSourceId: string | undefined;

		for (const event of events) {
			const body = event.body as {
				incident_id?: unknown;
				status?: unknown;
				summary?: unknown;
			};
			const incidentId = typeof body.incident_id === "string" ? body.incident_id : undefined;
			if (!incidentId) continue;

			if (dataSourceId === undefined) {
				// Search is eventually consistent, and a webhook can arrive seconds
				// after the data source is created — so a single miss is not proof
				// that nothing is shared. Retry briefly before giving up.
				let match: { id: string } | undefined;
				// Measured: a data source created seconds ago takes ~20s to become
				// searchable. Cover well past that before concluding it is absent.
				for (let attempt = 0; attempt < 20 && !match; attempt++) {
					if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 3000));
					const found = await notion.search({
						query: DATABASE_NAME,
						filter: { property: "object", value: "data_source" },
					});
					// Real Notion returns a data source's name in `title` (rich text);
					// there is no `name` field. Skip trashed hits: a torn-down fixture
					// stays searchable for a while, and matching one writes the rows
					// into a dead run's database.
					match = found.results.find((result) => {
						const r = result as {
							name?: unknown;
							in_trash?: boolean;
							title?: Array<{ plain_text?: string }>;
						};
						if (r.in_trash) return false;
						const title =
							typeof r.name === "string"
								? r.name
								: (r.title ?? []).map((t) => t.plain_text ?? "").join("");
						return title === DATABASE_NAME;
					}) as { id: string } | undefined;
				}
				if (!match) {
					throw new Error(`no data source named "${DATABASE_NAME}" is shared with this worker`);
				}
				dataSourceId = match.id;
			}

			// Match on the key, not on position: query order is not delivery order.
			const rows = await notion.dataSources.query({
				data_source_id: dataSourceId,
				filter: { property: "Incident ID", rich_text: { equals: incidentId } },
			});
			const row = rows.results[0];
			if (!row) continue;

			const properties: Record<string, unknown> = {};
			if (typeof body.status === "string") {
				properties.Status = { select: { name: body.status } };
			}
			if (typeof body.summary === "string") {
				properties.Notes = { rich_text: [{ text: { content: body.summary } }] };
			}
			if (Object.keys(properties).length === 0) continue;

			await notion.pages.update({
				page_id: row.id,
				properties: properties as Parameters<typeof notion.pages.update>[0]["properties"],
			});
		}
	},
});
