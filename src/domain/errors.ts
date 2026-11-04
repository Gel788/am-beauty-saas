export type ErrorCode =
  | "FORBIDDEN"
  | "VALIDATION"
  | "CONFLICT_SLOT"
  | "CONFLICT_RESOURCE"
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
  if (pg?.code === "23505" && (pg.constraint === "tenants_slug_key" || pg.constraint === "branches_slug_unique")) {
    return new AppError("VALIDATION", "Такой адрес онлайн-записи уже занят");
  }
  if (pg?.code === "23514" && (pg.constraint === "tenants_slug_format" || pg.constraint === "branches_slug_format")) {
    return new AppError("VALIDATION", "Адрес: латиница, цифры и дефис, от 2 символов");
  }
  if (pg?.code === "23505" && pg.constraint === "inventory_items_sku_unique") {
    return new AppError("VALIDATION", "Позиция с таким артикулом уже есть");
  }
  if (pg?.code === "23505" && pg.constraint === "inventory_counts_one_open") {
    return new AppError("VALIDATION", "В филиале уже идёт инвентаризация");
  }
  if (pg?.code === "23P01" && pg.constraint === "payroll_periods_no_overlap") {
    return new AppError("VALIDATION", "Период пересекается с другим периодом филиала");
  }
  if (pg?.code === "22P02") {
    return new AppError("NOT_FOUND", "Не найдено");
  }
  if (pg?.code === "42501") {
    return new AppError("FORBIDDEN", "Недостаточно прав");
  }
  return error;
}
