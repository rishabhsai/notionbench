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

const consulting = notion.teamspace({
  resourceId: "consulting-teamspace",
  parent: workspaceParent,
  name: "Consulting",
  accessLevel: "open",
});

const clients = consulting.addDatabase({
  resourceId: "clients-db",
  name: "Clients",
  dataSources: [
    {
      resourceId: "clients-ds",
      name: "Clients",
      properties: [
        { resourceId: "client-name-prop", name: "Name", type: "title" },
        { resourceId: "client-account-lead-prop", name: "Account Lead", type: "text" },
        {
          resourceId: "client-engagements-prop",
          name: "Engagements",
          type: "relation",
          targetDataSourceResourceId: "engagements-ds",
          targetDataSourcePropertyResourceId: "engagement-client-prop",
        },
        {
          resourceId: "client-billable-hours-prop",
          name: "Billable Hours",
          type: "rollup",
          relationPropertyResourceId: "client-engagements-prop",
          targetPropertyResourceId: "engagement-hours-prop",
          targetPropertyType: "number",
          aggregation: "sum",
        },
        {
          resourceId: "client-next-milestone-prop",
          name: "Next Milestone",
          type: "rollup",
          relationPropertyResourceId: "client-engagements-prop",
          targetPropertyResourceId: "engagement-due-prop",
          targetPropertyType: "date",
          aggregation: "earliest_date",
        },
      ],
    },
  ],
});

const engagements = consulting.addDatabase({
  resourceId: "engagements-db",
  name: "Engagements",
  dataSources: [
    {
      resourceId: "engagements-ds",
      name: "Engagements",
      properties: [
        { resourceId: "engagement-name-prop", name: "Name", type: "title" },
        {
          resourceId: "engagement-client-prop",
          name: "Client",
          type: "relation",
          targetDataSourceResourceId: "clients-ds",
          targetDataSourcePropertyResourceId: "client-engagements-prop",
        },
        { resourceId: "engagement-hours-prop", name: "Hours", type: "number" },
        { resourceId: "engagement-due-prop", name: "Due", type: "date" },
      ],
    },
  ],
});

const clientRows = clients.getDataSource("clients-ds");
const engagementRows = engagements.getDataSource("engagements-ds");

clientRows.addPage({
  resourceId: "northwind-client",
  properties: {
    Name: notion.text("Northwind Traders"),
    "Account Lead": notion.text("Priya Raman"),
  },
});

clientRows.addPage({
  resourceId: "cascade-client",
  properties: {
    Name: notion.text("Cascade Foods"),
    "Account Lead": notion.text("Miguel Ortiz"),
  },
});

engagementRows.addPage({
  resourceId: "northwind-discovery-engagement",
  properties: {
    Name: notion.text("Discovery workshop"),
    Client: notion.relation(["northwind-client"]),
    Hours: notion.number(40),
    Due: notion.date("2026-08-07"),
  },
});

engagementRows.addPage({
  resourceId: "northwind-migration-engagement",
  properties: {
    Name: notion.text("Data migration"),
    Client: notion.relation(["northwind-client"]),
    Hours: notion.number(120),
    Due: notion.date("2026-09-18"),
  },
});

engagementRows.addPage({
  resourceId: "cascade-audit-engagement",
  properties: {
    Name: notion.text("Supply chain audit"),
    Client: notion.relation(["cascade-client"]),
    Hours: notion.number(65),
    Due: notion.date("2026-08-28"),
  },
});
