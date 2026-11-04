import { AppError } from "@/domain/errors";
import { audit } from "./audit";
import { isAdminPlus, loadBranch } from "./access";
import { one } from "./db";
import type { Ctx } from "./types";
import { afterPaymentPosted, productLines } from "./inventory";
import { enqueueReceipt } from "./fiscal";
import {
  afterPaymentPosted as loyaltyAfterPosted,
  certificateSaleLines,
  fulfilSale,
  isLoyaltyMethod,
  membershipSaleLines,
  resolveTenders,
  type ResolvedTender,
  type SaleLine,
} from "./loyalty";

export type TenderInput = {
  method: "cash" | "card" | "sbp" | "transfer" | "bonus" | "certificate" | "membership";
  amountMinor: number;
  certificateCode?: string;
  membershipId?: string;
};
type StoredTender = ResolvedTender;

const ALLOWED = new Set(["cash", "card", "sbp", "transfer", "bonus", "certificate", "membership"]);

/** Payments that still carry money: posted, or refunded originals (their refunds are separate `out` rows). */
export const LIVE_PAYMENT = "p.status IN ('posted', 'refunded')";
/** Signed line sum: incoming minus refunds. Use with alias `pl` for lines and `p` for payments. */
export const NET_AMOUNT =
  "COALESCE(SUM(CASE WHEN p.direction = 'in' THEN pl.amount_minor ELSE -pl.amount_minor END), 0)::int";

export async function syncAppointmentDebt(ctx: Ctx, appointmentId: string) {
  const appt = await one<{ id: string; client_id: string | null; debt_minor: number; status: string }>(
    ctx.db,
    "SELECT id, client_id, debt_minor, status FROM appointments WHERE id = $1 FOR UPDATE",
    [appointmentId],
  );
  if (!appt) throw new AppError("NOT_FOUND", "Запись не найдена");
  const priceRow = await one<{ s: number }>(
    ctx.db,
    "SELECT COALESCE(SUM(price_minor), 0)::int AS s FROM appointment_services WHERE appointment_id = $1",
    [appointmentId],
  );
  const paidRow = await one<{ s: number }>(
    ctx.db,
    `SELECT ${NET_AMOUNT} AS s
     FROM payment_lines pl
     JOIN payments p ON p.id = pl.payment_id
     WHERE p.appointment_id = $1 AND ${LIVE_PAYMENT}
       AND pl.line_type IN ('service', 'deposit')`,
    [appointmentId],
  );
  // Debt follows money received: a refund is the salon giving money back, not the client owing more.
  const receivedRow = await one<{ paid: number; settled: number }>(
    ctx.db,
    `SELECT COALESCE(SUM(pl.amount_minor) FILTER (WHERE pl.line_type IN ('service', 'deposit')), 0)::int AS paid,
            COALESCE(SUM(pl.amount_minor) FILTER (WHERE pl.line_type = 'service'), 0)::int AS settled
     FROM payment_lines pl
     JOIN payments p ON p.id = pl.payment_id
     WHERE p.appointment_id = $1 AND ${LIVE_PAYMENT} AND p.direction = 'in'`,
    [appointmentId],
  );
  const price = Number(priceRow?.s ?? 0);
  const paid = Number(paidRow?.s ?? 0);
  const received = Number(receivedRow?.paid ?? 0);
  const settled = Number(receivedRow?.settled ?? 0);
  const newDebt = appt.status !== "cancelled" && settled > 0 && received < price ? price - received : 0;
  const overpaid = paid > price ? paid - price : 0;
  const delta = newDebt - Number(appt.debt_minor);
  if (delta !== 0 && appt.client_id) {
    await ctx.db.query("UPDATE clients SET balance_minor = balance_minor + $2, updated_at = now() WHERE id = $1", [
      appt.client_id,
      delta,
    ]);
  }
  await ctx.db.query("UPDATE appointments SET debt_minor = $2 WHERE id = $1", [appointmentId, newDebt]);
  return { debtMinor: newDebt, overpaidMinor: overpaid, paidMinor: paid, priceMinor: price };
}

export async function clearAppointmentDebt(ctx: Ctx, appointmentId: string): Promise<void> {
  const appt = await one<{ client_id: string | null; debt_minor: number }>(
    ctx.db,
    "SELECT client_id, debt_minor FROM appointments WHERE id = $1 FOR UPDATE",
    [appointmentId],
  );
  if (!appt) return;
  const debt = Number(appt.debt_minor);
  if (debt !== 0 && appt.client_id) {
    await ctx.db.query("UPDATE clients SET balance_minor = balance_minor - $2, updated_at = now() WHERE id = $1", [
      appt.client_id,
      debt,
    ]);
  }
  await ctx.db.query("UPDATE appointments SET debt_minor = 0 WHERE id = $1", [appointmentId]);
}

