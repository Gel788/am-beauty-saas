// Cash desk: shift close (SHIFT-CLOSE-*), Z-report, refunds (PAY-REFUND-*), void (PAY-VOID-01).
// Behaviour: docs/behavior/04-cash-shifts.md.
import { AppError } from "@/domain/errors";
import { audit } from "./audit";
import { loadBranch } from "./access";
import { many, one } from "./db";
import { LIVE_PAYMENT, assertMoney, insertPayment, requireShift, syncAppointmentDebt, type PaymentLineInput } from "./payments";
import type { Ctx } from "./types";

const CASH_ROLES = ["owner", "admin", "accountant", "super"];
const METHODS = ["cash", "card", "sbp", "transfer"] as const;
type Method = (typeof METHODS)[number];
const STALE_HOURS = 36;
const FORMER = "Бывший сотрудник";

function assertCashRole(ctx: Ctx) {
  if (!CASH_ROLES.includes(ctx.actor.role)) throw new AppError("FORBIDDEN", "Недостаточно прав");
}

type ShiftRow = {
  id: string;
  branch_id: string;
  status: "open" | "closing" | "closed";
  opened_by: string;
  opened_at: Date;
  opening_cash_minor: number;
  note: string;
  closing_started_by: string | null;
  closing_started_at: Date | null;
  closed_by: string | null;
  closed_at: Date | null;
  expected_cash_minor: number | null;
  counted_cash_minor: number | null;
  variance_minor: number | null;
  variance_reason: string | null;
  declared: Record<string, number> | null;
  totals: ShiftTotals | null;
  close_note: string;
  opened_by_name: string | null;
  closed_by_name: string | null;
  closing_started_by_name: string | null;
};

export type ShiftTotals = {
  openingCashMinor: number;
  byMethod: Record<Method, { inMinor: number; outMinor: number; netMinor: number }>;
  expected: Record<Method, number>;
  revenue: { servicesMinor: number; productsMinor: number; tipsMinor: number; debtRepaidMinor: number };
  incomeMinor: number;
  refundsMinor: number;
  changeGivenMinor: number;
  paymentCount: number;
  refundCount: number;
  voidCount: number;
  voidMinor: number;
};

const SHIFT_SELECT = `
  SELECT s.*,
         uo.name AS opened_by_name,
         uc.name AS closed_by_name,
         ucs.name AS closing_started_by_name
  FROM cash_shifts s
  LEFT JOIN users uo ON uo.id = s.opened_by
  LEFT JOIN users uc ON uc.id = s.closed_by
  LEFT JOIN users ucs ON ucs.id = s.closing_started_by`;

async function loadShift(ctx: Ctx, shiftId: string, lock = false): Promise<ShiftRow> {
  if (lock) {
    // Lock the bare row first: FOR UPDATE cannot target the nullable side of the joins.
    const locked = await one<{ id: string }>(ctx.db, "SELECT id FROM cash_shifts WHERE id = $1 FOR UPDATE", [shiftId]);
    if (!locked) throw new AppError("NOT_FOUND", "Смена не найдена");
  }
  const row = await one<ShiftRow>(ctx.db, `${SHIFT_SELECT} WHERE s.id = $1`, [shiftId]);
  if (!row) throw new AppError("NOT_FOUND", "Смена не найдена");
  await loadBranch(ctx, row.branch_id);
  return row;
}

