import { notion } from "./lib/notion";

// A plausible-but-wrong fix: the build passes and there is exactly one anchor,
// but the anchor is the brand-new space. `workspace-root` is gone, so the next
// `apply` no longer recognizes the Operations teamspace, the Runbooks database
// or the pages under them -- it builds a second copy of all of it inside a new
// workspace.
const vendorSpace = notion.space({
  resourceId: "vendor-space",
  name: "Vendor Management",
  icon: { type: "notion_icon", description: "briefcase", color: "brown" },
});

const vendorTeamspace = vendorSpace.addTeamspace({
  resourceId: "vendors-teamspace",
  name: "Vendors",
  accessLevel: "open",
  description: "Contracts, renewals, and who owns the relationship.",
});

// -----------------------------------------------------------------------------
// Applied last quarter. Everything below this banner is live in Notion.
// -----------------------------------------------------------------------------

const operations = vendorSpace.addTeamspace({
  resourceId: "ops-teamspace",
  name: "Operations",
  accessLevel: "open",
  icon: { type: "notion_icon", description: "gear", color: "gray" },
  description: "How we keep the lights on.",
});

operations.addPage({
  resourceId: "ops-handbook-page",
  properties: { title: notion.text("Operations handbook") },
  icon: { type: "notion_icon", description: "book", color: "blue" },
  content: `# Operations handbook

<callout icon="📌">
Start here if you are new to the rotation.
</callout>
`,
});

const runbooks = operations.addDatabase({
  resourceId: "runbooks-db",
  name: "Runbooks",
  icon: { type: "notion_icon", description: "clipboard", color: "green" },
  dataSources: [
    {
      resourceId: "runbooks-ds",
      name: "Runbooks",
      properties: [
        { resourceId: "runbook-name-prop", name: "Name", type: "title" },
        {
          resourceId: "runbook-system-prop",
          name: "System",
          type: "select",
          options: [
            { name: "Billing", color: "orange" },
            { name: "Search", color: "blue" },
            { name: "Ingest", color: "purple" },
          ],
        },
        { resourceId: "runbook-owner-prop", name: "Owner", type: "text" },
        { resourceId: "runbook-reviewed-prop", name: "Last Reviewed", type: "date" },
      ],
    },
  ],
});

runbooks.addView({
  resourceId: "runbooks-table-view",
  name: "All Runbooks",
  type: "table",
  dataSourceResourceId: "runbooks-ds",
});

const runbookRows = runbooks.getDataSource("runbooks-ds");

runbookRows.addPage({
  resourceId: "billing-retry-runbook",
  properties: {
    Name: notion.text("Replay failed billing retries"),
    System: notion.select("Billing"),
    Owner: notion.text("Dana Whitfield"),
    "Last Reviewed": notion.date("2026-06-12"),
  },
});

runbookRows.addPage({
  resourceId: "search-reindex-runbook",
  properties: {
    Name: notion.text("Reindex the search cluster"),
    System: notion.select("Search"),
    Owner: notion.text("Sam Ibarra"),
    "Last Reviewed": notion.date("2026-07-03"),
  },
});

// -----------------------------------------------------------------------------
// New this week: procurement asked for somewhere to track vendors.
// -----------------------------------------------------------------------------

const vendors = vendorTeamspace.addDatabase({
  resourceId: "vendors-db",
  name: "Vendors",
  dataSources: [
    {
      resourceId: "vendors-ds",
      name: "Vendors",
      properties: [
        { resourceId: "vendor-name-prop", name: "Name", type: "title" },
        {
          resourceId: "vendor-tier-prop",
          name: "Tier",
          type: "select",
          options: [
            { name: "Critical", color: "red" },
            { name: "Standard", color: "gray" },
          ],
        },
        { resourceId: "vendor-owner-prop", name: "Owner", type: "text" },
        { resourceId: "vendor-renewal-prop", name: "Renews", type: "date" },
      ],
    },
  ],
});

const vendorRows = vendors.getDataSource("vendors-ds");

vendorRows.addPage({
  resourceId: "cloudkeep-vendor",
  properties: {
    Name: notion.text("CloudKeep"),
    Tier: notion.select("Critical"),
    Owner: notion.text("Priya Raman"),
    Renews: notion.date("2026-11-30"),
  },
});

vendorRows.addPage({
  resourceId: "paperless-vendor",
  properties: {
    Name: notion.text("Paperless HR"),
    Tier: notion.select("Standard"),
    Owner: notion.text("Miguel Ortiz"),
    Renews: notion.date("2027-01-15"),
  },
});

export {};
