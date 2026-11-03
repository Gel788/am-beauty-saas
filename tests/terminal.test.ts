import { beforeAll, describe, expect, it } from "vitest";
import { createAppointment } from "@/server/appointments";
import { listPayments, refundPayment, setPaymentRefs } from "@/server/cash";
import { one } from "@/server/db";
import { listReceipts, processReceipts } from "@/server/fiscal";
import { createItem, receiveStock } from "@/server/inventory";
import { createPayment, openShift } from "@/server/payments";
import { updateBranch } from "@/server/settings";
import { at, bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;
let cream = "";
let day = 1;

beforeAll(async () => {
  salon = await createSalon();
  await run(salon.admin, (ctx) => openShift(ctx, { branchId: salon.branchId, openingCashMinor: 0 }));
  cream = (await run(salon.admin, (ctx) => createItem(ctx, { sku: "CR-01", title: "Крем для рук", costMinor: 40000, sellPriceMinor: 90000, forSale: true }))).id;
  await run(salon.admin, (ctx) => receiveStock(ctx, { branchId: salon.branchId, lines: [{ itemId: cream, qty: 5 }] }));
});

function visit() {
  day += 1;
  return run(salon.admin, (ctx) =>
    createAppointment(ctx, {
      branchId: salon.branchId,
      staffId: salon.staffA,
      clientId: salon.clientId,
      startsAt: at("10:00", `2026-12-${String(day).padStart(2, "0")}`),
      services: [{ serviceId: salon.serviceId }],
    }),
  );
}
const stock = () =>
  run(salon.admin, (ctx) => one<{ qty: string }>(ctx.db, "SELECT qty FROM stock_balances WHERE item_id = $1 AND branch_id = $2", [cream, salon.branchId])).then((row) => Number(row?.qty));

describe("PAY-UPSELL-01 goods in the visit payment", () => {
  it("one payment carries the service, the goods and the tip; stock goes down", async () => {
    const appt = await visit();
    const before = await stock();
    const paid = await run(salon.admin, (ctx) =>
      createPayment(ctx, {
        branchId: salon.branchId,
        appointmentId: appt.id,
        items: [{ itemId: cream, qty: 2 }],
        tipMinor: 10000,
        tenders: [{ method: "card", amountMinor: 150000 + 180000 + 10000 }],
      }),
    );
    expect(paid.totalMinor).toBe(340000);
    expect(paid.debtMinor).toBe(0);
    expect(await stock()).toBe(before - 2);
    const [row] = (await run(salon.admin, (ctx) => listPayments(ctx, salon.branchId))).filter((payment) => payment.id === paid.id);
    expect(row.lines.map((line) => [line.type, line.amountMinor])).toEqual([
      ["service", 150000],
      ["product", 180000],
      ["tip", 10000],
    ]);
  });

  it("goods can be sold to a visit that is already paid; too little money is refused", async () => {
    const appt = await visit();
    await run(salon.admin, (ctx) => createPayment(ctx, { branchId: salon.branchId, appointmentId: appt.id, tenders: [{ method: "cash", amountMinor: 150000 }] }));
    await expect(
      run(salon.admin, (ctx) => createPayment(ctx, { branchId: salon.branchId, appointmentId: appt.id, items: [{ itemId: cream, qty: 1 }], tenders: [{ method: "cash", amountMinor: 50000 }] })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const extra = await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, appointmentId: appt.id, items: [{ itemId: cream, qty: 1 }], tenders: [{ method: "cash", amountMinor: 100000 }] }),
    );
    expect(extra).toMatchObject({ totalMinor: 90000, changeMinor: 10000 });
  });

  it("a partial payment with goods pays the goods first and leaves the rest as debt", async () => {
    const appt = await visit();
    const paid = await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, appointmentId: appt.id, items: [{ itemId: cream, qty: 1 }], tenders: [{ method: "card", amountMinor: 190000 }] }),
    );
    expect(paid).toMatchObject({ totalMinor: 190000, paidMinor: 100000, partial: true });
  });

  it("with the CRM kassa on, the goods land in the same receipt", async () => {
    await run(salon.owner, (ctx) => updateBranch(ctx, salon.branchId, { fiscalEnabled: true, fiscalInn: "7701234567", fiscalPlace: "Москва" }));
    const appt = await visit();
    const paid = await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, appointmentId: appt.id, items: [{ itemId: cream, qty: 1 }], tenders: [{ method: "card", amountMinor: 240000 }] }),
    );
    await run(salon.admin, (ctx) => processReceipts(ctx));
    const [receipt] = await run(salon.admin, (ctx) => listReceipts(ctx, salon.branchId, { paymentId: paid.id }));
    expect(receipt.items.map((item) => item.paymentObject)).toEqual(["service", "commodity"]);
    expect(receipt.totalMinor).toBe(240000);
  });
});

describe("PAY-EXT own kassa and terminal", () => {
  it("own kassa and the CRM kassa exclude each other; only the owner switches", async () => {
    await expect(run(salon.owner, (ctx) => updateBranch(ctx, salon.branchId, { fiscalEnabled: true, externalReceipts: true }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(run(salon.admin, (ctx) => updateBranch(ctx, salon.branchId, { externalReceipts: true }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const branch = await run(salon.owner, (ctx) => updateBranch(ctx, salon.branchId, { externalReceipts: true }));
    expect(branch).toMatchObject({ externalReceipts: true, fiscalEnabled: false });
  });

  it("a terminal payment keeps the receipt number and operation code, and they can be filled later", async () => {
    const appt = await visit();
    const paid = await run(salon.admin, (ctx) =>
      createPayment(ctx, {
        branchId: salon.branchId,
        appointmentId: appt.id,
        tenders: [{ method: "card", amountMinor: 150000 }],
        receiptNo: " 0042 ",
        terminalRef: "RRN 123456789012",
      }),
    );
    // own kassa: the CRM sends no receipt of its own
    expect(await run(salon.admin, (ctx) => listReceipts(ctx, salon.branchId, { paymentId: paid.id }))).toEqual([]);
    const find = async () => (await run(salon.admin, (ctx) => listPayments(ctx, salon.branchId))).find((row) => row.id === paid.id)!;
    expect(await find()).toMatchObject({ receiptNo: "0042", terminalRef: "RRN 123456789012" });
    await expect(run(salon.master, (ctx) => setPaymentRefs(ctx, paid.id, { receiptNo: "1" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(run(salon.admin, (ctx) => setPaymentRefs(ctx, paid.id, { receiptNo: "x".repeat(41) }))).rejects.toMatchObject({ code: "VALIDATION" });
    await run(salon.admin, (ctx) => setPaymentRefs(ctx, paid.id, { receiptNo: "0043" }));
    expect(await find()).toMatchObject({ receiptNo: "0043", terminalRef: "RRN 123456789012" });

    const refund = await run(salon.admin, (ctx) => refundPayment(ctx, paid.id, { amountMinor: 50000, reason: "скол", receiptNo: "0050" }));
    expect((await run(salon.admin, (ctx) => listPayments(ctx, salon.branchId))).find((row) => row.id === refund.id)?.receiptNo).toBe("0050");
  });
});
