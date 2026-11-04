import { createHash, createHmac } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { one } from "@/server/db";
import { listIntegrations, saveIntegration } from "@/server/integrations";
import { listNotifications } from "@/server/messaging";
import { clientCalls, handleTelephonyWebhook, liveCalls, recentCalls } from "@/server/telephony";
import { NOW, bindTestDb, createSalon, run } from "./helpers";

bindTestDb();
let salon: Awaited<ReturnType<typeof createSalon>>;
let clientPhone = "";

const incoming = (input: { json?: Record<string, unknown>; form?: Record<string, string>; headers?: Record<string, string>; query?: Record<string, string>; subpath?: string }) => ({
  body: input.json ? JSON.stringify(input.json) : new URLSearchParams(input.form ?? {}).toString(),
  json: input.json ?? null,
  form: input.form ? new URLSearchParams(input.form) : null,
  headers: new Headers(input.headers ?? {}),
  query: new URLSearchParams(input.query ?? {}),
  subpath: input.subpath ?? "",
});

const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

beforeAll(async () => {
  salon = await createSalon();
  clientPhone = (await run(salon.owner, (ctx) => one<{ phone_e164: string }>(ctx.db, "SELECT phone_e164 FROM client_phones WHERE client_id = $1", [salon.clientId])))!.phone_e164;
});

