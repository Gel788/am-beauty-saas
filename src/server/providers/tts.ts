/**
 * VOICE-PRO-01: a live voice for the CRM's spoken answers with the salon's own key:
 * OpenAI (gpt-4o-mini-tts) or ElevenLabs. The key stays on the server; the browser only gets mp3.
 * Both refuse Russian IPs, so the OpenAI one takes an optional proxy address.
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

/** The phrase as mp3 from whichever voice the salon switched on. */
export function synthesize(provider: string, config: Config, text: string) {
  return provider === "elevenlabs" ? elevenSpeech(config, text) : openaiSpeech(config, text);
}
