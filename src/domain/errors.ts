export type ErrorCode =
  | "FORBIDDEN"
  | "VALIDATION"
  | "CONFLICT_SLOT"
  | "SHIFT_REQUIRED"
  | "SHIFT_CLOSED"
  | "NOT_FOUND"
  | "STALE"
  | "SOFT_CONFIRM";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

type PgError = { code?: string; constraint?: string };

export function mapPgError(error: unknown): unknown {
  if (isAppError(error)) return error;
  const pg = error as PgError;
  if (pg?.code === "23505" && pg.constraint === "one_open_shift_per_branch") {
    return new AppError("VALIDATION", "В филиале уже есть открытая смена");
  }
  if (pg?.code === "23505" && pg.constraint === "client_phones_active_unique") {
    return new AppError("VALIDATION", "Клиент с таким телефоном уже есть");
  }
  if (pg?.code === "23505" && pg.constraint === "users_email_key") {
    return new AppError("VALIDATION", "Пользователь с такой почтой уже есть");
  }
  if (pg?.code === "42501") {
    return new AppError("FORBIDDEN", "Недостаточно прав");
  }
  return error;
}
