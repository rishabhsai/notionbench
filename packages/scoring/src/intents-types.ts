/**
 * TypeScript mirror of the intent objects a Notion-as-Code project emits to
 * `dist/intents.json` (`npm run build`).
 *
 * This is a deliberately *pragmatic subset* of the template's `src/lib/types.d.ts`:
 * the fields the canonicalizer needs to reason about are typed, everything else
 * is kept as an `unknown` passthrough via the index signature. Unrecognized
 * fields still participate in equality — the canonicalizer walks raw JSON and
 * never drops keys it does not know about.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }

export type ResourceId = string

/** `parent: { type: "resourceId", resourceId }` — a reference, not a declaration. */
export interface ResourceRef {
  type: "resourceId"
  resourceId: ResourceId
  [key: string]: unknown
}

/** `{ type: "file", resourceId }` — reference into the file manifest. */
export interface FileRef {
  type: "file"
  resourceId: ResourceId
  /** Present when used as a page/database cover. */
  position?: number
  [key: string]: unknown
}

export interface EmojiIcon {
  type: "emoji"
  emoji: string
  [key: string]: unknown
}

export interface NotionIcon {
  type: "notion_icon"
  description: string
  color?: string
  [key: string]: unknown
}

export type Icon = EmojiIcon | NotionIcon | FileRef
export type CoverRef = FileRef | { type: "url"; url: string; position?: number; [key: string]: unknown }

/** Property schema entry inside `database.dataSources[].properties[]`. */
export interface PropertySchema {
  resourceId: ResourceId
  name: string
  type: string
  /** relation */
  targetDataSourceResourceId?: ResourceId
  targetDataSourcePropertyResourceId?: ResourceId
  /** rollup */
  relationPropertyResourceId?: ResourceId
  targetPropertyResourceId?: ResourceId
  targetPropertyType?: string
  aggregation?: string
  /** select / multi_select */
  options?: unknown
  /** formula */
  expression?: string
  [key: string]: unknown
}

export interface DataSourceSchema {
  resourceId: ResourceId
  name: string
  icon?: Icon
  /** resourceId of a template page */
  defaultTemplate?: ResourceId
  pageLayout?: JsonObject
  properties: PropertySchema[]
  [key: string]: unknown
}

export interface ViewSchema {
  resourceId: ResourceId
  name?: string
  type: string
  dataSourceResourceId: ResourceId
  defaultTemplate?: ResourceId
  sorts?: Array<{ propertyId: ResourceId; direction: string; [key: string]: unknown }>
  filters?: Array<{ propertyId: ResourceId; [key: string]: unknown }>
  properties?: Array<{ property: ResourceId; [key: string]: unknown }>
  columns?: Array<{ property: ResourceId; [key: string]: unknown }>
  groupBy?: { property: ResourceId; [key: string]: unknown }
  calendarBy?: ResourceId
  timelineBy?: ResourceId
  timelineByEnd?: ResourceId
  [key: string]: unknown
}

export interface SpaceIntent {
  type: "space"
  resourceId: ResourceId
  name: string
  icon?: Icon
  members?: Array<JsonObject>
  [key: string]: unknown
}

export interface TeamspaceIntent {
  type: "teamspace"
  resourceId: ResourceId
  name: string
  accessLevel?: string
  parent?: ResourceRef
  icon?: Icon
  description?: string
  [key: string]: unknown
}

export interface DatabaseIntent {
  type: "database"
  resourceId: ResourceId
  parent: ResourceRef
  name?: string
  description?: string
  icon?: Icon
  cover?: CoverRef
  dataSources: DataSourceSchema[]
  views?: ViewSchema[]
  [key: string]: unknown
}

export interface PageIntent {
  type: "page"
  resourceId: ResourceId
  parent: ResourceRef
  /**
   * Property values keyed by property NAME (not resourceId). Relation values
   * are arrays of page resourceIds; file values are arrays of `FileRef`;
   * text values are arrays of token arrays.
   */
  properties?: Record<string, Json>
  content?: string
  icon?: Icon
  cover?: CoverRef
  template?: boolean
  updateExisting?: boolean
  [key: string]: unknown
}

export interface ViewIntent {
  type: "view"
  databaseResourceId: ResourceId
  view: ViewSchema
  [key: string]: unknown
}

export interface FileAttachmentIntent {
  type: "file_attachment"
  /** resourceId of the file in the manifest */
  resourceId: ResourceId
  parentResourceId: ResourceId
  propertyName?: string
  [key: string]: unknown
}

export interface CustomAgentIntent {
  type: "custom_agent"
  resourceId: ResourceId
  name: string
  icon?: EmojiIcon | NotionIcon
  instructions?: string
  model?: string
  sharedResources?: ResourceId[]
  [key: string]: unknown
}

/** Any intent, including types this build of the package does not know about. */
export interface UnknownIntent {
  type: string
  [key: string]: unknown
}

export type Intent =
  | SpaceIntent
  | TeamspaceIntent
  | DatabaseIntent
  | PageIntent
  | ViewIntent
  | FileAttachmentIntent
  | CustomAgentIntent
  | UnknownIntent

export const KNOWN_INTENT_TYPES = [
  "space",
  "teamspace",
  "database",
  "page",
  "view",
  "file_attachment",
  "custom_agent",
] as const

export type KnownIntentType = (typeof KNOWN_INTENT_TYPES)[number]

export class IntentsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "IntentsError"
  }
}

/**
 * Validate the coarse shape of a built `dist/intents.json`: a flat array of
 * objects each carrying a string `type`. Intent types beyond
 * `KNOWN_INTENT_TYPES` are accepted (forward compatibility) — everything is
 * canonicalized structurally anyway.
 */
export function assertIntents(value: unknown, source = "intents"): Intent[] {
  if (!Array.isArray(value)) {
    throw new IntentsError(`${source}: expected a JSON array of intents, got ${describe(value)}`)
  }
  value.forEach((intent, i) => {
    if (intent === null || typeof intent !== "object" || Array.isArray(intent)) {
      throw new IntentsError(`${source}[${i}]: expected an object, got ${describe(intent)}`)
    }
    if (typeof (intent as { type?: unknown }).type !== "string") {
      throw new IntentsError(`${source}[${i}]: missing string \`type\` discriminator`)
    }
  })
  return value as Intent[]
}

/** Parse the text of a `dist/intents.json`. */
export function parseIntents(text: string, source = "intents.json"): Intent[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new IntentsError(`${source}: invalid JSON (${(err as Error).message})`)
  }
  return assertIntents(parsed, source)
}

function describe(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}
