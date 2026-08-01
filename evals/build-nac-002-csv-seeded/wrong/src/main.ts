import { readFileSync } from "node:fs";
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

// A plausible-but-wrong submission: the export really is read at build time and
// the schema is right, but blank lines are filtered out *and* the slice still
// drops a trailing one — so the last asset in data.csv never makes it into the
// database.
const rows = readFileSync("data.csv", "utf8")
  .split("\n")
  .filter(line => line.trim().length > 0)
  .slice(1, -1);

const itOps = notion.teamspace({
  resourceId: "it-ops",
  parent: workspaceParent,
  name: "IT Ops",
  accessLevel: "open",
});

const inventory = itOps.addDatabase({
  resourceId: "hardware-inventory",
  name: "Hardware Inventory",
  dataSources: [
    {
      resourceId: "hardware-inventory-source",
      name: "Hardware Inventory",
      properties: [
        { resourceId: "asset-prop", name: "Asset", type: "title" },
        {
          resourceId: "category-prop",
          name: "Category",
          type: "select",
          options: [
            { name: "Laptop", color: "blue" },
            { name: "Monitor", color: "purple" },
            { name: "Phone", color: "orange" },
            { name: "Accessory", color: "gray" },
          ],
        },
        { resourceId: "quantity-prop", name: "Quantity", type: "number" },
        { resourceId: "purchased-prop", name: "Purchased", type: "date" },
        { resourceId: "insured-prop", name: "Insured", type: "checkbox" },
      ],
    },
  ],
});

inventory.addView({
  resourceId: "all-assets-view",
  name: "All Assets",
  type: "table",
  dataSourceResourceId: "hardware-inventory-source",
});

const assets = inventory.getDataSource("hardware-inventory-source");

rows.forEach((line, index) => {
  const [asset, category, quantity, purchased, insured] = line.split(",");
  assets.addPage({
    resourceId: `asset-${index}`,
    properties: {
      Asset: notion.text(asset),
      Category: notion.select(category),
      Quantity: notion.number(Number(quantity)),
      Purchased: notion.date(purchased),
      Insured: notion.checkbox(insured === "yes"),
    },
  });
});