export async function requireShift(ctx: Ctx, branchId: string, bypassShift?: boolean) {
  const branch = await loadBranch(ctx, branchId);
  // FOR SHARE serialises with SHIFT-CLOSE-01: closing waits for in-flight payments, and
  // payments started after closing began see status = 'closing'.
  const active = await one<{ id: string; status: string }>(
    ctx.db,
    "SELECT id, status FROM cash_shifts WHERE branch_id = $1 AND status IN ('open', 'closing') FOR SHARE",
    [branchId],
  );
  if (active?.status === "closing") throw new AppError("SHIFT_CLOSED", "Смена закрывается, оплата недоступна");
  const open = active?.status === "open" ? active : null;
  if (branch.require_open_shift && !open) {
    if (bypassShift && ctx.actor.role === "owner" && branch.owner_can_bypass_shift) {
      return { shiftId: null as string | null, branch };
    }
    throw new AppError("SHIFT_REQUIRED", "Сначала откройте смену", { branchId });
  }
  return { shiftId: open?.id ?? null, branch };
}

export function assertMoney(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000_000) {
    throw new AppError("VALIDATION", `${label}: сумма в копейках должна быть целым числом`);
  }
}

export async function openShift(
  ctx: Ctx,
  input: { branchId: string; openingCashMinor: number; note?: string },
) {
  if (!["owner", "admin", "accountant"].includes(ctx.actor.role)) {
    throw new AppError("FORBIDDEN", "Недостаточно прав");
  }
  await loadBranch(ctx, input.branchId);
  assertMoney(input.openingCashMinor, "Сумма в кассе");
  const existing = await one<{ id: string; opened_at: Date }>(
    ctx.db,
    "SELECT id, opened_at, status FROM cash_shifts WHERE branch_id = $1 AND status IN ('open', 'closing')",
    [input.branchId],
  );
  if (existing) {
    const closing = (existing as { status?: string }).status === "closing";
    throw new AppError("VALIDATION", closing ? "Текущая смена закрывается. Завершите закрытие" : "Смена уже открыта. Закройте её, чтобы открыть новую", {
      shiftId: existing.id,
      openedAt: new Date(existing.opened_at).toISOString(),
    });
  }
  const id = crypto.randomUUID();
  await ctx.db.query(
    `INSERT INTO cash_shifts (id, tenant_id, branch_id, opened_by, opening_cash_minor, status, note)
     VALUES ($1, $2, $3, $4, $5, 'open', $6)`,
    [id, ctx.actor.tenantId, input.branchId, ctx.actor.userId, input.openingCashMinor, input.note?.trim() ?? ""],
  );
  await audit(ctx, {
    branchId: input.branchId,
    entity: "shift",
    entityId: id,
    action: "shift.opened",
    diff: { openingCashMinor: input.openingCashMinor },
  });
  return { id, status: "open" as const, openingCashMinor: input.openingCashMinor };
}

export type PaymentResult = {
  id: string;
  totalMinor: number;
  changeMinor: number;
  status: "posted";
  lineIds: string[];
  partial: boolean;
  debtMinor?: number;
  overpaidMinor?: number;
  paidMinor?: number;
  priceMinor?: number;
  issued?: { kind: string; id: string; code?: string }[];
};