/** Live totals of a shift from its posted payments. Closed shifts use the stored snapshot instead. */
export async function computeShiftTotals(ctx: Ctx, shiftId: string, openingCashMinor: number): Promise<ShiftTotals> {
  const tenders = await many<{ method: Method; direction: "in" | "out"; s: number }>(
    ctx.db,
    `SELECT t.method, p.direction, COALESCE(SUM(t.amount_minor), 0)::int AS s
     FROM payment_tenders t JOIN payments p ON p.id = t.payment_id
     WHERE p.shift_id = $1 AND ${LIVE_PAYMENT}
     GROUP BY t.method, p.direction`,
    [shiftId],
  );
  const lines = await many<{ line_type: string; direction: "in" | "out"; s: number }>(
    ctx.db,
    `SELECT pl.line_type, p.direction, COALESCE(SUM(pl.amount_minor), 0)::int AS s
     FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id
     WHERE p.shift_id = $1 AND ${LIVE_PAYMENT}
     GROUP BY pl.line_type, p.direction`,
    [shiftId],
  );
  const counts = await one<{ ins: number; outs: number; voids: number; void_minor: number; change: number; income: number; refunds: number }>(
    ctx.db,
    `SELECT
       COUNT(*) FILTER (WHERE p.direction = 'in' AND ${LIVE_PAYMENT})::int AS ins,
       COUNT(*) FILTER (WHERE p.direction = 'out' AND ${LIVE_PAYMENT})::int AS outs,
       COUNT(*) FILTER (WHERE p.status = 'void')::int AS voids,
       COALESCE(SUM(p.total_minor) FILTER (WHERE p.status = 'void'), 0)::int AS void_minor,
       COALESCE(SUM(p.change_minor) FILTER (WHERE p.direction = 'in' AND ${LIVE_PAYMENT}), 0)::int AS change,
       COALESCE(SUM(p.total_minor) FILTER (WHERE p.direction = 'in' AND ${LIVE_PAYMENT}), 0)::int AS income,
       COALESCE(SUM(p.total_minor) FILTER (WHERE p.direction = 'out' AND ${LIVE_PAYMENT}), 0)::int AS refunds
     FROM payments p WHERE p.shift_id = $1`,
    [shiftId],
  );
  const byMethod = Object.fromEntries(METHODS.map((method) => [method, { inMinor: 0, outMinor: 0, netMinor: 0 }])) as ShiftTotals["byMethod"];
  for (const row of tenders) {
    const bucket = byMethod[row.method];
    if (!bucket) continue;
    if (row.direction === "in") bucket.inMinor += Number(row.s);
    else bucket.outMinor += Number(row.s);
  }
  for (const method of METHODS) byMethod[method].netMinor = byMethod[method].inMinor - byMethod[method].outMinor;
  const net = (types: string[]) =>
    lines
      .filter((row) => types.includes(row.line_type))
      .reduce((sum, row) => sum + (row.direction === "in" ? Number(row.s) : -Number(row.s)), 0);
  return {
    openingCashMinor,
    byMethod,
    // Stored cash tenders are already net of change, so the drawer expects opening + cash in − cash out.
    expected: {
      cash: openingCashMinor + byMethod.cash.netMinor,
      card: byMethod.card.netMinor,
      sbp: byMethod.sbp.netMinor,
      transfer: byMethod.transfer.netMinor,
    },
    revenue: {
      servicesMinor: net(["service", "deposit"]),
      productsMinor: net(["product"]),
      tipsMinor: net(["tip"]),
      debtRepaidMinor: net(["debt"]),
    },
    incomeMinor: Number(counts?.income ?? 0),
    refundsMinor: Number(counts?.refunds ?? 0),
    changeGivenMinor: Number(counts?.change ?? 0),
    paymentCount: Number(counts?.ins ?? 0),
    refundCount: Number(counts?.outs ?? 0),
    voidCount: Number(counts?.voids ?? 0),
    voidMinor: Number(counts?.void_minor ?? 0),
  };
}

function presentShift(row: ShiftRow, ctx: Ctx, totals: ShiftTotals) {
  const openedAt = new Date(row.opened_at);
  const hoursOpen = (ctx.now.getTime() - openedAt.getTime()) / 3_600_000;
  return {
    id: row.id,
    branchId: row.branch_id,
    status: row.status,
    openingCashMinor: Number(row.opening_cash_minor),
    openedAt: openedAt.toISOString(),
    openedById: row.opened_by,
    openedByName: row.opened_by_name ?? FORMER,
    note: row.note,
    closingStartedAt: row.closing_started_at ? new Date(row.closing_started_at).toISOString() : null,
    closingStartedById: row.closing_started_by,
    closingStartedByName: row.closing_started_by ? row.closing_started_by_name ?? FORMER : null,
    closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
    closedByName: row.closed_by ? row.closed_by_name ?? FORMER : null,
    expectedCashMinor: row.status === "closed" ? Number(row.expected_cash_minor) : totals.expected.cash,
    countedCashMinor: row.counted_cash_minor === null ? null : Number(row.counted_cash_minor),
    varianceMinor: row.variance_minor === null ? null : Number(row.variance_minor),
    varianceReason: row.variance_reason,
    declared: row.declared ?? {},
    closeNote: row.close_note,
    staleWarning: row.status !== "closed" && hoursOpen >= STALE_HOURS,
    hoursOpen: Math.floor(hoursOpen),
    totals,
  };
}

