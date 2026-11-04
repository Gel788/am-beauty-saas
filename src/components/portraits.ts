const STAFF: Record<string, string> = {
  "Алина Ковалёва": "/staff/alina.jpg",
  "Марина Соколова": "/staff/marina.jpg",
  "Денис Волков": "/staff/denis.jpg",
  "Елена Лебедева": "/staff/elena.jpg",
  "Ольга Воронова": "/staff/olga.jpg",
  "Виктория Павлова": "/staff/victoria.jpg",
};

export function portraitFor(name: string | null | undefined): string | null {
  if (!name) return null;
  return STAFF[name] ?? null;
}

export const SALON_PHOTO = "/staff/salon.jpg";
