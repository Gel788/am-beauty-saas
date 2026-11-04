import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asOnline, confirmBooking, createHold } from "@/server/booking";
import { many } from "@/server/db";
import { pushPublicKey, pushStatus, sendTestPush, setPushSender, subscribePush, unsubscribePush } from "@/server/push";
import { at, bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;
const sent: { endpoint: string; payload: { title: string; body: string; url: string } }[] = [];
const gone = new Set<string>();

const sub = (name: string) => ({ endpoint: `https://push.example.test/${name}-${crypto.randomUUID()}`, keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } });

beforeAll(async () => {
  salon = await createSalon();
  setPushSender(async (subscription, payload) => {
    if (gone.has(subscription.endpoint)) throw Object.assign(new Error("gone"), { statusCode: 410 });
    sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
    return { statusCode: 201 };
  });
});
afterAll(() => setPushSender(null));

describe("PWA push (PWA-PUSH-01)", () => {
  it("gives a VAPID public key and keeps the same one", async () => {
    const first = await run(salon.admin, (ctx) => pushPublicKey(ctx));
    const second = await run(salon.owner, (ctx) => pushPublicKey(ctx));
    expect(first.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(second.publicKey).toBe(first.publicKey);
  });

  it("validates subscriptions and counts devices per user", async () => {
    await expect(run(salon.admin, (ctx) => subscribePush(ctx, { subscription: { endpoint: "http://evil", keys: {} } }))).rejects.toMatchObject({ code: "VALIDATION" });
    const phone = sub("admin-phone");
    expect(await run(salon.admin, (ctx) => subscribePush(ctx, { subscription: phone }))).toEqual({ devices: 1 });
    // The same device again does not double up.
    expect(await run(salon.admin, (ctx) => subscribePush(ctx, { subscription: phone }))).toEqual({ devices: 1 });
    await run(salon.admin, (ctx) => sendTestPush(ctx));
    expect(sent.at(-1)).toMatchObject({ endpoint: phone.endpoint, payload: { title: "Am Beauty" } });
  });

  it("a new online booking reaches the desk and that visit's master; a dead device is dropped", async () => {
    const masterPhone = sub("master-phone");
    await run(salon.master, (ctx) => subscribePush(ctx, { subscription: masterPhone }));
    const stale = sub("admin-old-laptop");
    await run(salon.admin, (ctx) => subscribePush(ctx, { subscription: stale }));
    gone.add(stale.endpoint);
    const before = sent.length;
    const hold = await asOnline(salon.tenantId, (ctx) => createHold(ctx, salon.branchId, { serviceId: salon.serviceId, staffId: salon.staffA, startsAt: at("15:00", "2026-11-12") }));
    const booking = await asOnline(salon.tenantId, (ctx) => confirmBooking(ctx, salon.branchId, { holdId: hold.holdId, name: "Пуш Клиент", phone: "+79005550101", consent: true }));
    const fresh = sent.slice(before);
    expect(fresh.map((row) => row.endpoint)).toContain(masterPhone.endpoint);
    expect(fresh[0].payload).toMatchObject({ title: "Онлайн-запись: Пуш Клиент", url: `/journal?open=${booking.appointmentId}` });
    const left = await run(salon.admin, (ctx) => many<{ endpoint: string }>(ctx.db, "SELECT endpoint FROM push_subscriptions"));
    expect(left.map((row) => row.endpoint)).not.toContain(stale.endpoint);
  });

  it("turning off removes the device", async () => {
    expect((await run(salon.master, (ctx) => unsubscribePush(ctx))).devices).toBe(0);
    expect((await run(salon.master, (ctx) => pushStatus(ctx))).devices).toBe(0);
  });
});
