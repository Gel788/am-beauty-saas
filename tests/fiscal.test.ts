import { beforeAll, describe, expect, it } from "vitest";
import { createAppointment, getAppointment } from "@/server/appointments";
import { listPayments, refundPayment, voidPayment } from "@/server/cash";
import { many, one } from "@/server/db";
import { buildDocument, listReceipts, processReceipts, registerFiscalProvider, retryReceipt, spread } from "@/server/fiscal";
import { cancelPayLink, createPayLink, listPayLinks, publicPayInfo, sandboxPay } from "@/server/acquiring";
import { createPayment, openShift } from "@/server/payments";
import { updateBranch } from "@/server/settings";
import { at, bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;
let day = 1;
const ORIGIN = "https://crm.test";

beforeAll(async () => {
  salon = await createSalon();
  await run(salon.admin, (ctx) => openShift(ctx, { branchId: salon.branchId, openingCashMinor: 0 }));
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
async function payVisit(method: "cash" | "card") {
  const appt = await visit();
  return run(salon.admin, (ctx) => createPayment(ctx, { branchId: salon.branchId, appointmentId: appt.id, tenders: [{ method, amountMinor: 150000 }] }));
}
const receiptsOf = (paymentId: string) => run(salon.admin, (ctx) => listReceipts(ctx, salon.branchId, { paymentId }));
const flush = () => run(salon.admin, (ctx) => processReceipts(ctx));

describe("receipt document (FISC-DOC)", () => {
  const branch = { fiscal_inn: "7701234567", fiscal_place: "Москва, Садовая 1", fiscal_taxation: "usn_income", fiscal_vat: "none" };

  it("spread keeps the total and the proportions", () => {
    expect(spread([1000, 3000], 101)).toEqual([25, 76]);
    expect(spread([0, 0], 10)).toEqual([0, 0]);
  });

  it("tips stay out, bonuses are a discount, certificates are prepaid", () => {
    const doc = buildDocument(
      branch,
      "sell",
      [
        { line_type: "service", title: "Маникюр", amount_minor: 150000, qty: null },
        { line_type: "product", title: "Масло", amount_minor: 50000, qty: "2.000" },
        { line_type: "tip", title: "Чаевые", amount_minor: 20000, qty: null },
      ],
      [
        { method: "cash", amount_minor: 30000 },
        { method: "card", amount_minor: 110000 },
        { method: "bonus", amount_minor: 20000 },
        { method: "certificate", amount_minor: 60000 },
      ],
      { phone: "+79990000000" },
    )!;
    expect(doc.items).toEqual([
      expect.objectContaining({ name: "Маникюр", sumMinor: 135000, paymentObject: "service", paymentMethod: "full_payment" }),
      expect.objectContaining({ name: "Масло", sumMinor: 45000, quantity: 2, paymentObject: "commodity" }),
    ]);
    // tip 200 ₽ came out of cash: 300 − 200 = 100 ₽ cash left
    expect(doc.payments).toEqual([
      { type: "cash", sumMinor: 10000 },
      { type: "electronic", sumMinor: 110000 },
      { type: "prepaid", sumMinor: 60000 },
    ]);
    expect(doc.totalMinor).toBe(180000);
  });

  it("a tip-only payment has no receipt", () => {
    expect(buildDocument(branch, "sell", [{ line_type: "tip", title: "Чаевые", amount_minor: 1000, qty: null }], [{ method: "cash", amount_minor: 1000 }], {})).toBeNull();
  });
});

describe("fiscal settings", () => {
  it("only the owner turns receipts on, and needs INN and address", async () => {
    await expect(run(salon.admin, (ctx) => updateBranch(ctx, salon.branchId, { fiscalEnabled: true }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(run(salon.owner, (ctx) => updateBranch(ctx, salon.branchId, { fiscalEnabled: true }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(run(salon.owner, (ctx) => updateBranch(ctx, salon.branchId, { fiscalInn: "123" }))).rejects.toMatchObject({ code: "VALIDATION" });
    const branch = await run(salon.owner, (ctx) =>
      updateBranch(ctx, salon.branchId, { fiscalEnabled: true, fiscalInn: "770123456789", fiscalPlace: "Москва, Садовая 1", acquiringEnabled: true }),
    );
    expect(branch).toMatchObject({ fiscalEnabled: true, fiscalProvider: "test", acquiringEnabled: true });
    // The admin's settings form sends the whole branch back; unchanged fiscal fields are fine.
    await run(salon.admin, (ctx) => updateBranch(ctx, salon.branchId, { ...branch, noShowGraceMin: 20 }));
  });
});

describe("receipts from payments", () => {
  it("FISC-SELL-01 a visit payment queues a receipt that the job registers", async () => {
    const appt = await visit();
    const paid = await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, appointmentId: appt.id, tenders: [{ method: "card", amountMinor: 150000 }] }),
    );
    expect(await receiptsOf(paid.id)).toEqual([expect.objectContaining({ kind: "sell", status: "pending", totalMinor: 150000 })]);
    await flush();
    const [receipt] = await receiptsOf(paid.id);
    expect(receipt).toMatchObject({ status: "done", fnNumber: expect.any(String), fdNumber: expect.any(String) });
    expect(receipt.customer).toHaveProperty("phone");
    const list = await run(salon.admin, (ctx) => listPayments(ctx, salon.branchId));
    expect(list.find((row) => row.id === paid.id)?.receipts).toEqual([expect.objectContaining({ kind: "sell", status: "done" })]);
  });

  it("FISC-ADVANCE-01 a deposit is an advance; the visit receipt settles it as prepaid", async () => {
    const appt = await visit();
    const deposit = await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, appointmentId: appt.id, kind: "deposit", tenders: [{ method: "sbp", amountMinor: 50000 }] }),
    );
    const [advance] = await receiptsOf(deposit.id);
    expect(advance.items).toEqual([expect.objectContaining({ paymentMethod: "advance", paymentObject: "payment", sumMinor: 50000 })]);
    const rest = await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, appointmentId: appt.id, tenders: [{ method: "cash", amountMinor: 100000 }] }),
    );
    const [final] = await receiptsOf(rest.id);
    expect(final.items).toEqual([expect.objectContaining({ name: "Маникюр", sumMinor: 150000, paymentMethod: "full_payment" })]);
    expect(final.payments).toEqual([
      { type: "cash", sumMinor: 100000 },
      { type: "prepaid", sumMinor: 50000 },
    ]);
  });

  it("FISC-REFUND-01 a refund gets a sell_refund receipt; voiding before sending drops the receipt", async () => {
    const appt = await visit();
    const paid = await run(salon.admin, (ctx) =>
      createPayment(ctx, { branchId: salon.branchId, appointmentId: appt.id, tenders: [{ method: "card", amountMinor: 150000 }] }),
    );
    const refund = await run(salon.admin, (ctx) => refundPayment(ctx, paid.id, { amountMinor: 40000, reason: "скол" }));
    expect(await receiptsOf(refund.id)).toEqual([expect.objectContaining({ kind: "sell_refund", totalMinor: 40000 })]);

    const cash = await payVisit("cash");
    await run(salon.admin, (ctx) => voidPayment(ctx, cash.id, { reason: "ошиблись записью" }));
    expect(await receiptsOf(cash.id)).toEqual([expect.objectContaining({ kind: "sell", status: "canceled" })]);
  });

  it("FISC-VOID-01 voiding a registered receipt issues a reversal", async () => {
    const cash = await payVisit("cash");
    await flush();
    await run(salon.admin, (ctx) => voidPayment(ctx, cash.id, { reason: "двойной ввод" }));
    const receipts = await receiptsOf(cash.id);
    expect(receipts.map((row) => [row.kind, row.status]).sort()).toEqual([
      ["sell", "done"],
      ["sell_refund", "pending"],
    ]);
  });

  it("FISC-RETRY-01 provider errors retry with backoff; a hard error fails and can be retried by hand", async () => {
    let fail = true;
    registerFiscalProvider({
      name: "flaky",
      label: "Сбойная",
      async register() {
        return fail ? { status: "failed", error: "ККТ не отвечает", retry: false } : { status: "done", externalId: "x", fnNumber: "1", fdNumber: "2", fiscalSign: "3", registeredAt: new Date().toISOString() };
      },
    });
    await run(salon.owner, (ctx) => updateBranch(ctx, salon.branchId, { fiscalProvider: "flaky" }));
    const paid = await payVisit("card");
    await flush();
    const [failed] = await receiptsOf(paid.id);
    expect(failed).toMatchObject({ status: "failed", error: "ККТ не отвечает" });
    await expect(run(salon.master, (ctx) => retryReceipt(ctx, failed.id))).rejects.toMatchObject({ code: "FORBIDDEN" });
    fail = false;
    await run(salon.admin, (ctx) => retryReceipt(ctx, failed.id));
    await flush();
    expect((await receiptsOf(paid.id))[0]).toMatchObject({ status: "done" });
    await run(salon.owner, (ctx) => updateBranch(ctx, salon.branchId, { fiscalProvider: "test" }));
  });
});

