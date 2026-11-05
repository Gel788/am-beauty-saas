/**
 * INT-*: self-service integrations. The owner picks a provider, types in the keys from their own
 * account, checks the connection and switches it on — no server env and no developer involved.
 * Settings are plain JSON; secrets are sealed (secrets.ts) and never leave the server unmasked.
 */
import { randomBytes } from "node:crypto";
import { AppError } from "@/domain/errors";
import { audit } from "./audit";
import { many, one } from "./db";
import { atolCheck } from "./providers/atol";
import type { CheckResult, Config } from "./providers/http";
import { smscCheck, smsRuCheck } from "./providers/sms";
import { elevenCheck, OPENAI_VOICES, openaiCheck, REG_AI_URL, SBER_VOICES, sberCheck } from "./providers/tts";
import { tbankCheck } from "./providers/tbank";
import { telegramApi } from "./providers/telegram";
import { yookassaCheck } from "./providers/yookassa";
import { decryptSecrets, encryptSecrets, maskSecret } from "./secrets";
import type { Ctx } from "./types";

export type IntegrationKind = "telegram" | "sms" | "fiscal" | "acquiring" | "voice" | "assistant";
type Field = { key: string; label: string; secret?: boolean; required?: boolean; placeholder?: string; options?: { value: string; label: string }[]; hint?: string };
type Definition = {
  provider: string;
  kind: IntegrationKind;
  label: string;
  about: string;
  docsUrl: string;
  fields: Field[];
  /** Only one provider of the kind may be on (one SMS gateway, one bot). */
  exclusive?: boolean;
  check: (config: Config, ctx: Ctx) => Promise<CheckResult & { settings?: Record<string, string> }>;
  /** Runs after a successful check when the integration is switched on/off. */
  onEnable?: (config: Config, ctx: Ctx) => Promise<void>;
  onDisable?: (config: Config, ctx: Ctx) => Promise<void>;
};

function webhookBase() {
  return (process.env.PUBLIC_URL || "http://127.0.0.1:43123").replace(/\/$/, "");
}