async function shiftView(ctx: Ctx, row: ShiftRow) {
  const totals =
    row.status === "closed" && row.totals
      ? row.totals
      : await computeShiftTotals(ctx, row.id, Number(row.opening_cash_minor));
  return presentShift(row, ctx, totals);
}

/** The branch's active shift (open or closing), or null. */
export async function currentShift(ctx: Ctx, branchId: string) {
  await loadBranch(ctx, branchId);
  const row = await one<ShiftRow>(
    ctx.db,
    `${SHIFT_SELECT} WHERE s.branch_id = $1 AND s.status IN ('open', 'closing')`,
    [branchId],
  );
  if (!row) return null;
  return shiftView(ctx, row);
}

/** SHIFT-CLOSE-01 step 1–2: freeze payments and show expected totals. */
export async function startClosing(ctx: Ctx, shiftId: string) {
  assertCashRole(ctx);
  const row = await loadShift(ctx, shiftId, true);
  if (row.status === "closing") throw new AppError("VALIDATION", "Смена уже закрывается");
  if (row.status === "closed") throw new AppError("SHIFT_CLOSED", "Смена уже закрыта");
  await ctx.db.query(
    "UPDATE cash_shifts SET status = 'closing', closing_started_by = $2, closing_started_at = now() WHERE id = $1",
    [shiftId, ctx.actor.userId],
  );
  await audit(ctx, { branchId: row.branch_id, entity: "shift", entityId: shiftId, action: "shift.closing_started" });
  return shiftView(ctx, await loadShift(ctx, shiftId));
}

/** SHIFT-CLOSE-02: back to open, only by whoever started closing or the owner. */
export async function cancelClosing(ctx: Ctx, shiftId: string) {
  assertCashRole(ctx);
  const row = await loadShift(ctx, shiftId, true);
  if (row.status !== "closing") throw new AppError("VALIDATION", "Смена не в режиме закрытия");
  if (ctx.actor.role !== "owner" && ctx.actor.role !== "super" && row.closing_started_by !== ctx.actor.userId) {
    throw new AppError("FORBIDDEN", "Отменить закрытие может тот, кто его начал, или владелец");
  }
  await ctx.db.query(
    "UPDATE cash_shifts SET status = 'open', closing_started_by = NULL, closing_started_at = NULL WHERE id = $1",
    [shiftId],
  );
  await audit(ctx, { branchId: row.branch_id, entity: "shift", entityId: shiftId, action: "shift.closing_cancelled" });
  return shiftView(ctx, await loadShift(ctx, shiftId));
}

