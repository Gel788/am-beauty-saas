import { beforeAll, describe, expect, it } from "vitest";
import { createItem, listItems, updateItem } from "@/server/inventory";
import { bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;
beforeAll(async () => {
  salon = await createSalon();
});

describe("inventory items", () => {
  it("INV-ITEM-01 an empty article number is filled in automatically", async () => {
    const a = await run(salon.admin, (ctx) => createItem(ctx, { title: "Перчатки" }));
    const b = await run(salon.admin, (ctx) => createItem(ctx, { title: "Салфетки", sku: "  " }));
    expect(a.sku).toBe("P-0001");
    expect(b.sku).toBe("P-0002");
    await expect(run(salon.admin, (ctx) => createItem(ctx, { title: "Ещё", sku: "P-0001" }))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("INV-ITEM-02 what is on the shelf goes in as a receipt; below the minimum the item is low", async () => {
    const item = await run(salon.admin, (ctx) => createItem(ctx, { title: "Гель-лак", unit: "ml", costMinor: 2000, minQty: "50", branchId: salon.branchId, initialQty: "120" }));
    const listed = (await run(salon.admin, (ctx) => listItems(ctx, salon.branchId))).find((row) => row.id === item.id)!;
    expect(listed).toMatchObject({ qty: 120, minQty: 50 });
    const edited = await run(salon.admin, (ctx) => updateItem(ctx, item.id, { minQty: "150" }));
    expect(edited.minQty).toBe(150);
    await expect(run(salon.admin, (ctx) => updateItem(ctx, item.id, { minQty: "-1" }))).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
