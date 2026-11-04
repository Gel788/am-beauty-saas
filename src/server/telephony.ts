/**
 * TEL-*: calls from the salon's PBX. The provider posts call events to a per-salon webhook; the CRM
 * finds the client by number, shows a card to the desk while the phone rings, keeps a call log on the
 * client and raises «Пропущенный звонок» when nobody picked up.
 *
 * Providers: Zadarma and Mango Office (their own event formats and signatures) and a plain JSON
 * webhook for any other PBX or a connector (Albato, Zapier, ApiX-Drive).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@/domain/errors";
import { formatPhone, normalizePhone } from "@/domain/phone";
import { isAdminPlus } from "./access";
import { asOnline } from "./booking";
import { many, one } from "./db";
import { integrationConfig } from "./integrations";
import { notifyDesk } from "./messaging";
import { healthAlert } from "./techcard";
import type { Ctx } from "./types";

export const TELEPHONY_PROVIDERS = ["telephony_webhook", "zadarma", "mango"] as const;
export type TelephonyProvider = (typeof TELEPHONY_PROVIDERS)[number];

export type CallEvent = {
  callId: string;
  state: "ringing" | "answered" | "ended";
  direction: "in" | "out";
  from: string;
  to: string;
  /** Seconds of talk, when the PBX tells it at the end. */
  duration?: number | null;
  /** The PBX's own verdict at the end: answered or not. */
  answered?: boolean | null;
  recordingUrl?: string | null;
  at?: Date;
};

type Incoming = { body: string; form: URLSearchParams | null; json: Record<string, unknown> | null; headers: Headers; query: URLSearchParams; subpath: string };

