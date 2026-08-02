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

describe("inline vs separate view spellings", () => {
  /**
   * Move the inline `database.views[]` entries whose resourceId is in `ids`
   * (default: all of them) into standalone `view` intents — i.e. rewrite the
   * document from the `notion.database({views:[…]})` spelling into the
   * `db.addView(…)` spelling, exactly as an agent could have authored it.
   */
  function separate(intents: Intent[], ids?: string[]): Intent[] {
    const out: Intent[] = []
    for (const intent of clone(intents)) {
      const db = intent as any
      if (db.type !== "database" || !Array.isArray(db.views)) {
        out.push(intent)
        continue
      }
      const move = db.views.filter((v: any) => ids === undefined || ids.includes(v.resourceId))
      const keep = db.views.filter((v: any) => !move.includes(v))
      if (keep.length > 0) db.views = keep
      else delete db.views
      out.push(intent)
      for (const view of move) {
        out.push({ type: "view", databaseResourceId: db.resourceId, view })
      }
    }
    return out
  }

  /** `workspace()` plus a second (board) view on Tasks, declared inline. */
  function twoViews(): Intent[] {
    const intents = clone(workspace())
    ;(intents[2] as any).views.push({
      resourceId: "v-board",
      name: "By status",
      type: "board",
      dataSourceResourceId: "ds-tasks",
      groupBy: { property: "p-status", type: "select" },
    })
    return intents
  }

  it("treats an inline-only and a separate-only workspace as equal", () => {
    const inline = twoViews()
    const separated = separate(inline)
    // sanity: the two documents really are spelled differently
    expect(separated.filter((i) => i.type === "view")).toHaveLength(2)
    expect((inline[2] as any).views).toHaveLength(2)

    const result = diffIntents(inline, separated)
    expect(result.differences).toEqual([])
    expect(result.equal).toBe(true)
    // ...and symmetrically
    expect(diffIntents(separated, inline).equal).toBe(true)
  })

  it("treats a mixed spelling as equal to an all-separate one", () => {
    const mixed = separate(twoViews(), ["v-board"]) // v-table stays inline
    expect((mixed[2] as any).views).toHaveLength(1)
    expect(mixed.filter((i) => i.type === "view")).toHaveLength(1)

    expect(diffIntents(separate(twoViews()), mixed).equal).toBe(true)
    expect(diffIntents(mixed, twoViews()).equal).toBe(true)
  })

  it("is insensitive to where the views sit in the document", () => {
    const separated = separate(twoViews())
    const shuffled = clone(separated).reverse()
    expect(diffIntents(separated, shuffled).equal).toBe(true)

    const swappedInline = twoViews()
    ;(swappedInline[2] as any).views.reverse()
    expect(diffIntents(twoViews(), swappedInline).equal).toBe(true)
    expect(diffIntents(separated, swappedInline).equal).toBe(true)
  })

  it("survives resourceId renaming across spellings", () => {
    const renamed = rename(separate(twoViews()), { ...RENAMES, "v-board": "board-1" })
    expect(diffIntents(twoViews(), renamed).equal).toBe(true)
  })

  it("still reports a genuinely different view config, readably", () => {
    const expectedIntents = twoViews() // board grouped by Status, inline
    const actualIntents = separate(twoViews()) // ...separate, but grouped by Name
    const board = actualIntents.find((i) => (i as any).view?.resourceId === "v-board") as any
    board.view.groupBy = { property: "p-name", type: "title" }

    const result = diffIntents(expectedIntents, actualIntents)
    expect(result.equal).toBe(false)
    expect(result.differences.length).toBeGreaterThan(0)
    const rendered = result.differences.map((d) => `[${d.kind}] ${d.path}: ${d.message}`)
    // the report points at the board view's grouping, not at the spelling
    expect(rendered.some((line) => line.includes('view "By status"'))).toBe(true)
    expect(rendered.some((line) => line.includes("groupBy"))).toBe(true)
    for (const line of rendered) {
      expect(line).not.toMatch(/addView|inline|spelling/i)
    }
  })

  it("still reports a view that is missing in either spelling", () => {
    const withoutBoard = separate(workspace()) // only the table view
    const missing = diffIntents(twoViews(), withoutBoard)
    expect(missing.equal).toBe(false)
    expect(missing.differences.some((d) => d.kind === "missing")).toBe(true)

    const extra = diffIntents(workspace(), separate(twoViews()))
    expect(extra.equal).toBe(false)
    expect(extra.differences.some((d) => d.kind === "unexpected")).toBe(true)
  })

  it("keeps view-internal order significant after lifting", () => {
    const separated = separate(workspace())
    const flippedSorts = clone(separated)
    ;(flippedSorts.find((i) => i.type === "view") as any).view.sorts.reverse()
    expect(diffIntents(separated, flippedSorts).equal).toBe(false)
    // ...against the inline spelling too
    expect(diffIntents(workspace(), flippedSorts).equal).toBe(false)
  })

  it("lifts inline views into synthetic view intents during canonicalization", () => {
    const doc = canonicalize(twoViews())
    const views = doc.intents.filter((i: any) => i.type === "view")
    expect(views).toHaveLength(2)
    for (const v of views as any[]) {
      expect(v.databaseResourceId).toBe(doc.idMap["db-tasks"])
    }
    expect(doc.json).not.toContain('"views"')
  })

  it("leaves a database with no views alone", () => {
    const noViews = clone(workspace())
    delete (noViews[2] as any).views
    expect(canonicalize(noViews).intents.some((i: any) => i.type === "view")).toBe(false)
    expect(diffIntents(noViews, clone(noViews)).equal).toBe(true)
    // the Projects database never had `views` at all and is untouched
    expect(canonicalize(workspace()).json).toContain('"Projects"')
    // a database that lost its only view is still a real difference
    expect(diffIntents(workspace(), noViews).equal).toBe(false)
  })

  it("treats an empty inline views array as no views", () => {
    const empty = clone(workspace())
    ;(empty[2] as any).views = []
    const absent = clone(workspace())
    delete (absent[2] as any).views
    expect(diffIntents(absent, empty).equal).toBe(true)
  })

  it("leaves a malformed `views` field untouched (it still participates in equality)", () => {
    const odd = clone(workspace())
    ;(odd[2] as any).views = "not an array"
    expect(canonicalize(odd).json).toContain("not an array")
    expect(diffIntents(workspace(), odd).equal).toBe(false)
  })

  it("keeps pinned resourceIds working across spellings", () => {
    const pinned = ["db-tasks", "v-table"]
    const map = { ...RENAMES }
    for (const id of pinned) delete map[id]

    const inline = workspace()
    const separated = rename(separate(workspace()), map)
    const result = diffIntents(inline, separated, { pinnedResourceIds: pinned })
    expect(result.differences).toEqual([])
    expect(result.equal).toBe(true)

    // the pinned view id must still be required, whichever spelling is used
    const renamedView = diffIntents(inline, rename(separate(workspace()), { "v-table": "v-other" }), {
      pinnedResourceIds: pinned,
    })
    expect(renamedView.equal).toBe(false)
    expect(renamedView.differences.some((d) => d.kind === "pinned-id-missing")).toBe(true)

    // and so must the pinned database id the lifted view now points at
    const renamedDb = diffIntents(inline, rename(separate(workspace()), { "db-tasks": "db-other" }), {
      pinnedResourceIds: pinned,
    })
    expect(renamedDb.equal).toBe(false)
    expect(renamedDb.differences.some((d) => d.kind === "pinned-id-missing")).toBe(true)
  })

  it("can be opted out of, to assert one spelling", () => {
    const strict = diffIntents(workspace(), separate(workspace()), { normalizeInlineViews: false })
    expect(strict.equal).toBe(false)
    expect(strict.differences.some((d) => d.kind === "unexpected")).toBe(true)

    // the same spelling still compares fine with normalization off
    expect(
      diffIntents(separate(workspace()), separate(workspace()), { normalizeInlineViews: false }).equal,
    ).toBe(true)
    expect(canonicalize(workspace(), { normalizeInlineViews: false }).json).toContain('"views"')
  })

  it("accepts the real template probe in either spelling", () => {
    // the probe carries both an inline view (`v-inline`) and an `addView` one (`v1`)
    expect(diffIntents(templateProbe, separate(templateProbe)).equal).toBe(true)
  })
})

