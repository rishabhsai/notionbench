/**
 * ExpenseHub API — local stand-in.
 *
 * Same shapes as the hosted API, reading a snapshot of the current period
 * instead of the network. The real endpoint paginates once you get past a few
 * hundred reports; a period never has that many, so this returns them all.
 *
 * Don't edit this file — it mirrors the vendor's contract.
 */

/** One submitted expense report. */
export interface ExpenseReport {
	id: string;
	title: string;
	category: "travel" | "software" | "meals" | "hardware";
	status: "submitted" | "approved" | "reimbursed";
	/** Amount in cents; ExpenseHub never sends fractional currency. */
	amount_cents: number;
}

const REPORTS: ExpenseReport[] = [
	{
		id: "EX-2201",
		title: "Flights to the Denver offsite",
		category: "travel",
		status: "approved",
		amount_cents: 48250,
	},
	{
		id: "EX-2202",
		title: "Figma team seats",
		category: "software",
		status: "reimbursed",
		amount_cents: 14400,
	},
	{
		id: "EX-2203",
		title: "Client dinner, Q3 review",
		category: "meals",
		status: "submitted",
		amount_cents: 9875,
	},
	{
		id: "EX-2204",
		title: "Standing desk for the new hire",
		category: "hardware",
		status: "approved",
		amount_cents: 32900,
	},
	{
		id: "EX-2205",
		title: "Hotel, Denver offsite",
		category: "travel",
		status: "reimbursed",
		amount_cents: 61200,
	},
	{
		id: "EX-2206",
		title: "Linear annual plan",
		category: "software",
		status: "approved",
		amount_cents: 96000,
	},
];

/** `GET /v1/reports` — every report in the current period. */
export async function listReports(): Promise<ExpenseReport[]> {
	return REPORTS.map((report) => ({ ...report }));
}
