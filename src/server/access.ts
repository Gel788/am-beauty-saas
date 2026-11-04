import { AppError } from "@/domain/errors";
import { one } from "./db";
import type { Actor, BranchRow, Ctx, Role } from "./types";

export function assertRole(ctx: Ctx, roles: Role[]): void {
  if (!roles.includes(ctx.actor.role)) {
    throw new AppError("FORBIDDEN", "Недостаточно прав");
  }
}

export async function loadBranch(ctx: Ctx, branchId: string): Promise<BranchRow> {
  const branch = await one<BranchRow>(ctx.db, "SELECT * FROM branches WHERE id = $1", [branchId]);
  if (!branch) throw new AppError("NOT_FOUND", "Филиал не найден");
  if (ctx.actor.role !== "owner" && ctx.actor.role !== "super" && ctx.actor.branchId && ctx.actor.branchId !== branchId) {
    throw new AppError("FORBIDDEN", "Нет доступа к этому филиалу");
  }
  if (ctx.actor.role === "master" && ctx.actor.staffId) {
    const link = await one<{ staff_id: string }>(
      ctx.db,
      "SELECT staff_id FROM staff_branches WHERE staff_id = $1 AND branch_id = $2",
      [ctx.actor.staffId, branchId],
    );
    if (!link) throw new AppError("FORBIDDEN", "Нет доступа к этому филиалу");
  }
  return branch;
}

export function isAdminPlus(actor: Actor): boolean {
  return actor.role === "owner" || actor.role === "admin" || actor.role === "super";
}
