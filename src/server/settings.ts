import { AppError } from "@/domain/errors";
import { isAdminPlus, loadBranch } from "./access";
import { many } from "./db";
import type { BranchRow, Ctx } from "./types";

export async function listBranches(ctx: Ctx) {
  const rows = await many<BranchRow>(ctx.db, "SELECT * FROM branches ORDER BY created_at");
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
  };
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
  };
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
  const branch = await loadBranch(ctx, id);
  return presentBranch(branch);
}