export async function createPayment(
  ctx: Ctx,
  input: {
    branchId: string;
    kind?: "visit" | "deposit" | "tip" | "debt" | "misc" | "certificate" | "membership";
    appointmentId?: string | null;
    clientId?: string | null;
    version?: number;
    tenders: TenderInput[];
    tipMinor?: number;
    amountMinor?: number;
    title?: string;
    bypassShift?: boolean;
    acknowledgePartial?: boolean;
    /** INV-SALE-01: goods sold through the till (kind misc). */
    items?: { itemId: string; qty: unknown; priceMinor?: number }[];
    /** LOY-SUB-01: membership plan sold (kind membership). */
    planId?: string;
    /** ACQ-*: paid through the acquiring provider; the money is in the bank, not in the shift's drawer. */
    online?: boolean;
    /** PAY-EXT-01: the receipt was printed on the salon's own kassa; its number, optional. */
    receiptNo?: string;
    /** PAY-EXT-01: the bank terminal's operation code (RRN / auth code), optional. */
    terminalRef?: string;
    /** GRP-PAY-01: a misc income that is a service (a seat at a group event), not goods. */
    serviceLine?: boolean;
  },
): Promise<PaymentResult> {
  const external = externalRefs(input);
  const kind = input.kind ?? (input.appointmentId ? "visit" : "misc");
  if (kind === "misc" || kind === "debt" || kind === "certificate" || kind === "membership") {
    if (!isAdminPlus(ctx.actor) && ctx.actor.role !== "accountant") {
      throw new AppError("FORBIDDEN", "Недостаточно прав");
    }
  }
  for (const tender of input.tenders ?? []) {
    assertMoney(tender.amountMinor, "Оплата");
    if (!ALLOWED.has(tender.method)) throw new AppError("VALIDATION", "Неизвестный способ оплаты");
  }
  const loyal = (input.tenders ?? []).some((tender) => isLoyaltyMethod(tender.method));
  if (loyal && !(kind === "visit" || (kind === "misc" && input.items?.length))) {
    throw new AppError("VALIDATION", "Бонусами, сертификатом и абонементом оплачивают визит или товар");
  }
  const handed = (input.tenders ?? []).reduce((sum, tender) => sum + tender.amountMinor, 0);
  if (handed <= 0) throw new AppError("VALIDATION", "Укажите сумму оплаты");

  const { shiftId } = input.online ? { shiftId: null } : await requireShift(ctx, input.branchId, input.bypassShift);
  const tipMinor = input.tipMinor ?? 0;
  assertMoney(tipMinor, "Чаевые");

  let clientId = input.clientId ?? null;
  const appointmentId = input.appointmentId ?? null;
  const lines: PaymentLineInput[] = [];

  if (kind === "certificate" || kind === "membership") {
    const sale: SaleLine[] =
      kind === "certificate" ? await certificateSaleLines(ctx, Number(input.amountMinor ?? handed)) : await membershipSaleLines(ctx, String(input.planId ?? ""), clientId);
    const bill = sale.reduce((sum, line) => sum + line.amountMinor, 0);
    if (handed < bill) throw new AppError("VALIDATION", "Внесено меньше суммы чека");
    const change = handed - bill;
    const cashHanded = input.tenders.filter((tender) => tender.method === "cash").reduce((sum, tender) => sum + tender.amountMinor, 0);
    if (change > cashHanded) throw new AppError("VALIDATION", "Сдача возможна только с наличных. Уменьшите сумму карты");
    const payment = await insertPayment(ctx, {
      ...external,
      branchId: input.branchId,
      appointmentId: null,
      clientId,
      shiftId,
      total: bill,
      change,
      lines: sale,
      tenders: storedTenders(input.tenders, change),
    });
    const issued = await fulfilSale(ctx, payment.id, input.branchId, clientId, payment.lineIds.map((lineId, index) => ({ lineId, line: sale[index] })));
    return { ...payment, partial: false, issued };
  }

  if (kind === "debt") {
    if (!clientId) throw new AppError("VALIDATION", "Укажите клиента");
    const client = await one<{ balance_minor: number }>(
      ctx.db,
      "SELECT balance_minor FROM clients WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
      [clientId],
    );
    if (!client) throw new AppError("NOT_FOUND", "Клиент не найден");
    if (handed > Number(client.balance_minor)) {
      throw new AppError("VALIDATION", "Сумма больше долга клиента");
    }
    lines.push({ type: "debt", refId: clientId, title: "Погашение долга", amountMinor: handed });
  } else if (kind === "misc" && input.items?.length) {
    lines.push(...(await productLines(ctx, input.branchId, input.items)));
    const goods = lines.reduce((sum, line) => sum + line.amountMinor, 0);
    if (tipMinor > 0) lines.push({ type: "tip", refId: null, title: "Чаевые", amountMinor: tipMinor });
    const bill = goods + tipMinor;
    if (handed < bill) throw new AppError("VALIDATION", "Внесено меньше суммы чека");
    const change = handed - bill;
    const cashHanded = input.tenders.filter((tender) => tender.method === "cash").reduce((sum, tender) => sum + tender.amountMinor, 0);
    if (change > cashHanded) throw new AppError("VALIDATION", "Сдача возможна только с наличных. Уменьшите сумму карты");
    const resolved = await resolveTenders(ctx, { tenders: input.tenders, branchId: input.branchId, clientId, bill: goods, appointmentId: null });
    const sale = await insertPayment(ctx, {
      ...external,
      branchId: input.branchId,
      appointmentId: null,
      clientId,
      shiftId,
      total: bill,
      change,
      lines,
      tenders: storedTenders(resolved, change),
    });
    return { ...sale, partial: false };
  } else if (kind === "misc") {
    lines.push({
      type: input.serviceLine ? "service" : "product",
      refId: null,
      title: input.title?.trim() || "Прочий приход",
      amountMinor: handed - tipMinor,
    });
    if (handed - tipMinor <= 0) throw new AppError("VALIDATION", "Сумма прихода должна быть больше нуля");
    if (tipMinor > 0) lines.push({ type: "tip", refId: null, title: "Чаевые", amountMinor: tipMinor });
  } else {
    if (!appointmentId) throw new AppError("VALIDATION", "Не указана запись");
    const appt = await one<{
      id: string;
      status: string;
      version: number;
      client_id: string | null;
      branch_id: string;
      staff_id: string;
    }>(ctx.db, "SELECT * FROM appointments WHERE id = $1 FOR UPDATE", [appointmentId]);
    if (!appt || appt.branch_id !== input.branchId) throw new AppError("NOT_FOUND", "Запись не найдена");
    if (appt.status === "cancelled") throw new AppError("VALIDATION", "Нельзя принять оплату по отменённой записи");
    if (input.version !== undefined && Number(appt.version) !== input.version) {
      throw new AppError("STALE", "Запись изменена. Обновить?");
    }
    if (ctx.actor.role === "master") {
      const branch = await loadBranch(ctx, input.branchId);
      if (!branch.master_can_take_payment || ctx.actor.staffId !== appt.staff_id) {
        throw new AppError("FORBIDDEN", "Недостаточно прав");
      }
    } else if (!isAdminPlus(ctx.actor) && ctx.actor.role !== "accountant") {
      throw new AppError("FORBIDDEN", "Недостаточно прав");
    }
    clientId = appt.client_id;
    const services = await ctx.db.query<{ id: string; service_id: string | null; title_snapshot: string; price_minor: number }>(
      "SELECT id, service_id, title_snapshot, price_minor FROM appointment_services WHERE appointment_id = $1 ORDER BY position",
      [appointmentId],
    );
    const price = services.rows.reduce((sum, service) => sum + Number(service.price_minor), 0);
    const paidRow = await one<{ s: number }>(
      ctx.db,
      `SELECT ${NET_AMOUNT} AS s
       FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id
       WHERE p.appointment_id = $1 AND ${LIVE_PAYMENT}
         AND pl.line_type IN ('service', 'deposit')`,
      [appointmentId],
    );
    const already = Number(paidRow?.s ?? 0);
    const serviceDue = Math.max(0, price - already);

    if (kind === "deposit") {
      if (!["scheduled", "confirmed"].includes(appt.status)) {
        throw new AppError("VALIDATION", "Предоплату можно принять только до визита");
      }
      if (handed > serviceDue) throw new AppError("VALIDATION", "Предоплата больше остатка");
      lines.push({ type: "deposit", refId: appointmentId, title: "Предоплата", amountMinor: handed });
    } else if (kind === "tip") {
      lines.push({ type: "tip", refId: appointmentId, title: "Чаевые", amountMinor: handed });
    } else {
      if (tipMinor > handed) throw new AppError("VALIDATION", "Чаевые больше внесённой суммы");
      const cashHanded = input.tenders.filter((tender) => tender.method === "cash").reduce((sum, tender) => sum + tender.amountMinor, 0);
      // PAY-UPSELL-01: goods sold to the client at checkout go into the same payment and receipt.
      const goodsLines = input.items?.length ? await productLines(ctx, input.branchId, input.items) : [];
      const goodsMinor = goodsLines.reduce((sum, line) => sum + line.amountMinor, 0);
      if (serviceDue === 0 && tipMinor === 0 && goodsMinor === 0) {
        throw new AppError("VALIDATION", "Запись уже оплачена");
      }
      if (handed < goodsMinor + tipMinor) throw new AppError("VALIDATION", "Внесено меньше суммы товаров и чаевых");
      const intendedService = input.amountMinor !== undefined ? Math.min(input.amountMinor, serviceDue) : serviceDue;
      const servicePay = Math.min(intendedService, Math.max(0, handed - tipMinor - goodsMinor), serviceDue);
      if (servicePay + tipMinor + goodsMinor <= 0) throw new AppError("VALIDATION", "Укажите сумму оплаты");
      if (input.acknowledgePartial === false && servicePay < serviceDue) {
        throw new AppError("VALIDATION", "Суммы не хватает для полной оплаты");
      }
      const bill = servicePay + tipMinor + goodsMinor;
      let change = 0;
      if (handed > bill) {
        change = handed - bill;
        if (change > cashHanded) {
          throw new AppError("VALIDATION", "Сдача возможна только с наличных. Уменьшите сумму карты");
        }
      }
      if (servicePay > serviceDue) throw new AppError("VALIDATION", "Сумма больше остатка по записи");
      let left = servicePay;
      for (const service of services.rows) {
        const paidService = await one<{ s: number }>(
          ctx.db,
          `SELECT ${NET_AMOUNT} AS s
           FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id
           WHERE p.appointment_id = $1 AND ${LIVE_PAYMENT} AND pl.ref_id = $2 AND pl.line_type = 'service'`,
          [appointmentId, service.id],
        );
        const due = Number(service.price_minor) - Number(paidService?.s ?? 0);
        if (due <= 0 || left <= 0) continue;
        const take = Math.min(due, left);
        lines.push({ type: "service", refId: service.id, title: service.title_snapshot, amountMinor: take });
        left -= take;
      }
      if (left > 0) throw new AppError("VALIDATION", "Сумма больше остатка по записи");
      lines.push(...goodsLines);
      if (tipMinor > 0) lines.push({ type: "tip", refId: appointmentId, title: "Чаевые", amountMinor: tipMinor });
      const total = lines.reduce((sum, line) => sum + line.amountMinor, 0);
      const serviceDueList = [];
      for (const service of services.rows) {
        const paidService = await one<{ s: number }>(
          ctx.db,
          `SELECT ${NET_AMOUNT} AS s FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id
           WHERE p.appointment_id = $1 AND ${LIVE_PAYMENT} AND pl.ref_id = $2 AND pl.line_type = 'service'`,
          [appointmentId, service.id],
        );
        serviceDueList.push({ serviceId: service.service_id, dueMinor: Number(service.price_minor) - Number(paidService?.s ?? 0) });
      }
      // LOY-BON-02: the burn cap is a share of the whole visit, so paying in two goes cannot beat it.
      const spent = await one<{ s: number }>(
        ctx.db,
        `SELECT COALESCE(SUM(CASE WHEN p.direction = 'in' THEN t.amount_minor ELSE -t.amount_minor END), 0)::int AS s
         FROM payment_tenders t JOIN payments p ON p.id = t.payment_id
         WHERE p.appointment_id = $1 AND ${LIVE_PAYMENT} AND t.method = 'bonus'`,
        [appointmentId],
      );
      const resolved = await resolveTenders(ctx, {
        tenders: input.tenders,
        branchId: input.branchId,
        clientId,
        bill: servicePay + goodsMinor,
        bonusBase: { totalMinor: services.rows.reduce((sum, service) => sum + Number(service.price_minor), 0), spentMinor: Number(spent?.s ?? 0) },
        appointmentId,
        serviceDue: serviceDueList,
      });
      const payment = await insertPayment(ctx, {
      ...external,
        branchId: input.branchId,
        appointmentId,
        clientId,
        shiftId,
        total,
        change,
        lines,
        tenders: storedTenders(resolved, change),
      });
      const synced = await syncAppointmentDebt(ctx, appointmentId);
      await ctx.db.query(
        "UPDATE appointments SET version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1",
        [appointmentId, ctx.actor.userId],
      );
      return { ...payment, ...synced, partial: synced.paidMinor < synced.priceMinor && synced.paidMinor > 0 };
    }
  }

  const total = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  const payment = await insertPayment(ctx, {
      ...external,
    branchId: input.branchId,
    appointmentId,
    clientId,
    shiftId,
    total,
    change: 0,
    lines,
    tenders: input.tenders.map((tender) => ({ method: tender.method, amountMinor: tender.amountMinor })),
  });
  if (kind === "debt" && clientId) {
    await ctx.db.query("UPDATE clients SET balance_minor = balance_minor - $2, updated_at = now() WHERE id = $1", [
      clientId,
      total,
    ]);
  }
  let synced = null;
  if (appointmentId && kind !== "tip") {
    synced = await syncAppointmentDebt(ctx, appointmentId);
    await ctx.db.query(
      "UPDATE appointments SET version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1",
      [appointmentId, ctx.actor.userId],
    );
  }
  return { ...payment, ...(synced ?? {}), partial: synced ? synced.paidMinor < synced.priceMinor && synced.paidMinor > 0 : false };
}

