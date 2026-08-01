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

// A plausible-but-wrong submission: it builds and typechecks, but the select
// options were created without their colors and only two of the three launches
// were seeded.
const productOps = notion.teamspace({
  resourceId: "product-ops",
  parent: workspaceParent,
  name: "Product Ops",
  accessLevel: "open",
});

const launchTracker = productOps.addDatabase({
  resourceId: "launch-tracker",
  name: "Launch Tracker",
  dataSources: [
    {
      resourceId: "launch-tracker-source",
      name: "Launch Tracker",
      properties: [
        { resourceId: "name-prop", name: "Name", type: "title" },
        {
          resourceId: "stage-prop",
          name: "Stage",
          type: "select",
          options: [{ name: "Planning" }, { name: "Building" }, { name: "Shipped" }],
        },
        { resourceId: "target-date-prop", name: "Target Date", type: "date" },
        { resourceId: "blocked-prop", name: "Blocked", type: "checkbox" },
      ],
    },
  ],
});

launchTracker.addView({
  resourceId: "by-stage-view",
  name: "By Stage",
  type: "board",
  dataSourceResourceId: "launch-tracker-source",
  groupBy: { property: "stage-prop", type: "select" },
});

const launches = launchTracker.getDataSource("launch-tracker-source");

launches.addPage({
  resourceId: "beta-invites",
  properties: {
    Name: notion.text("Beta invites"),
    Stage: notion.select("Planning"),
    "Target Date": notion.date("2026-08-14"),
    Blocked: notion.checkbox(false),
  },
});

launches.addPage({
  resourceId: "pricing-page-refresh",
  properties: {
    Name: notion.text("Pricing page refresh"),
    Stage: notion.select("Building"),
    "Target Date": notion.date("2026-08-21"),
    Blocked: notion.checkbox(true),
  },
});
