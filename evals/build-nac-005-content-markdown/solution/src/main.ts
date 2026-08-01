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

const engineering = notion.teamspace({
  resourceId: "engineering-teamspace",
  parent: workspaceParent,
  name: "Engineering",
  accessLevel: "open",
});

engineering.addPage({
  resourceId: "on-call-handbook-page",
  properties: { title: notion.text("On-call handbook") },
  icon: { type: "emoji", emoji: "📟" },
  content: `<callout icon="🚨">
	Page the incident lead **before** you touch production.
</callout>

## Severity ladder

<table header-row="true">
	<tr>
		<td>Severity</td>
		<td>Response time</td>
		<td>Who to wake</td>
	</tr>
	<tr>
		<td>Sev 1</td>
		<td>5 minutes</td>
		<td>Incident lead and platform on-call</td>
	</tr>
	<tr>
		<td>Sev 2</td>
		<td>30 minutes</td>
		<td>Platform on-call</td>
	</tr>
	<tr>
		<td>Sev 3</td>
		<td>Next business day</td>
		<td>Nobody, file a ticket</td>
	</tr>
</table>

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

<details>
<summary>You cannot reach the incident lead</summary>
	Escalate to the engineering manager on the rotation, then to the VP. Do not sit on a Sev 1 waiting for a reply.
</details>

<details>
<summary>The dashboard itself is down</summary>
	Treat it as a Sev 2 until proven otherwise and fall back to the raw metrics endpoint.
</details>

<callout icon="📝">
	Write the timeline as you go. Reconstructing it afterwards always loses the detail that mattered.
</callout>
`,
});
