import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
import { j } from "@notionhq/workers/schema-builder";
import { listReports } from "./expensehub.js";

const worker = new Worker();
export default worker;

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

const expenseHub = worker.pacer("expenseHub", { allowedRequests: 10, intervalMs: 1000 });

// The recurring half: a sync on a schedule keeps the database current.
worker.sync("expensesSync", {
	database: expenseReports,
	mode: "replace",
	schedule: "30m",
	execute: async () => {
		await expenseHub.wait();
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
			// ExpenseHub returns a whole period in one response, so one execution
			// is the whole cycle.
			hasMore: false,
		};
	},
});

// The on-demand half: a tool the agent can call mid-conversation.
worker.tool("expense_totals", {
	title: "Expense Totals",
	description:
		"Totals the current period's expense reports, either for one category or across all of them.",
	schema: j.object({
		category: j
			.string()
			.nullable()
			.describe("The category to total, or null for every category."),
	}),
	outputSchema: j.object({
		category: j.string().describe('The category totalled, or "all".'),
		report_count: j.number().describe("How many reports are covered."),
		total_cents: j.number().describe("Their total, in cents."),
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