describe("telephony (TEL)", () => {
  it("TEL-EVENT-01 plain webhook: token required; a known caller pops up with the card; unanswered → missed + notification", async () => {
    await expect(handleTelephonyWebhook(salon.tenantId, "telephony_webhook", incoming({ json: { event: "ringing", callId: "x" } }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const list = await run(salon.owner, (ctx) => saveIntegration(ctx, "telephony_webhook", { values: {}, enabled: true }));
    const url = list.find((item) => item.provider === "telephony_webhook")!.webhookUrl!;
    expect(url).toContain(`/api/webhooks/telephony/${salon.tenantId}/telephony_webhook?token=`);
    const token = new URL(url).searchParams.get("token")!;
    await expect(handleTelephonyWebhook(salon.tenantId, "telephony_webhook", incoming({ json: { event: "ringing", callId: "c1", from: clientPhone }, query: { token: "nope" } }))).rejects.toMatchObject({ code: "FORBIDDEN" });

    await handleTelephonyWebhook(salon.tenantId, "telephony_webhook", incoming({ json: { event: "ringing", callId: "c1", from: clientPhone.replace("+7", "8"), to: "+74950000000" }, query: { token } }), NOW);
    const live = await run(salon.admin, (ctx) => liveCalls(ctx), later(5));
    expect(live.enabled).toBe(true);
    expect(live.calls).toHaveLength(1);
    expect(live.calls[0].client).toMatchObject({ id: salon.clientId, visits: expect.any(Number) });
    // Masters do not get the popup.
    expect((await run(salon.master, (ctx) => liveCalls(ctx))).calls).toEqual([]);

    await handleTelephonyWebhook(salon.tenantId, "telephony_webhook", incoming({ json: { event: "ended", callId: "c1" }, query: { token } }), later(20));
    expect((await run(salon.admin, (ctx) => liveCalls(ctx), later(25))).calls).toHaveLength(0);
    const log = await run(salon.admin, (ctx) => clientCalls(ctx, salon.clientId));
    expect(log[0]).toMatchObject({ status: "missed", direction: "in" });
    const feed = await run(salon.admin, (ctx) => listNotifications(ctx));
    expect(feed.items.find((item) => item.kind === "call.missed")).toMatchObject({ entity: "client", entityId: salon.clientId });

    // An unknown number, answered: no notification, shows in the salon's list without a client.
    await handleTelephonyWebhook(salon.tenantId, "telephony_webhook", incoming({ json: { event: "ringing", callId: "c2", from: "+79161234567" }, query: { token } }), later(60));
    const ringing = await run(salon.admin, (ctx) => liveCalls(ctx), later(62));
    expect(ringing.calls[0]).toMatchObject({ client: null, phoneE164: "+79161234567" });
    await handleTelephonyWebhook(salon.tenantId, "telephony_webhook", incoming({ json: { event: "answered", callId: "c2" }, query: { token } }), later(65));
    await handleTelephonyWebhook(salon.tenantId, "telephony_webhook", incoming({ json: { event: "ended", callId: "c2", duration: 95 }, query: { token } }), later(160));
    // A repeated end event changes nothing.
    await handleTelephonyWebhook(salon.tenantId, "telephony_webhook", incoming({ json: { event: "ended", callId: "c2" }, query: { token } }), later(170));
    const recent = await run(salon.admin, (ctx) => recentCalls(ctx));
    expect(recent.find((row) => row.phoneE164 === "+79161234567")).toMatchObject({ status: "ended", durationSec: 95, clientId: null });
    expect((await run(salon.admin, (ctx) => recentCalls(ctx, { missedOnly: true }))).every((row) => row.status === "missed")).toBe(true);
  });

  it("TEL-EVENT-01 Zadarma: signed form events; answered by disposition", async () => {
    await run(salon.owner, (ctx) => saveIntegration(ctx, "zadarma", { values: { key: "abcdef1234567890", secret: "SECRETsecret1234" }, enabled: true }));
    const list = await run(salon.owner, (ctx) => listIntegrations(ctx));
    // One PBX at a time: the plain webhook was switched off.
    expect(list.find((item) => item.provider === "telephony_webhook")?.enabled).toBe(false);
    const start = { event: "NOTIFY_START", call_start: "2026-11-03 12:00:00", pbx_call_id: "in_abc", caller_id: clientPhone.slice(1), called_did: "74951112233" };
    const sign = (fields: string[]) => createHmac("sha1", "SECRETsecret1234").update(fields.join("")).digest("base64");
    await expect(handleTelephonyWebhook(salon.tenantId, "zadarma", incoming({ form: start, headers: { signature: "bad" } }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await handleTelephonyWebhook(salon.tenantId, "zadarma", incoming({ form: start, headers: { signature: sign([start.caller_id, start.called_did, start.call_start]) } }), NOW);
    const end = { ...start, event: "NOTIFY_END", duration: "42", disposition: "answered" };
    await handleTelephonyWebhook(salon.tenantId, "zadarma", incoming({ form: end, headers: { signature: sign([end.caller_id, end.called_did, end.call_start]) } }), later(50));
    const log = await run(salon.admin, (ctx) => clientCalls(ctx, salon.clientId));
    expect(log.find((row) => row.durationSec === 42)).toMatchObject({ status: "ended" });
  });

  it("TEL-EVENT-01 Mango Office: sign = sha256(key + json + salt); summary events are ignored", async () => {
    await run(salon.owner, (ctx) => saveIntegration(ctx, "mango", { values: { apiKey: "vpbx-key", apiSalt: "salt-123" }, enabled: true }));
    const json = JSON.stringify({ entry_id: "E1", call_id: "L1", call_state: "Appeared", from: { number: clientPhone.slice(1) }, to: { line_number: "74950000001", extension: "101" } });
    const form = { vpbx_api_key: "vpbx-key", sign: createHash("sha256").update(`vpbx-key${json}salt-123`).digest("hex"), json };
    await expect(handleTelephonyWebhook(salon.tenantId, "mango", incoming({ form: { ...form, sign: "0" }, subpath: "events/call" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await handleTelephonyWebhook(salon.tenantId, "mango", incoming({ form, subpath: "events/summary" }))).toMatchObject({ calls: 0 });
    await handleTelephonyWebhook(salon.tenantId, "mango", incoming({ form, subpath: "events/call" }), later(300));
    const live = await run(salon.admin, (ctx) => liveCalls(ctx), later(301));
    expect(live.calls[0]?.client?.id).toBe(salon.clientId);
  });

  it("an unknown provider or tenant is refused", async () => {
    await expect(handleTelephonyWebhook(salon.tenantId, "skype", incoming({}))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(handleTelephonyWebhook("not-a-uuid", "mango", incoming({}))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