/** SHIFT-CLOSE-01 steps 3–6: count the drawer, record variance, freeze the snapshot. */
export async function closeShift(
  ctx: Ctx,
  shiftId: string,
  input: {
    countedCashMinor: number;
    declared?: Partial<Record<Exclude<Method, "cash">, number>>;
    varianceReason?: string;
    note?: string;
  },
) {
  assertCashRole(ctx);
  const row = await loadShift(ctx, shiftId, true);
  if (row.status === "closed") throw new AppError("SHIFT_CLOSED", "Смена уже закрыта");
  if (row.status !== "closing") throw new AppError("VALIDATION", "Сначала начните закрытие смены");
  if (input.countedCashMinor === undefined || input.countedCashMinor === null) {
    throw new AppError("VALIDATION", "Введите пересчитанную сумму наличных");
  }
  assertMoney(input.countedCashMinor, "Наличные по пересчёту");
  const branch = await loadBranch(ctx, row.branch_id);
  const totals = await computeShiftTotals(ctx, shiftId, Number(row.opening_cash_minor));

  // Non-cash is auto-accepted at the expected value unless the cashier declares otherwise.
  const declared: Record<string, number> = {};
  const nonCashVariance: Record<string, number> = {};
  for (const method of ["card", "sbp", "transfer"] as const) {
    const value = input.declared?.[method];
    if (value === undefined || value === null) {
      declared[method] = totals.expected[method];
      continue;
    }
    assertMoney(value, "Заявленная сумма");
    declared[method] = value;
    if (value !== totals.expected[method]) nonCashVariance[method] = value - totals.expected[method];
  }

  const variance = input.countedCashMinor - totals.expected.cash;
  const threshold = Number(branch.shift_variance_threshold_minor ?? 0);
  const reason = input.varianceReason?.trim() ?? "";
  const needsReason = Math.abs(variance) > threshold || Object.keys(nonCashVariance).length > 0;
  if (needsReason && !reason) {
    throw new AppError("VALIDATION", "Укажите причину расхождения", {
      varianceMinor: variance,
      expectedCashMinor: totals.expected.cash,
      nonCashVariance,
    });
  }

  await ctx.db.query(
    `UPDATE cash_shifts SET
       status = 'closed', closed_by = $2, closed_at = now(),
       expected_cash_minor = $3, counted_cash_minor = $4, variance_minor = $5,
       variance_reason = $6, declared = $7::jsonb, totals = $8::jsonb, close_note = $9
     WHERE id = $1`,
    [
      shiftId,
      ctx.actor.userId,
      totals.expected.cash,
      input.countedCashMinor,
      variance,
      reason || null,
      JSON.stringify(declared),
      JSON.stringify(totals),
      input.note?.trim() ?? "",
    ],
  );
  await audit(ctx, {
    branchId: row.branch_id,
    entity: "shift",
    entityId: shiftId,
    action: "shift.closed",
    diff: {
      expectedCashMinor: totals.expected.cash,
      countedCashMinor: input.countedCashMinor,
      varianceMinor: variance,
      varianceReason: reason || null,
      nonCashVariance,
    },
  });
  return shiftReport(ctx, shiftId);
}

/** Z-report (section 8): header, totals by method, refunds, expected vs counted, payments. */
export async function shiftReport(ctx: Ctx, shiftId: string) {
  assertCashRole(ctx);
  const row = await loadShift(ctx, shiftId);
  const shift = await shiftView(ctx, row);
  const payments = await describePayments(ctx, "p.shift_id = $1", [shiftId]);
  return { shift, payments };
}

export async function listShifts(ctx: Ctx, branchId: string, limit = 30) {
  assertCashRole(ctx);
  await loadBranch(ctx, branchId);
  const rows = await many<ShiftRow>(
    ctx.db,
    `${SHIFT_SELECT} WHERE s.branch_id = $1 ORDER BY s.opened_at DESC LIMIT $2`,
    [branchId, Math.min(Math.max(limit, 1), 100)],
  );
  const result = [];
  for (const row of rows) result.push(await shiftView(ctx, row));
  return result;
}

type PaymentRow = {
  id: string;
  branch_id: string;
  appointment_id: string | null;
  client_id: string | null;
  client_name: string | null;
  shift_id: string | null;
  shift_status: string | null;
  direction: "in" | "out";
  status: "posted" | "refunded" | "void" | "pending";
  total_minor: number;
  change_minor: number;
  refund_of_id: string | null;
  refund_reason: string | null;
  void_reason: string | null;
  posted_at: Date | null;
  created_by: string;
  created_by_name: string | null;
};

