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

// A plausible-but-wrong submission: all of the copy is on the page and the
// headings are right, but it is written in plain GitHub-flavored Markdown —
// the callouts became bold paragraphs, the toggles became more headings, the
// table became a pipe table, and the sub-steps were flattened into one list.
const engineering = notion.teamspace({
  resourceId: "engineering",
  parent: workspaceParent,
  name: "Engineering",
  accessLevel: "open",
});

engineering.addPage({
  resourceId: "on-call-handbook",
  properties: { title: notion.text("On-call handbook") },
  icon: { type: "emoji", emoji: "📟" },
  content: `🚨 **Page the incident lead before you touch production.**

## Severity ladder

| Severity | Response time | Who to wake |
| --- | --- | --- |
| Sev 1 | 5 minutes | Incident lead and platform on-call |
| Sev 2 | 30 minutes | Platform on-call |
| Sev 3 | Next business day | Nobody, file a ticket |

## First fifteen minutes

- Acknowledge the page in the alerting channel
- Say your name so nobody double-responds
- Start a thread for the timeline
- Read the status dashboard before you read any code
- Error rate
- Latency p99
- Queue depth
- Say the severity out loud and write it in the thread

## When you are stuck

### You cannot reach the incident lead

Escalate to the engineering manager on the rotation, then to the VP. Do not sit on a Sev 1 waiting for a reply.

### The dashboard itself is down

Treat it as a Sev 2 until proven otherwise and fall back to the raw metrics endpoint.

📝 Write the timeline as you go. Reconstructing it afterwards always loses the detail that mattered.
`,
});
