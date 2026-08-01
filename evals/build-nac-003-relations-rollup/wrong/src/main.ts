import { notion } from "./lib/notion";

/**
 * The workspace this project applies to already exists. The "workspace-root"
 * resourceId is the anchor that `ntn notion-as-code apply` maps onto it, so
 * top-level resources are parented to `workspaceParent`.
 */
export const workspaceParent = {
  type: "resourceId",
  resourceId: "workspace-root",
} as const;

// A plausible-but-wrong submission: both databases have a relation property
// pointing at the other one, but neither names the property on the far side —
// so these are two independent one-way relations that never sync, not the
// single two-way relation that was asked for.
const consulting = notion.teamspace({
  resourceId: "consulting",
  parent: workspaceParent,
  name: "Consulting",
  accessLevel: "open",
});

const clients = consulting.addDatabase({
  resourceId: "clients",
  name: "Clients",
  dataSources: [
    {
      resourceId: "clients-source",
      name: "Clients",
      properties: [
        { resourceId: "client-name", name: "Name", type: "title" },
        { resourceId: "client-lead", name: "Account Lead", type: "text" },
        {
          resourceId: "client-engagements",
          name: "Engagements",
          type: "relation",
          targetDataSourceResourceId: "engagements-source",
        },
        {
          resourceId: "client-hours",
          name: "Billable Hours",
          type: "rollup",
          relationPropertyResourceId: "client-engagements",
          targetPropertyResourceId: "engagement-hours",
          targetPropertyType: "number",
          aggregation: "sum",
        },
        {
          resourceId: "client-next-milestone",
          name: "Next Milestone",
          type: "rollup",
          relationPropertyResourceId: "client-engagements",
          targetPropertyResourceId: "engagement-due",
          targetPropertyType: "date",
          aggregation: "earliest_date",
        },
      ],
    },
  ],
});

const engagements = consulting.addDatabase({
  resourceId: "engagements",
  name: "Engagements",
  dataSources: [
    {
      resourceId: "engagements-source",
      name: "Engagements",
      properties: [
        { resourceId: "engagement-name", name: "Name", type: "title" },
        {
          resourceId: "engagement-client",
          name: "Client",
          type: "relation",
          targetDataSourceResourceId: "clients-source",
        },
        { resourceId: "engagement-hours", name: "Hours", type: "number" },
        { resourceId: "engagement-due", name: "Due", type: "date" },
      ],
    },
  ],
});

const clientRows = clients.getDataSource("clients-source");
const engagementRows = engagements.getDataSource("engagements-source");

clientRows.addPage({
  resourceId: "northwind",
  properties: {
    Name: notion.text("Northwind Traders"),
    "Account Lead": notion.text("Priya Raman"),
  },
});

clientRows.addPage({
  resourceId: "cascade",
  properties: {
    Name: notion.text("Cascade Foods"),
    "Account Lead": notion.text("Miguel Ortiz"),
  },
});

engagementRows.addPage({
  resourceId: "discovery-workshop",
  properties: {
    Name: notion.text("Discovery workshop"),
    Client: notion.relation(["northwind"]),
    Hours: notion.number(40),
    Due: notion.date("2026-08-07"),
  },
});

engagementRows.addPage({
  resourceId: "data-migration",
  properties: {
    Name: notion.text("Data migration"),
    Client: notion.relation(["northwind"]),
    Hours: notion.number(120),
    Due: notion.date("2026-09-18"),
  },
});

engagementRows.addPage({
  resourceId: "supply-chain-audit",
  properties: {
    Name: notion.text("Supply chain audit"),
    Client: notion.relation(["cascade"]),
    Hours: notion.number(65),
    Due: notion.date("2026-08-28"),
  },
});