describe("derived view groupBy.type", () => {
  /**
   * A board view grouped by Status. `groupBy` is spliced in verbatim so a test
   * can omit `type`, state it correctly, or state it wrongly.
   */
  function board(groupBy: unknown, opts: { dataSource?: string; property?: string } = {}): Intent[] {
    return [
      { type: "teamspace", resourceId: "ts", name: "T", accessLevel: "open" },
      {
        type: "database",
        resourceId: "db",
        name: "Tasks",
        parent: { type: "resourceId", resourceId: "ts" },
        dataSources: [
          {
            resourceId: "ds",
            name: "Tasks",
            properties: [
              { resourceId: "p-name", name: "Name", type: "title" },
              {
                resourceId: "p-status",
                name: "Status",
                type: "select",
                options: [{ name: "Todo", color: "gray" }],
              },
            ],
          },
        ],
      },
      {
        type: "view",
        databaseResourceId: "db",
        view: {
          resourceId: "v",
          name: "By Status",
          type: "board",
          dataSourceResourceId: opts.dataSource ?? "ds",
          groupBy,
        },
      },
    ]
  }

  const grouped = (extra: Record<string, unknown> = {}) => ({ property: "p-status", ...extra })

  /** The canonicalized `groupBy` object of the document's only view. */
  function canonicalGroupBy(intents: Intent[], opts = {}): any {
    const doc = canonicalize(intents, opts)
    const view = doc.intents.find((i: any) => i.type === "view") as any
    return view.view.groupBy
  }

  it("treats an omitted type as the grouped property's declared type", () => {
    const result = diffIntents(board(grouped({ type: "select" })), board(grouped()))
    expect(result.differences).toEqual([])
    expect(result.equal).toBe(true)
    expect(diffIntents(board(grouped()), board(grouped({ type: "select" }))).equal).toBe(true)
  })

  it("treats two documents that both omit it as equal", () => {
    expect(diffIntents(board(grouped()), board(grouped())).equal).toBe(true)
    // the derived value really is written into the canonical document
    expect(canonicalGroupBy(board(grouped())).type).toBe("select")
    expect(canonicalGroupBy(board(grouped()))).toEqual(
      canonicalGroupBy(board(grouped({ type: "select" }))),
    )
  })

  it("still reports a type that disagrees with the grouped property", () => {
    const result = diffIntents(board(grouped({ type: "select" })), board(grouped({ type: "date" })))
    expect(result.equal).toBe(false)
    const rendered = result.differences.map((d) => `[${d.kind}] ${d.path}: ${d.message}`)
    expect(rendered.some((line) => line.includes("groupBy.type"))).toBe(true)
    expect(rendered.some((line) => line.includes('"select"') && line.includes('"date"'))).toBe(true)
    // an omitted type is not "anything goes" — it derives to select, not date
    expect(diffIntents(board(grouped()), board(grouped({ type: "date" }))).equal).toBe(false)
  })

  it("still reports a groupBy pointing at a different property", () => {
    const result = diffIntents(board(grouped()), board({ property: "p-name" }))
    expect(result.equal).toBe(false)
    expect(result.differences.length).toBeGreaterThan(0)
  })

  it("leaves an unresolvable reference alone instead of guessing", () => {
    // property not declared on the data source the view points at
    const dangling = () => board({ property: "p-ghost" })
    expect(diffIntents(dangling(), dangling()).equal).toBe(true)
    expect(canonicalGroupBy(dangling())).not.toHaveProperty("type")

    // view pointing at a data source this document does not declare
    const elsewhere = () => board(grouped(), { dataSource: "ds-other" })
    expect(diffIntents(elsewhere(), elsewhere()).equal).toBe(true)
    expect(canonicalGroupBy(elsewhere())).not.toHaveProperty("type")

    // ...and an unresolved omission is not silently equal to a stated type
    expect(diffIntents(elsewhere(), board(grouped({ type: "select" }))).equal).toBe(false)
  })

  it("does not resolve across data sources", () => {
    const twoSources = (dataSource: string): Intent[] => [
      { type: "teamspace", resourceId: "ts", name: "T", accessLevel: "open" },
      {
        type: "database",
        resourceId: "db",
        name: "Tasks",
        parent: { type: "resourceId", resourceId: "ts" },
        dataSources: [
          {
            resourceId: "ds-a",
            name: "A",
            properties: [{ resourceId: "p-a", name: "Name", type: "title" }],
          },
          {
            resourceId: "ds-b",
            name: "B",
            properties: [{ resourceId: "p-b", name: "Stage", type: "select" }],
          },
        ],
      },
      {
        type: "view",
        databaseResourceId: "db",
        // groups by a property that lives on ds-b while targeting `dataSource`
        view: {
          resourceId: "v",
          type: "board",
          dataSourceResourceId: dataSource,
          groupBy: { property: "p-b" },
        },
      },
    ]
    // resolvable through ds-b, so it fills
    expect(canonicalGroupBy(twoSources("ds-b")).type).toBe("select")
    // not resolvable through ds-a: left absent rather than borrowed from ds-b
    expect(canonicalGroupBy(twoSources("ds-a"))).not.toHaveProperty("type")
    expect(diffIntents(twoSources("ds-a"), twoSources("ds-a")).equal).toBe(true)
    expect(diffIntents(twoSources("ds-a"), twoSources("ds-b")).equal).toBe(false)
  })

  it("fills a lifted inline view just like a separate one", () => {
    const inline = (groupBy: unknown): Intent[] => {
      const intents = board(groupBy)
      const view = (intents[2] as any).view
      ;(intents[1] as any).views = [view]
      return [intents[0], intents[1]]
    }
    // inline + omitted vs separate + explicit: both spellings, both normalizations
    expect(diffIntents(board(grouped({ type: "select" })), inline(grouped())).equal).toBe(true)
    expect(diffIntents(inline(grouped()), inline(grouped({ type: "select" }))).equal).toBe(true)
    // ...and a wrong explicit type inline is still caught
    expect(diffIntents(board(grouped({ type: "select" })), inline(grouped({ type: "date" }))).equal).toBe(
      false,
    )
    // works with view lifting turned off too
    expect(
      diffIntents(inline(grouped()), inline(grouped({ type: "select" })), {
        normalizeInlineViews: false,
      }).equal,
    ).toBe(true)
  })

  it("leaves views without a groupBy alone", () => {
    expect(diffIntents(workspace(), clone(workspace())).equal).toBe(true)
    expect(canonicalize(workspace()).json).not.toContain("groupBy")
  })

  it("can be opted out of, to require the field verbatim", () => {
    const strict = diffIntents(board(grouped({ type: "select" })), board(grouped()), {
      normalizeGroupByType: false,
    })
    expect(strict.equal).toBe(false)
    expect(strict.differences.some((d) => d.kind === "missing" && d.path.includes("groupBy.type"))).toBe(
      true,
    )
    // the two flags are independent
    expect(
      diffIntents(board(grouped({ type: "select" })), board(grouped()), { normalizeInlineViews: false })
        .equal,
    ).toBe(true)
  })

  it("does not mutate the caller's intents", () => {
    const input = board(grouped())
    const before = JSON.stringify(input)
    canonicalize(input)
    expect(JSON.stringify(input)).toBe(before)
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

describe("property visibility spellings", () => {
  // A real document: the property the view references must actually be
  // declared, or it is dangling and the whole entry normalizes away.
  const doc = (properties: unknown[]) => [
    {
      type: "database",
      resourceId: "db",
      name: "Tickets",
      parent: { type: "workspace" },
      dataSources: [
        {
          resourceId: "ds",
          name: "Tickets",
          properties: [
            { resourceId: "p-name", name: "Name", type: "title" },
            { resourceId: "p-esc", name: "Escalated", type: "checkbox" },
          ],
        },
      ],
    },
    {
      type: "view",
      resourceId: "v",
      name: "Board",
      dataSourceResourceId: "ds",
      view: { type: "table", properties },
    },
  ]

  it("treats visibility:'hide' and visible:false as the same column", () => {
    const a = canonicalize(doc([{ property: "p-esc", visible: false }]))
    const b = canonicalize(doc([{ property: "p-esc", visibility: "hide" }]))
    expect(b.json).toBe(a.json)
  })

  it("treats visibility:'show' and visible:true as the same column", () => {
    const a = canonicalize(doc([{ property: "p-esc", visible: true }]))
    const b = canonicalize(doc([{ property: "p-esc", visibility: "show" }]))
    expect(b.json).toBe(a.json)
  })

  it("still distinguishes a hidden column from a visible one", () => {
    const a = canonicalize(doc([{ property: "p-esc", visibility: "hide" }]))
    const b = canonicalize(doc([{ property: "p-esc", visibility: "show" }]))
    expect(b.json).not.toBe(a.json)
  })

  it("leaves hide_if_empty alone — it has no boolean equivalent", () => {
    const a = canonicalize(doc([{ property: "p-esc", visible: false }]))
    const b = canonicalize(doc([{ property: "p-esc", visibility: "hide_if_empty" }]))
    expect(b.json).not.toBe(a.json)
  })

  it("can be turned off", () => {
    const opts = { normalizePropertyVisibility: false }
    const a = canonicalize(doc([{ property: "p-esc", visible: false }]), opts)
    const b = canonicalize(doc([{ property: "p-esc", visibility: "hide" }]), opts)
    expect(b.json).not.toBe(a.json)
  })
})
