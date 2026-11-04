import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticateApiKey, createApiKey, listApiKeys, rateLimit, revokeApiKey, runAsApi, v1Appointments, v1Branches, v1CancelAppointment, v1Clients, v1CreateAppointment, v1CreateClient, v1Services, v1Staff } from "@/server/public-api";
import { assertPublicUrl, createWebhook, runWebhooksForTenant, setWebhookSender, signature } from "@/server/webhooks";
import { addCalendarDays, formatLocalDate } from "@/domain/time";
import { TZ, at, bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;
const tomorrow = addCalendarDays(formatLocalDate(new Date(), TZ), 1);
const sent: { url: string; headers: Record<string, string>; body: string }[] = [];

beforeAll(async () => {
  salon = await createSalon();
  setWebhookSender(async (url, init) => {
    sent.push({ url, headers: init.headers, body: init.body });
    return { status: url.includes("broken") ? 500 : 200 };
  });
});
afterAll(() => setWebhookSender(null));

describe("API keys", () => {
  it("API-KEY-01 the owner issues a key shown once; only its hash is stored", async () => {
    await expect(run(salon.admin, (ctx) => createApiKey(ctx, { name: "Сайт" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const created = await run(salon.owner, (ctx) => createApiKey(ctx, { name: "Сайт", scope: "read" }));
    expect(created.key).toMatch(/^ab_live_[a-f0-9]{32}$/);
    expect(created.prefix).toBe(created.key.slice(0, 12));
    const listed = await run(salon.owner, (ctx) => listApiKeys(ctx));
    expect(JSON.stringify(listed)).not.toContain(created.key);
    const caller = await authenticateApiKey(`Bearer ${created.key}`);
    expect(caller).toMatchObject({ tenantId: salon.tenantId, scope: "read", actor: { role: "admin", name: "API: Сайт" } });
    await run(salon.owner, (ctx) => revokeApiKey(ctx, created.id));
    await expect(authenticateApiKey(`Bearer ${created.key}`)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(authenticateApiKey("Bearer nope")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("API-KEY-02 a key bound to a branch sees only that branch", async () => {
    const created = await run(salon.owner, (ctx) => createApiKey(ctx, { name: "Филиал", branchId: salon.otherBranchId }));
    const caller = await authenticateApiKey(`Bearer ${created.key}`);
    const branches = await runAsApi(caller, (ctx) => v1Branches(ctx));
    expect(branches.data.map((row) => row.id)).toEqual([salon.otherBranchId]);
    const staff = await runAsApi(caller, (ctx) => v1Staff(ctx));
    expect(staff.data.map((row) => row.id)).toEqual([salon.staffA]);
    const query = new URLSearchParams({ branchId: salon.branchId, from: `${tomorrow}T00:00:00Z`, to: `${tomorrow}T23:00:00Z` });
    await expect(runAsApi(caller, (ctx) => v1Appointments(ctx, query))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("API-RATE-01 limits a key to 120 requests a minute", () => {
    const now = Date.now();
    for (let i = 0; i < 120; i += 1) rateLimit("test-key", now);
    expect(() => rateLimit("test-key", now)).toThrow();
    expect(rateLimit("test-key", now + 61000).remaining).toBe(119);
  });
});

describe("API v1", () => {
  it("API-V1 reads the catalog, creates a client and a visit, finds and cancels it", async () => {
    const created = await run(salon.owner, (ctx) => createApiKey(ctx, { name: "1С", scope: "write" }));
    const caller = await authenticateApiKey(`Bearer ${created.key}`);
    const services = await runAsApi(caller, (ctx) => v1Services(ctx));
    expect(services.data.find((row) => row.id === salon.serviceId)).toMatchObject({ title: "Маникюр", durationMin: 60, priceMinor: 150000 });

    const client = await runAsApi(caller, (ctx) => v1CreateClient(ctx, { name: "Ирина Апи", phone: "+7 900 555-12-34" }));
    expect(client.data).toMatchObject({ name: "Ирина Апи", phones: ["+79005551234"], source: "api" });
    const found = await runAsApi(caller, (ctx) => v1Clients(ctx, new URLSearchParams({ phone: "89005551234" })));
    expect(found.data.map((row) => row.id)).toEqual([client.data.id]);

    const visit = await runAsApi(caller, (ctx) =>
      v1CreateAppointment(ctx, { branchId: salon.branchId, staffId: salon.staffA, clientId: client.data.id, startsAt: at("11:00", tomorrow), services: [{ serviceId: salon.serviceId }] }),
    );
    expect(visit.data).toMatchObject({ source: "api", status: "scheduled", client: { id: client.data.id }, totalMinor: 150000, staff: { id: salon.staffA } });
    await expect(
      runAsApi(caller, (ctx) => v1CreateAppointment(ctx, { branchId: salon.branchId, staffId: salon.staffA, clientId: client.data.id, startsAt: at("11:30", tomorrow), services: [{ serviceId: salon.serviceId }] })),
    ).rejects.toMatchObject({ code: "CONFLICT_SLOT" });

    const list = await runAsApi(caller, (ctx) => v1Appointments(ctx, new URLSearchParams({ from: at("00:00", tomorrow), to: at("23:59", tomorrow), clientId: client.data.id })));
    expect(list.data.map((row) => row.id)).toEqual([visit.data.id]);
    await expect(runAsApi(caller, (ctx) => v1Appointments(ctx, new URLSearchParams({ from: at("00:00", tomorrow), to: at("00:00", addCalendarDays(tomorrow, 40)) })))).rejects.toMatchObject({ code: "VALIDATION" });

    const cancelled = await runAsApi(caller, (ctx) => v1CancelAppointment(ctx, visit.data.id, {}));
    expect(cancelled.data.status).toBe("cancelled");
  });
});

describe("webhooks", () => {
  it("API-HOOK-01 refuses addresses inside the network", () => {
    for (const url of ["http://localhost:3000/x", "http://127.0.0.1/x", "http://10.0.0.5/x", "http://192.168.1.2/x", "http://169.254.169.254/latest", "ftp://example.com"]) {
      expect(() => assertPublicUrl(url)).toThrow();
    }
    expect(assertPublicUrl("https://hooks.example.com/ab")).toBe("https://hooks.example.com/ab");
  });

  it("API-HOOK-01 a change queues a signed delivery; a failing receiver is retried later", async () => {
    const good = await run(salon.owner, (ctx) => createWebhook(ctx, { url: "https://hooks.example.com/ab", events: ["appointment.created", "appointment.cancelled"] }));
    await run(salon.owner, (ctx) => createWebhook(ctx, { url: "https://broken.example.com/ab", events: ["appointment.created"] }));
    expect(good.secret).toMatch(/^whsec_/);
    sent.length = 0;
    const key = await run(salon.owner, (ctx) => createApiKey(ctx, { name: "Хуки", scope: "write" }));
    const caller = await authenticateApiKey(`Bearer ${key.key}`);
    const visit = await runAsApi(caller, (ctx) =>
      v1CreateAppointment(ctx, { branchId: salon.branchId, staffId: salon.staffB, clientId: salon.clientId, startsAt: at("15:00", tomorrow), services: [{ serviceId: salon.serviceId }] }),
    );
    const first = await runWebhooksForTenant(salon.tenantId);
    expect(first).toEqual({ sent: 1, failed: 1 });
    const delivered = sent.find((item) => item.url.includes("hooks.example.com"))!;
    expect(JSON.parse(delivered.body)).toMatchObject({ event: "appointment.created", data: { appointmentId: visit.data.id, branchId: salon.branchId } });
    expect(delivered.headers["x-ambeauty-signature"]).toBe(signature(good.secret, delivered.body));
    expect(delivered.body).not.toContain("Анна");

    // The broken receiver waits for its retry; nothing is due right now.
    expect(await runWebhooksForTenant(salon.tenantId)).toEqual({ sent: 0, failed: 0 });
    expect(await runWebhooksForTenant(salon.tenantId, new Date(Date.now() + 2 * 60000))).toEqual({ sent: 0, failed: 1 });
  });
});
