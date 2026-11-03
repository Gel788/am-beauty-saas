import { AppError } from "@/domain/errors";
import { audit } from "./audit";
import { isAdminPlus, loadBranch } from "./access";
import { one } from "./db";
import type { Ctx } from "./types";

type TenderInput = { method: "cash" | "card" | "sbp" | "transfer" | "bonus" | "certificate"; amountMinor: number };

const ALLOWED = new Set(["cash", "card", "sbp", "transfer"]);

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
    `SELECT COALESCE(SUM(pl.amount_minor), 0)::int AS s
     FROM payment_lines pl
     JOIN payments p ON p.id = pl.payment_id
     WHERE p.appointment_id = $1 AND p.status = 'posted' AND p.direction = 'in'
       AND pl.line_type IN ('service', 'deposit')`,
    [appointmentId],
  );
  const settlementRow = await one<{ s: number }>(
    ctx.db,
    `SELECT COALESCE(SUM(pl.amount_minor), 0)::int AS s
     FROM payment_lines pl
     JOIN payments p ON p.id = pl.payment_id
     WHERE p.appointment_id = $1 AND p.status = 'posted' AND p.direction = 'in'
       AND pl.line_type = 'service'`,
    [appointmentId],
  );
  const price = Number(priceRow?.s ?? 0);
  const paid = Number(paidRow?.s ?? 0);
  const settled = Number(settlementRow?.s ?? 0);
  const newDebt = appt.status !== "cancelled" && settled > 0 && paid < price ? price - paid : 0;
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

async function requireShift(ctx: Ctx, branchId: string, bypassShift?: boolean) {
  const branch = await loadBranch(ctx, branchId);
  const closing = await one<{ id: string }>(
    ctx.db,
    "SELECT id FROM cash_shifts WHERE branch_id = $1 AND status = 'closing'",
    [branchId],
  );
  if (closing) throw new AppError("SHIFT_CLOSED", "Смена закрывается, оплата недоступна");
  const open = await one<{ id: string }>(
    ctx.db,
    "SELECT id FROM cash_shifts WHERE branch_id = $1 AND status = 'open'",
    [branchId],
  );
  if (branch.require_open_shift && !open) {
    if (bypassShift && ctx.actor.role === "owner" && branch.owner_can_bypass_shift) {
      return { shiftId: null as string | null, branch };
    }
    throw new AppError("SHIFT_REQUIRED", "Сначала откройте смену", { branchId });
  }
  return { shiftId: open?.id ?? null, branch };
}

