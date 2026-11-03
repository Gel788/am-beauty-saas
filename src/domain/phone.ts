import { AppError } from "./errors";

export function normalizePhone(input: string): string {
  const trimmed = (input ?? "").trim().replace(/[\s().-]/g, "");
  if (!trimmed) {
    throw new AppError("VALIDATION", "Телефон обязателен");
  }
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) {
      throw new AppError("VALIDATION", "Укажите телефон в международном формате");
    }
    return `+${digits}`;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) return `+7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith("7")) return `+${digits}`;
  if (digits.length === 10) return `+7${digits}`;
  throw new AppError("VALIDATION", "Укажите телефон в международном формате");
}

export function formatPhone(e164: string): string {
  if (e164.startsWith("+7") && e164.length === 12) {
    const d = e164.slice(2);
    return `+7 ${d.slice(0, 3)} ${d.slice(3, 6)}-${d.slice(6, 8)}-${d.slice(8)}`;
  }
  return e164;
}

export function phoneDigits(input: string): string {
  return input.replace(/\D/g, "");
}