async function describePayments(ctx: Ctx, where: string, params: unknown[], limit = 200) {
  const rows = await many<PaymentRow>(
    ctx.db,
    `SELECT p.id, p.branch_id, p.appointment_id, p.client_id, c.name AS client_name, p.shift_id, s.status AS shift_status,
            p.direction, p.status, p.total_minor, p.change_minor, p.refund_of_id, p.refund_reason, p.void_reason,
            p.posted_at, p.created_by, u.name AS created_by_name
     FROM payments p
     LEFT JOIN clients c ON c.id = p.client_id
     LEFT JOIN cash_shifts s ON s.id = p.shift_id
     LEFT JOIN users u ON u.id = p.created_by
     WHERE ${where}
     ORDER BY p.posted_at DESC NULLS LAST, p.created_at DESC
     LIMIT ${limit}`,
    params,
  );
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const lines = await many<{ id: string; payment_id: string; line_type: string; title: string; amount_minor: number; refund_of_line_id: string | null }>(
    ctx.db,
    "SELECT id, payment_id, line_type, title, amount_minor, refund_of_line_id FROM payment_lines WHERE payment_id = ANY($1::uuid[])",
    [ids],
  );
  const tenders = await many<{ payment_id: string; method: string; amount_minor: number }>(
    ctx.db,
    "SELECT payment_id, method, amount_minor FROM payment_tenders WHERE payment_id = ANY($1::uuid[])",
    [ids],
  );
  const refunded = await many<{ refund_of_id: string; s: number }>(
    ctx.db,
    `SELECT refund_of_id, COALESCE(SUM(total_minor), 0)::int AS s
     FROM payments WHERE refund_of_id = ANY($1::uuid[]) AND status = 'posted' AND direction = 'out'
     GROUP BY refund_of_id`,
    [ids],
  );
  const refundedBy = new Map(refunded.map((row) => [row.refund_of_id, Number(row.s)]));
  const active = await one<{ id: string }>(
    ctx.db,
    "SELECT id FROM cash_shifts WHERE branch_id = $1 AND status = 'open'",
    [rows[0].branch_id],
  );
  return rows.map((row) => {
    const own = tenders.filter((tender) => tender.payment_id === row.id);
    const refundedMinor = refundedBy.get(row.id) ?? 0;
    const refundableMinor = row.direction === "in" && row.status === "posted" ? Number(row.total_minor) - refundedMinor : 0;
    const cashOnly = own.length > 0 && own.every((tender) => tender.method === "cash");
    return {
      id: row.id,
      appointmentId: row.appointment_id,
      clientId: row.client_id,
      clientName: row.client_name,
      shiftId: row.shift_id,
      direction: row.direction,
      status: row.status,
      totalMinor: Number(row.total_minor),
      changeMinor: Number(row.change_minor),
      refundOfId: row.refund_of_id,
      refundReason: row.refund_reason,
      voidReason: row.void_reason,
      postedAt: row.posted_at ? new Date(row.posted_at).toISOString() : null,
      createdByName: row.created_by_name ?? FORMER,
      lines: lines
        .filter((line) => line.payment_id === row.id)
        .map((line) => ({ id: line.id, type: line.line_type, title: line.title, amountMinor: Number(line.amount_minor), refundOfLineId: line.refund_of_line_id })),
      tenders: own.map((tender) => ({ method: tender.method, amountMinor: Number(tender.amount_minor) })),
      refundedMinor,
      refundableMinor,
      canRefund: refundableMinor > 0 && Boolean(active),
      canVoid:
        row.direction === "in" &&
        row.status === "posted" &&
        refundedMinor === 0 &&
        cashOnly &&
        Boolean(active) &&
        row.shift_id === active?.id,
    };
  });
}

export async function listPayments(ctx: Ctx, branchId: string, filter: { date?: string; shiftId?: string } = {}) {
  assertCashRole(ctx);
  const branch = await loadBranch(ctx, branchId);
  if (filter.shiftId) return describePayments(ctx, "p.branch_id = $1 AND p.shift_id = $2", [branchId, filter.shiftId]);
  if (filter.date) {
    return describePayments(ctx, "p.branch_id = $1 AND (p.posted_at AT TIME ZONE $3)::date = $2::date", [
      branchId,
      filter.date,
      branch.timezone,
    ]);
  }
  return describePayments(ctx, "p.branch_id = $1", [branchId], 100);
}

