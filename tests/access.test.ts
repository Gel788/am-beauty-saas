import { describe, expect, it } from "vitest";
import { login, register } from "@/server/auth";
import { createClient } from "@/server/clients";
import { withSession } from "@/server/db";
import { createSalon, run, bindTestDb } from "./helpers";

bindTestDb();

describe("access", () => {
  it("registers a tenant and logs in", async () => {
    const email = `olga-${crypto.randomUUID().slice(0, 8)}@test.local`;
    const created = await register({
      email,
      password: "ambeauty",
      name: "Ольга",
      salonName: "Новый салон",
    });
    expect(created.actor.role).toBe("owner");
    const again = await login(email, "ambeauty");
    expect(again.actor?.tenantId).toBe(created.actor.tenantId);
    await expect(login(email, "wrong-pass")).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("RLS hides another tenant's clients", async () => {
    const a = await createSalon();
    const b = await createSalon();
    await run(b.admin, (ctx) => createClient(ctx, { name: "Секрет Б", phone: "+79008887766" }));
    const rows = await run(a.admin, (ctx) => ctx.db.query("SELECT name FROM clients"));
    expect(rows.rows.some((row) => row.name === "Секрет Б")).toBe(false);
    await expect(
      withSession({ tenantId: a.tenantId, userId: a.owner.userId }, (db) =>
        db.query("INSERT INTO clients (id, tenant_id, name) VALUES ($1, $2, 'чужой')", [
          crypto.randomUUID(),
          b.tenantId,
        ]),
      ),
    ).rejects.toBeTruthy();
  });
});
