import { AppError } from "@/domain/errors";
import { isAdminPlus, loadBranch } from "./access";
import { many, one } from "./db";
import type { BranchRow, Ctx } from "./types";
import { fiscalProviders } from "./fiscal";
import { acquiringProviders } from "./acquiring";

export async function listBranches(ctx: Ctx) {
  const rows = await many<BranchRow>(
    ctx.db,
    "SELECT b.*, t.slug AS tenant_slug FROM branches b JOIN tenants t ON t.id = b.tenant_id ORDER BY b.created_at, b.name",
  );
  return rows
    .filter((branch) => !ctx.actor.branchId || ctx.actor.branchId === branch.id || ctx.actor.role === "owner" || ctx.actor.role === "super")
    .map(presentBranch);
}

export function presentBranch(branch: BranchRow) {
  return {
    id: branch.id,
    name: branch.name,
    address: branch.address,
    timezone: branch.timezone,
    currency: branch.currency,
    requireOpenShift: branch.require_open_shift,
    ownerCanBypassShift: branch.owner_can_bypass_shift,
    masterSeesAllColumns: branch.master_sees_all_columns,
    masterCanCreateOwn: branch.master_can_create_own,
    masterCanDragOwn: branch.master_can_drag_own,
    masterCanCancelOwnFuture: branch.master_can_cancel_own_future,
    masterCanTakePayment: branch.master_can_take_payment,
    arrivalWindowHours: branch.arrival_window_hours,
    noShowGraceMin: branch.no_show_grace_min,
    gridLabelMin: branch.grid_label_min,
    requirePaymentOnComplete: branch.require_payment_on_complete,
    shiftVarianceThresholdMinor: Number(branch.shift_variance_threshold_minor ?? 0),
    tenantSlug: branch.tenant_slug ?? null,
    slug: branch.slug,
    onlineEnabled: branch.online_enabled,
    onlineStepMin: Number(branch.online_step_min),
    onlineMinNoticeMin: Number(branch.online_min_notice_min),
    onlineMaxAdvanceDays: Number(branch.online_max_advance_days),
    onlineHoldMin: Number(branch.online_hold_min),
    onlineCancelHours: Number(branch.online_cancel_hours),
    onlineMaxActivePerPhone: Number(branch.online_max_active_per_phone),
    onlineAccent: branch.online_accent,
    reminderEnabled: branch.reminder_enabled,
    reminderHours: Number(branch.reminder_hours),
    bookingMessageEnabled: branch.booking_message_enabled,
    accrueOnCompleteUnpaid: branch.accrue_on_complete_unpaid,
    consumePolicy: branch.consume_policy,
    allowNegativeStock: branch.allow_negative_stock,
    fiscalEnabled: branch.fiscal_enabled,
    externalReceipts: branch.external_receipts,
    fiscalProvider: branch.fiscal_provider,
    fiscalInn: branch.fiscal_inn,
    fiscalTaxation: branch.fiscal_taxation,
    fiscalVat: branch.fiscal_vat,
    fiscalPlace: branch.fiscal_place,
    acquiringEnabled: branch.acquiring_enabled,
    acquiringProvider: branch.acquiring_provider,
    acquiringLinkHours: Number(branch.acquiring_link_hours),
    onlineDepositBps: Number(branch.online_deposit_bps),
    onlineDepositMinutes: Number(branch.online_deposit_minutes),
  };
}

const INT_FIELDS: Record<string, [number, number, string]> = {
  onlineMinNoticeMin: [0, 10080, "Минимум до записи: от 0 до 10080 минут"],
  onlineMaxAdvanceDays: [1, 365, "Запись вперёд: от 1 до 365 дней"],
  onlineHoldMin: [5, 10, "Бронь слота: от 5 до 10 минут"],
  onlineCancelHours: [0, 720, "Отмена клиентом: от 0 до 720 часов"],
  onlineMaxActivePerPhone: [1, 50, "Будущих записей на телефон: от 1 до 50"],
  reminderHours: [1, 168, "Напоминание: от 1 до 168 часов до визита"],
  acquiringLinkHours: [1, 168, "Ссылка на оплату действует от 1 до 168 часов"],
  onlineDepositBps: [0, 10000, "Предоплата: от 0 до 100%"],
  onlineDepositMinutes: [10, 1440, "Время на предоплату: от 10 минут до суток"],
};