export async function appointmentPayments(ctx: Ctx, appointmentId: string) {
  const appt = await one<{ branch_id: string; staff_id: string }>(
    ctx.db,
    "SELECT branch_id, staff_id FROM appointments WHERE id = $1",
    [appointmentId],
  );
  if (!appt) throw new AppError("NOT_FOUND", "Запись не найдена");
  const branch = await loadBranch(ctx, appt.branch_id);
  const masterOwn = ctx.actor.role === "master" && ctx.actor.staffId === appt.staff_id && branch.master_can_take_payment;
  if (!CASH_ROLES.includes(ctx.actor.role) && !masterOwn) throw new AppError("FORBIDDEN", "Недостаточно прав");
  const items = await describePayments(ctx, "p.appointment_id = $1", [appointmentId]);
  // Masters may see the ledger of their visit, but refund/void are cash-desk actions.
  return masterOwn ? items.map((item) => ({ ...item, canRefund: false, canVoid: false })) : items;
}

type OriginalPayment = {
  id: string;
  branch_id: string;
  appointment_id: string | null;
  client_id: string | null;
  shift_id: string | null;
  direction: "in" | "out";
  status: string;
  total_minor: number;
  version: number;
};

async function lockOriginal(ctx: Ctx, paymentId: string) {
  const row = await one<OriginalPayment>(ctx.db, "SELECT * FROM payments WHERE id = $1 FOR UPDATE", [paymentId]);
  if (!row) throw new AppError("NOT_FOUND", "Платёж не найден");
  await loadBranch(ctx, row.branch_id);
  if (row.direction !== "in") throw new AppError("VALIDATION", "Возврат возможен только по приходу");
  if (row.status === "void") throw new AppError("VALIDATION", "Платёж аннулирован");
  if (row.status === "refunded") throw new AppError("VALIDATION", "Платёж уже полностью возвращён");
  if (row.status !== "posted") throw new AppError("VALIDATION", "Платёж не проведён");
  return row;
}

async function afterMoneyChange(ctx: Ctx, appointmentId: string | null) {
  if (!appointmentId) return null;
  const synced = await syncAppointmentDebt(ctx, appointmentId);
  await ctx.db.query(
    "UPDATE appointments SET version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1",
    [appointmentId, ctx.actor.userId],
  );
  return synced;
}