function same(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function safePhone(raw: unknown) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    return normalizePhone(text.startsWith("+") || text.length <= 11 ? text : `+${text}`);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Provider adapters

/** Plain JSON: {event: ringing|answered|ended|missed, callId, from, to, direction?, duration?, recordingUrl?}, ?token= or X-Webhook-Token. */
function parseGeneric(input: Incoming, config: Record<string, string>): CallEvent[] {
  const token = input.headers.get("x-webhook-token") ?? input.query.get("token") ?? "";
  if (!config.webhookToken || !same(token, config.webhookToken)) throw new AppError("FORBIDDEN", "Неверный токен вебхука");
  const body = input.json ?? {};
  const event = String(body.event ?? body.state ?? "").toLowerCase();
  const state = event === "ringing" || event === "start" ? "ringing" : event === "answered" || event === "answer" ? "answered" : event === "ended" || event === "end" || event === "missed" ? "ended" : null;
  const callId = String(body.callId ?? body.call_id ?? "").trim();
  if (!state || !callId) throw new AppError("VALIDATION", "Нужны поля event и callId");
  return [
    {
      callId,
      state,
      direction: String(body.direction ?? "in") === "out" ? "out" : "in",
      from: String(body.from ?? ""),
      to: String(body.to ?? ""),
      duration: body.duration != null ? Number(body.duration) : null,
      answered: event === "missed" ? false : body.answered != null ? Boolean(body.answered) : null,
      recordingUrl: body.recordingUrl ? String(body.recordingUrl) : null,
    },
  ];
}

/**
 * Zadarma: NOTIFY_START / NOTIFY_ANSWER / NOTIFY_END (incoming) and NOTIFY_OUT_START / NOTIFY_OUT_END,
 * form-encoded, header Signature = base64(HMAC-SHA1(<fields>, secret)).
 */
function parseZadarma(input: Incoming, config: Record<string, string>): CallEvent[] {
  const form = input.form ?? new URLSearchParams();
  const get = (key: string) => form.get(key) ?? "";
  const event = get("event");
  const signed: Record<string, string[]> = {
    NOTIFY_START: ["caller_id", "called_did", "call_start"],
    NOTIFY_ANSWER: ["caller_id", "destination", "call_start"],
    NOTIFY_END: ["caller_id", "called_did", "call_start"],
    NOTIFY_OUT_START: ["internal", "destination", "call_start"],
    NOTIFY_OUT_END: ["internal", "destination", "call_start"],
  };
  const fields = signed[event];
  if (!fields) return [];
  const expected = createHmac("sha1", config.secret ?? "").update(fields.map(get).join("")).digest("base64");
  if (!config.secret || !same(input.headers.get("signature") ?? "", expected)) throw new AppError("FORBIDDEN", "Подпись Zadarma не совпала");
  const callId = get("pbx_call_id");
  const started = get("call_start") ? new Date(get("call_start").replace(" ", "T")) : undefined;
  const at = started && !Number.isNaN(started.getTime()) ? started : undefined;
  if (event === "NOTIFY_START") return [{ callId, state: "ringing", direction: "in", from: get("caller_id"), to: get("called_did"), at }];
  if (event === "NOTIFY_ANSWER") return [{ callId, state: "answered", direction: "in", from: get("caller_id"), to: get("called_did") }];
  if (event === "NOTIFY_OUT_START") return [{ callId, state: "ringing", direction: "out", from: get("internal"), to: get("destination"), at }];
  const out = event === "NOTIFY_OUT_END";
  return [
    {
      callId,
      state: "ended",
      direction: out ? "out" : "in",
      from: out ? get("internal") : get("caller_id"),
      to: out ? get("destination") : get("called_did"),
      duration: Number(get("duration") || 0),
      answered: get("disposition") === "answered",
      recordingUrl: null,
    },
  ];
}

/** Mango Office: POST <url>/events/call with vpbx_api_key, sign = sha256(key + json + salt), json. */
function parseMango(input: Incoming, config: Record<string, string>): CallEvent[] {
  const form = input.form ?? new URLSearchParams();
  const key = form.get("vpbx_api_key") ?? "";
  const json = form.get("json") ?? "";
  const sign = form.get("sign") ?? "";
  const expected = createHash("sha256").update(`${key}${json}${config.apiSalt ?? ""}`).digest("hex");
  if (!config.apiKey || !config.apiSalt || !same(key, config.apiKey) || !same(sign, expected)) throw new AppError("FORBIDDEN", "Подпись Mango Office не совпала");
  if (!input.subpath.endsWith("events/call")) return [];
  const data = JSON.parse(json || "{}") as { entry_id?: string; call_state?: string; location?: string; from?: { number?: string; extension?: string }; to?: { number?: string; line_number?: string; extension?: string } };
  const outgoing = Boolean(data.from?.extension) && !data.to?.extension;
  const state = data.call_state === "Appeared" ? "ringing" : data.call_state === "Connected" ? "answered" : data.call_state === "Disconnected" ? "ended" : null;
  if (!state || !data.entry_id) return [];
  // A call to several extensions arrives as several legs; the entry is one call for the salon.
  return [{ callId: data.entry_id, state, direction: outgoing ? "out" : "in", from: data.from?.number ?? "", to: data.to?.line_number ?? data.to?.number ?? "" }];
}

const PARSERS: Record<TelephonyProvider, (input: Incoming, config: Record<string, string>) => CallEvent[]> = {
  telephony_webhook: parseGeneric,
  zadarma: parseZadarma,
  mango: parseMango,
};

// ---------------------------------------------------------------- Recording events

async function clientByPhone(ctx: Ctx, phone: string | null) {
  if (!phone) return null;
  return one<{ id: string; name: string }>(
    ctx.db,
    `SELECT c.id, c.name FROM client_phones p JOIN clients c ON c.id = p.client_id
     WHERE p.phone_e164 = $1 AND p.deleted_at IS NULL AND c.merged_into_id IS NULL LIMIT 1`,
    [phone],
  );
}

/** TEL-EVENT-01: one event moves the call along ringing → answered → ended / missed. Repeats are harmless. */
export async function recordCallEvent(ctx: Ctx, provider: string, event: CallEvent, branchId: string | null) {
  if (!event.callId) return null;
  const at = event.at ?? ctx.now;
  const existing = await one<{ id: string; status: string; answered_at: Date | null; started_at: Date; client_id: string | null; phone_e164: string | null }>(
    ctx.db,
    "SELECT id, status, answered_at, started_at, client_id, phone_e164 FROM calls WHERE provider = $1 AND external_id = $2 FOR UPDATE",
    [provider, event.callId],
  );
  // Later events may come without the number: the call keeps what its first event said.
  const clientPhone = existing?.phone_e164 ?? safePhone(event.direction === "in" ? event.from : event.to);
  const client = existing?.client_id
    ? await one<{ id: string; name: string }>(ctx.db, "SELECT id, name FROM clients WHERE id = $1", [existing.client_id])
    : await clientByPhone(ctx, clientPhone);
  let id = existing?.id;
  if (!existing) {
    id = crypto.randomUUID();
    await ctx.db.query(
      `INSERT INTO calls (id, tenant_id, branch_id, provider, external_id, direction, phone_e164, line, client_id, status, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ringing', $10)`,
      [id, ctx.actor.tenantId, branchId, provider, event.callId.slice(0, 200), event.direction, clientPhone, String(event.direction === "in" ? event.to : event.from).slice(0, 40), client?.id ?? null, at.toISOString()],
    );
  }
  const status = existing?.status ?? "ringing";
  if (event.state === "answered" && status === "ringing") {
    await ctx.db.query("UPDATE calls SET status = 'answered', answered_at = $2 WHERE id = $1", [id, ctx.now.toISOString()]);
  }
  if (event.state === "ended" && (status === "ringing" || status === "answered")) {
    const answered = event.answered ?? (status === "answered" || Boolean(existing?.answered_at));
    const final = answered ? "ended" : "missed";
    await ctx.db.query(
      `UPDATE calls SET status = $2, ended_at = $3, duration_sec = $4, recording_url = COALESCE($5, recording_url),
         answered_at = CASE WHEN $2 = 'ended' THEN COALESCE(answered_at, $3) ELSE answered_at END
       WHERE id = $1`,
      [id, final, ctx.now.toISOString(), event.duration ?? null, event.recordingUrl ?? null],
    );
    // TEL-MISSED-01: nobody picked up an incoming call — the desk calls back.
    if (final === "missed" && event.direction === "in") {
      const who = client?.name ?? (clientPhone ? formatPhone(clientPhone) : "скрытый номер");
      await notifyDesk(ctx, {
        branchId,
        kind: "call.missed",
        title: `Пропущенный звонок: ${who}`,
        body: client && clientPhone ? formatPhone(clientPhone) : "Перезвоните, пока клиент не ушёл к другим.",
        entity: client ? "client" : undefined,
        entityId: client?.id ?? null,
      });
    }
  }
  return id ?? null;
}

/** Public entry: the salon's PBX posts here. Unknown tenant, switched-off provider or a bad signature → FORBIDDEN. */
export async function handleTelephonyWebhook(tenantId: string, provider: string, input: Incoming, now = new Date()) {
  if (!/^[0-9a-f-]{36}$/.test(tenantId) || !(TELEPHONY_PROVIDERS as readonly string[]).includes(provider)) throw new AppError("FORBIDDEN", "Недостаточно прав");
  return asOnline(
    tenantId,
    async (ctx) => {
      const config = await integrationConfig(ctx, provider);
      if (!config) throw new AppError("FORBIDDEN", "Телефония не подключена");
      const events = PARSERS[provider as TelephonyProvider](input, config);
      const branchId = config.branchId && /^[0-9a-f-]{36}$/.test(config.branchId) ? config.branchId : null;
      const ids: string[] = [];
      for (const event of events) {
        const id = await recordCallEvent(ctx, provider, event, branchId);
        if (id) ids.push(id);
      }
      return { ok: true, calls: ids.length };
    },
    now,
  );
}

// ---------------------------------------------------------------- Desk side

type ClientCard = {
  id: string;
  name: string;
  visits: number;
  lastVisit: { at: string; title: string; staff: string } | null;
  nextVisit: { id: string; at: string; title: string; staff: string } | null;
  debtMinor: number;
  alert: string | null;
  note: string;
};

export async function callerCard(ctx: Ctx, clientId: string): Promise<ClientCard | null> {
  const client = await one<{ id: string; name: string; allergies: string | null; contraindications: string | null; notes: string | null }>(
    ctx.db,
    "SELECT id, name, allergies, contraindications, COALESCE(notes, '') AS notes FROM clients WHERE id = $1",
    [clientId],
  );
  if (!client) return null;
  const stats = await one<{ visits: number; debt: number }>(
    ctx.db,
    `SELECT count(*) FILTER (WHERE status = 'completed')::int AS visits, COALESCE(SUM(debt_minor), 0)::int AS debt FROM appointments WHERE client_id = $1`,
    [clientId],
  );
  const visit = (order: "past" | "next") =>
    one<{ id: string; starts_at: Date; title: string | null; staff: string }>(
      ctx.db,
      `SELECT a.id, a.starts_at, s.display_name AS staff,
              (SELECT string_agg(title_snapshot, ', ' ORDER BY position) FROM appointment_services WHERE appointment_id = a.id) AS title
       FROM appointments a JOIN staff s ON s.id = a.staff_id
       WHERE a.client_id = $1 AND ${order === "past" ? "a.status = 'completed' AND a.starts_at < $2" : "a.status IN ('scheduled', 'confirmed') AND a.starts_at >= $2"}
       ORDER BY a.starts_at ${order === "past" ? "DESC" : "ASC"} LIMIT 1`,
      [clientId, ctx.now.toISOString()],
    );
  const last = await visit("past");
  const next = await visit("next");
  return {
    id: client.id,
    name: client.name,
    visits: Number(stats?.visits ?? 0),
    lastVisit: last ? { at: new Date(last.starts_at).toISOString(), title: last.title ?? "", staff: last.staff } : null,
    nextVisit: next ? { id: next.id, at: new Date(next.starts_at).toISOString(), title: next.title ?? "", staff: next.staff } : null,
    debtMinor: Number(stats?.debt ?? 0),
    alert: healthAlert(client.allergies, client.contraindications),
    note: (client.notes ?? "").slice(0, 200),
  };
}

function assertDesk(ctx: Ctx) {
  if (!isAdminPlus(ctx.actor)) throw new AppError("FORBIDDEN", "Недостаточно прав");
}

/** TEL-POPUP-01: calls ringing now (or answered in the last minute) with the caller's card. */
export async function liveCalls(ctx: Ctx) {
  if (!isAdminPlus(ctx.actor)) return { enabled: false, timezone: "Europe/Moscow", calls: [] };
  const enabled = await one(ctx.db, "SELECT 1 FROM tenant_integrations WHERE kind = 'telephony' AND enabled");
  if (!enabled) return { enabled: false, timezone: "Europe/Moscow", calls: [] };
  const rows = await many<{ id: string; phone_e164: string | null; client_id: string | null; status: string; started_at: Date; direction: string }>(
    ctx.db,
    `SELECT id, phone_e164, client_id, status, started_at, direction FROM calls
     WHERE direction = 'in' AND ($1::uuid IS NULL OR branch_id IS NULL OR branch_id = $1)
       AND ((status = 'ringing' AND started_at > $2) OR (status = 'answered' AND answered_at > $3))
     ORDER BY started_at DESC LIMIT 3`,
    [ctx.actor.branchId, new Date(ctx.now.getTime() - 3 * 60000).toISOString(), new Date(ctx.now.getTime() - 60000).toISOString()],
  );
  const zone = await one<{ timezone: string }>(ctx.db, "SELECT timezone FROM branches WHERE ($1::uuid IS NULL OR id = $1) ORDER BY created_at LIMIT 1", [ctx.actor.branchId]);
  const calls = [];
  for (const row of rows) {
    calls.push({
      id: row.id,
      phone: row.phone_e164 ? formatPhone(row.phone_e164) : "скрытый номер",
      phoneE164: row.phone_e164,
      status: row.status,
      startedAt: new Date(row.started_at).toISOString(),
      client: row.client_id ? await callerCard(ctx, row.client_id) : null,
    });
  }
  return { enabled: true, timezone: zone?.timezone ?? "Europe/Moscow", calls };
}

/** TEL-LOG-01: the client's calls, newest first. */
export async function clientCalls(ctx: Ctx, clientId: string) {
  assertDesk(ctx);
  const rows = await many<{ id: string; direction: string; status: string; started_at: Date; duration_sec: number | null; recording_url: string | null }>(
    ctx.db,
    "SELECT id, direction, status, started_at, duration_sec, recording_url FROM calls WHERE client_id = $1 ORDER BY started_at DESC LIMIT 30",
    [clientId],
  );
  return rows.map((row) => ({
    id: row.id,
    direction: row.direction,
    status: row.status,
    startedAt: new Date(row.started_at).toISOString(),
    durationSec: row.duration_sec,
    recordingUrl: row.recording_url,
  }));
}

/** TEL-LOG-02: the salon's recent calls, missed ones first in mind — the desk calls them back. */
export async function recentCalls(ctx: Ctx, input: { missedOnly?: boolean } = {}) {
  assertDesk(ctx);
  const rows = await many<{ id: string; direction: string; status: string; phone_e164: string | null; client_id: string | null; client_name: string | null; started_at: Date; duration_sec: number | null }>(
    ctx.db,
    `SELECT c.id, c.direction, c.status, c.phone_e164, c.client_id, cl.name AS client_name, c.started_at, c.duration_sec
     FROM calls c LEFT JOIN clients cl ON cl.id = c.client_id
     WHERE ($1::uuid IS NULL OR c.branch_id IS NULL OR c.branch_id = $1) ${input.missedOnly ? "AND c.status = 'missed'" : ""}
     ORDER BY c.started_at DESC LIMIT 50`,
    [ctx.actor.branchId],
  );
  return rows.map((row) => ({
    id: row.id,
    direction: row.direction,
    status: row.status,
    phone: row.phone_e164 ? formatPhone(row.phone_e164) : "скрытый номер",
    phoneE164: row.phone_e164,
    clientId: row.client_id,
    clientName: row.client_name,
    startedAt: new Date(row.started_at).toISOString(),
    durationSec: row.duration_sec,
  }));
}
