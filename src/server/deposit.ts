/**
 * OB-PAY-01: deposit for online bookings. The booking is created at once (the slot is taken), waits
 * `online_deposit_minutes` for the money and is cancelled when nothing came in, so the slot frees up.
 */
import { AppError } from "@/domain/errors";
import { issuePayLink, ACQUIRING_ACTOR_ID } from "./acquiring";
import { cancelAppointment } from "./appointments";
import { many } from "./db";
import { notifyDesk, publicUrl } from "./messaging";
import type { Actor, BranchRow, Ctx } from "./types";

/** Amount the client pays online for this service at this branch; 0 = no deposit. */
export function depositAmount(branch: Pick<BranchRow, "acquiring_enabled" | "online_deposit_bps">, service: { price_minor: number; online_deposit_minor: number | null }) {
  if (!branch.acquiring_enabled) return 0;
  const price = Number(service.price_minor);
  const raw = service.online_deposit_minor !== null && service.online_deposit_minor !== undefined
    ? Number(service.online_deposit_minor)
    : Math.round((price * Number(branch.online_deposit_bps)) / 10000);
  return Math.max(0, Math.min(raw, price));
}

/** Starts the wait and returns the client's pay page. */
export async function startDeposit(ctx: Ctx, branch: BranchRow, appointmentId: string, amountMinor: number) {
  const dueAt = new Date(ctx.now.getTime() + Number(branch.online_deposit_minutes) * 60_000);
  await ctx.db.query("UPDATE appointments SET deposit_due_at = $2 WHERE id = $1", [appointmentId, dueAt.toISOString()]);
  try {
    const link = await issuePayLink(ctx, appointmentId, { amountMinor, purpose: "deposit", origin: publicUrl() });
    return { amountMinor, payUrl: String(link.url), dueAt: dueAt.toISOString() };
  } catch (error) {
    // No pay link means no way to pay: the booking stands without a deposit rather than being lost.
    await ctx.db.query("UPDATE appointments SET deposit_due_at = NULL WHERE id = $1", [appointmentId]);
    await notifyDesk(ctx, {
      branchId: branch.id,
      kind: "payment.online_problem",
      title: "Онлайн-запись без предоплаты",
      body: `Не удалось создать ссылку на оплату: ${error instanceof AppError ? error.message : "ошибка провайдера"}`,
      entity: "appointment",
      entityId: appointmentId,
    });
    return null;
  }
}

function depositActor(tenantId: string, branchId: string): Actor {
  return { userId: ACQUIRING_ACTOR_ID, tenantId, role: "admin", branchId, staffId: null, name: "Онлайн-оплата", email: "" };
}

/** Job: unpaid bookings past their deadline are cancelled and their links closed. */
export async function cancelUnpaidDeposits(ctx: Ctx) {
  const due = await many<{ id: string; branch_id: string; version: number; client_name: string | null }>(
    ctx.db,
    `SELECT a.id, a.branch_id, a.version, c.name AS client_name FROM appointments a LEFT JOIN clients c ON c.id = a.client_id
     WHERE a.deposit_due_at IS NOT NULL AND a.deposit_due_at <= $1 AND a.status IN ('scheduled', 'confirmed')
     ORDER BY a.deposit_due_at FOR UPDATE OF a SKIP LOCKED`,
    [ctx.now.toISOString()],
  );
  let cancelled = 0;
  for (const row of due) {
    const actorCtx: Ctx = { ...ctx, actor: depositActor(ctx.actor.tenantId, row.branch_id) };
    await cancelAppointment(actorCtx, row.id, { version: Number(row.version), reason: "Не внесена предоплата" });
    await ctx.db.query("UPDATE appointments SET deposit_due_at = NULL WHERE id = $1", [row.id]);
    await ctx.db.query("UPDATE online_payments SET status = 'canceled', updated_at = now() WHERE appointment_id = $1 AND status IN ('created', 'pending')", [row.id]);
    await notifyDesk(actorCtx, {
      branchId: row.branch_id,
      kind: "booking.online",
      title: `Онлайн-запись отменена: ${row.client_name ?? "клиент"} не внёс предоплату`,
      entity: "appointment",
      entityId: row.id,
    });
    cancelled += 1;
  }
  return cancelled;
}
