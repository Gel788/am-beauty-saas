/** OB-SRC-01: booking channels. Any short slug is accepted; these get a name and a ready link. */
export const BOOKING_CHANNELS: { id: string; label: string; hint: string }[] = [
  { id: "yandex", label: "Яндекс Карты", hint: "Яндекс Бизнес → карточка организации → кнопка «Записаться онлайн» или «Онлайн-запись»" },
  { id: "2gis", label: "2ГИС", hint: "Личный кабинет 2ГИС для бизнеса → карточка → кнопка «Онлайн-запись»" },
  { id: "google", label: "Google Карты", hint: "Профиль компании Google → ссылка для записи" },
  { id: "instagram", label: "Instagram", hint: "Ссылка в шапке профиля или кнопка «Записаться»" },
  { id: "vk", label: "ВКонтакте", hint: "Кнопка действия сообщества или ссылка в меню" },
  { id: "telegram", label: "Telegram", hint: "Описание канала, закреплённое сообщение или кнопка бота" },
  { id: "whatsapp", label: "WhatsApp", hint: "Описание бизнес-профиля или быстрый ответ" },
  { id: "site", label: "Сайт", hint: "Кнопка «Записаться» на сайте или окно записи (iframe)" },
];

const LABELS = new Map(BOOKING_CHANNELS.map((channel) => [channel.id, channel.label]));

export function channelLabel(id: string | null | undefined) {
  if (!id) return "Без метки";
  return LABELS.get(id) ?? id;
}

/** Reads ?src= (or utm_source) into a safe slug; anything else is dropped. */
export function cleanChannel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24);
  if (!slug) return null;
  if (slug === "yandexmaps" || slug === "yandex_maps" || slug === "ya") return "yandex";
  if (slug === "dgis" || slug === "2gis_ru") return "2gis";
  if (slug === "ig" || slug === "insta") return "instagram";
  if (slug === "vkontakte") return "vk";
  return slug;
}