/** PAY-REFUND-01 / PAY-REFUND-02. Without `amountMinor`/`lines` the whole remainder is refunded. */
export async function refundPayment(
  ctx: Ctx,
  paymentId: string,
  input: {
    amountMinor?: number;
    lines?: { lineId: string; amountMinor: number }[];
    method?: Method;
    reason?: string;
  } = {},
) {
  assertCashRole(ctx);
  const original = await lockOriginal(ctx, paymentId);
  // P1: refunds go through the currently open shift (it may differ from the original's shift).
  const { shiftId } = await requireShift(ctx, original.branch_id);
  if (!shiftId) throw new AppError("SHIFT_REQUIRED", "Сначала откройте смену", { branchId: original.branch_id });

  const lines = await many<{ id: string; line_type: string; ref_id: string | null; title: string; amount_minor: number }>(
    ctx.db,
    "SELECT id, line_type, ref_id, title, amount_minor FROM payment_lines WHERE payment_id = $1",
    [paymentId],
  );
  const refundedLines = await many<{ refund_of_line_id: string; s: number }>(
    ctx.db,
    `SELECT pl.refund_of_line_id, COALESCE(SUM(pl.amount_minor), 0)::int AS s
     FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id
     WHERE p.refund_of_id = $1 AND p.status = 'posted' AND pl.refund_of_line_id IS NOT NULL
     GROUP BY pl.refund_of_line_id`,
    [paymentId],
  );
  const lineLeft = new Map(lines.map((line) => [line.id, Number(line.amount_minor)]));
  for (const row of refundedLines) lineLeft.set(row.refund_of_line_id, (lineLeft.get(row.refund_of_line_id) ?? 0) - Number(row.s));
  const remaining = [...lineLeft.values()].reduce((sum, value) => sum + Math.max(0, value), 0);
  if (remaining <= 0) throw new AppError("VALIDATION", "По платежу нечего возвращать");

  const refundLines: PaymentLineInput[] = [];
  if (input.lines?.length) {
    for (const item of input.lines) {
      assertMoney(item.amountMinor, "Сумма возврата");
      const line = lines.find((candidate) => candidate.id === item.lineId);
      if (!line) throw new AppError("VALIDATION", "Строка платежа не найдена");
      if (item.amountMinor === 0) continue;
      if (item.amountMinor > (lineLeft.get(line.id) ?? 0)) {
        throw new AppError("VALIDATION", `Возврат по «${line.title}» больше оплаченного`);
      }
      refundLines.push({ type: line.line_type, refId: line.ref_id, title: line.title, amountMinor: item.amountMinor, refundOfLineId: line.id });
    }
  } else {
    const wanted = input.amountMinor ?? remaining;
    assertMoney(wanted, "Сумма возврата");
    if (wanted > remaining) throw new AppError("VALIDATION", "Сумма возврата больше остатка по платежу", { refundableMinor: remaining });
    // Service money first, tips last: a partial refund rarely takes back the master's tip.
    const order = [...lines].sort((a, b) => Number(a.line_type === "tip") - Number(b.line_type === "tip"));
    let left = wanted;
    for (const line of order) {
      if (left <= 0) break;
      const take = Math.min(left, Math.max(0, lineLeft.get(line.id) ?? 0));
      if (take <= 0) continue;
      refundLines.push({ type: line.line_type, refId: line.ref_id, title: line.title, amountMinor: take, refundOfLineId: line.id });
      left -= take;
    }
  }
  const total = refundLines.reduce((sum, line) => sum + line.amountMinor, 0);
  if (total <= 0) throw new AppError("VALIDATION", "Укажите сумму возврата");

  // Money goes back the way it came: each method up to what it brought in, minus earlier refunds.
  const tenderRows = await many<{ method: Method; s: number }>(
    ctx.db,
    "SELECT method, COALESCE(SUM(amount_minor), 0)::int AS s FROM payment_tenders WHERE payment_id = $1 GROUP BY method",
    [paymentId],
  );
  const refundedTenders = await many<{ method: Method; s: number }>(
    ctx.db,
    `SELECT t.method, COALESCE(SUM(t.amount_minor), 0)::int AS s
     FROM payment_tenders t JOIN payments p ON p.id = t.payment_id
     WHERE p.refund_of_id = $1 AND p.status = 'posted'
     GROUP BY t.method`,
    [paymentId],
  );
  const methodLeft = new Map(tenderRows.map((row) => [row.method, Number(row.s)]));
  for (const row of refundedTenders) methodLeft.set(row.method, (methodLeft.get(row.method) ?? 0) - Number(row.s));
  const tenders: { method: Method; amountMinor: number }[] = [];
  if (input.method) {
    if (!METHODS.includes(input.method)) throw new AppError("VALIDATION", "Неизвестный способ возврата");
    const available = methodLeft.get(input.method) ?? 0;
    if (total > available) {
      throw new AppError("VALIDATION", "Способом возврата можно вернуть не больше, чем им оплатили", { availableMinor: available });
    }
    tenders.push({ method: input.method, amountMinor: total });
  } else {
    // Non-cash first, so the drawer is touched only when the original was paid in cash.
    let left = total;
    for (const method of ["card", "sbp", "transfer", "cash"] as const) {
      const take = Math.min(left, Math.max(0, methodLeft.get(method) ?? 0));
      if (take <= 0) continue;
      tenders.push({ method, amountMinor: take });
      left -= take;
    }
    if (left > 0) throw new AppError("VALIDATION", "Не хватает суммы по способам оплаты для возврата");
  }

  const refund = await insertPayment(ctx, {
    branchId: original.branch_id,
    appointmentId: original.appointment_id,
    clientId: original.client_id,
    shiftId,
    total,
    change: 0,
    lines: refundLines,
    tenders,
    direction: "out",
    refundOfId: original.id,
    refundReason: input.reason?.trim() || null,
  });

  const full = total === remaining;
  if (full) {
    await ctx.db.query("UPDATE payments SET status = 'refunded', version = version + 1 WHERE id = $1", [original.id]);
  } else {
    await ctx.db.query("UPDATE payments SET version = version + 1 WHERE id = $1", [original.id]);
  }
  // A refunded debt repayment puts the debt back on the client.
  const debtBack = refundLines.filter((line) => line.type === "debt").reduce((sum, line) => sum + line.amountMinor, 0);
  if (debtBack > 0 && original.client_id) {
    await ctx.db.query("UPDATE clients SET balance_minor = balance_minor + $2, updated_at = now() WHERE id = $1", [
      original.client_id,
      debtBack,
    ]);
  }
  const synced = await afterMoneyChange(ctx, original.appointment_id);
  await audit(ctx, {
    branchId: original.branch_id,
    entity: "payment",
    entityId: original.id,
    action: "payment.refunded",
    diff: { refundId: refund.id, amountMinor: total, full, tenders, reason: input.reason?.trim() || null, shiftId },
  });
  if (original.appointment_id) {
    await audit(ctx, {
      branchId: original.branch_id,
      entity: "appointment",
      entityId: original.appointment_id,
      action: "payment.refunded",
      diff: { paymentId: original.id, amountMinor: total },
    });
  }
  return {
    id: refund.id,
    refundOfId: original.id,
    amountMinor: total,
    full,
    tenders,
    originalStatus: full ? ("refunded" as const) : ("posted" as const),
    refundableMinor: remaining - total,
    ...(synced ?? {}),
  };
}