export const INTEGRATIONS: Definition[] = [
  {
    provider: "telegram_bot",
    kind: "telegram",
    label: "Свой Telegram-бот",
    about: "Напоминания и уведомления приходят от бота с именем и аватаркой вашего салона. Создайте бота у @BotFather и вставьте токен.",
    docsUrl: "https://core.telegram.org/bots/tutorial#obtain-your-bot-token",
    exclusive: true,
    fields: [{ key: "token", label: "Токен бота", secret: true, required: true, placeholder: "123456789:AA…" }],
    async check(config) {
      const api = telegramApi(config.token);
      if (!api || !config.token) return { ok: false, text: "Вставьте токен бота" };
      const me = await api("getMe", {});
      const bot = me.result as { username?: string; first_name?: string } | undefined;
      if (!me.ok || !bot?.username) return { ok: false, text: me.description ?? "Telegram не принял токен" };
      return { ok: true, text: `Бот @${bot.username} на связи`, settings: { username: bot.username } };
    },
    async onEnable(config, ctx) {
      const api = telegramApi(config.token)!;
      const done = await api("setWebhook", {
        url: `${webhookBase()}/api/webhooks/telegram/t/${ctx.actor.tenantId}`,
        secret_token: config.webhookSecret,
        allowed_updates: ["message", "callback_query"],
      });
      if (!done.ok) throw new AppError("VALIDATION", `Telegram не принял адрес вебхука: ${done.description ?? "ошибка"}`);
    },
    async onDisable(config) {
      await telegramApi(config.token)?.("deleteWebhook", {}).catch(() => undefined);
    },
  },
  {
    provider: "sms_ru",
    kind: "sms",
    label: "SMS.ru",
    about: "SMS для клиентов без Telegram. API-ключ — в личном кабинете SMS.ru → «Программистам».",
    docsUrl: "https://sms.ru/api",
    exclusive: true,
    fields: [
      { key: "apiId", label: "API-ключ (api_id)", secret: true, required: true },
      { key: "sender", label: "Имя отправителя", placeholder: "Если согласовано в SMS.ru", hint: "Пусто — общий номер SMS.ru" },
    ],
    check: (config) => smsRuCheck(config),
  },
  {
    provider: "smsc",
    kind: "sms",
    label: "SMSC.ru",
    about: "SMS через SMSC.ru: логин и пароль от личного кабинета (или пароль для API).",
    docsUrl: "https://smsc.ru/api/",
    exclusive: true,
    fields: [
      { key: "login", label: "Логин", required: true },
      { key: "password", label: "Пароль", secret: true, required: true },
      { key: "sender", label: "Имя отправителя", hint: "Пусто — по умолчанию из кабинета" },
    ],
    check: (config) => smscCheck(config),
  },
  {
    provider: "atol",
    kind: "fiscal",
    label: "АТОЛ Онлайн",
    about: "Облачная касса по 54-ФЗ: чеки за онлайн-оплату и оплату в салоне уходят в ОФД без кассового аппарата на ресепшене.",
    docsUrl: "https://online.atol.ru/",
    fields: [
      { key: "login", label: "Логин интеграции", required: true },
      { key: "password", label: "Пароль интеграции", secret: true, required: true },
      { key: "groupCode", label: "Код группы ККТ", required: true, placeholder: "group_code_1234" },
      { key: "email", label: "Email продавца для чеков", placeholder: "kassa@salon.ru" },
      { key: "mode", label: "Среда", options: [{ value: "live", label: "Боевая" }, { value: "test", label: "Тестовая (testonline.atol.ru)" }] },
    ],
    check: (config) => atolCheck(config),
  },
  {
    provider: "yookassa",
    kind: "acquiring",
    label: "ЮKassa",
    about: "Оплата картой и по СБП по ссылке. shopId и секретный ключ — в личном кабинете ЮKassa → «Интеграция».",
    docsUrl: "https://yookassa.ru/developers/using-api/interaction-format",
    fields: [
      { key: "shopId", label: "shopId", required: true },
      { key: "secretKey", label: "Секретный ключ", secret: true, required: true, placeholder: "live_… или test_…" },
    ],
    check: (config) => yookassaCheck(config),
  },
  {
    provider: "tbank",
    kind: "acquiring",
    label: "Т-Банк",
    about: "Интернет-эквайринг Т-Банка: карта, СБП, T-Pay. Ключ терминала и пароль — в кабинете бизнеса → «Интернет-эквайринг» → «Терминалы».",
    docsUrl: "https://www.tbank.ru/kassa/dev/payments/",
    fields: [
      { key: "terminalKey", label: "Ключ терминала (TerminalKey)", required: true },
      { key: "password", label: "Пароль терминала", secret: true, required: true },
    ],
    check: (config) => tbankCheck(config),
  },
  {
    provider: "reg_ai",
    kind: "assistant",
    label: "REG.RU AI (ai.reg.cloud)",
    about: "Ассистент и голос CRM на нейросетях REG.RU: работает с российского сервера, оплата в рублях. Нужен только API-ключ из кабинета ai.reg.cloud.",
    docsUrl: "https://ai.reg.cloud/",
    exclusive: true,
    fields: [
      { key: "apiKey", label: "API-ключ", secret: true, required: true, placeholder: "sk-…" },
      { key: "model", label: "Модель ассистента", placeholder: "gpt-6-luna", hint: "Пусто — gpt-6-luna. Умнее — gpt-6.1-sol" },
      { key: "voice", label: "Голос", options: OPENAI_VOICES },
      { key: "ttsModel", label: "Модель озвучки", placeholder: "gpt-4o-mini-tts", hint: "Если у провайдера нет озвучки, CRM говорит голосом браузера" },
    ],
    check: (config) => openaiCheck({ ...config, baseUrl: REG_AI_URL }),
  },
  {
    provider: "openai_voice",
    kind: "assistant",
    label: "OpenAI или совместимый провайдер",
    about: "Ассистент, который понимает любые вопросы и просьбы («кто у Марины после обеда?», «отметь, что Ольга пришла»). Если провайдер умеет озвучку — и голос ответов. Подойдёт ключ OpenAI или любого провайдера с OpenAI-совместимым API: укажите его адрес и модель.",
    docsUrl: "https://platform.openai.com/api-keys",
    exclusive: true,
    fields: [
      { key: "apiKey", label: "API-ключ", secret: true, required: true, placeholder: "sk-…" },
      { key: "voice", label: "Голос", options: OPENAI_VOICES },
      { key: "ttsModel", label: "Модель озвучки", placeholder: "gpt-4o-mini-tts", hint: "Пусто — gpt-4o-mini-tts. Если у провайдера нет озвучки, CRM говорит голосом браузера" },
      { key: "baseUrl", label: "Адрес API провайдера", placeholder: "https://api.openai.com/v1", hint: "Для провайдера или прокси: его адрес, совместимый с OpenAI. Пусто — напрямую в OpenAI" },
      { key: "model", label: "Модель ассистента", placeholder: "gpt-6-luna", hint: "Имя модели, как его пишет провайдер, с поддержкой инструментов (tools). Пусто — gpt-5-mini" },
    ],
    check: (config) => openaiCheck(config),
  },
  {
    provider: "salute_speech",
    kind: "voice",
    label: "SaluteSpeech (Сбер)",
    about: "Живой русский голос: Наталья, Борис, Марфа и другие. Работает с российского сервера, оплата в рублях, есть бесплатный объём. developers.sber.ru → SaluteSpeech → «Получить ключ»: скопируйте «Ключ авторизации».",
    docsUrl: "https://developers.sber.ru/docs/ru/salutespeech/integration-individuals",
    exclusive: true,
    fields: [
      { key: "authKey", label: "Ключ авторизации (Authorization key)", secret: true, required: true, placeholder: "MDE5…==" },
      { key: "voice", label: "Голос", options: SBER_VOICES },
      { key: "scope", label: "Тип аккаунта", options: [{ value: "SALUTE_SPEECH_PERS", label: "Физлицо" }, { value: "SALUTE_SPEECH_CORP", label: "Юрлицо / ИП" }] },
    ],
    check: (config) => sberCheck(config),
  },
  {
    provider: "elevenlabs",
    kind: "voice",
    label: "ElevenLabs",
    about: "Самый живой голос. Ключ — elevenlabs.io → Profile → API Keys. Голос можно выбрать в библиотеке ElevenLabs и вставить его Voice ID.",
    docsUrl: "https://elevenlabs.io/app/settings/api-keys",
    exclusive: true,
    fields: [
      { key: "apiKey", label: "API-ключ", secret: true, required: true },
      { key: "voiceId", label: "Voice ID", placeholder: "EXAVITQu4vr4xnSDxMaL", hint: "Пусто — голос Sarah, хорошо говорит по-русски" },
    ],
    check: (config) => elevenCheck(config),
  },
];
const BY_NAME = new Map(INTEGRATIONS.map((item) => [item.provider, item]));
export function integrationDefinition(provider: string) {
  return BY_NAME.get(provider) ?? null;
}

