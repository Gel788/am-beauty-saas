/**
 * CMD-BAR-*: the command bar understands short Russian phrases typed by the desk:
 * «запиши Анну к Алине завтра в 15 на маникюр», «склад», «журнал на пятницу», «Марина».
 * Pure: names are matched against lists the caller passes in, dates against today.
 */
import { addCalendarDays, isoWeekday } from "./time";

export type Named = { id: string; name: string };
export type ServiceRef = { id: string; title: string; staffIds: string[]; durationMin: number; priceMinor: number };

export type Parsed = {
  intent: "book" | "open" | "find";
  date: string | null;
  /** Minutes from midnight. */
  time: number | null;
  staff: Named | null;
  client: Named | null;
  services: ServiceRef[];
  /** Words left over after dates, times, names and services were taken out (a new client's name, a search). */
  rest: string;
};

const MONTHS = ["январ", "феврал", "март", "апрел", "ма", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];
/** «ноября» → 10; «маникюр» is not May. */
function monthOf(word: string | undefined) {
  if (!word) return -1;
  return MONTHS.findIndex((stem) => (stem === "ма" ? /^ма[яй]$/.test(word) : word.startsWith(stem)));
}
const WEEKDAYS: [string, number][] = [
  ["понедельник", 1], ["пн", 1], ["вторник", 2], ["вт", 2], ["сред", 3], ["ср", 3], ["четверг", 4], ["чт", 4],
  ["пятниц", 5], ["пт", 5], ["суббот", 6], ["сб", 6], ["воскресень", 7], ["вс", 7],
];
const BOOK = /^(запиш|запис|забронир|постав|добав.*запис|новая запись|book)/;
const STOP = new Set(["к", "ко", "на", "в", "во", "у", "с", "со", "и", "для", "по", "мне", "клиента", "клиентку", "мастеру", "мастера", "часов", "час", "утра", "вечера", "дня"]);

export function normalize(text: string) {
  return text.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}:.\s-]/gu, " ").replace(/\s+/g, " ").trim();
}

/** Russian endings change («Анну», «к Алине», «Марине»): compare stems, not whole words. */
export function stemMatch(word: string, target: string) {
  const a = normalize(word);
  const b = normalize(target);
  if (a.length < 3 || b.length < 3) return a === b;
  if (a === b) return true;
  const stem = (value: string) => (value.length > 4 ? value.slice(0, value.length - 2) : value.slice(0, Math.max(3, value.length - 1)));
  return b.startsWith(stem(a)) || a.startsWith(stem(b));
}

/** How well a phrase names a person: every word of the phrase that matches a word of the name counts. */
function nameScore(words: string[], name: string) {
  const parts = normalize(name).split(" ");
  let score = 0;
  const used: number[] = [];
  words.forEach((word, index) => {
    if (STOP.has(word) || word.length < 3) return;
    const hit = parts.find((part) => stemMatch(word, part));
    if (hit) {
      // A longer common start wins: «Марине» is Марина, not Мария.
      let common = 0;
      while (common < Math.min(word.length, hit.length) && word[common] === hit[common]) common += 1;
      // …and so does a closer length: «Марию» is Мария, not Марина.
      score += 1 + common / 100 - Math.abs(word.length - hit.length) / 1000;
      used.push(index);
    }
  });
  return { score, used };
}

function bestName<T extends { name: string }>(words: string[], list: T[], taken: Set<number>) {
  let best: { item: T; score: number; used: number[] } | null = null;
  for (const item of list) {
    const free = words.map((word, index) => (taken.has(index) ? "" : word));
    const { score, used } = nameScore(free, item.name);
    if (score > 0 && (!best || score > best.score)) best = { item, score, used };
  }
  return best;
}

