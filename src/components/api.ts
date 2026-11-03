export type ApiError = Error & { code?: string; details?: Record<string, unknown> | null };

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401 && typeof window !== "undefined") {
    window.location.href = "/login";
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const error = new Error(body.error?.message || "Не получилось выполнить операцию") as ApiError;
    error.code = body.error?.code;
    error.details = body.error?.details;
    throw error;
  }
  return body as T;
}
