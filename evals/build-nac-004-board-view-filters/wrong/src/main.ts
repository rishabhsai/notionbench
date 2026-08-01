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

// A plausible-but-wrong submission: the board, its columns and its card fields
// are all right, but the second filter was written against the property the
// board is grouped by instead of against Team — so the view shows every team's
// urgent escalations rather than Platform's.
const support = notion.teamspace({
  resourceId: "support-teamspace",
  parent: workspaceParent,
  name: "Support",
  accessLevel: "open",
});

const queue = support.addDatabase({
  resourceId: "support-queue-db",
  name: "Support Queue",
  dataSources: [
    {
      resourceId: "support-queue-ds",
      name: "Support Queue",
      properties: [
        { resourceId: "ticket-name-prop", name: "Name", type: "title" },
        {
          resourceId: "ticket-priority-prop",
          name: "Priority",
          type: "select",
          options: [
            { name: "Urgent", color: "red" },
            { name: "Normal", color: "blue" },
            { name: "Low", color: "gray" },
          ],
        },
        {
          resourceId: "ticket-team-prop",
          name: "Team",
          type: "select",
          options: [
            { name: "Platform", color: "purple" },
            { name: "Billing", color: "orange" },
            { name: "Mobile", color: "green" },
          ],
        },
        { resourceId: "ticket-escalated-prop", name: "Escalated", type: "checkbox" },
        { resourceId: "ticket-opened-prop", name: "Opened", type: "date" },
      ],
    },
  ],
});

queue.addView({
  resourceId: "support-queue-table-view",
  name: "All Tickets",
  type: "table",
  dataSourceResourceId: "support-queue-ds",
});

queue.addView({
  resourceId: "support-queue-escalations-view",
  name: "Platform Escalations",
  type: "board",
  dataSourceResourceId: "support-queue-ds",
  groupBy: {
    property: "ticket-priority-prop",
    type: "select",
    emptyGroupVisibility: "hide",
  },
  columns: [
    { property: "ticket-priority-prop", value: { type: "select", value: "Urgent" } },
    { property: "ticket-priority-prop", value: { type: "select", value: "Normal" } },
    { property: "ticket-priority-prop", value: { type: "select", value: "Low" }, hidden: true },
  ],
  filters: [
    {
      propertyId: "ticket-escalated-prop",
      propertyType: "checkbox",
      operator: "checkbox_is",
      value: true,
    },
    {
      propertyId: "ticket-priority-prop",
      propertyType: "select",
      operator: "enum_is",
      value: "Urgent",
    },
    {
      propertyId: "ticket-opened-prop",
      propertyType: "date",
      operator: "date_is_on_or_after",
      value: "2026-07-01",
    },
  ],
  properties: [
    { property: "ticket-team-prop", visible: true },
    { property: "ticket-opened-prop", visible: true },
    { property: "ticket-escalated-prop", visible: false },
  ],
  sorts: [{ propertyId: "ticket-opened-prop", direction: "ascending" }],
});

const tickets = queue.getDataSource("support-queue-ds");

tickets.addPage({
  resourceId: "checkout-500s-ticket",
  properties: {
    Name: notion.text("Checkout returning 500s"),
    Priority: notion.select("Urgent"),
    Team: notion.select("Platform"),
    Escalated: notion.checkbox(true),
    Opened: notion.date("2026-07-14"),
  },
});

tickets.addPage({
  resourceId: "invoice-pdf-ticket",
  properties: {
    Name: notion.text("Invoice PDF missing tax line"),
    Priority: notion.select("Normal"),
    Team: notion.select("Billing"),
    Escalated: notion.checkbox(false),
    Opened: notion.date("2026-06-28"),
  },
});

tickets.addPage({
  resourceId: "push-notifications-ticket",
  properties: {
    Name: notion.text("Push notifications delayed"),
    Priority: notion.select("Normal"),
    Team: notion.select("Platform"),
    Escalated: notion.checkbox(true),
    Opened: notion.date("2026-07-22"),
  },
});
