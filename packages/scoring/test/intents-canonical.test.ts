import { readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { canonicalize, diffIntents, isOrderedArray } from "../src/intents-canonical.js"
import { assertIntents, IntentsError, parseIntents, type Intent } from "../src/intents-types.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const templateProbe = JSON.parse(
  readFileSync(path.join(here, "fixtures", "template-probe.intents.json"), "utf8"),
) as Intent[]

/**
 * Deep clone with every occurrence of a mapped resourceId renamed: whole
 * strings, `{{id}}` content mentions and `prop("id")` formula tokens.
 */
function rename(intents: unknown, map: Record<string, string>): Intent[] {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk)
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]))
    }
    if (typeof value !== "string") return value
    if (map[value] !== undefined) return map[value]
    return value
      .replace(/\{\{([^{}]+)\}\}/g, (whole, id: string) =>
        map[id.trim()] !== undefined ? `{{${map[id.trim()]}}}` : whole,
      )
      .replace(/prop\(("|')([^"']+)\1\)/g, (whole, quote: string, id: string) =>
        map[id] !== undefined ? `prop(${quote}${map[id]}${quote})` : whole,
      )
  }
  return walk(JSON.parse(JSON.stringify(intents))) as Intent[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// --- fixtures --------------------------------------------------------------

/** Two databases with a two-way relation, plus a view and two rows. */
function workspace(): Intent[] {
  return [
    { type: "space", resourceId: "sp", name: "Acme" },
    {
      type: "teamspace",
      resourceId: "ts",
      name: "Eng",
      accessLevel: "closed",
      parent: { type: "resourceId", resourceId: "sp" },
    },
    {
      type: "database",
      resourceId: "db-tasks",
      name: "Tasks",
      parent: { type: "resourceId", resourceId: "ts" },
      dataSources: [
        {
          resourceId: "ds-tasks",
          name: "Tasks",
          properties: [
            { resourceId: "p-name", name: "Name", type: "title" },
            {
              resourceId: "p-status",
              name: "Status",
              type: "select",
              options: [
                { name: "Todo", color: "gray" },
                { name: "Doing", color: "blue" },
              ],
            },
            {
              resourceId: "p-project",
              name: "Project",
              type: "relation",
              targetDataSourceResourceId: "ds-projects",
              targetDataSourcePropertyResourceId: "p-tasks",
            },
          ],
        },
      ],
      views: [
        {
          resourceId: "v-table",
          name: "All tasks",
          type: "table",
          dataSourceResourceId: "ds-tasks",
          sorts: [
            { propertyId: "p-status", direction: "ascending" },
            { propertyId: "p-name", direction: "ascending" },
          ],
          filters: [
            { propertyId: "p-status", propertyType: "select", operator: "enum_is", value: "Todo" },
          ],
        },
      ],
    },
    {
      type: "database",
      resourceId: "db-projects",
      name: "Projects",
      parent: { type: "resourceId", resourceId: "ts" },
      dataSources: [
        {
          resourceId: "ds-projects",
          name: "Projects",
          properties: [
            { resourceId: "p-pname", name: "Name", type: "title" },
            {
              resourceId: "p-tasks",
              name: "Tasks",
              type: "relation",
              targetDataSourceResourceId: "ds-tasks",
              targetDataSourcePropertyResourceId: "p-project",
            },
          ],
        },
      ],
    },
    {
      type: "page",
      resourceId: "row-apollo",
      parent: { type: "resourceId", resourceId: "ds-projects" },
      properties: { Name: [["Apollo"]] },
    },
    {
      type: "page",
      resourceId: "row-ship",
      parent: { type: "resourceId", resourceId: "ds-tasks" },
      properties: { Name: [["Ship it"]], Status: "Todo", Project: ["row-apollo"] },
    },
  ]
}

const RENAMES: Record<string, string> = {
  sp: "workspace",
  ts: "zzz-team",
  "db-tasks": "aaa",
  "ds-tasks": "tasks_source",
  "p-name": "prop1",
  "p-status": "prop2",
  "p-project": "prop3",
  "v-table": "the-view",
  "db-projects": "bbb",
  "ds-projects": "projects_source",
  "p-pname": "prop4",
  "p-tasks": "prop5",
  "row-apollo": "r1",
  "row-ship": "r2",
}

// --- tests -----------------------------------------------------------------

describe("canonicalize", () => {
  it("assigns a structural label to every resourceId", () => {
    const doc = canonicalize(workspace())
    expect(Object.keys(doc.idMap).sort()).toEqual(
      [
        "db-projects",
        "db-tasks",
        "ds-projects",
        "ds-tasks",
        "p-name",
        "p-pname",
        "p-project",
        "p-status",
        "p-tasks",
        "row-apollo",
        "row-ship",
        "sp",
        "ts",
        "v-table",
      ].sort(),
    )
    for (const label of Object.values(doc.idMap)) expect(label).toMatch(/^#c\d+$/)
    expect(doc.json).not.toContain("db-tasks")
    expect(doc.ambiguities).toEqual([])
  })

  it("is stable across repeated runs", () => {
    expect(canonicalize(workspace()).json).toBe(canonicalize(workspace()).json)
  })

  it("keeps names, values and unknown fields verbatim", () => {
    const doc = canonicalize(workspace())
    expect(doc.json).toContain('"Ship it"')
    expect(doc.json).toContain('"Projects"')
  })

  it("rejects input that is not an intent array", () => {
    expect(() => canonicalize({ type: "space" })).toThrow(IntentsError)
    expect(() => canonicalize([{ resourceId: "x" }])).toThrow(/type/)
  })
})

describe("diffIntents — renaming invariance", () => {
  it("treats the same structure with different ids as equal", () => {
    const result = diffIntents(workspace(), rename(workspace(), RENAMES))
    expect(result.differences).toEqual([])
    expect(result.equal).toBe(true)
  })

  it("is insensitive to intent emission order", () => {
    const shuffled = clone(workspace()).reverse()
    expect(diffIntents(workspace(), shuffled).equal).toBe(true)
  })

  it("is insensitive to object key order and unordered array order", () => {
    const actual = clone(workspace())
    const db = actual[2] as Record<string, any>
    db.dataSources[0].properties.reverse()
    db.views[0].filters = [...db.views[0].filters]
    actual[3] = Object.fromEntries(Object.entries(actual[3]).reverse()) as never
    expect(diffIntents(workspace(), actual).equal).toBe(true)
  })

  it("round-trips the real template build output under renaming", () => {
    const renamed = rename(templateProbe, {
      sp: "space-1",
      ts: "team-1",
      db: "database-1",
      ds: "source-1",
      "p-title": "prop-title",
      "p-txt": "prop-notes",
      "p-rel": "prop-rel",
      "p-roll": "prop-roll",
      "p-f": "prop-formula",
      "p-auto": "prop-auto",
      "p-file": "prop-file",
      "p-person": "prop-person",
      "v-inline": "view-inline",
      v1: "view-board",
      tmpl: "template-page",
      row1: "row-one",
      ag: "agent-1",
      pg: "page-1",
      f1: "file-1",
      ds2: "source-2",
      "p-rel2": "prop-rel-2",
      "p-num2": "prop-num-2",
      // `pg2` is intentionally left alone: the probe's page content mentions a
      // resource that is never declared, and dangling mentions are not renamed.
    })
    const result = diffIntents(templateProbe, renamed)
    expect(result.differences).toEqual([])
    expect(result.equal).toBe(true)
  })

  it("leaves mentions of undeclared resources verbatim", () => {
    const base: Intent[] = [
      {
        type: "page",
        resourceId: "pg",
        parent: { type: "resourceId", resourceId: "ts" },
        content: 'see <page url="{{ghost}}">x</page>',
      },
      { type: "teamspace", resourceId: "ts", name: "T", accessLevel: "open" },
    ]
    const doc = canonicalize(base)
    expect(doc.json).toContain("{{ghost}}")
    expect(doc.idMap.ghost).toBeUndefined()
  })
})

describe("diffIntents — structural differences", () => {
  it("reports a renamed property", () => {
    const actual = clone(workspace())
    ;(actual[2] as any).dataSources[0].properties[1].name = "State"
    const result = diffIntents(workspace(), actual)
    expect(result.equal).toBe(false)
    const kinds = result.differences.map((d) => d.kind).sort()
    expect(kinds).toContain("missing")
    expect(kinds).toContain("unexpected")
    const missing = result.differences.find((d) => d.kind === "missing")!
    expect(missing.path).toContain('database "Tasks"')
    expect(missing.path).toContain("properties[Status]")
  })

  it("reports a changed scalar with a readable path", () => {
    const actual = clone(workspace())
    ;(actual[2] as any).dataSources[0].properties[1].options[1].color = "red"
    const result = diffIntents(workspace(), actual)
    expect(result.equal).toBe(false)
    expect(result.differences[0].kind).toBe("changed")
    expect(result.differences[0].path).toMatch(/properties\[Status\]\.options\[1\]\.color/)
    expect(result.differences[0].message).toContain('"blue"')
    expect(result.differences[0].message).toContain('"red"')
  })

  it("reports a missing and an unexpected intent", () => {
    const missingRow = clone(workspace()).filter((i) => i.resourceId !== "row-ship")
    const missing = diffIntents(workspace(), missingRow)
    expect(missing.equal).toBe(false)
    expect(missing.differences.some((d) => d.kind === "missing")).toBe(true)

    const extra = clone(workspace())
    extra.push({
      type: "page",
      resourceId: "row-extra",
      parent: { type: "resourceId", resourceId: "ds-tasks" },
      properties: { Name: [["Extra"]] },
    })
    const unexpected = diffIntents(workspace(), extra)
    expect(unexpected.equal).toBe(false)
    expect(unexpected.differences.some((d) => d.kind === "unexpected")).toBe(true)
  })

  it("detects a missing field", () => {
    const actual = clone(workspace())
    delete (actual[2] as any).dataSources[0].properties[2].targetDataSourcePropertyResourceId
    const result = diffIntents(workspace(), actual)
    expect(result.equal).toBe(false)
    expect(result.differences.some((d) => d.kind === "missing")).toBe(true)
  })

  it("detects unknown/extra fields (passthrough participates in equality)", () => {
    const actual = clone(workspace())
    ;(actual[2] as any).futureField = { nested: true }
    const result = diffIntents(workspace(), actual)
    expect(result.equal).toBe(false)
    expect(result.differences.some((d) => d.kind === "unexpected" && d.path.includes("futureField"))).toBe(
      true,
    )
  })

  it("caps the number of reported differences", () => {
    const actual = clone(workspace()).slice(0, 1)
    const result = diffIntents(workspace(), actual, { maxDifferences: 2 })
    expect(result.differences.length).toBeLessThanOrEqual(2)
  })
})

describe("diffIntents — reference graph isomorphism", () => {
  /** Two databases, each with one relation property; `crossed` swaps the targets. */
  function pair(crossed: boolean): Intent[] {
    return [
      {
        type: "database",
        resourceId: "d1",
        name: "Alpha",
        parent: { type: "resourceId", resourceId: "ts" },
        dataSources: [
          {
            resourceId: "s1",
            name: "Alpha",
            properties: [
              { resourceId: "a-title", name: "Name", type: "title" },
              {
                resourceId: "a-rel",
                name: "Link",
                type: "relation",
                targetDataSourceResourceId: crossed ? "s1" : "s2",
              },
            ],
          },
        ],
      },
      {
        type: "database",
        resourceId: "d2",
        name: "Beta",
        parent: { type: "resourceId", resourceId: "ts" },
        dataSources: [
          {
            resourceId: "s2",
            name: "Beta",
            properties: [
              { resourceId: "b-title", name: "Name", type: "title" },
              {
                resourceId: "b-rel",
                name: "Link",
                type: "relation",
                targetDataSourceResourceId: crossed ? "s2" : "s1",
              },
            ],
          },
        ],
      },
      { type: "teamspace", resourceId: "ts", name: "T", accessLevel: "open" },
    ]
  }

  it("accepts an isomorphic reference graph with permuted ids", () => {
    const renamed = rename(pair(false), {
      d1: "database-alpha",
      s1: "source-alpha",
      "a-title": "z1",
      "a-rel": "z2",
      d2: "database-beta",
      s2: "source-beta",
      "b-title": "y1",
      "b-rel": "y2",
      ts: "team",
    })
    expect(diffIntents(pair(false), renamed).equal).toBe(true)
  })

  it("rejects a graph with the same objects but different edges", () => {
    // identical multiset of intents/properties, only the relation targets moved
    const result = diffIntents(pair(false), pair(true))
    expect(result.equal).toBe(false)
    expect(result.differences.length).toBeGreaterThan(0)
  })

  it("follows relation values on pages", () => {
    const expected = workspace()
    const actual = clone(workspace())
    // point the row's relation at itself instead of the project row
    ;(actual[5] as any).properties.Project = ["row-ship"]
    expect(diffIntents(expected, actual).equal).toBe(false)
    // ...and renaming that target is still fine
    expect(diffIntents(expected, rename(workspace(), RENAMES)).equal).toBe(true)
  })

  it("does not mistake select values for resourceIds", () => {
    const expected = clone(workspace())
    const actual = clone(workspace())
    ;(actual[5] as any).properties.Status = "Doing"
    const result = diffIntents(expected, actual)
    expect(result.equal).toBe(false)
    expect(result.differences[0].message).toContain("Doing")
  })

  it("rewrites {{resourceId}} mentions inside page content", () => {
    const base: Intent[] = [
      {
        type: "page",
        resourceId: "hub",
        parent: { type: "resourceId", resourceId: "ts" },
        properties: { title: [["Hub"]] },
        content: '# Team\n<page url="{{child}}">Getting Started</page>',
      },
      {
        type: "page",
        resourceId: "child",
        parent: { type: "resourceId", resourceId: "hub" },
        properties: { title: [["Getting Started"]] },
      },
      { type: "teamspace", resourceId: "ts", name: "T", accessLevel: "open" },
    ]
    const renamed = rename(base, { hub: "home", child: "start-here", ts: "team" })
    expect(diffIntents(base, renamed).equal).toBe(true)

    const wrongTarget = clone(base)
    ;(wrongTarget[0] as any).content = '# Team\n<page url="{{hub}}">Getting Started</page>'
    expect(diffIntents(base, wrongTarget).equal).toBe(false)
  })

  it("collapses structurally indistinguishable resources instead of guessing", () => {
    const twins = (n: number): Intent[] => {
      const out: Intent[] = [{ type: "teamspace", resourceId: "ts", name: "T", accessLevel: "open" }]
      for (let i = 0; i < n; i++) {
        out.push({
          type: "page",
          resourceId: `twin-${i}`,
          parent: { type: "resourceId", resourceId: "ts" },
          properties: { title: [["Same"]] },
        })
      }
      return out
    }
    expect(diffIntents(twins(2), rename(twins(2), { "twin-0": "b", "twin-1": "a" })).equal).toBe(true)
    const three = diffIntents(twins(2), twins(3))
    expect(three.equal).toBe(false)
    expect(three.differences.some((d) => d.kind === "unexpected")).toBe(true)
  })
})

describe("value normalization", () => {
  it("treats the interchangeable page property value shapes as equal", () => {
    const actual = clone(workspace())
    ;(actual[4] as any).properties.Name = "Apollo" // instead of [["Apollo"]]
    ;(actual[5] as any).properties.Project = "row-apollo" // instead of ["row-apollo"]
    expect(diffIntents(workspace(), actual).equal).toBe(true)

    const strict = diffIntents(workspace(), actual, { normalizePropertyValues: false })
    expect(strict.equal).toBe(false)
  })

  it("normalizes numeric property values to their string form", () => {
    const make = (value: unknown): Intent[] => [
      {
        type: "page",
        resourceId: "row",
        parent: { type: "resourceId", resourceId: "ds" },
        properties: { Count: value as never },
      },
    ]
    expect(diffIntents(make(5), make("5")).equal).toBe(true)
    expect(diffIntents(make(5), make(6)).equal).toBe(false)
  })

  it("still distinguishes different values", () => {
    const actual = clone(workspace())
    ;(actual[4] as any).properties.Name = "Artemis"
    expect(diffIntents(workspace(), actual).equal).toBe(false)
  })

  it("rewrites prop(\"<resourceId>\") inside formula expressions", () => {
    const withFormula = (): Intent[] => {
      const intents = clone(workspace())
      ;(intents[2] as any).dataSources[0].properties.push({
        resourceId: "p-formula",
        name: "Label",
        type: "formula",
        expression: 'concat(prop("p-name"), " - ", prop("p-status"))',
      })
      return intents
    }
    const renamed = rename(withFormula(), { ...RENAMES, "p-formula": "zzz" })
    expect(diffIntents(withFormula(), renamed).equal).toBe(true)

    // pointing the formula at a different property is a real difference
    const wrong = withFormula()
    ;(wrong[2] as any).dataSources[0].properties[3].expression =
      'concat(prop("p-status"), " - ", prop("p-status"))'
    expect(diffIntents(withFormula(), wrong).equal).toBe(false)
  })

  it("leaves prop() tokens that are not declared resourceIds verbatim", () => {
    const intents: Intent[] = [
      {
        type: "database",
        resourceId: "db",
        name: "D",
        parent: { type: "resourceId", resourceId: "ts" },
        dataSources: [
          {
            resourceId: "ds",
            name: "D",
            properties: [
              { resourceId: "p1", name: "Name", type: "title" },
              { resourceId: "p2", name: "F", type: "formula", expression: 'prop("Name")' },
            ],
          },
        ],
      },
      { type: "teamspace", resourceId: "ts", name: "T", accessLevel: "open" },
    ]
    expect(canonicalize(intents).json).toContain('prop(\\"Name\\")')
  })
})

describe("diffIntents — pinned resourceIds", () => {
  const pinned = ["db-tasks", "ds-tasks", "p-status"]

  it("passes when the pinned ids are unchanged and the rest is renamed", () => {
    const map = { ...RENAMES }
    for (const id of pinned) delete map[id]
    const result = diffIntents(workspace(), rename(workspace(), map), { pinnedResourceIds: pinned })
    expect(result.differences).toEqual([])
    expect(result.equal).toBe(true)
  })

  it("fails when a pinned id was renamed, even though the structure matches", () => {
    const result = diffIntents(workspace(), rename(workspace(), { "p-status": "p-state" }), {
      pinnedResourceIds: pinned,
    })
    expect(result.equal).toBe(false)
    expect(result.differences.some((d) => d.kind === "pinned-id-missing")).toBe(true)
    expect(result.differences.find((d) => d.kind === "pinned-id-missing")!.message).toContain(
      "p-status",
    )
  })

  it("uses literal labels for pinned ids", () => {
    const doc = canonicalize(workspace(), { pinnedResourceIds: pinned })
    expect(doc.idMap["db-tasks"]).toBe("#!db-tasks")
    expect(doc.idMap["p-name"]).toMatch(/^#c\d+$/)
  })

  it("still detects structural changes while ids are pinned", () => {
    const actual = clone(workspace())
    ;(actual[2] as any).dataSources[0].properties[1].options.pop()
    const result = diffIntents(workspace(), actual, { pinnedResourceIds: pinned })
    expect(result.equal).toBe(false)
  })

  it("reports a pinned id that only exists in the actual intents", () => {
    const result = diffIntents(workspace(), workspace(), { pinnedResourceIds: ["not-there"] })
    expect(result.equal).toBe(true)
    const actual = clone(workspace())
    ;(actual[4] as any).resourceId = "not-there"
    const unexpected = diffIntents(workspace(), actual, { pinnedResourceIds: ["not-there"] })
    expect(unexpected.differences.some((d) => d.kind === "pinned-id-unexpected")).toBe(true)
  })
})

describe("array order policy", () => {
  it("treats semantic sibling order as significant", () => {
    expect(isOrderedArray("$database.views[].sorts")).toBe(true)
    expect(isOrderedArray("$view.view.properties")).toBe(true)
    expect(isOrderedArray("$database.views[].properties")).toBe(true)
    expect(isOrderedArray("$database.dataSources[].properties[].options")).toBe(true)
    expect(isOrderedArray("$database.dataSources[].pageLayout.properties")).toBe(true)
    expect(isOrderedArray("$view.view.columns")).toBe(true)
  })

  it("treats declaration order as insignificant", () => {
    expect(isOrderedArray("$database.dataSources")).toBe(false)
    expect(isOrderedArray("$database.dataSources[].properties")).toBe(false)
    expect(isOrderedArray("$database.views")).toBe(false)
    expect(isOrderedArray("$view.view.filters")).toBe(false)
    expect(isOrderedArray("$space.members")).toBe(false)
  })

  it("flags a reordered sort chain but not a reordered filter list", () => {
    const reorderedSorts = clone(workspace())
    ;(reorderedSorts[2] as any).views[0].sorts.reverse()
    const sorts = diffIntents(workspace(), reorderedSorts)
    expect(sorts.equal).toBe(false)

    const withTwoFilters = clone(workspace())
    ;(withTwoFilters[2] as any).views[0].filters.push({
      propertyId: "p-name",
      propertyType: "title",
      operator: "string_contains",
      value: "a",
    })
    const flipped = clone(withTwoFilters)
    ;(flipped[2] as any).views[0].filters.reverse()
    expect(diffIntents(withTwoFilters, flipped).equal).toBe(true)
  })

  it("flags reordered select options", () => {
    const actual = clone(workspace())
    ;(actual[2] as any).dataSources[0].properties[1].options.reverse()
    expect(diffIntents(workspace(), actual).equal).toBe(false)
  })
})

describe("intent parsing helpers", () => {
  it("parses a built intents.json", () => {
    const intents = parseIntents(JSON.stringify(templateProbe))
    expect(intents).toHaveLength(templateProbe.length)
  })

  it("reports parse and shape errors with the source name", () => {
    expect(() => parseIntents("{", "dist/intents.json")).toThrow(/dist\/intents\.json: invalid JSON/)
    expect(() => parseIntents('{"type":"space"}', "dist/intents.json")).toThrow(/expected a JSON array/)
    expect(() => assertIntents([null])).toThrow(/expected an object/)
  })
})
