import { notion } from "./lib/notion";

/**
 * The workspace this project applies to already exists. The "workspace-root"
 * resourceId is the anchor that `ntn notion-as-code apply` maps onto it, so
 * top-level resources are parented to `workspaceParent`.
 */
const workspaceParent = {
  type: "resourceId",
  resourceId: "workspace-root",
} as const;

// A plausible-but-wrong migration: the Stage options and the column name are
// right, but renaming the column also renamed its resourceId — so the next
// `apply` drops the applied Notes column and adds an empty Context column
// beside it, losing everything people had written in it.
const marketing = notion.teamspace({
  resourceId: "marketing-teamspace",
  parent: workspaceParent,
  name: "Marketing",
  accessLevel: "open",
  icon: { type: "notion_icon", description: "megaphone", color: "orange" },
  description: "Campaign planning and publishing.",
});

const contentCalendar = marketing.addDatabase({
  resourceId: "content-calendar-db",
  name: "Content Calendar",
  icon: { type: "notion_icon", description: "calendar", color: "blue" },
  description: "Everything we publish, and where it is in the pipeline.",
  dataSources: [
    {
      resourceId: "content-calendar-ds",
      name: "Content Calendar",
      properties: [
        { resourceId: "content-title-prop", name: "Title", type: "title" },
        {
          resourceId: "content-stage-prop",
          name: "Stage",
          type: "select",
          options: [
            { name: "Drafting", color: "blue" },
            { name: "Review", color: "yellow" },
            { name: "Scheduled", color: "purple" },
            { name: "Published", color: "green" },
          ],
        },
        { resourceId: "content-owner-prop", name: "Owner", type: "text" },
        { resourceId: "content-publish-date-prop", name: "Publish Date", type: "date" },
        { resourceId: "content-context-prop", name: "Context", type: "text" },
      ],
    },
  ],
});

contentCalendar.addView({
  resourceId: "content-calendar-board-view",
  name: "By Stage",
  type: "board",
  dataSourceResourceId: "content-calendar-ds",
  groupBy: { property: "content-stage-prop", type: "select" },
});

const posts = contentCalendar.getDataSource("content-calendar-ds");

posts.addPage({
  resourceId: "q3-launch-announcement",
  properties: {
    Title: notion.text("Q3 launch announcement"),
    Stage: notion.select("Drafting"),
    Owner: notion.text("Dana Whitfield"),
    "Publish Date": notion.date("2026-08-11"),
    Context: notion.text("Hold until legal signs off on the pricing claim."),
  },
});

posts.addPage({
  resourceId: "customer-story-helio",
  properties: {
    Title: notion.text("Customer story: Helio Labs"),
    Stage: notion.select("Review"),
    Owner: notion.text("Sam Ibarra"),
    "Publish Date": notion.date("2026-08-04"),
    Context: notion.text("Quotes approved; screenshots still need a refresh."),
  },
});

posts.addPage({
  resourceId: "changelog-july",
  properties: {
    Title: notion.text("July changelog"),
    Stage: notion.select("Published"),
    Owner: notion.text("Dana Whitfield"),
    "Publish Date": notion.date("2026-07-31"),
    Context: notion.text("Cross-posted to the community forum."),
  },
});

posts.addPage({
  resourceId: "webinar-followup",
  properties: {
    Title: notion.text("Webinar follow-up sequence"),
    Stage: notion.select("Drafting"),
    Owner: notion.text("Priya Raman"),
    "Publish Date": notion.date("2026-09-02"),
    Context: notion.text("Three emails; the third one is still an outline."),
  },
});

export {};
