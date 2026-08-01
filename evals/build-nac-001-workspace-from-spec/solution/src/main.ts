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

const productOps = notion.teamspace({
  resourceId: "product-ops-teamspace",
  parent: workspaceParent,
  name: "Product Ops",
  accessLevel: "open",
});

const launchTracker = productOps.addDatabase({
  resourceId: "launch-tracker-db",
  name: "Launch Tracker",
  dataSources: [
    {
      resourceId: "launch-tracker-ds",
      name: "Launch Tracker",
      properties: [
        { resourceId: "launch-name-prop", name: "Name", type: "title" },
        {
          resourceId: "launch-stage-prop",
          name: "Stage",
          type: "select",
          options: [
            { name: "Planning", color: "blue" },
            { name: "Building", color: "yellow" },
            { name: "Shipped", color: "green" },
          ],
        },
        {
          resourceId: "launch-target-date-prop",
          name: "Target Date",
          type: "date",
        },
        { resourceId: "launch-blocked-prop", name: "Blocked", type: "checkbox" },
      ],
    },
  ],
});

launchTracker.addView({
  resourceId: "launch-tracker-board-view",
  name: "By Stage",
  type: "board",
  dataSourceResourceId: "launch-tracker-ds",
  groupBy: { property: "launch-stage-prop", type: "select" },
});

const launches = launchTracker.getDataSource("launch-tracker-ds");

launches.addPage({
  resourceId: "beta-invites-launch",
  properties: {
    Name: notion.text("Beta invites"),
    Stage: notion.select("Planning"),
    "Target Date": notion.date("2026-08-14"),
    Blocked: notion.checkbox(false),
  },
});

launches.addPage({
  resourceId: "pricing-page-refresh-launch",
  properties: {
    Name: notion.text("Pricing page refresh"),
    Stage: notion.select("Building"),
    "Target Date": notion.date("2026-08-21"),
    Blocked: notion.checkbox(true),
  },
});

launches.addPage({
  resourceId: "docs-revamp-launch",
  properties: {
    Name: notion.text("Docs revamp"),
    Stage: notion.select("Shipped"),
    "Target Date": notion.date("2026-07-31"),
    Blocked: notion.checkbox(false),
  },
});
