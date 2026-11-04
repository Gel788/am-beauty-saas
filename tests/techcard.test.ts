import { beforeAll, describe, expect, it } from "vitest";
import { createAppointment, getAppointment } from "@/server/appointments";
import { mergeClients } from "@/server/merge";
import { masterDay } from "@/server/period";
import { addFormula, addPhoto, deleteFormula, deletePhoto, getPhoto, getTechCard, updateHealth } from "@/server/techcard";
import { DAY, at, bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;

beforeAll(async () => {
  salon = await createSalon();
});

// The smallest valid PNG (1×1).
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("client tech card", () => {
  it("CL-TECH-01 allergies need the health consent once, then show on the record and the master's day", async () => {
    await expect(run(salon.admin, (ctx) => updateHealth(ctx, salon.clientId, { allergies: "латекс" }))).rejects.toMatchObject({ code: "VALIDATION", details: { reason: "HEALTH_CONSENT" } });
    const card = await run(salon.admin, (ctx) => updateHealth(ctx, salon.clientId, { allergies: "латекс", contraindications: "беременность", consent: true }));
    expect(card).toMatchObject({ allergies: "латекс", contraindications: "беременность", healthConsentAt: expect.any(String) });
    // Consent is kept: the next edit needs no tick.
    await run(salon.master, (ctx) => updateHealth(ctx, salon.clientId, { allergies: "латекс, никель" }));
    await expect(run(salon.accountant, (ctx) => getTechCard(ctx, salon.clientId))).rejects.toMatchObject({ code: "FORBIDDEN" });

    const appt = await run(salon.admin, (ctx) =>
      createAppointment(ctx, { branchId: salon.branchId, staffId: salon.staffA, clientId: salon.clientId, startsAt: at("12:00", DAY), services: [{ serviceId: salon.serviceId }], acknowledgeSoft: true }),
    );
    const record = await run(salon.admin, (ctx) => getAppointment(ctx, appt.id));
    expect(record.clientAlert).toBe("Аллергия: латекс, никель. Противопоказания: беременность");

    await run(salon.master, (ctx) => addFormula(ctx, salon.clientId, { kind: "color", body: "7.1 + 8.0 1:1, оксид 6% 60 мл, 35 мин", appointmentId: appt.id }));
    const day = await run(salon.master, (ctx) => masterDay(ctx, { date: DAY }));
    const row = day.appointments.find((item) => item.id === appt.id)!;
    expect(row.alert).toContain("латекс");
    expect(row.lastFormula).toContain("7.1");
  });

  it("CL-TECH-02/03 formulas and photos: real images only, author or admin deletes", async () => {
    const withFormula = await run(salon.master, (ctx) => addFormula(ctx, salon.clientId, { kind: "nails", body: "База Kodi 12, цвет 40, топ без липкого" }));
    const mine = withFormula.formulas.find((item) => item.body.startsWith("База"))!;
    expect(mine).toMatchObject({ kind: "nails", staffName: "Алина", canDelete: true });
    const adminView = await run(salon.admin, (ctx) => addFormula(ctx, salon.clientId, { kind: "brows", body: "Хна, тон 3" }));
    const adminFormula = adminView.formulas.find((item) => item.body === "Хна, тон 3")!;
    await expect(run(salon.master, (ctx) => deleteFormula(ctx, salon.clientId, adminFormula.id))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await run(salon.master, (ctx) => deleteFormula(ctx, salon.clientId, mine.id));
    await expect(run(salon.master, (ctx) => addFormula(ctx, salon.clientId, { body: " " }))).rejects.toMatchObject({ code: "VALIDATION" });

    await expect(run(salon.master, (ctx) => addPhoto(ctx, salon.clientId, { mime: "image/png", data: Buffer.from("<svg/>").toString("base64") }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(run(salon.master, (ctx) => addPhoto(ctx, salon.clientId, { mime: "image/gif", data: PNG }))).rejects.toMatchObject({ code: "VALIDATION" });
    const withPhoto = await run(salon.master, (ctx) => addPhoto(ctx, salon.clientId, { mime: "image/png", data: `data:image/png;base64,${PNG}`, kind: "after", caption: "Миндаль, нюд" }));
    const photo = withPhoto.photos[0];
    expect(photo).toMatchObject({ kind: "after", caption: "Миндаль, нюд", url: `/api/clients/${salon.clientId}/photos/${photo.id}` });
    const file = await run(salon.admin, (ctx) => getPhoto(ctx, salon.clientId, photo.id));
    expect(file.mime).toBe("image/png");
    expect(file.data.subarray(1, 4).toString("latin1")).toBe("PNG");
    await run(salon.admin, (ctx) => deletePhoto(ctx, salon.clientId, photo.id));
    await expect(run(salon.admin, (ctx) => getPhoto(ctx, salon.clientId, photo.id))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("merging cards keeps both cards' warnings and formulas", async () => {
    const other = crypto.randomUUID();
    await run(salon.owner, (ctx) => ctx.db.query("INSERT INTO clients (id, tenant_id, name, source, allergies, health_consent_at) VALUES ($1,$2,'Анна Смирнова','walk-in','лидокаин', now())", [other, salon.tenantId]));
    await run(salon.admin, (ctx) => addFormula(ctx, other, { kind: "lashes", body: "Изгиб C, 0.07, 9–11 мм" }));
    await run(salon.admin, (ctx) => mergeClients(ctx, salon.clientId, other));
    const card = await run(salon.admin, (ctx) => getTechCard(ctx, salon.clientId));
    expect(card.allergies).toBe("латекс, никель; лидокаин");
    expect(card.formulas.some((item) => item.body.startsWith("Изгиб C"))).toBe(true);
  });
});
