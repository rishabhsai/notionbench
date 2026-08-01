import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
import { j } from "@notionhq/workers/schema-builder";
import { triggers } from "@notionhq/workers/triggers";
import { listReports } from "./expensehub.js";

const worker = new Worker();
export default worker;

// A plausible-but-wrong submission: "every 30 minutes, do these steps" reads
// like a scheduled workflow, the SDK has one, and it is right there in the type
// definitions — so this reaches for `worker.workflow()` with a recurrence
// trigger and writes the rows through the Notion client. The behavior is
// roughly what finance asked for; the repository instructions say this API is
// off limits, and they win.
const expenseReports = worker.database("expenseReports", {
	type: "managed",
	initialTitle: "Expense Reports",
	primaryKeyProperty: "Report ID",
	schema: {
		properties: {
			Title: Schema.title(),
			"Report ID": Schema.richText(),
			Category: Schema.select([
				{ name: "travel" },
				{ name: "software" },
				{ name: "meals" },
				{ name: "hardware" },
			]),
			Status: Schema.select([
				{ name: "submitted" },
				{ name: "approved" },
				{ name: "reimbursed" },
			]),
		},
	},
});

worker.sync("expensesSync", {
	database: expenseReports,
	mode: "replace",
	schedule: "30m",
	execute: async () => {
		const reports = await listReports();
		return {
			changes: reports.map((report) => ({
				type: "upsert" as const,
				key: report.id,
				properties: {
					Title: Builder.title(report.title),
					"Report ID": Builder.richText(report.id),
					Category: Builder.select(report.category),
					Status: Builder.select(report.status),
				},
			})),
			hasMore: false,
		};
	},
});

worker.workflow("expenseDigest", {
	title: "Expense Digest",
	description: "Recomputes the category breakdown on a recurring schedule.",
	triggers: [triggers.recurrence()],
	execute: async () => {
		const reports = await listReports();
		const byCategory = new Map<string, number>();
		for (const report of reports) {
			byCategory.set(report.category, (byCategory.get(report.category) ?? 0) + report.amount_cents);
		}
		console.log("expense digest", Object.fromEntries(byCategory));
	},
});

worker.tool("expense_totals", {
	title: "Expense Totals",
	description:
		"Totals the current period's expense reports, either for one category or across all of them.",
	schema: j.object({
		category: j.string().nullable().describe("The category to total, or null for every category."),
	}),
	outputSchema: j.object({
		category: j.string(),
		report_count: j.number(),
		total_cents: j.number(),
	}),
	execute: async ({ category }) => {
		const reports = await listReports();
		const wanted = category?.trim().toLowerCase() ?? null;
		const matching = wanted === null ? reports : reports.filter((r) => r.category === wanted);
		return {
			category: wanted ?? "all",
			report_count: matching.length,
			total_cents: matching.reduce((sum, report) => sum + report.amount_cents, 0),
		};
	},
});
