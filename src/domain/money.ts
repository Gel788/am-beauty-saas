export function formatMoney(minor: number, currency = "RUB"): string {
  const fraction = minor % 100 === 0 ? 0 : 2;
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    minimumFractionDigits: fraction,
    maximumFractionDigits: fraction,
  }).format(minor / 100);
}

export function rublesToMinor(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}
