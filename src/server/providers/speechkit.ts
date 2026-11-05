/**
 * VOICE-PRO-01: Yandex SpeechKit text-to-speech (API v1) with the salon's own key.
 * Natural Russian voices; the key stays on the server, the browser only gets the audio.
 */
import { request, type CheckResult, type Config } from "./http";

const TTS = "https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize";

export const SPEECHKIT_VOICES = [
  { value: "alena", label: "Алёна (женский, мягкий)" },
  { value: "jane", label: "Джейн (женский, живой)" },
  { value: "marina", label: "Марина (женский, спокойный)" },
  { value: "filipp", label: "Филипп (мужской)" },
  { value: "ermil", label: "Ермил (мужской, спокойный)" },
];

function form(config: Config, text: string) {
  const body = new URLSearchParams({ text: text.slice(0, 1000), lang: "ru-RU", voice: config.voice || "alena", format: "mp3", speed: "1.05" });
  if (config.folderId) body.set("folderId", config.folderId);
  return body;
}

function headers(config: Config) {
  return { "content-type": "application/x-www-form-urlencoded", Authorization: `Api-Key ${config.apiKey ?? ""}` };
}

function problem(status: number, raw: string) {
  if (status === 401 || status === 403) return "Яндекс не принял ключ: проверьте API-ключ и роль ai.speechkit-tts.user у сервисного аккаунта";
  if (status === 400 && /folder/i.test(raw)) return "Проверьте ID каталога";
  try {
    const parsed = JSON.parse(raw) as { error_message?: string; message?: string };
    return parsed.error_message || parsed.message || `SpeechKit ответил ${status}`;
  } catch {
    return `SpeechKit ответил ${status}`;
  }
}

export async function speechkitCheck(config: Config): Promise<CheckResult> {
  if (!config.apiKey) return { ok: false, text: "Вставьте API-ключ" };
  const { ok, status, raw } = await request(TTS, { method: "POST", headers: headers(config), body: form(config, "Проверка связи") });
  return ok ? { ok: true, text: "Голос работает" } : { ok: false, text: problem(status, raw) };
}

/** The phrase as mp3 bytes. */
export async function speechkitSynthesize(config: Config, text: string): Promise<ArrayBuffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(TTS, { method: "POST", headers: headers(config), body: form(config, text), signal: controller.signal });
    if (!response.ok) throw new Error(problem(response.status, await response.text()));
    return await response.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}
