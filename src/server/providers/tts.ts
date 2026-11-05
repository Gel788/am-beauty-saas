/**
 * VOICE-PRO-01: a live voice for the CRM's spoken answers with the salon's own key:
 * OpenAI (gpt-4o-mini-tts) or ElevenLabs. The key stays on the server; the browser only gets mp3.
 * Both refuse Russian IPs, so the OpenAI one takes an optional proxy address.
 * VOICE-LOCAL-01: and our own Piper voice on the CRM server, which works with no key at all.
 */
import { request, type CheckResult, type Config } from "./http";

export const OPENAI_VOICES = [
  { value: "nova", label: "Nova (женский, тёплый)" },
  { value: "shimmer", label: "Shimmer (женский, мягкий)" },
  { value: "coral", label: "Coral (женский, живой)" },
  { value: "sage", label: "Sage (спокойный)" },
  { value: "onyx", label: "Onyx (мужской, низкий)" },
  { value: "echo", label: "Echo (мужской)" },
];

export const REG_AI_URL = "https://ai.reg.cloud/v1";

const STYLE = "Говори по-русски, тепло и естественно, как вежливый администратор салона красоты. Без пауз в начале.";

function openaiBase(config: Config) {
  return (config.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
}

function explain(status: number, raw: string, who: string) {
  if (status === 401) return `${who} не принял ключ`;
  if (status === 403 && /country|region|territory|unsupported/i.test(raw)) return `${who} не работает с IP этого сервера (страна не поддерживается). Нужен сервер за границей или прокси`;
  if (status === 429) return `${who}: лимит или нет денег на балансе`;
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } | string; detail?: { message?: string } };
    const message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.detail?.message;
    return message ? `${who}: ${message}` : `${who} ответил ${status}`;
  } catch {
    return `${who} ответил ${status}`;
  }
}

async function audio(url: string, init: RequestInit, who: string): Promise<ArrayBuffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(explain(response.status, await response.text(), who));
    return await response.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

export async function openaiCheck(config: Config): Promise<CheckResult> {
  if (!config.apiKey) return { ok: false, text: "Вставьте API-ключ" };
  const { ok, status, raw } = await request(`${openaiBase(config)}/models`, { headers: { Authorization: `Bearer ${config.apiKey}` } });
  return ok ? { ok: true, text: "Ключ принят, ассистент и голос на связи" } : { ok: false, text: explain(status, raw, "OpenAI") };
}

export function openaiSpeech(config: Config, text: string) {
  return audio(
    `${openaiBase(config)}/audio/speech`,
    {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${config.apiKey ?? ""}` },
      body: JSON.stringify({ model: config.ttsModel || "gpt-4o-mini-tts", voice: config.voice || "nova", input: text.slice(0, 1000), instructions: STYLE, response_format: "mp3" }),
    },
    "OpenAI",
  );
}

const ELEVEN = "https://api.elevenlabs.io/v1";
const ELEVEN_DEFAULT_VOICE = "EXAVITQu4vr4xnSDxMaL";

export async function elevenCheck(config: Config): Promise<CheckResult> {
  if (!config.apiKey) return { ok: false, text: "Вставьте API-ключ" };
  const { ok, status, raw } = await request(`${ELEVEN}/user`, { headers: { "xi-api-key": config.apiKey } });
  return ok ? { ok: true, text: "Голос ElevenLabs на связи" } : { ok: false, text: explain(status, raw, "ElevenLabs") };
}

export function elevenSpeech(config: Config, text: string) {
  return audio(
    `${ELEVEN}/text-to-speech/${encodeURIComponent(config.voiceId || ELEVEN_DEFAULT_VOICE)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": config.apiKey ?? "" },
      body: JSON.stringify({ text: text.slice(0, 1000), model_id: "eleven_multilingual_v2" }),
    },
    "ElevenLabs",
  );
}

// VOICE-PRO-04: SaluteSpeech (Sber): natural Russian voices, works from Russian servers, paid in rubles.
const SBER_OAUTH = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const SBER_TTS = "https://smartspeech.sber.ru/rest/v1/text:synthesize";
export const SBER_VOICES = [
  { value: "Nec_24000", label: "Наталья (женский, тёплый)" },
  { value: "May_24000", label: "Марфа (женский)" },
  { value: "Ost_24000", label: "Александра (женский)" },
  { value: "Bys_24000", label: "Борис (мужской)" },
  { value: "Tur_24000", label: "Тарас (мужской)" },
  { value: "Pon_24000", label: "Сергей (мужской)" },
];
const sberTokens = new Map<string, { token: string; until: number }>();

async function sberToken(config: Config) {
  const key = (config.authKey ?? "").trim();
  const cached = sberTokens.get(key);
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const { ok, status, data, raw } = await request<{ access_token?: string; expires_at?: number; message?: string }>(SBER_OAUTH, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", Accept: "application/json", RqUID: crypto.randomUUID(), Authorization: `Basic ${key}` },
    body: new URLSearchParams({ scope: config.scope || "SALUTE_SPEECH_PERS" }),
  });
  if (!ok || !data?.access_token) throw new Error(status === 401 || status === 400 ? "Сбер не принял ключ авторизации" : explain(status, raw, "SaluteSpeech"));
  sberTokens.set(key, { token: data.access_token, until: data.expires_at ?? Date.now() + 25 * 60_000 });
  return data.access_token;
}