/** The salon part of the public link /b/{tenantSlug}/{branchSlug}. Owner only. */
export async function updateTenantSlug(ctx: Ctx, slug: string) {
  if (ctx.actor.role !== "owner" && ctx.actor.role !== "super") throw new AppError("FORBIDDEN", "Адрес салона меняет владелец");
  const value = slug.trim().toLowerCase();
  await ctx.db.query("UPDATE tenants SET slug = $2 WHERE id = $1", [ctx.actor.tenantId, value]);
  const row = await one<{ slug: string }>(ctx.db, "SELECT slug FROM tenants WHERE id = $1", [ctx.actor.tenantId]);
  return { tenantSlug: row?.slug ?? value };
}

export async function updateBranch(ctx: Ctx, id: string, input: Record<string, unknown>) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  await loadBranch(ctx, id);
  const map: Record<string, string> = {
    name: "name",
    address: "address",
    timezone: "timezone",
    requireOpenShift: "require_open_shift",
    masterSeesAllColumns: "master_sees_all_columns",
    masterCanCreateOwn: "master_can_create_own",
    masterCanDragOwn: "master_can_drag_own",
    masterCanCancelOwnFuture: "master_can_cancel_own_future",
    masterCanTakePayment: "master_can_take_payment",
    arrivalWindowHours: "arrival_window_hours",
    noShowGraceMin: "no_show_grace_min",
    gridLabelMin: "grid_label_min",
    requirePaymentOnComplete: "require_payment_on_complete",
    shiftVarianceThresholdMinor: "shift_variance_threshold_minor",
    slug: "slug",
    onlineEnabled: "online_enabled",
    onlineStepMin: "online_step_min",
    onlineMinNoticeMin: "online_min_notice_min",
    onlineMaxAdvanceDays: "online_max_advance_days",
    onlineHoldMin: "online_hold_min",
    onlineCancelHours: "online_cancel_hours",
    onlineMaxActivePerPhone: "online_max_active_per_phone",
    onlineAccent: "online_accent",
    reminderEnabled: "reminder_enabled",
    reminderHours: "reminder_hours",
    bookingMessageEnabled: "booking_message_enabled",
    accrueOnCompleteUnpaid: "accrue_on_complete_unpaid",
    consumePolicy: "consume_policy",
    allowNegativeStock: "allow_negative_stock",
    fiscalEnabled: "fiscal_enabled",
    externalReceipts: "external_receipts",
    fiscalProvider: "fiscal_provider",
    fiscalInn: "fiscal_inn",
    fiscalTaxation: "fiscal_taxation",
    fiscalVat: "fiscal_vat",
    fiscalPlace: "fiscal_place",
    acquiringEnabled: "acquiring_enabled",
    acquiringProvider: "acquiring_provider",
    acquiringLinkHours: "acquiring_link_hours",
    onlineDepositBps: "online_deposit_bps",
    onlineDepositMinutes: "online_deposit_minutes",
  };
  // Forms send the whole branch back, so only a changed value counts as an attempt.
  const before = presentBranch(await loadBranch(ctx, id)) as Record<string, unknown>;
  const fiscalKeys = ["fiscalEnabled", "externalReceipts", "fiscalProvider", "fiscalInn", "fiscalTaxation", "fiscalVat", "fiscalPlace", "acquiringEnabled", "acquiringProvider", "acquiringLinkHours", "onlineDepositBps", "onlineDepositMinutes"];
  if (fiscalKeys.some((key) => input[key] !== undefined && input[key] !== before[key]) && ctx.actor.role !== "owner" && ctx.actor.role !== "super") {
    throw new AppError("FORBIDDEN", "Кассу и онлайн-оплату настраивает владелец");
  }
  if (input.fiscalInn !== undefined) {
    input.fiscalInn = String(input.fiscalInn).trim();
    if (input.fiscalInn && !/^(\d{10}|\d{12})$/.test(String(input.fiscalInn))) throw new AppError("VALIDATION", "ИНН — 10 цифр для организации или 12 для ИП");
  }
  if (input.fiscalPlace !== undefined) input.fiscalPlace = String(input.fiscalPlace).trim().slice(0, 256);
  if (input.fiscalTaxation !== undefined && !["osn", "usn_income", "usn_income_outcome", "esn", "patent"].includes(String(input.fiscalTaxation))) {
    throw new AppError("VALIDATION", "Неизвестная система налогообложения");
  }
  if (input.fiscalVat !== undefined && !["none", "vat0", "vat5", "vat7", "vat10", "vat20"].includes(String(input.fiscalVat))) {
    throw new AppError("VALIDATION", "Неизвестная ставка НДС");
  }
  if (input.fiscalProvider !== undefined && !(await fiscalProviders(ctx)).some((provider) => provider.name === input.fiscalProvider)) {
    throw new AppError("VALIDATION", "Такой онлайн-кассы нет");
  }
  if (input.acquiringProvider !== undefined && !(await acquiringProviders(ctx)).some((provider) => provider.name === input.acquiringProvider)) {
    throw new AppError("VALIDATION", "Такого провайдера оплаты нет");
  }
  // One source of receipts: either the CRM's online kassa or the salon's own one.
  if (input.fiscalEnabled === true && input.externalReceipts === true) throw new AppError("VALIDATION", "Выберите одно: онлайн-касса через CRM или своя касса");
  if (input.fiscalEnabled === true && input.externalReceipts === undefined) input.externalReceipts = false;
  if (input.externalReceipts === true && input.fiscalEnabled === undefined) input.fiscalEnabled = false;
  if (input.fiscalEnabled === true) {
    const current = await loadBranch(ctx, id);
    const inn = String(input.fiscalInn ?? current.fiscal_inn);
    const place = String(input.fiscalPlace ?? current.fiscal_place);
    if (!inn) throw new AppError("VALIDATION", "Чтобы включить чеки, укажите ИНН");
    if (!place) throw new AppError("VALIDATION", "Чтобы включить чеки, укажите адрес расчётов");
  }
  for (const [key, [min, max, message]] of Object.entries(INT_FIELDS)) {
    if (input[key] === undefined) continue;
    const value = Number(input[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new AppError("VALIDATION", message);
  }
  if (input.onlineStepMin !== undefined && ![5, 10, 15, 30].includes(Number(input.onlineStepMin))) {
    throw new AppError("VALIDATION", "Шаг слотов: 5, 10, 15 или 30 минут");
  }
  if (input.onlineAccent !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(input.onlineAccent))) {
    throw new AppError("VALIDATION", "Цвет — в формате #RRGGBB");
  }
  if (input.consumePolicy !== undefined && !["warn", "block"].includes(String(input.consumePolicy))) {
    throw new AppError("VALIDATION", "Политика списания: предупреждать или запрещать");
  }
  if (input.slug !== undefined) input.slug = String(input.slug).trim().toLowerCase();
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(map)) {
    if (input[key] !== undefined) {
      values.push(input[key]);
      sets.push(`${column} = $${values.length + 1}`);
    }
  }
  if (input.shiftVarianceThresholdMinor !== undefined) {
    const value = Number(input.shiftVarianceThresholdMinor);
    if (!Number.isInteger(value) || value < 0) throw new AppError("VALIDATION", "Порог расхождения — целое число копеек ≥ 0");
  }
  if (!sets.length) throw new AppError("VALIDATION", "Нет полей для сохранения");
  values.unshift(id);
  await ctx.db.query(`UPDATE branches SET ${sets.join(", ")} WHERE id = $1`, values);
  const branch = await one<BranchRow>(
    ctx.db,
    "SELECT b.*, t.slug AS tenant_slug FROM branches b JOIN tenants t ON t.id = b.tenant_id WHERE b.id = $1",
    [id],
  );
  return presentBranch(branch!);
}