export function parseDate(words: string[], today: string, taken: Set<number>): string | null {
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (taken.has(i)) continue;
    const take = (n = 1) => {
      for (let k = 0; k < n; k += 1) taken.add(i + k);
    };
    if (word === "сегодня") return take(), today;
    if (word === "завтра") return take(), addCalendarDays(today, 1);
    if (word === "послезавтра") return take(), addCalendarDays(today, 2);
    if (word === "через" && /^\d+$/.test(words[i + 1] ?? "") && /^(дн|ден|недел)/.test(words[i + 2] ?? "")) {
      const n = Number(words[i + 1]) * (words[i + 2].startsWith("недел") ? 7 : 1);
      return take(3), addCalendarDays(today, n);
    }
    const dotted = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?$/.exec(word);
    if (dotted) {
      const year = dotted[3] ? (dotted[3].length === 2 ? 2000 + Number(dotted[3]) : Number(dotted[3])) : Number(today.slice(0, 4));
      take();
      return rollForward(year, Number(dotted[2]), Number(dotted[1]), today, !dotted[3]);
    }
    if (/^\d{1,2}$/.test(word)) {
      const month = monthOf(words[i + 1]);
      if (month >= 0) {
        take(2);
        return rollForward(Number(today.slice(0, 4)), month + 1, Number(word), today, true);
      }
    }
    const weekday = WEEKDAYS.find(([stem]) => (stem.length <= 2 ? word === stem : word.startsWith(stem)));
    if (weekday) {
      take();
      const diff = (weekday[1] - isoWeekday(today) + 7) % 7;
      return addCalendarDays(today, diff === 0 ? 7 : diff);
    }
  }
  return null;
}

function rollForward(year: number, month: number, day: number, today: string, roll: boolean) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (roll && date < today) date = `${year + 1}${date.slice(4)}`;
  return date;
}

export function parseTime(words: string[], taken: Set<number>): number | null {
  for (let i = 0; i < words.length; i += 1) {
    if (taken.has(i)) continue;
    const clock = /^(\d{1,2})[:.](\d{2})$/.exec(words[i]);
    const prev = words[i - 1];
    if (clock && Number(clock[1]) < 24 && Number(clock[2]) < 60 && !(prev && /^\d/.test(prev))) {
      taken.add(i);
      if (prev === "в" || prev === "на") taken.add(i - 1);
      return Number(clock[1]) * 60 + Number(clock[2]);
    }
    if (/^\d{1,2}$/.test(words[i]) && (prev === "в" || prev === "на") && monthOf(words[i + 1]) < 0) {
      let hour = Number(words[i]);
      const next = words[i + 1] ?? "";
      if (/^(вечера|дня)$/.test(next) && hour < 12) hour += 12;
      if (hour >= 24) continue;
      // «в 3» at a salon means 15:00, not 3 at night.
      if (hour >= 1 && hour <= 8 && !/^утра$/.test(next)) hour += 12;
      taken.add(i - 1);
      taken.add(i);
      if (/^(вечера|дня|утра|часов|час|часа)$/.test(next)) taken.add(i + 1);
      return hour * 60;
    }
  }
  return null;
}

export function parseCommand(
  text: string,
  lists: { staff: Named[]; clients: Named[]; services: ServiceRef[]; today: string },
): Parsed {
  const words = normalize(text).split(" ").filter(Boolean);
  const taken = new Set<number>();
  let intent: Parsed["intent"] = "find";
  if (words.length && BOOK.test(words[0])) {
    intent = "book";
    taken.add(0);
  }
  const date = parseDate(words, lists.today, taken);
  const time = parseTime(words, taken);

  // A master is named after «к»: «к Алине». Without «к», the best name match still counts.
  const afterK = new Set(words.map((word, index) => (words[index - 1] === "к" || words[index - 1] === "ко" ? index : -1)).filter((index) => index >= 0));
  const staffList = lists.staff.map((item) => ({ ...item }));
  const staffPick = bestName(
    words.map((word, index) => (afterK.size && !afterK.has(index) ? "" : word)),
    staffList,
    taken,
  ) ?? (afterK.size ? null : bestName(words, staffList, taken));
  const staff = staffPick?.item ?? null;
  staffPick?.used.forEach((index) => taken.add(index));

  // Services by any word of the title («маникюр», «брови» → «Коррекция бровей»).
  const services: ServiceRef[] = [];
  words.forEach((word, index) => {
    if (taken.has(index) || STOP.has(word) || word.length < 4) return;
    const candidates = lists.services.filter((service) => normalize(service.title).split(" ").some((part) => part.length >= 4 && stemMatch(word, part)));
    if (!candidates.length) return;
    const forStaff = staff ? candidates.filter((service) => service.staffIds.includes(staff.id)) : candidates;
    const pick = (forStaff.length ? forStaff : candidates)[0];
    if (!services.some((service) => service.id === pick.id)) services.push(pick);
    taken.add(index);
  });

  const clientPick = bestName(words, lists.clients.map((item) => ({ ...item })), taken);
  const client = clientPick?.item ?? null;
  clientPick?.used.forEach((index) => taken.add(index));

  if (intent === "find" && (staff || client) && (date || time) && services.length) intent = "book";
  const rest = words.filter((word, index) => !taken.has(index) && !STOP.has(word)).join(" ");
  return { intent, date, time, staff, client, services, rest };
}

