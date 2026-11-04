/**
 * Secrets the salon types in (API keys, bot tokens) are stored encrypted: AES-256-GCM with
 * INTEGRATIONS_KEY (32 bytes, hex or base64). In development a fixed key is used so the demo works;
 * production refuses to store a secret without the key.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { AppError } from "@/domain/errors";

function key(): Buffer {
  const raw = process.env.INTEGRATIONS_KEY?.trim();
  if (raw) {
    const buffer = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (buffer.length === 32) return buffer;
    throw new AppError("VALIDATION", "INTEGRATIONS_KEY должен быть 32 байта (64 hex-символа или base64)");
  }
  if (process.env.NODE_ENV === "production") {
    throw new AppError("VALIDATION", "На сервере не задан INTEGRATIONS_KEY — ключи интеграций нельзя сохранить");
  }
  return createHash("sha256").update("am-beauty-dev-integrations").digest();
}

export function encryptSecrets(values: Record<string, string>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(values), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function decryptSecrets(sealed: string | null | undefined): Record<string, string> {
  if (!sealed) return {};
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !body) return {};
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    const text = Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
    return JSON.parse(text) as Record<string, string>;
  } catch {
    // Wrong key (rotated or lost): the integration shows as needing its keys again.
    return {};
  }
}

/** "sk_live_abcdef1234" → "••••1234" for the settings screen. */
export function maskSecret(value: string | undefined) {
  if (!value) return "";
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}
