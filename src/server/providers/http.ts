/** All provider HTTP goes through here, so tests can stand in for the outside world. */
export type Http = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

let current: Http | null = null;
export function setProviderHttp(http: Http | null) {
  current = http;
}

export async function request<T = unknown>(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<{ status: number; ok: boolean; data: T; raw: string }> {
  const http: Http = current ?? ((target, options) => fetch(target, options));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? 15000);
  try {
    const response = await http(url, { ...init, signal: controller.signal });
    const raw = await response.text();
    let data: unknown = raw;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      // plain-text answers stay as text
    }
    return { status: response.status, ok: response.ok, data: data as T, raw };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("Провайдер не ответил за 15 секунд");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export type Config = Record<string, string>;
export type CheckResult = { ok: boolean; text: string };