/** Pages of the CRM the bar can open, with the words people use for them. */
export const PAGES: { href: string; title: string; words: string[] }[] = [
  { href: "/journal", title: "Календарь", words: ["календарь", "журнал", "записи", "расписание"] },
  { href: "/dashboard", title: "Дашборд", words: ["дашборд", "главная", "сводка", "итоги"] },
  { href: "/clients", title: "Клиенты", words: ["клиенты", "база", "клиентская"] },
  { href: "/clients/import", title: "Импорт клиентов", words: ["импорт", "загрузить", "yclients", "выгрузка"] },
  { href: "/clients/duplicates", title: "Дубли клиентов", words: ["дубли", "дубликаты", "склеить"] },
  { href: "/staff", title: "Мастера и график", words: ["мастера", "сотрудники", "график", "смены", "команда"] },
  { href: "/services", title: "Услуги и цены", words: ["услуги", "прайс", "цены", "прейскурант"] },
  { href: "/cash", title: "Финансы и касса", words: ["касса", "финансы", "оплаты", "смена", "деньги", "чек"] },
  { href: "/inventory", title: "Склад", words: ["склад", "остатки", "материалы", "товары", "приход", "инвентаризация"] },
  { href: "/payroll", title: "Зарплаты", words: ["зарплата", "зарплаты", "выплаты", "расчет"] },
  { href: "/reports", title: "Отчёты", words: ["отчеты", "отчет", "аналитика", "выручка", "статистика"] },
  { href: "/loyalty", title: "Лояльность", words: ["лояльность", "бонусы", "сертификаты", "абонементы", "промокоды"] },
  { href: "/retention", title: "Удержание", words: ["удержание", "отзывы", "лист ожидания", "ожидание", "неявки"] },
  { href: "/groups", title: "Группы и мастер-классы", words: ["группы", "мастер-класс", "занятия"] },
  { href: "/network", title: "Сеть салонов", words: ["сеть", "филиалы"] },
  { href: "/settings", title: "Настройки", words: ["настройки", "интеграции", "уведомления", "телеграм", "sms"] },
  { href: "/settings/billing", title: "Подписка", words: ["подписка", "тариф", "оплатить crm"] },
  { href: "/me", title: "Мой день", words: ["мой день"] },
];

export function matchPages(text: string) {
  const query = normalize(text);
  if (!query) return [];
  const words = query.split(" ");
  return PAGES.map((page) => {
    const title = normalize(page.title);
    let score = 0;
    if (title.startsWith(query)) score += 3;
    for (const word of words) {
      if (word.length < 3) continue;
      if (page.words.some((item) => item.startsWith(word) || (word.length >= 4 && word.startsWith(item.slice(0, Math.max(4, item.length - 2)))))) score += 2;
      else if (title.split(" ").some((part) => part.startsWith(word))) score += 1;
    }
    return { page, score };
  })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.page);
}