export function externalRefs(input: { receiptNo?: unknown; terminalRef?: unknown }) {
  const clean = (value: unknown, label: string) => {
    const text = typeof value === "string" ? value.trim() : "";
    if (text.length > 40) throw new AppError("VALIDATION", `${label}: не длиннее 40 символов`);
    return text || null;
  };
  return { receiptNo: clean(input.receiptNo, "Номер чека"), terminalRef: clean(input.terminalRef, "Код операции терминала") };
}

function storedTenders(tenders: StoredTender[], change: number) {
  let changeLeft = change;
  const stored: StoredTender[] = [];
  for (const tender of tenders) {
    let amount = tender.amountMinor;
    if (tender.method === "cash" && changeLeft > 0) {
      const cut = Math.min(amount, changeLeft);
      amount -= cut;
      changeLeft -= cut;
    }
    if (amount > 0) stored.push({ ...tender, amountMinor: amount });
  }
  return stored;
}

export type PaymentLineInput = {
  type: string;
  refId: string | null;
  title: string;
  amountMinor: number;
  refundOfLineId?: string | null;
  itemId?: string | null;
  qty?: number | null;
};

export async function insertPayment(
  ctx: Ctx,
  input: {
    branchId: string;
    appointmentId: string | null;
    clientId: string | null;
    shiftId: string | null;
    total: number;
    change: number;
    lines: PaymentLineInput[];
    tenders: StoredTender[];
    direction?: "in" | "out";
    refundOfId?: string | null;
    refundReason?: string | null;
    receiptNo?: string | null;
    terminalRef?: string | null;
  },
) {
  const direction = input.direction ?? "in";
  const tenderSum = input.tenders.reduce((sum, tender) => sum + tender.amountMinor, 0);
  if (tenderSum !== input.total) {
    throw new AppError("VALIDATION", "Сумма оплат не сходится с чеком");
  }
  const id = crypto.randomUUID();
  await ctx.db.query(
    `INSERT INTO payments (
       id, tenant_id, branch_id, appointment_id, client_id, shift_id, direction, status,
       total_minor, change_minor, created_by, posted_at, refund_of_id, refund_reason, external_receipt_no, terminal_ref
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'posted',$8,$9,$10, now(), $11, $12, $13, $14)`,
    [
      id,
      ctx.actor.tenantId,
      input.branchId,
      input.appointmentId,
      input.clientId,
      input.shiftId,
      direction,
      input.total,
      input.change,
      ctx.actor.userId,
      input.refundOfId ?? null,
      input.refundReason ?? null,
      input.receiptNo ?? null,
      input.terminalRef ?? null,
    ],
  );
  const lineIds: string[] = [];
  for (const line of input.lines) {
    const lineId = crypto.randomUUID();
    lineIds.push(lineId);
    await ctx.db.query(
      `INSERT INTO payment_lines (id, tenant_id, payment_id, line_type, ref_id, title, amount_minor, refund_of_line_id, item_id, qty)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        lineId,
        ctx.actor.tenantId,
        id,
        line.type,
        line.refId,
        line.title,
        line.amountMinor,
        line.refundOfLineId ?? null,
        line.itemId ?? null,
        line.qty == null ? null : line.qty.toFixed(3),
      ],
    );
  }
  for (const tender of input.tenders) {
    await ctx.db.query(
      `INSERT INTO payment_tenders (id, tenant_id, payment_id, method, amount_minor, certificate_id, membership_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [crypto.randomUUID(), ctx.actor.tenantId, id, tender.method, tender.amountMinor, tender.certificateId ?? null, tender.membershipId ?? null],
    );
  }
  await afterPaymentPosted(ctx, id);
  await loyaltyAfterPosted(ctx, id);
  await enqueueReceipt(ctx, id);
  if (direction === "in") {
    await audit(ctx, {
      branchId: input.branchId,
      entity: "payment",
      entityId: id,
      action: "payment.posted",
      diff: { totalMinor: input.total, changeMinor: input.change, appointmentId: input.appointmentId, shiftId: input.shiftId },
    });
  }
  return { id, totalMinor: input.total, changeMinor: input.change, status: "posted" as const, lineIds };
}