/** PAY-VOID-01: P1 voids only cash payments of the still-open shift; anything else is a refund. */
export async function voidPayment(ctx: Ctx, paymentId: string, input: { reason?: string } = {}) {
  assertCashRole(ctx);
  const original = await lockOriginal(ctx, paymentId);
  const reason = input.reason?.trim() ?? "";
  if (!reason) throw new AppError("VALIDATION", "Укажите причину аннулирования");
  const shift = original.shift_id
    ? await one<{ id: string; status: string }>(ctx.db, "SELECT id, status FROM cash_shifts WHERE id = $1 FOR SHARE", [original.shift_id])
    : null;
  if (!shift) throw new AppError("VALIDATION", "Платёж без смены — оформите возврат");
  if (shift.status === "closing") throw new AppError("SHIFT_CLOSED", "Смена закрывается, аннулирование недоступно");
  if (shift.status !== "open") throw new AppError("SHIFT_CLOSED", "Смена платежа закрыта — оформите возврат");
  const methods = await many<{ method: string }>(ctx.db, "SELECT DISTINCT method FROM payment_tenders WHERE payment_id = $1", [paymentId]);
  if (!methods.length || methods.some((row) => row.method !== "cash")) {
    throw new AppError("VALIDATION", "Аннулировать можно только оплату наличными. Для карты оформите возврат");
  }
  const refunds = await one<{ n: number }>(
    ctx.db,
    "SELECT COUNT(*)::int AS n FROM payments WHERE refund_of_id = $1 AND status = 'posted'",
    [paymentId],
  );
  if (Number(refunds?.n ?? 0) > 0) throw new AppError("VALIDATION", "По платежу уже был возврат — аннулирование недоступно");

  await ctx.db.query(
    "UPDATE payments SET status = 'void', void_reason = $2, voided_by = $3, voided_at = now(), version = version + 1 WHERE id = $1",
    [paymentId, reason, ctx.actor.userId],
  );
  const debt = await one<{ s: number }>(
    ctx.db,
    "SELECT COALESCE(SUM(amount_minor), 0)::int AS s FROM payment_lines WHERE payment_id = $1 AND line_type = 'debt'",
    [paymentId],
  );
  if (Number(debt?.s ?? 0) > 0 && original.client_id) {
    await ctx.db.query("UPDATE clients SET balance_minor = balance_minor + $2, updated_at = now() WHERE id = $1", [
      original.client_id,
      Number(debt?.s),
    ]);
  }
  const synced = await afterMoneyChange(ctx, original.appointment_id);
  await audit(ctx, {
    branchId: original.branch_id,
    entity: "payment",
    entityId: paymentId,
    action: "payment.voided",
    diff: { totalMinor: Number(original.total_minor), reason },
  });
  if (original.appointment_id) {
    await audit(ctx, {
      branchId: original.branch_id,
      entity: "appointment",
      entityId: original.appointment_id,
      action: "payment.voided",
      diff: { paymentId, totalMinor: Number(original.total_minor) },
    });
  }
  return { id: paymentId, status: "void" as const, ...(synced ?? {}) };
}
