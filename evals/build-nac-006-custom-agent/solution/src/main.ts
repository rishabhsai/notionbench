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

const customerSuccess = notion.teamspace({
  resourceId: "customer-success-teamspace",
  parent: workspaceParent,
  name: "Customer Success",
  accessLevel: "open",
});

const feedback = customerSuccess.addDatabase({
  resourceId: "customer-feedback-db",
  name: "Customer Feedback",
  dataSources: [
    {
      resourceId: "customer-feedback-ds",
      name: "Customer Feedback",
      properties: [
        { resourceId: "feedback-title-prop", name: "Summary", type: "title" },
        { resourceId: "feedback-account-prop", name: "Account", type: "text" },
        {
          resourceId: "feedback-theme-prop",
          name: "Theme",
          type: "select",
          options: [
            { name: "Onboarding", color: "blue" },
            { name: "Reliability", color: "red" },
            { name: "Pricing", color: "yellow" },
          ],
        },
        { resourceId: "feedback-received-prop", name: "Received", type: "date" },
      ],
    },
  ],
});

const feedbackRows = feedback.getDataSource("customer-feedback-ds");

feedbackRows.addPage({
  resourceId: "acme-sso-feedback",
  properties: {
    Summary: notion.text("SSO setup took three calls"),
    Account: notion.text("Acme Corp"),
    Theme: notion.select("Onboarding"),
    Received: notion.date("2026-07-09"),
  },
});

feedbackRows.addPage({
  resourceId: "helio-timeout-feedback",
  properties: {
    Summary: notion.text("Exports time out on large workspaces"),
    Account: notion.text("Helio Labs"),
    Theme: notion.select("Reliability"),
    Received: notion.date("2026-07-17"),
  },
});

notion.customAgent({
  resourceId: "feedback-triage-agent",
  name: "Feedback Triage",
  icon: { type: "emoji", emoji: "🛟" },
  model: "almond-croissant-low",
  instructions: `You triage incoming customer feedback for the Customer Success team.

When someone gives you a piece of feedback:

1. Search the Customer Feedback database for an existing entry about the same problem before creating a new one.
2. Fill in **Account**, **Theme** and **Received** on every entry you create. Never leave Theme empty.
3. If the feedback does not fit an existing Theme, say so in your reply instead of inventing a new option.

Always quote the customer's own words in the Summary. Do not paraphrase complaints into something softer than what was said.`,
  sharedResources: ["customer-feedback-db"],
});
