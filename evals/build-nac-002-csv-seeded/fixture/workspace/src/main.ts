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

// Describe the workspace below. Everything you create with `notion.*` is
// recorded as an intent and written to dist/intents.json by `npm run build`.
void notion;