export async function sberCheck(config: Config): Promise<CheckResult> {
  if (!config.authKey) return { ok: false, text: "Вставьте ключ авторизации" };
  try {
    await sberToken(config);
    return { ok: true, text: "Голос Сбера на связи" };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { ok: false, text: /certificate|self.signed|UNABLE_TO/i.test(text) ? "Нет сертификата Минцифры на сервере: пересоберите сервер (install.sh)" : text };
  }
}

export async function sberSpeech(config: Config, text: string) {
  const token = await sberToken(config);
  return audio(
    `${SBER_TTS}?format=wav16&voice=${encodeURIComponent(config.voice || "Nec_24000")}`,
    { method: "POST", headers: { "content-type": "application/text", Authorization: `Bearer ${token}` }, body: text.slice(0, 1000) },
    "SaluteSpeech",
  );
}

/** VOICE-LOCAL-01: our own voice (Piper) running next to the CRM. No key, nothing leaves the server. */
export const LOCAL_VOICES = [
  { value: "irina", label: "Ирина (женский)" },
  { value: "denis", label: "Денис (мужской)" },
  { value: "dmitri", label: "Дмитрий (мужской)" },
  { value: "ruslan", label: "Руслан (мужской)" },
];

export function localVoiceUrl() {
  return (process.env.TTS_URL ?? "").replace(/\/$/, "");
}

export async function localCheck(): Promise<CheckResult> {
  const base = localVoiceUrl();
  if (!base) return { ok: false, text: "Свой голос не установлен на этом сервере: обновите сервер (install.sh)" };
  try {
    const { ok, data } = await request<{ voices?: string[] }>(`${base}/`, { timeoutMs: 5000 });
    if (ok && data?.voices?.length) return { ok: true, text: `Свой голос на связи: ${data.voices.length} голоса` };
    return { ok: false, text: "Голоса ещё не скачались: обновите сервер (install.sh)" };
  } catch {
    return { ok: false, text: "Свой голос не отвечает: он запускается вместе с сервером, подождите минуту" };
  }
}

export function localSpeech(config: Config, text: string) {
  return audio(
    `${localVoiceUrl()}/synthesize`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: text.slice(0, 1000), voice: config.voice || "irina", speed: 0.95 }) },
    "Свой голос",
  );
}

/** The phrase as audio from whichever voice the salon switched on. */
export function synthesize(provider: string, config: Config, text: string) {
  if (provider === "local_voice") return localSpeech(config, text);
  if (provider === "elevenlabs") return elevenSpeech(config, text);
  if (provider === "salute_speech") return sberSpeech(config, text);
  return openaiSpeech(provider === "reg_ai" ? { ...config, baseUrl: REG_AI_URL } : config, text);
}