function assertMoney(value: number, label: string) {
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
    "SELECT id, opened_at FROM cash_shifts WHERE branch_id = $1 AND status = 'open'",
    [input.branchId],
  );
  if (existing) {
    throw new AppError("VALIDATION", "Смена уже открыта", {
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

export async function currentShift(ctx: Ctx, branchId: string) {
  await loadBranch(ctx, branchId);
  const row = await one<{
    id: string;
    status: string;
    opening_cash_minor: number;
    opened_at: Date;
    note: string;
  }>(
    ctx.db,
    `SELECT id, status, opening_cash_minor, opened_at, note
     FROM cash_shifts WHERE branch_id = $1 AND status = 'open'`,
    [branchId],
  );
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    openingCashMinor: Number(row.opening_cash_minor),
    openedAt: new Date(row.opened_at).toISOString(),
    note: row.note,
  };
}

export async function createPayment(
  ctx: Ctx,
  input: {
    branchId: string;
    kind?: "visit" | "deposit" | "tip" | "debt" | "misc";
    appointmentId?: string | null;
    clientId?: string | null;
    version?: number;
    tenders: TenderInput[];
    tipMinor?: number;
    amountMinor?: number;
    title?: string;
    bypassShift?: boolean;
    acknowledgePartial?: boolean;
  },
) {
  const kind = input.kind ?? (input.appointmentId ? "visit" : "misc");
  if (kind === "misc" || kind === "debt") {
    if (!isAdminPlus(ctx.actor) && ctx.actor.role !== "accountant") {
      throw new AppError("FORBIDDEN", "Недостаточно прав");
    }
  }
  for (const tender of input.tenders ?? []) {
    assertMoney(tender.amountMinor, "Оплата");
    if (!ALLOWED.has(tender.method)) {
      throw new AppError("VALIDATION", "Бонусы и сертификаты подключаются с модулем лояльности");
    }
  }
  const handed = (input.tenders ?? []).reduce((sum, tender) => sum + tender.amountMinor, 0);
  if (handed <= 0) throw new AppError("VALIDATION", "Укажите сумму оплаты");

  const { shiftId } = await requireShift(ctx, input.branchId, input.bypassShift);
  const tipMinor = input.tipMinor ?? 0;
  assertMoney(tipMinor, "Чаевые");

  let clientId = input.clientId ?? null;
  let appointmentId = input.appointmentId ?? null;
  const lines: { type: string; refId: string | null; title: string; amountMinor: number }[] = [];

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
  } else if (kind === "misc") {
    lines.push({
      type: "product",
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
    const services = await ctx.db.query<{ id: string; title_snapshot: string; price_minor: number }>(
      "SELECT id, title_snapshot, price_minor FROM appointment_services WHERE appointment_id = $1 ORDER BY position",
      [appointmentId],
    );
    const price = services.rows.reduce((sum, service) => sum + Number(service.price_minor), 0);
    const paidRow = await one<{ s: number }>(
      ctx.db,
      `SELECT COALESCE(SUM(pl.amount_minor), 0)::int AS s
       FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id
       WHERE p.appointment_id = $1 AND p.status = 'posted' AND p.direction = 'in'
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
      if (serviceDue === 0 && tipMinor === 0) {
        throw new AppError("VALIDATION", "Запись уже оплачена");
      }
      const intendedService = input.amountMinor !== undefined ? Math.min(input.amountMinor, serviceDue) : serviceDue;
      const servicePay = Math.min(intendedService, Math.max(0, handed - tipMinor), serviceDue);
      if (servicePay + tipMinor <= 0) throw new AppError("VALIDATION", "Укажите сумму оплаты");
      if (input.acknowledgePartial === false && servicePay + tipMinor < serviceDue + tipMinor && servicePay < serviceDue) {
        throw new AppError("VALIDATION", "Суммы не хватает для полной оплаты");
      }
      const bill = servicePay + tipMinor;
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
          `SELECT COALESCE(SUM(pl.amount_minor), 0)::int AS s
           FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id
           WHERE p.appointment_id = $1 AND p.status = 'posted' AND pl.ref_id = $2 AND pl.line_type = 'service'`,
          [appointmentId, service.id],
        );
        const due = Number(service.price_minor) - Number(paidService?.s ?? 0);
        if (due <= 0 || left <= 0) continue;
        const take = Math.min(due, left);
        lines.push({ type: "service", refId: service.id, title: service.title_snapshot, amountMinor: take });
        left -= take;
      }
      if (left > 0) throw new AppError("VALIDATION", "Сумма больше остатка по записи");
      if (tipMinor > 0) lines.push({ type: "tip", refId: appointmentId, title: "Чаевые", amountMinor: tipMinor });
      const total = lines.reduce((sum, line) => sum + line.amountMinor, 0);
      const payment = await insertPayment(ctx, {
        branchId: input.branchId,
        appointmentId,
        clientId,
        shiftId,
        total,
        change,
        lines,
        tenders: storedTenders(input.tenders, change),
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

function storedTenders(tenders: TenderInput[], change: number) {
  let changeLeft = change;
  const stored: { method: TenderInput["method"]; amountMinor: number }[] = [];
  for (const tender of tenders) {
    let amount = tender.amountMinor;
    if (tender.method === "cash" && changeLeft > 0) {
      const cut = Math.min(amount, changeLeft);
      amount -= cut;
      changeLeft -= cut;
    }
    if (amount > 0) stored.push({ method: tender.method, amountMinor: amount });
  }
  return stored;
}

async function insertPayment(
  ctx: Ctx,
  input: {
    branchId: string;
    appointmentId: string | null;
    clientId: string | null;
    shiftId: string | null;
    total: number;
    change: number;
    lines: { type: string; refId: string | null; title: string; amountMinor: number }[];
    tenders: { method: string; amountMinor: number }[];
  },
) {
  const tenderSum = input.tenders.reduce((sum, tender) => sum + tender.amountMinor, 0);
  if (tenderSum !== input.total) {
    throw new AppError("VALIDATION", "Сумма оплат не сходится с чеком");
  }
  const id = crypto.randomUUID();
  await ctx.db.query(
    `INSERT INTO payments (
       id, tenant_id, branch_id, appointment_id, client_id, shift_id, direction, status,
       total_minor, change_minor, created_by, posted_at
     ) VALUES ($1,$2,$3,$4,$5,$6,'in','posted',$7,$8,$9, now())`,
    [
      id,
      ctx.actor.tenantId,
      input.branchId,
      input.appointmentId,
      input.clientId,
      input.shiftId,
      input.total,
      input.change,
      ctx.actor.userId,
    ],
  );
  for (const line of input.lines) {
    await ctx.db.query(
      `INSERT INTO payment_lines (id, tenant_id, payment_id, line_type, ref_id, title, amount_minor)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [crypto.randomUUID(), ctx.actor.tenantId, id, line.type, line.refId, line.title, line.amountMinor],
    );
  }
  for (const tender of input.tenders) {
    await ctx.db.query(
      `INSERT INTO payment_tenders (id, tenant_id, payment_id, method, amount_minor)
       VALUES ($1,$2,$3,$4,$5)`,
      [crypto.randomUUID(), ctx.actor.tenantId, id, tender.method, tender.amountMinor],
    );
  }
  await audit(ctx, {
    branchId: input.branchId,
    entity: "payment",
    entityId: id,
    action: "payment.posted",
    diff: { totalMinor: input.total, changeMinor: input.change, appointmentId: input.appointmentId },
  });
  return { id, totalMinor: input.total, changeMinor: input.change, status: "posted" as const };
}

export async function listPayments(ctx: Ctx, branchId: string, date?: string) {
  await loadBranch(ctx, branchId);
  if (!["owner", "admin", "accountant"].includes(ctx.actor.role)) {
    throw new AppError("FORBIDDEN", "Недостаточно прав");
  }
  const rows = await ctx.db.query<{
    id: string;
    total_minor: number;
    change_minor: number;
    status: string;
    posted_at: Date | null;
    appointment_id: string | null;
    client_id: string | null;
    client_name: string | null;
  }>(
    `SELECT p.id, p.total_minor, p.change_minor, p.status, p.posted_at, p.appointment_id, p.client_id, c.name AS client_name
     FROM payments p
     LEFT JOIN clients c ON c.id = p.client_id
     WHERE p.branch_id = $1
       AND ($2::date IS NULL OR (p.posted_at AT TIME ZONE (SELECT timezone FROM branches WHERE id = $1))::date = $2::date)
     ORDER BY p.posted_at DESC
     LIMIT 100`,
    [branchId, date ?? null],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    totalMinor: Number(row.total_minor),
    changeMinor: Number(row.change_minor),
    status: row.status,
    postedAt: row.posted_at ? new Date(row.posted_at).toISOString() : null,
    appointmentId: row.appointment_id,
    clientId: row.client_id,
    clientName: row.client_name,
  }));
}