type Row = {
  provider: string;
  kind: IntegrationKind;
  enabled: boolean;
  settings: Record<string, string>;
  secrets: string | null;
  status: "new" | "ok" | "error";
  status_text: string;
  checked_at: Date | null;
  updated_at: Date;
};

function webhookUrl(definition: Definition, ctx: Ctx) {
  if (definition.kind === "acquiring") return `${webhookBase()}/api/webhooks/acquiring/${definition.provider}`;
  if (definition.kind === "fiscal") return null;
  if (definition.kind === "telegram") return `${webhookBase()}/api/webhooks/telegram/t/${ctx.actor.tenantId}`;
  return null;
}

function assertOwner(ctx: Ctx) {
  if (ctx.actor.role !== "owner" && ctx.actor.role !== "super") throw new AppError("FORBIDDEN", "Интеграции подключает владелец");
}

/** INT-LIST-01: the catalog with the salon's state; secrets come back masked. */
export async function listIntegrations(ctx: Ctx) {
  assertOwner(ctx);
  const rows = await many<Row>(ctx.db, "SELECT * FROM tenant_integrations");
  const byProvider = new Map(rows.map((row) => [row.provider, row]));
  return INTEGRATIONS.map((definition) => {
    const row = byProvider.get(definition.provider);
    const secrets = decryptSecrets(row?.secrets);
    const values: Record<string, string> = {};
    for (const field of definition.fields) values[field.key] = field.secret ? maskSecret(secrets[field.key]) : String(row?.settings?.[field.key] ?? "");
    return {
      provider: definition.provider,
      kind: definition.kind,
      label: definition.label,
      about: definition.about,
      docsUrl: definition.docsUrl,
      fields: definition.fields.map(({ key, label, secret, required, placeholder, options, hint }) => ({ key, label, secret: Boolean(secret), required: Boolean(required), placeholder: placeholder ?? "", options: options ?? null, hint: hint ?? "" })),
      values,
      connected: Boolean(row),
      enabled: Boolean(row?.enabled),
      status: row?.status ?? "new",
      statusText: row?.status_text ?? "",
      checkedAt: row?.checked_at ? new Date(row.checked_at).toISOString() : null,
      account: row?.settings?.username ? `@${row.settings.username}` : null,
      webhookUrl: webhookUrl(definition, ctx),
    };
  });
}

