import { beforeAll, describe, expect, it } from "vitest";
import { changeStatus, createAppointment } from "@/server/appointments";
import { refundPayment, voidPayment } from "@/server/cash";
import { many, one } from "@/server/db";
import {
  applyCount,
  createItem,
  deleteItem,
  getCount,
  listItems,
  listMovements,
  receiveStock,
  setConsumables,
  setCounted,
  startCount,
  transferStock,
  writeOffStock,
} from "@/server/inventory";
import { createPayment, openShift } from "@/server/payments";
import { calculatePeriod, createPeriod, createRule } from "@/server/payroll";
import { at, bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;
let gel: string; // ml, used by the manicure
let file: string; // pcs, used by the manicure
let cream: string; // pcs, sold in the till

beforeAll(async () => {
  salon = await createSalon();
  await run(salon.admin, (ctx) => openShift(ctx, { branchId: salon.branchId, openingCashMinor: 0 }));
});

async function qty(itemId: string, branchId = salon.branchId) {
  const items = await run(salon.owner, (ctx) => listItems(ctx, branchId, { includeArchived: true }));
  return items.find((item) => item.id === itemId)!.qty;
}

/** A visit taken to in_progress, ready to be completed through changeStatus. */
async function visitInProgress(day: string, time: string) {
  const appt = await run(salon.admin, (ctx) =>
    createAppointment(ctx, {
      branchId: salon.branchId,
      staffId: salon.staffA,
      clientId: salon.clientId,
      startsAt: at(time, day),
      services: [{ serviceId: salon.serviceId }],
      acknowledgeSoft: true,
    }),
  );
  await run(salon.owner, (ctx) => ctx.db.query("UPDATE appointments SET status = 'in_progress' WHERE id = $1", [appt.id]));
  const row = await run(salon.owner, (ctx) => one<{ version: number }>(ctx.db, "SELECT version FROM appointments WHERE id = $1", [appt.id]));
  return { id: appt.id, version: Number(row!.version) };
}

describe("inventory", () => {
  it("INV-ITEM-01 items: unique sku, roles, delete or archive", async () => {
    gel = (await run(salon.admin, (ctx) => createItem(ctx, { sku: "GEL-01", title: "Гель-лак", unit: "ml", costMinor: 2000 }))).id;
    file = (await run(salon.accountant, (ctx) => createItem(ctx, { sku: "FILE-01", title: "Пилка", costMinor: 5000 }))).id;
    cream = (await run(salon.admin, (ctx) => createItem(ctx, { sku: "CR-01", title: "Крем для рук", costMinor: 40000, sellPriceMinor: 90000, forSale: true }))).id;
    await expect(run(salon.admin, (ctx) => createItem(ctx, { sku: "GEL-01", title: "Дубль" }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(run(salon.master, (ctx) => createItem(ctx, { sku: "X", title: "X" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await run(salon.master, (ctx) => listItems(ctx, salon.branchId))).length).toBe(3);

    const spare = await run(salon.admin, (ctx) => createItem(ctx, { sku: "TMP", title: "Временная" }));
    expect(await run(salon.admin, (ctx) => deleteItem(ctx, spare.id))).toMatchObject({ outcome: "deleted" });
  });

  it("INV-RECEIPT-01 / WRITEOFF-01 receipt adds, write-off needs a reason and never goes negative silently", async () => {
    await run(salon.admin, (ctx) =>
      receiveStock(ctx, {
        branchId: salon.branchId,
        supplier: "ООО Бьюти",
        document: "ТН-17",
        lines: [
          { itemId: gel, qty: "100" },
          { itemId: file, qty: 10, costMinor: 6000 },
          { itemId: cream, qty: 5 },
        ],
      }),
    );
    expect(await qty(gel)).toBe(100);
    expect((await run(salon.owner, (ctx) => listItems(ctx, salon.branchId))).find((item) => item.id === file)?.costMinor).toBe(6000);

    await expect(run(salon.admin, (ctx) => writeOffStock(ctx, { branchId: salon.branchId, itemId: gel, qty: 5 }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      run(salon.admin, (ctx) => writeOffStock(ctx, { branchId: salon.branchId, itemId: file, qty: 11, reason: "брак" })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await run(salon.admin, (ctx) => writeOffStock(ctx, { branchId: salon.branchId, itemId: gel, qty: "2.5", reason: "пролили" }));
    expect(await qty(gel)).toBe(97.5);
    await expect(run(salon.master, (ctx) => writeOffStock(ctx, { branchId: salon.branchId, itemId: gel, qty: 1, reason: "x" }))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // Stock with history is archived, not deleted.
    await expect(run(salon.admin, (ctx) => deleteItem(ctx, gel))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("INV-TRANSFER-01 moves stock between branches atomically", async () => {
    const result = await run(salon.owner, (ctx) =>
      transferStock(ctx, { fromBranchId: salon.branchId, toBranchId: salon.otherBranchId, itemId: file, qty: 3 }),
    );
    expect(await qty(file)).toBe(7);
    expect(await qty(file, salon.otherBranchId)).toBe(3);
    const linked = await run(salon.owner, (ctx) =>
      many<{ qty: string }>(ctx.db, "SELECT qty FROM stock_movements WHERE transfer_id = $1 ORDER BY qty", [result.transferId]),
    );
    expect(linked.map((row) => Number(row.qty))).toEqual([-3, 3]);
    await expect(
      run(salon.owner, (ctx) => transferStock(ctx, { fromBranchId: salon.branchId, toBranchId: salon.otherBranchId, itemId: file, qty: 50 })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await qty(file)).toBe(7);
    expect(await qty(file, salon.otherBranchId)).toBe(3);
  });

  it("INV-CONSUME-01 completing a visit consumes materials; short stock warns by default and blocks by policy", async () => {
    await run(salon.admin, (ctx) =>
      setConsumables(ctx, salon.serviceId, [
        { itemId: gel, qty: "1.5" },
        { itemId: file, qty: 4 },
      ]),
    );
    const first = await visitInProgress("2026-10-10", "10:00");
    const done = await run(salon.master, (ctx) => changeStatus(ctx, first.id, "completed", { version: first.version }));
    expect(done.stockWarnings).toEqual([]);
    expect(await qty(gel)).toBe(96);
    expect(await qty(file)).toBe(3);

    // Only 3 files left, 4 needed: completes, flags the movement and reports it.
    const second = await visitInProgress("2026-10-10", "12:00");
    const short = await run(salon.admin, (ctx) => changeStatus(ctx, second.id, "completed", { version: second.version }));
    expect(short.stockWarnings).toMatchObject([{ itemId: file, neededQty: 4, availableQty: 3 }]);
    expect(await qty(file)).toBe(-1);
    const flagged = await run(salon.owner, (ctx) =>
      one<{ negative: boolean }>(ctx.db, "SELECT negative FROM stock_movements WHERE appointment_id = $1 AND item_id = $2", [second.id, file]),
    );
    expect(flagged?.negative).toBe(true);

    await run(salon.owner, (ctx) => ctx.db.query("UPDATE branches SET consume_policy = 'block' WHERE id = $1", [salon.branchId]));
    const third = await visitInProgress("2026-10-10", "14:00");
    await expect(run(salon.admin, (ctx) => changeStatus(ctx, third.id, "completed", { version: third.version }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const status = await run(salon.owner, (ctx) => one<{ status: string }>(ctx.db, "SELECT status FROM appointments WHERE id = $1", [third.id]));
    expect(status?.status).toBe("in_progress");
    expect(await qty(gel)).toBe(94.5);
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE branches SET consume_policy = 'warn' WHERE id = $1", [salon.branchId]));
  });

  it("INV-CONSUME-01 a full refund of the service puts the materials back once", async () => {
    await run(salon.admin, (ctx) => receiveStock(ctx, { branchId: salon.branchId, lines: [{ itemId: file, qty: 10 }] }));
    const visit = await visitInProgress("2026-10-11", "10:00");
    await run(salon.admin, (ctx) => changeStatus(ctx, visit.id, "completed", { version: visit.version }));
    const gelBefore = await qty(gel);
    const payment = await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, appointmentId: visit.id, tenders: [{ method: "card", amountMinor: 150000 }] }),
    );
    await run(salon.admin, (ctx) => refundPayment(ctx, payment.id, { amountMinor: 50000, reason: "скидка" }));
    expect(await qty(gel)).toBe(gelBefore);
    await run(salon.admin, (ctx) => refundPayment(ctx, payment.id, { reason: "переделка" }));
    expect(await qty(gel)).toBe(gelBefore + 1.5);
    const reversals = await run(salon.owner, (ctx) =>
      many<{ id: string }>(ctx.db, "SELECT id FROM stock_movements WHERE appointment_id = $1 AND reverses_id IS NOT NULL", [visit.id]),
    );
    expect(reversals.length).toBe(2);
  });

  it("INV-SALE-01 the till sells goods from stock; refund and void bring them back", async () => {
    const sale = await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, kind: "misc", items: [{ itemId: cream, qty: 2 }], tenders: [{ method: "cash", amountMinor: 200000 }] }),
    );
    expect(sale).toMatchObject({ totalMinor: 180000, changeMinor: 20000 });
    expect(await qty(cream)).toBe(3);
    await expect(
      run(salon.admin, (ctx) =>
        createPayment(ctx, { branchId: salon.branchId, kind: "misc", items: [{ itemId: gel, qty: 1 }], tenders: [{ method: "cash", amountMinor: 1000 }] }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      run(salon.admin, (ctx) =>
        createPayment(ctx, { branchId: salon.branchId, kind: "misc", items: [{ itemId: cream, qty: 9 }], tenders: [{ method: "card", amountMinor: 810000 }] }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    await run(salon.admin, (ctx) => refundPayment(ctx, sale.id, { amountMinor: 90000, reason: "не подошёл" }));
    expect(await qty(cream)).toBe(4);

    const cash = await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, kind: "misc", items: [{ itemId: cream, qty: 1 }], tenders: [{ method: "cash", amountMinor: 90000 }] }),
    );
    expect(await qty(cream)).toBe(3);
    await run(salon.admin, (ctx) => voidPayment(ctx, cash.id, { reason: "ошибка кассира" }));
    expect(await qty(cream)).toBe(4);
  });

  it("INV-COUNT-01 count: expected snapshot, counted input, variance report, adjustments", async () => {
    const count = await run(salon.admin, (ctx) => startCount(ctx, { branchId: salon.branchId }));
    await expect(run(salon.admin, (ctx) => startCount(ctx, { branchId: salon.branchId }))).rejects.toMatchObject({ code: "VALIDATION" });
    const expectedGel = count.lines.find((line) => line.itemId === gel)!.expectedQty;
    // A sale while counting is not lost: the adjustment is counted − expected.
    await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, kind: "misc", items: [{ itemId: cream, qty: 1 }], tenders: [{ method: "card", amountMinor: 90000 }] }),
    );
    await run(salon.admin, (ctx) =>
      setCounted(ctx, count.id, [
        { itemId: gel, countedQty: String(expectedGel - 2) },
        { itemId: cream, countedQty: 4 },
      ]),
    );
    const sheet = await run(salon.admin, (ctx) => getCount(ctx, count.id));
    const gelLine = sheet.lines.find((line) => line.itemId === gel)!;
    expect(gelLine).toMatchObject({ diffQty: -2, diffCostMinor: -4000 });
    expect(sheet.summary).toMatchObject({ counted: 2, shortageCostMinor: -4000, surplusCostMinor: 0 });

    const applied = await run(salon.admin, (ctx) => applyCount(ctx, count.id));
    expect(applied.status).toBe("applied");
    expect(await qty(gel)).toBe(expectedGel - 2);
    expect(await qty(cream)).toBe(3);
    const moves = await run(salon.admin, (ctx) => listMovements(ctx, salon.branchId, { type: "inventory_adjust" }));
    expect(moves.map((move) => [move.itemId, move.qty])).toEqual([[gel, -2]]);
    await expect(run(salon.admin, (ctx) => setCounted(ctx, count.id, [{ itemId: gel, countedQty: 1 }]))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("PAYROLL-SCHEME-05 deduct_materials takes the consumed cost off the base", async () => {
    await run(salon.admin, (ctx) =>
      createRule(ctx, { staffId: salon.staffA, scheme: "percent", percentBps: 5000, deductMaterials: true, validFrom: "2026-01-01" }),
    );
    await run(salon.admin, (ctx) => receiveStock(ctx, { branchId: salon.branchId, lines: [{ itemId: file, qty: 10 }] }));
    const visit = await visitInProgress("2026-09-15", "10:00");
    await run(salon.admin, (ctx) => changeStatus(ctx, visit.id, "completed", { version: visit.version }));
    await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, appointmentId: visit.id, tenders: [{ method: "card", amountMinor: 150000 }] }),
    );
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE appointments SET completed_at = $2 WHERE id = $1", [visit.id, at("11:00", "2026-09-15")]));
    const period = await run(salon.admin, (ctx) => createPeriod(ctx, { branchId: salon.branchId, startsOn: "2026-09-01", endsOn: "2026-09-30" }));
    const sheet = await run(salon.admin, (ctx) => calculatePeriod(ctx, period.id));
    const line = sheet.items[0].lines.find((entry) => entry.type === "service")!;
    // Materials: 1.5 ml × 20 ₽ + 4 pcs × 60 ₽ = 270 ₽.
    expect(line.rate).toMatchObject({ grossMinor: 150000, materialsMinor: 27000 });
    expect(line.baseAmountMinor).toBe(123000);
    expect(line.resultMinor).toBe(61500);
  });
});