describe("online payment links (ACQ)", () => {
  it("ACQ-LINK-01 a pay link is paid in the sandbox, posts outside the shift and gets a receipt", async () => {
    const appt = await visit();
    await expect(run(salon.admin, (ctx) => createPayLink(ctx, appt.id, { amountMinor: 999999, origin: ORIGIN }))).rejects.toMatchObject({ code: "VALIDATION" });
    const first = await run(salon.admin, (ctx) => createPayLink(ctx, appt.id, { amountMinor: 50000, origin: ORIGIN }));
    expect(first).toMatchObject({ purpose: "deposit", status: "pending", url: expect.stringMatching(/^https:\/\/crm\.test\/pay\/[a-f0-9]{64}$/) });
    const link = await run(salon.admin, (ctx) => createPayLink(ctx, appt.id, { origin: ORIGIN }));
    expect(link).toMatchObject({ purpose: "visit", amountMinor: 150000 });
    const { links } = await run(salon.admin, (ctx) => listPayLinks(ctx, appt.id));
    expect(links.find((row) => row.id === first.id)?.status).toBe("canceled");

    const info = await run(salon.admin, (ctx) => publicPayInfo(ctx, link.id));
    expect(info).toMatchObject({ sandbox: true, amountMinor: 150000, status: "pending" });
    const paid = await run(salon.admin, (ctx) => sandboxPay(ctx, link.id, "sbp"));
    expect(paid).toMatchObject({ status: "succeeded", method: "sbp" });
    // Paying twice changes nothing.
    await run(salon.admin, (ctx) => sandboxPay(ctx, link.id, "sbp"));
    const payments = await run(salon.admin, (ctx) => many<{ shift_id: string | null; total_minor: number }>(ctx.db, "SELECT shift_id, total_minor FROM payments WHERE appointment_id = $1", [appt.id]));
    expect(payments).toEqual([{ shift_id: null, total_minor: 150000 }]);
    const tender = await run(salon.admin, (ctx) => one<{ method: string }>(ctx.db, "SELECT t.method FROM payment_tenders t JOIN payments p ON p.id = t.payment_id WHERE p.appointment_id = $1", [appt.id]));
    expect(tender?.method).toBe("sbp");
    const detail = await run(salon.admin, (ctx) => getAppointment(ctx, appt.id));
    expect(detail.debtMinor ?? 0).toBe(0);
    await expect(run(salon.admin, (ctx) => createPayLink(ctx, appt.id, { origin: ORIGIN }))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("ACQ-LINK-02 a paid link after the visit was paid at the desk is kept as income with a refund note", async () => {
    const appt = await visit();
    const link = await run(salon.admin, (ctx) => createPayLink(ctx, appt.id, { origin: ORIGIN }));
    await run(salon.admin, (ctx) => createPayment(ctx, { branchId: salon.branchId, appointmentId: appt.id, tenders: [{ method: "cash", amountMinor: 150000 }] }));
    const paid = await run(salon.admin, (ctx) => sandboxPay(ctx, link.id, "card"));
    expect(paid.status).toBe("succeeded");
    const {
      links: [row],
    } = await run(salon.admin, (ctx) => listPayLinks(ctx, appt.id));
    expect(row.error).toMatch(/возврат/);
  });

  it("ACQ-LINK-03 a cancelled or expired link cannot be paid", async () => {
    const appt = await visit();
    const link = await run(salon.admin, (ctx) => createPayLink(ctx, appt.id, { origin: ORIGIN }));
    await run(salon.admin, (ctx) => cancelPayLink(ctx, link.id));
    await expect(run(salon.admin, (ctx) => sandboxPay(ctx, link.id, "card"))).rejects.toMatchObject({ code: "VALIDATION" });
    const late = await run(salon.admin, (ctx) => createPayLink(ctx, appt.id, { origin: ORIGIN }));
    await expect(
      run(salon.admin, (ctx) => sandboxPay(ctx, late.id, "card"), new Date("2026-11-10T00:00:00Z")),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
