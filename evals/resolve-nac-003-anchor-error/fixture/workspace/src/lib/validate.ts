// Vendored from the Notion SDK's Notion-as-Code toolchain. Do not edit by
// hand; update it from the SDK when the validation rules change.
//
// `ntn notion-as-code apply` resolves a project against exactly one workspace
// anchor: either a new space the project creates, or an existing workspace the
// project's top-level resources are parented to. The build runs the same check
// so a project that cannot be applied fails locally instead of half-way through
// an apply.

import type { InfraAsCodeIntent } from "./types";

/**
 * Every resourceId the document *declares*, at any depth — intents, data
 * sources, properties, views. `{ type: "resourceId" }` objects are references
 * to a resource, not declarations of one.
 */
function declaredResourceIds(intents: InfraAsCodeIntent[]): Set<string> {
  const declared = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const node = value as Record<string, unknown>;
    if (typeof node.resourceId === "string" && node.type !== "resourceId") {
      declared.add(node.resourceId);
    }
    for (const child of Object.values(node)) walk(child);
  };
  walk(intents);
  return declared;
}

/**
 * Parent references that point outside the project. Each one is a resource that
 * `apply` has to resolve against something that already exists in Notion — an
 * anchor.
 */
function externalAnchors(intents: InfraAsCodeIntent[]): string[] {
  const declared = declaredResourceIds(intents);
  const anchors = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const node = value as Record<string, unknown>;
    const parent = node.parent as { resourceId?: unknown } | undefined;
    if (
      parent !== undefined &&
      parent !== null &&
      typeof parent.resourceId === "string" &&
      !declared.has(parent.resourceId)
    ) {
      anchors.add(parent.resourceId);
    }
    for (const child of Object.values(node)) walk(child);
  };
  walk(intents);
  return [...anchors];
}

/**
 * Throws when the intent document does not describe exactly one workspace
 * anchor. Called by the build before `dist/intents.json` is written.
 */
export function validateIntents(intents: InfraAsCodeIntent[]): void {
  if (intents.length === 0) return;

  const spaces = intents.filter(intent => intent.type === "space");
  const external = externalAnchors(intents);
  const anchors = [
    ...spaces.map(space => `new space "${space.resourceId}" (created by notion.space)`),
    ...external.map(id => `existing workspace "${id}" (referenced as a parent, not declared in this project)`),
  ];

  if (anchors.length > 1) {
    throw new Error(
      `Notion as Code: this project describes ${anchors.length} workspace anchors, but a project is ` +
        `applied against exactly one:\n` +
        anchors.map(anchor => `  - ${anchor}`).join("\n"),
    );
  }
  if (anchors.length === 0) {
    throw new Error(
      "Notion as Code: this project describes no workspace anchor — every resource is parented inside the " +
        "project, so there is nothing for `apply` to attach it to.",
    );
  }
}
