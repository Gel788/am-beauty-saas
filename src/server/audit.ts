import type { Ctx } from "./types";

export async function audit(
  ctx: Ctx,
  entry: {
    branchId?: string | null;
    entity: string;
    entityId: string;
    action: string;
    diff?: unknown;
  },
): Promise<void> {
  await ctx.db.query(
    `INSERT INTO audit_log (id, tenant_id, branch_id, actor_id, entity, entity_id, action, diff)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      crypto.randomUUID(),
      ctx.actor.tenantId,
      entry.branchId ?? null,
      ctx.actor.userId,
      entry.entity,
      entry.entityId,
      entry.action,
      JSON.stringify(entry.diff ?? {}),
    ],
  );
}

export async function listAudit(ctx: Ctx, entity: string, entityId: string) {
  const result = await ctx.db.query(
    `SELECT id, actor_id, action, diff, created_at, branch_id
     FROM audit_log
     WHERE entity = $1 AND entity_id = $2
     ORDER BY created_at ASC`,
    [entity, entityId],
  );
  return result.rows.map((row) => ({
    id: row.id as string,
    actorId: row.actor_id as string | null,
    action: row.action as string,
    diff: row.diff,
    createdAt: new Date(row.created_at as string).toISOString(),
    branchId: row.branch_id as string | null,
  }));
}
