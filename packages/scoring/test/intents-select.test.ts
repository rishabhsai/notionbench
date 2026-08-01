import { describe, expect, it } from "vitest"
import {
  collectResources,
  dataSources,
  intentsOfType,
  pagesUnder,
  propDate,
  propText,
  propertiesOf,
  propertyValues,
  views,
} from "../src/intents-select.js"
import type { Json } from "../src/intents-types.js"

/** A miniature but shape-accurate NAC build output. */
const DOC: Json[] = [
  { type: "teamspace", resourceId: "ts", name: "Product Ops" },
  {
    type: "database",
    resourceId: "db",
    parent: { type: "resourceId", resourceId: "ts" },
    name: "Launch Tracker",
    dataSources: [
      {
        resourceId: "ds",
        name: "Launch Tracker",
        properties: [
          { resourceId: "p-name", name: "Name", type: "title" },
          {
            resourceId: "p-stage",
            name: "Stage",
            type: "select",
            options: [{ name: "Planning", color: "blue" }],
          },
        ],
      },
    ],
    views: [{ resourceId: "v-board", name: "By Stage", type: "board", dataSourceResourceId: "ds" }],
  },
  {
    type: "view",
    databaseResourceId: "db",
    view: { resourceId: "v-table", name: "All", type: "table", dataSourceResourceId: "ds" },
  },
  {
    type: "page",
    resourceId: "pg-1",
    parent: { type: "resourceId", resourceId: "ds" },
    properties: {
      Name: [["Beta invites"]],
      Stage: "Planning",
      Blocked: false,
      "Target Date": [["2026-08-14", [["d", { start_date: "2026-08-14" }]]]],
    },
  },
  {
    type: "page",
    resourceId: "pg-elsewhere",
    parent: { type: "resourceId", resourceId: "ts" },
    properties: {},
  },
]

describe("selectors", () => {
  it("filters top-level intents by type", () => {
    expect(intentsOfType(DOC, "teamspace").map((t) => t.name)).toEqual(["Product Ops"])
    expect(intentsOfType(DOC, "page")).toHaveLength(2)
    expect(intentsOfType(DOC, "nope")).toEqual([])
  })

  it("collects data sources across database intents", () => {
    expect(dataSources(DOC).map((d) => d.resourceId)).toEqual(["ds"])
  })

  it("reads a data source's property schemas", () => {
    expect(propertiesOf(dataSources(DOC)[0]!).map((p) => p.name)).toEqual(["Name", "Stage"])
  })

  it("returns [] for a data source with no properties array", () => {
    expect(propertiesOf({ resourceId: "x" })).toEqual([])
  })

  it("collects inline views and views added by a standalone view intent", () => {
    expect(views(DOC).map((v) => v.resourceId)).toEqual(["v-board", "v-table"])
  })

  it("finds pages parented to a specific resource", () => {
    expect(pagesUnder(DOC, "ds").map((p) => p.resourceId)).toEqual(["pg-1"])
    expect(pagesUnder(DOC, "missing")).toEqual([])
  })

  it("exposes page property values keyed by name", () => {
    const page = pagesUnder(DOC, "ds")[0]!
    expect(Object.keys(propertyValues(page)).sort()).toEqual(["Blocked", "Name", "Stage", "Target Date"])
    expect(propertyValues({ type: "page" })).toEqual({})
  })
})

describe("propText", () => {
  it("flattens the interchangeable text shapes", () => {
    expect(propText([["Beta invites"]])).toBe("Beta invites")
    expect(propText([["Beta "], ["invites"]])).toBe("Beta invites")
    expect(propText("Planning")).toBe("Planning")
    expect(propText(7)).toBe("7")
  })

  it("renders checkboxes the way the property table writes them", () => {
    expect(propText(true)).toBe("Yes")
    expect(propText(false)).toBe("No")
  })

  it("is undefined for absent or non-textual values", () => {
    expect(propText(undefined)).toBeUndefined()
    expect(propText(null)).toBeUndefined()
    expect(propText({ a: 1 })).toBeUndefined()
  })
})

describe("propDate", () => {
  it("extracts a start date from a notion.date() token array", () => {
    expect(propDate([["2026-08-14", [["d", { start_date: "2026-08-14" }]]]])).toEqual({
      start: "2026-08-14",
    })
  })

  it("extracts a range", () => {
    expect(
      propDate([["x", [["d", { start_date: "2026-08-14", end_date: "2026-08-20" }]]]]),
    ).toEqual({ start: "2026-08-14", end: "2026-08-20" })
  })

  it("is undefined when there is no date annotation", () => {
    expect(propDate([["plain text"]])).toBeUndefined()
    expect(propDate("2026-08-14")).toBeUndefined()
    expect(propDate(undefined)).toBeUndefined()
  })
})

describe("collectResources", () => {
  const resources = collectResources(DOC)

  it("collects every declaring object, keyed by resourceId", () => {
    expect([...resources.keys()].sort()).toEqual(
      ["db", "ds", "p-name", "p-stage", "pg-1", "pg-elsewhere", "ts", "v-board", "v-table"].sort(),
    )
  })

  it("does not treat a parent reference as a declaration", () => {
    // `ts` is declared by the teamspace intent, not by the database's parent link.
    expect(resources.get("ts")!.node.type).toBe("teamspace")
  })

  it("records the nearest enclosing declared resource", () => {
    expect(resources.get("ds")!.ancestor).toBe("db")
    expect(resources.get("p-stage")!.ancestor).toBe("ds")
    expect(resources.get("db")!.ancestor).toBeUndefined()
  })

  it("labels resources by their container", () => {
    expect(resources.get("ds")!.kind).toBe("dataSource")
    expect(resources.get("p-name")!.kind).toBe("property")
    expect(resources.get("v-board")!.kind).toBe("view")
    expect(resources.get("v-table")!.kind).toBe("view")
    expect(resources.get("pg-1")!.kind).toBe("page")
  })

  it("ignores a bare file reference but keeps a file property schema", () => {
    const doc: Json[] = [
      {
        type: "page",
        resourceId: "p",
        cover: { type: "file", resourceId: "logo.png" },
      },
      {
        type: "database",
        resourceId: "d",
        dataSources: [
          {
            resourceId: "d-ds",
            properties: [{ resourceId: "attachments", name: "Files", type: "file" }],
          },
        ],
      },
    ]
    const found = collectResources(doc)
    expect(found.has("logo.png")).toBe(false)
    expect(found.get("attachments")!.kind).toBe("property")
  })
})