async function loadRow(ctx: Ctx, provider: string, lock = false) {
  return one<Row>(ctx.db, `SELECT * FROM tenant_integrations WHERE provider = $1 ${lock ? "FOR UPDATE" : ""}`, [provider]);
}

function configOf(row: Row): Config {
  return { ...(row.settings ?? {}), ...decryptSecrets(row.secrets) };
}

async function runCheck(ctx: Ctx, definition: Definition, config: Config) {
  try {
    return await definition.check(config, ctx);
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * INT-SAVE-01: store the keys and (when asked) switch on. Empty secret fields keep the stored value,
 * so the owner can change the sender name without retyping the key. Switching on always checks first.
 */
export async function saveIntegration(ctx: Ctx, provider: string, input: { values?: Record<string, unknown>; enabled?: boolean }) {
  assertOwner(ctx);
  const definition = integrationDefinition(provider);
  if (!definition) throw new AppError("NOT_FOUND", "Такой интеграции нет");
  const row = await loadRow(ctx, provider, true);
  const settings: Record<string, string> = { ...(row?.settings ?? {}) };
  const secrets = decryptSecrets(row?.secrets);
  for (const field of definition.fields) {
    const raw = input.values?.[field.key];
    if (raw === undefined) continue;
    const value = String(raw ?? "").trim().slice(0, 500);
    if (field.secret) {
      if (value && !value.startsWith("••••")) secrets[field.key] = value;
    } else if (field.options && value && !field.options.some((option) => option.value === value)) {
      throw new AppError("VALIDATION", `${field.label}: неизвестное значение`);
    } else {
      settings[field.key] = value;
    }
  }
  if (definition.provider === "telegram_bot" && !secrets.webhookSecret) secrets.webhookSecret = randomBytes(24).toString("hex");
  if (definition.fields.some((field) => field.options) && !settings.mode) settings.mode = definition.fields.find((field) => field.key === "mode")?.options?.[0]?.value ?? "";
  const missing = definition.fields.filter((field) => field.required && !(field.secret ? secrets[field.key] : settings[field.key]));
  const enabled = input.enabled ?? row?.enabled ?? false;
  if (enabled && missing.length) throw new AppError("VALIDATION", `Заполните: ${missing.map((field) => field.label).join(", ")}`);

  let status: Row["status"] = row?.status ?? "new";
  let statusText = row?.status_text ?? "";
  let checkedAt: string | null = row?.checked_at ? new Date(row.checked_at).toISOString() : null;
  const config = { ...settings, ...secrets };
  if (!missing.length) {
    const result = await runCheck(ctx, definition, config);
    status = result.ok ? "ok" : "error";
    statusText = result.text;
    checkedAt = ctx.now.toISOString();
    if (result.ok && "settings" in result && result.settings) Object.assign(settings, result.settings);
    if (enabled && !result.ok) throw new AppError("VALIDATION", `Не удалось подключиться: ${result.text}`);
  }
  if (enabled && definition.onEnable) await definition.onEnable({ ...settings, ...secrets }, ctx);
  if (!enabled && row?.enabled && definition.onDisable) await definition.onDisable(configOf(row), ctx);
  if (enabled && definition.exclusive) {
    const others = await many<Row>(ctx.db, "SELECT * FROM tenant_integrations WHERE kind = $1 AND provider <> $2 AND enabled FOR UPDATE", [definition.kind, provider]);
    for (const other of others) {
      await integrationDefinition(other.provider)?.onDisable?.(configOf(other), ctx);
      await ctx.db.query("UPDATE tenant_integrations SET enabled = false, updated_at = now() WHERE provider = $1", [other.provider]);
    }
  }
  await ctx.db.query(
    `INSERT INTO tenant_integrations (tenant_id, provider, kind, enabled, settings, secrets, status, status_text, checked_at, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
     ON CONFLICT (tenant_id, provider) DO UPDATE SET enabled = $4, settings = $5, secrets = $6, status = $7, status_text = $8, checked_at = $9, updated_by = $10, updated_at = now()`,
    [ctx.actor.tenantId, provider, definition.kind, enabled, JSON.stringify(settings), encryptSecrets(secrets), status, statusText, checkedAt, ctx.actor.userId],
  );
  // The audit names what changed, never the values of secrets.
  await audit(ctx, {
    branchId: null,
    entity: "tenant",
    entityId: ctx.actor.tenantId,
    action: "integration.saved",
    diff: { provider, enabled, fields: Object.keys(input.values ?? {}), status },
  });
  return listIntegrations(ctx);
}

/** INT-CHECK-01: «Проверить подключение» with the stored keys. */
export async function checkIntegration(ctx: Ctx, provider: string) {
  assertOwner(ctx);
  const definition = integrationDefinition(provider);
  const row = await loadRow(ctx, provider, true);
  if (!definition || !row) throw new AppError("NOT_FOUND", "Сначала сохраните ключи");
  const result = await runCheck(ctx, definition, configOf(row));
  const settings = result.ok && "settings" in result && result.settings ? { ...row.settings, ...result.settings } : row.settings;
  await ctx.db.query("UPDATE tenant_integrations SET status = $2, status_text = $3, checked_at = $4, settings = $5 WHERE provider = $1", [
    provider,
    result.ok ? "ok" : "error",
    result.text,
    ctx.now.toISOString(),
    JSON.stringify(settings),
  ]);
  return listIntegrations(ctx);
}

/** INT-DELETE-01: forget the keys. Branches that used the provider fall back to «test». */
export async function deleteIntegration(ctx: Ctx, provider: string) {
  assertOwner(ctx);
  const definition = integrationDefinition(provider);
  const row = await loadRow(ctx, provider, true);
  if (!definition || !row) throw new AppError("NOT_FOUND", "Не найдено");
  if (row.enabled) await definition.onDisable?.(configOf(row), ctx);
  await ctx.db.query("DELETE FROM tenant_integrations WHERE provider = $1", [provider]);
  if (definition.kind === "fiscal") await ctx.db.query("UPDATE branches SET fiscal_provider = 'test', fiscal_enabled = false WHERE fiscal_provider = $1", [provider]);
  if (definition.kind === "acquiring") await ctx.db.query("UPDATE branches SET acquiring_provider = 'test', acquiring_enabled = false WHERE acquiring_provider = $1", [provider]);
  await audit(ctx, { branchId: null, entity: "tenant", entityId: ctx.actor.tenantId, action: "integration.deleted", diff: { provider } });
  return listIntegrations(ctx);
}

/** Config of an enabled integration of the current tenant (null when off or not set up). */
export async function integrationConfig(ctx: Ctx, provider: string): Promise<Config | null> {
  const row = await loadRow(ctx, provider);
  return row?.enabled ? configOf(row) : null;
}

/** The enabled provider of a kind (for the exclusive kinds: SMS gateway, own bot). */
export async function activeIntegration(ctx: Ctx, kind: IntegrationKind): Promise<{ provider: string; config: Config } | null> {
  const row = await one<Row>(ctx.db, "SELECT * FROM tenant_integrations WHERE kind = $1 AND enabled ORDER BY updated_at DESC LIMIT 1", [kind]);
  return row ? { provider: row.provider, config: configOf(row) } : null;
}

export async function enabledProviders(ctx: Ctx, kind: IntegrationKind) {
  const rows = await many<{ provider: string }>(ctx.db, "SELECT provider FROM tenant_integrations WHERE kind = $1 AND enabled", [kind]);
  return new Set(rows.map((row) => row.provider));
}
