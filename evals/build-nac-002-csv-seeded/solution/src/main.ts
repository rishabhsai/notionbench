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

interface AssetRow {
  asset: string;
  category: string;
  quantity: number;
  purchased: string;
  insured: boolean;
}

/**
 * `npm run build` executes the bundle from the project root, so the export
 * is read relative to the project root rather than to `dist/`.
 */
function readAssets(file: string): AssetRow[] {
  const lines = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0);

  // Drop the header row; every remaining line is one asset.
  return lines.slice(1).map(line => {
    const [asset, category, quantity, purchased, insured] = line.split(",");
    return {
      asset,
      category,
      quantity: Number(quantity),
      purchased,
      insured: insured.toLowerCase() === "yes",
    };
  });
}

/** Stable, readable resourceId for a row, derived from its asset name. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const itOps = notion.teamspace({
  resourceId: "it-ops-teamspace",
  parent: workspaceParent,
  name: "IT Ops",
  accessLevel: "open",
});

const inventory = itOps.addDatabase({
  resourceId: "hardware-inventory-db",
  name: "Hardware Inventory",
  dataSources: [
    {
      resourceId: "hardware-inventory-ds",
      name: "Hardware Inventory",
      properties: [
        { resourceId: "asset-name-prop", name: "Asset", type: "title" },
        {
          resourceId: "asset-category-prop",
          name: "Category",
          type: "select",
          options: [
            { name: "Laptop", color: "blue" },
            { name: "Monitor", color: "purple" },
            { name: "Phone", color: "orange" },
            { name: "Accessory", color: "gray" },
          ],
        },
        { resourceId: "asset-quantity-prop", name: "Quantity", type: "number" },
        { resourceId: "asset-purchased-prop", name: "Purchased", type: "date" },
        { resourceId: "asset-insured-prop", name: "Insured", type: "checkbox" },
      ],
    },
  ],
});

inventory.addView({
  resourceId: "hardware-inventory-table-view",
  name: "All Assets",
  type: "table",
  dataSourceResourceId: "hardware-inventory-ds",
});

const assets = inventory.getDataSource("hardware-inventory-ds");

for (const row of readAssets("data.csv")) {
  assets.addPage({
    resourceId: `asset-${slug(row.asset)}`,
    properties: {
      Asset: notion.text(row.asset),
      Category: notion.select(row.category),
      Quantity: notion.number(row.quantity),
      Purchased: notion.date(row.purchased),
      Insured: notion.checkbox(row.insured),
    },
  });
}
