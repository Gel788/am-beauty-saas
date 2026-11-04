import { beforeAll, describe, expect, it } from "vitest";
import { createAppointment } from "@/server/appointments";
import { many, withSession } from "@/server/db";
import { JOBS_ACTOR_ID, inQuietHours, registerChannel, runReminderJob, sendDueReminders } from "@/server/reminders";
import { listMessages } from "@/server/reminders";
import { NOW, at, bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;

beforeAll(async () => {
  salon = await createSalon();
});

function job(now = NOW) {
  return withSession({ tenantId: salon.tenantId, userId: JOBS_ACTOR_ID }, (db) =>
    sendDueReminders({
      db,
      actor: { userId: JOBS_ACTOR_ID, tenantId: salon.tenantId, role: "client", branchId: null, staffId: null, name: "", email: "" },
      now,
    }),
  );
}

function visit(date: string, time: string, clientId = salon.clientId, staffId = salon.staffA) {
  return run(salon.admin, (ctx) =>
    createAppointment(ctx, { branchId: salon.branchId, staffId, clientId, startsAt: at(time, date), services: [{ serviceId: salon.serviceId }] }),
  );
}

async function messages() {
  return run(salon.owner, (ctx) =>
    many<{ appointment_id: string; status: string; channel: string; error: string | null; body: string }>(
      ctx.db,
      "SELECT appointment_id, status, channel, error, body FROM outbound_messages ORDER BY created_at",
    ),
  );
}

describe("visit reminders", () => {
  it("MSG-AUTO-01 reminds once for live appointments inside the window", async () => {
    // NOW is 12:00 local on 2026-11-03; the window is 24 hours.
    const soon = await visit("2026-11-03", "15:00");
    const tomorrow = await visit("2026-11-04", "10:00");
    const tooFar = await visit("2026-11-04", "13:00");
    const cancelled = await visit("2026-11-03", "17:00");
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE appointments SET status = 'cancelled' WHERE id = $1", [cancelled.id]));

    expect(await job()).toEqual({ sent: 2, failed: 0, deferred: 0 });
    const sent = await messages();
    expect(sent.map((row) => row.appointment_id).sort()).toEqual([soon.id, tomorrow.id].sort());
    expect(sent.every((row) => row.status === "delivered" && row.channel === "log")).toBe(true);
    expect(sent[0].body).toContain("Маникюр");
    expect(sent[0].body).toContain("Алина");

    expect(await job()).toEqual({ sent: 0, failed: 0, deferred: 0 });
    expect(sent.find((row) => row.appointment_id === tooFar.id)).toBeUndefined();
    const history = await run(salon.admin, (ctx) =>
      many<{ action: string }>(ctx.db, "SELECT action FROM audit_log WHERE entity_id = $1", [soon.id]),
    );
    expect(history.map((row) => row.action)).toContain("reminder.sent");
  });

  it("MSG edge: nothing goes out in quiet hours; it is sent after them", async () => {
    const late = await visit("2026-11-05", "11:00", salon.clientId, salon.staffB);
    const night = new Date("2026-11-04T20:30:00.000Z"); // 23:30 local
    expect(inQuietHours(night, { timezone: "Europe/Moscow", quiet_start_min: 1320, quiet_end_min: 540 })).toBe(true);
    expect((await job(night)).deferred).toBe(1);
    expect((await messages()).find((row) => row.appointment_id === late.id)).toBeUndefined();
    const morning = new Date("2026-11-05T06:05:00.000Z"); // 09:05 local
    expect((await job(morning)).sent).toBe(1);
  });

  it("MSG-AUTO-01 falls back to the next channel and logs failures", async () => {
    registerChannel({ name: "broken", deliver: async () => ({ ok: false, error: "нет связи" }) });
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE tenants SET message_channels = ARRAY['broken', 'log'] WHERE id = $1", [salon.tenantId]));
    const a = await visit("2026-11-06", "10:00");
    const noPhone = crypto.randomUUID();
    await run(salon.owner, (ctx) =>
      ctx.db.query("INSERT INTO clients (id, tenant_id, name) VALUES ($1, $2, 'Без телефона')", [noPhone, salon.tenantId]),
    );
    const b = await visit("2026-11-06", "12:00", noPhone);
    const result = await job(new Date("2026-11-05T09:00:00.000Z"));
    expect(result).toEqual({ sent: 1, failed: 1, deferred: 0 });
    const rows = await messages();
    expect(rows.find((row) => row.appointment_id === a.id)?.channel).toBe("log");
    expect(rows.find((row) => row.appointment_id === b.id)).toMatchObject({ status: "failed", error: "У клиента нет телефона" });

    const list = await run(salon.admin, (ctx) => listMessages(ctx, salon.branchId));
    expect(list.length).toBe(rows.length);
    await expect(run(salon.master, (ctx) => listMessages(ctx, salon.branchId))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("MSG-AUTO-01 reminders can be switched off per branch; the job walks every tenant", async () => {
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE branches SET reminder_enabled = false WHERE id = $1", [salon.branchId]));
    const c = await visit("2026-11-07", "10:00");
    expect(await job(new Date("2026-11-06T09:00:00.000Z"))).toEqual({ sent: 0, failed: 0, deferred: 0 });
    await run(salon.owner, (ctx) => ctx.db.query("UPDATE branches SET reminder_enabled = true WHERE id = $1", [salon.branchId]));
    const total = await runReminderJob(new Date("2026-11-06T09:00:00.000Z"));
    expect(total.tenants).toBeGreaterThanOrEqual(1);
    expect((await messages()).find((row) => row.appointment_id === c.id)?.status).toBe("delivered");
  });
});
