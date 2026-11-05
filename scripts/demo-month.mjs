/**
 * DEMO-MONTH: fills the demo salon (olga@ambeauty.local) so it can be tested for real.
 * - a realistic schedule: shifts, breaks, a vacation, days off, a short day;
 * - the journal booked every day up to the end of the month (at least three weeks ahead);
 * - a full warehouse in every branch with two months of history and service tech cards.
 *
 * Safe to run again and again (deploy/install.sh runs it on every update): the schedule and the
 * warehouse are set up once, and only days without demo visits get new ones. Changes testers make
 * are kept. Does nothing when the demo salon is not in the database.
 */
import pg from "pg";

const TENANT = "11111111-1111-4111-8111-111111111111";
const TZ_OFFSET_MIN = 180; // Europe/Moscow, no DST
const MARK = "demo-month";

const DAY = 86_400_000;
let seedState = 20261105;
const rand = (n) => {
  seedState = (seedState * 1103515245 + 12345) % 2147483648;
  return seedState % n;
};
const chance = (p) => rand(1000) < p * 1000;
const pick = (list) => list[rand(list.length)];

/** "YYYY-MM-DD" of a moment in Moscow. */
const localDate = (ms) => new Date(ms + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);
/** The UTC moment of a Moscow wall-clock minute on a date. */
const momentOf = (date, minute) => new Date(Date.parse(`${date}T00:00:00Z`) + (minute - TZ_OFFSET_MIN) * 60000);
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const isoWeekday = (date) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const ru = (date) => date.split("-").reverse().join(".");

export async function demoMonth(client, { now = Date.now(), log = console.log } = {}) {
  const tenant = await client.query("SELECT id FROM tenants WHERE id = $1", [TENANT]);
  if (!tenant.rowCount) {
    log("demo-month: demo salon not found, nothing to do");
    return { skipped: true };
  }
  const today = localDate(now);
  const actor = (await client.query("SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.tenant_id = $1 ORDER BY (m.role = 'owner') DESC LIMIT 1", [TENANT])).rows[0]?.id;
  const admin = (await client.query("SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.tenant_id = $1 AND m.role = 'admin' LIMIT 1", [TENANT])).rows[0]?.id ?? actor;
  const branches = (await client.query("SELECT id, name FROM branches WHERE tenant_id = $1 ORDER BY created_at, name", [TENANT])).rows;

  await client.query("BEGIN");
  try {
    const schedule = await setUpSchedule(client, { today, branches, log });
    const clients = await ensureClients(client, { log });
    const booked = await fillJournal(client, { today, now, admin, clients, log });
    const stock = await setUpWarehouse(client, { today, now, actor, branches, log });
    await client.query("COMMIT");
    return { schedule, booked, stock };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Schedule

/** [start, end, breakStart, breakEnd] in minutes, by ISO weekday. */
const PATTERNS = [
  { days: [1, 2, 3, 4, 5], hours: [600, 1140, 840, 870] }, // Пн–Пт 10–19, обед 14:00
  { days: [2, 3, 4, 5, 6], hours: [660, 1200, 900, 930] }, // Вт–Сб 11–20, обед 15:00
  { days: [3, 4, 5, 6, 7], hours: [720, 1260, 960, 990] }, // Ср–Вс 12–21, обед 16:00
  { days: [1, 2, 4, 5, 6], hours: [540, 1080, 780, 810] }, // Пн, Вт, Чт, Пт, Сб 9–18, обед 13:00
  { days: [1, 3, 5, 6, 7], hours: [600, 1200, 870, 900] }, // Пн, Ср, Пт, Сб, Вс 10–20, обед 14:30
];

async function setUpSchedule(client, { today, branches, log }) {
  const done = await client.query("SELECT 1 FROM schedule_exceptions WHERE tenant_id = $1 AND note LIKE $2 LIMIT 1", [TENANT, `${MARK}%`]);
  if (done.rowCount) return { created: false };

  // Every master gets one home branch (no more 10–20 every day in two places at once).
  const links = (
    await client.query(
      `SELECT s.id, s.display_name, array_agg(sb.branch_id ORDER BY b.created_at, b.name) AS branches
       FROM staff s JOIN staff_branches sb ON sb.staff_id = s.id JOIN branches b ON b.id = sb.branch_id
       WHERE s.tenant_id = $1 AND s.active GROUP BY s.id, s.display_name, s.created_at ORDER BY s.created_at, s.display_name`,
      [TENANT],
    )
  ).rows;
  await client.query("DELETE FROM schedule_templates WHERE tenant_id = $1", [TENANT]);
  const insert = (branchId, staffId, weekday, start, end, kind) =>
    client.query(
      "INSERT INTO schedule_templates (id, tenant_id, branch_id, staff_id, weekday, start_min, end_min, kind) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [crypto.randomUUID(), TENANT, branchId, staffId, weekday, start, end, kind],
    );
  let index = 0;
  for (const person of links) {
    const pattern = PATTERNS[index % PATTERNS.length];
    const [start, end, breakStart, breakEnd] = pattern.hours;
    const home = person.branches[0];
    // A master linked to two branches works Saturdays in the second one.
    const away = person.branches.length > 1 && pattern.days.includes(6) ? person.branches[1] : null;
    for (const weekday of pattern.days) {
      const where = away && weekday === 6 ? away : home;
      await insert(where, person.id, weekday, start, end, "work");
      await insert(where, person.id, weekday, breakStart, breakEnd, "break");
    }
    index += 1;
  }

  // Life happens: a vacation, days off, a short day.
  const exception = (branchId, staffId, from, to, kind, note, start = null, end = null) =>
    client.query(
      "INSERT INTO schedule_exceptions (id, tenant_id, branch_id, staff_id, starts_on, ends_on, kind, start_min, end_min, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [crypto.randomUUID(), TENANT, branchId, staffId, from, to, kind, start, end, `${MARK}: ${note}`],
    );
  const events = [];
  const byIndex = (n) => links[n % Math.max(links.length, 1)];
  if (links.length) {
    const vacationer = byIndex(1);
    await exception(vacationer.branches[0], vacationer.id, addDays(today, 12), addDays(today, 18), "vacation", "отпуск");
    events.push(`${vacationer.display_name}: отпуск ${ru(addDays(today, 12))}–${ru(addDays(today, 18))}`);
    const off = byIndex(2);
    await exception(off.branches[0], off.id, addDays(today, 5), addDays(today, 5), "day_off", "к врачу");
    events.push(`${off.display_name}: выходной ${ru(addDays(today, 5))}`);
    const short = byIndex(3);
    await exception(short.branches[0], short.id, addDays(today, 3), addDays(today, 3), "special_hours", "короткий день", 720, 960);
    events.push(`${short.display_name}: ${ru(addDays(today, 3))} с 12 до 16`);
    if (links.length > 5) {
      const other = byIndex(5);
      await exception(other.branches[0], other.id, addDays(today, 9), addDays(today, 10), "day_off", "учёба");
      events.push(`${other.display_name}: обучение ${ru(addDays(today, 9))}–${ru(addDays(today, 10))}`);
    }
  }
  log(`demo-month: schedule for ${links.length} masters; ${events.join("; ")}`);
  return { created: true, masters: links.length, events, branches: branches.length };
}

/** Working windows of a master on a date, minus breaks, from templates and exceptions. */
function windowsFor(date, staffId, branchId, templates, exceptions) {
  const own = exceptions.filter((row) => row.staff_id === staffId && row.branch_id === branchId && row.starts_on <= date && row.ends_on >= date);
  if (own.some((row) => row.kind === "day_off" || row.kind === "vacation")) return [];
  const weekday = isoWeekday(date);
  const rows = templates.filter((row) => row.staff_id === staffId && row.branch_id === branchId && row.weekday === weekday);
  const special = own.find((row) => row.kind === "special_hours");
  let work = special ? [[special.start_min, special.end_min]] : rows.filter((row) => row.kind === "work").map((row) => [row.start_min, row.end_min]);
  for (const brk of rows.filter((row) => row.kind === "break")) {
    work = work.flatMap(([start, end]) =>
      brk.end_min <= start || brk.start_min >= end ? [[start, end]] : [[start, brk.start_min], [brk.end_min, end]].filter(([a, b]) => b - a >= 30),
    );
  }
  return work;
}

// ---------------------------------------------------------------------------------------------
// Clients: a month of visits needs more than twenty regulars.

const FIRST = ["Анастасия", "Екатерина", "Светлана", "Ирина", "Татьяна", "Наталья", "Елизавета", "Вероника", "Александра", "Софья", "Арина", "Валерия", "Милана", "Ева", "Кристина", "Евгения", "Олеся", "Диана", "Яна", "Маргарита"];
const LAST = ["Иванова", "Петрова", "Сидорова", "Козлова", "Новикова", "Морозова", "Волкова", "Соловьёва", "Васильева", "Зайцева", "Павлова", "Семёнова", "Голубева", "Виноградова", "Богданова", "Воробьёва", "Фролова", "Тихонова", "Белова", "Комарова"];
const MEN = ["Артём Ершов", "Максим Гусев", "Илья Титов", "Никита Кудрявцев", "Роман Баранов", "Кирилл Куликов", "Егор Абрамов", "Тимур Сафин"];

async function ensureClients(client, { log }) {
  const extra = await client.query("SELECT count(*)::int AS n FROM clients WHERE tenant_id = $1 AND source = $2", [TENANT, MARK]);
  if (Number(extra.rows[0].n) === 0) {
    const names = [];
    for (let i = 0; i < 48; i += 1) names.push(`${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`);
    names.push(...MEN);
    let added = 0;
    for (const [i, name] of names.entries()) {
      const phone = `+7915${String(4100000 + i * 137).padStart(7, "0")}`;
      const taken = await client.query("SELECT 1 FROM client_phones WHERE tenant_id = $1 AND phone_e164 = $2 AND deleted_at IS NULL", [TENANT, phone]);
      if (taken.rowCount) continue;
      const id = crypto.randomUUID();
      const birth = chance(0.6) ? `19${80 + rand(20)}-${String(1 + rand(12)).padStart(2, "0")}-${String(1 + rand(28)).padStart(2, "0")}` : null;
      await client.query("INSERT INTO clients (id, tenant_id, name, source, birth_date, created_at) VALUES ($1,$2,$3,$4,$5, now() - ($6 || ' days')::interval)", [id, TENANT, name, MARK, birth, String(20 + rand(300))]);
      await client.query("INSERT INTO client_phones (id, tenant_id, client_id, phone_e164, is_primary) VALUES ($1,$2,$3,$4,true)", [crypto.randomUUID(), TENANT, id, phone]);
      added += 1;
    }
    log(`demo-month: ${added} more clients`);
  }
  return (await client.query("SELECT id FROM clients WHERE tenant_id = $1 AND deleted_at IS NULL AND merged_into_id IS NULL", [TENANT])).rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------------------------
// Journal

const COMMENTS = ["Хочет нюдовый оттенок", "Первый раз у нас", "Аллергия на лидокаин — уточнить", "Просила напомнить за день", "Придёт с дочкой", "Как в прошлый раз", "Чувствительная кожа", "Перенос с прошлой недели"];
const CHANNELS = ["yandex", "2gis", "instagram", "site", "telegram"];

async function fillJournal(client, { today, now, admin, clients, log }) {
  const [year, month] = today.split("-").map(Number);
  const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const lastDay = monthEnd > addDays(today, 21) ? monthEnd : addDays(today, 21);
  const first = addDays(today, 1);

  const templates = (await client.query("SELECT staff_id, branch_id, weekday, start_min, end_min, kind FROM schedule_templates WHERE tenant_id = $1", [TENANT])).rows;
  const exceptions = (
    await client.query("SELECT staff_id, branch_id, to_char(starts_on,'YYYY-MM-DD') AS starts_on, to_char(ends_on,'YYYY-MM-DD') AS ends_on, kind, start_min, end_min FROM schedule_exceptions WHERE tenant_id = $1", [TENANT])
  ).rows;
  const staffServices = (
    await client.query(
      `SELECT ss.staff_id, s.id, s.title, s.duration_min, s.price_minor, s.color, s.buffer_after_min
       FROM service_staff ss JOIN services s ON s.id = ss.service_id JOIN staff st ON st.id = ss.staff_id
       WHERE ss.tenant_id = $1 AND s.active AND st.active`,
      [TENANT],
    )
  ).rows;
  const servicesOf = new Map();
  for (const row of staffServices) servicesOf.set(row.staff_id, [...(servicesOf.get(row.staff_id) ?? []), row]);
  const pairs = [...new Set(templates.filter((row) => row.kind === "work").map((row) => `${row.staff_id}|${row.branch_id}`))].map((key) => key.split("|"));

  const from = momentOf(first, 0);
  const to = momentOf(addDays(lastDay, 1), 0);
  const filledDays = new Set(
    (
      await client.query("SELECT DISTINCT to_char(starts_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS d FROM appointments WHERE tenant_id = $1 AND custom ->> 'demo' = $2 AND starts_at >= $3", [
        TENANT,
        MARK,
        from.toISOString(),
      ])
    ).rows.map((row) => row.d),
  );
  const busy = new Map();
  for (const row of (
    await client.query("SELECT staff_id, starts_at, ends_at FROM appointments WHERE tenant_id = $1 AND status NOT IN ('cancelled','no_show') AND starts_at < $3 AND ends_at > $2", [TENANT, from.toISOString(), to.toISOString()])
  ).rows) {
    busy.set(row.staff_id, [...(busy.get(row.staff_id) ?? []), [new Date(row.starts_at).getTime(), new Date(row.ends_at).getTime()]]);
  }
  const free = (staffId, start, end) => !(busy.get(staffId) ?? []).some(([a, b]) => a < end && b > start);

  let count = 0;
  let days = 0;
  for (let date = first; date <= lastDay; date = addDays(date, 1)) {
    if (filledDays.has(date)) continue;
    days += 1;
    const ahead = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
    // Close days are almost full, the end of the month is a third booked; weekends are busier.
    const weekend = isoWeekday(date) >= 5 ? 0.12 : 0;
    const load = Math.max(0.22, 0.88 - ahead * 0.028) + weekend;
    for (const [staffId, branchId] of pairs) {
      const menu = servicesOf.get(staffId) ?? [];
      if (!menu.length) continue;
      for (const [start, end] of windowsFor(date, staffId, branchId, templates, exceptions)) {
        let minute = start;
        while (minute < end) {
          const service = pick(menu);
          const duration = service.duration_min;
          if (minute + duration > end || !chance(load)) {
            minute += 30;
            continue;
          }
          const startsAt = momentOf(date, minute).getTime();
          const endsAt = startsAt + duration * 60000;
          if (!free(staffId, startsAt, endsAt)) {
            minute += 30;
            continue;
          }
          busy.set(staffId, [...(busy.get(staffId) ?? []), [startsAt, endsAt]]);
          const id = crypto.randomUUID();
          const online = chance(0.35);
          const status = ahead <= 1 && chance(0.6) ? "confirmed" : "scheduled";
          await client.query(
            `INSERT INTO appointments (id, tenant_id, branch_id, staff_id, client_id, starts_at, ends_at, branch_tz, tz_offset_min, status, comment, source, channel, color, custom, created_by, updated_by, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'Europe/Moscow',$8,$9,$10,$11,$12,$13,$14,$15,$15,$16)`,
            [
              id,
              TENANT,
              branchId,
              staffId,
              pick(clients),
              new Date(startsAt).toISOString(),
              new Date(endsAt).toISOString(),
              TZ_OFFSET_MIN,
              status,
              chance(0.15) ? pick(COMMENTS) : "",
              online ? "online" : "admin",
              online ? pick(CHANNELS) : null,
              service.color,
              JSON.stringify({ demo: MARK }),
              admin,
              new Date(now - rand(14) * DAY).toISOString(),
            ],
          );
          await client.query(
            "INSERT INTO appointment_services (id, tenant_id, appointment_id, service_id, title_snapshot, duration_min, price_minor, position) VALUES ($1,$2,$3,$4,$5,$6,$7,0)",
            [crypto.randomUUID(), TENANT, id, service.id, service.title, duration, service.price_minor],
          );
          count += 1;
          minute += duration + (service.buffer_after_min ?? 0) + (chance(0.4) ? 15 : 0);
          minute = Math.ceil(minute / 15) * 15;
        }
      }
    }
  }
  log(`demo-month: ${count} visits booked over ${days} days, up to ${ru(lastDay)}`);
  return { visits: count, days, until: lastDay };
}

// ---------------------------------------------------------------------------------------------
// Warehouse

/** [sku, title, unit, costMinor per unit, sellMinor, minQty, qty per branch [1,2,3], uses per day] */
const CATALOG = [
  // Ногтевой сервис
  ["NAIL-GEL-NUDE", "Гель-лак Kodi «Nude 40», 8 мл", "ml", 4400, 0, 16, [56, 32, 24], 2.5],
  ["NAIL-GEL-RED", "Гель-лак Kodi «Red 70», 8 мл", "ml", 4400, 0, 16, [40, 8, 16], 1.5],
  ["NAIL-GEL-MILK", "Гель-лак Luxio «Milk», 15 мл", "ml", 5200, 0, 30, [90, 45, 30], 2],
  ["NAIL-GEL-BLACK", "Гель-лак TNL «Black», 10 мл", "ml", 2900, 0, 20, [12, 30, 20], 1],
  ["NAIL-BASE-RUB", "База каучуковая Kodi, 30 мл", "ml", 3300, 0, 60, [150, 90, 60], 4],
  ["NAIL-BASE-CAM", "Камуфлирующая база «Pink», 30 мл", "ml", 3600, 0, 60, [45, 60, 30], 2],
  ["NAIL-TOP-NW", "Топ без липкого слоя, 30 мл", "ml", 3000, 0, 60, [120, 60, 90], 4],
  ["NAIL-TOP-MATTE", "Топ матовый, 15 мл", "ml", 3400, 0, 15, [30, 15, 0], 0.5],
  ["NAIL-PRIMER", "Праймер бескислотный, 15 мл", "ml", 2600, 0, 15, [45, 30, 15], 1],
  ["NAIL-DEGR", "Обезжириватель, 500 мл", "ml", 90, 0, 300, [1400, 700, 500], 30],
  ["NAIL-REMOVER", "Ремувер для гель-лака, 500 мл", "ml", 110, 0, 300, [900, 250, 500], 25],
  ["NAIL-FILE-180", "Пилка 180/240, одноразовая", "pcs", 2500, 0, 50, [180, 90, 60], 6],
  ["NAIL-BAF", "Баф 120/120", "pcs", 3000, 0, 40, [35, 60, 40], 4],
  ["NAIL-CAP", "Колпачки для фрезы 80 грит", "pcs", 900, 0, 100, [400, 200, 100], 8],
  ["NAIL-SPONGE", "Безворсовые салфетки, 1000 шт", "pcs", 60, 0, 500, [2600, 1200, 900], 25],
  ["NAIL-FOIL", "Фольга для снятия, 100 шт", "pcs", 100, 0, 100, [60, 300, 200], 6],
  // Брови и ресницы
  ["BROW-PAINT-BR", "Краска для бровей Refectocil «коричневая», 15 мл", "ml", 3200, 0, 15, [40, 20, 0], 1],
  ["BROW-HENNA", "Хна для бровей BrowXenna, 6 г", "g", 21000, 0, 6, [18, 12, 0], 0.3],
  ["BROW-OXID", "Оксидант 3%, 100 мл", "ml", 600, 0, 50, [160, 100, 0], 3],
  ["LASH-LAM-1", "Состав для ламинирования №1, 8 мл", "ml", 9500, 0, 8, [24, 16, 0], 0.4],
  ["LASH-LAM-2", "Состав для ламинирования №2, 8 мл", "ml", 9500, 0, 8, [6, 16, 0], 0.4],
  ["LASH-PADS", "Силиконовые валики, пара", "pack", 4500, 0, 10, [36, 24, 0], 1],
  ["LASH-PATCH", "Патчи гидрогелевые, пара", "pcs", 1500, 0, 50, [140, 80, 0], 3],
  // Волосы и барбер
  ["HAIR-COLOR-5", "Краска Estel «5/0», 60 мл", "ml", 650, 0, 120, [420, 300, 0], 6],
  ["HAIR-OXY-6", "Оксигент 6%, 1 л", "ml", 45, 0, 500, [2400, 1600, 0], 30],
  ["HAIR-SHAMPOO", "Шампунь профессиональный, 1 л", "ml", 120, 0, 500, [1800, 1200, 0], 40],
  ["HAIR-COLLAR", "Воротнички бумажные, 100 шт", "pcs", 250, 0, 100, [220, 400, 0], 8],
  ["BEARD-OIL-PRO", "Масло для бороды (кабинетное), 100 мл", "ml", 800, 0, 30, [80, 60, 0], 2],
  // Массаж и SPA
  ["SPA-OIL-ALM", "Масло массажное миндальное, 1 л", "ml", 95, 0, 500, [1200, 0, 2600], 45],
  ["SPA-CREAM", "Крем массажный, 500 мл", "ml", 140, 0, 250, [400, 0, 900], 20],
  ["SPA-WRAP", "Обёртывание шоколадное, 1 кг", "g", 210, 0, 400, [0, 0, 1800], 40],
  ["SPA-SHEET", "Простыни одноразовые, 20 шт", "pcs", 1800, 0, 60, [140, 0, 300], 8],
  // Расходники
  ["DISP-GLOVES-M", "Перчатки нитриловые M, 100 шт", "pcs", 900, 0, 200, [340, 120, 500], 20],
  ["DISP-GLOVES-S", "Перчатки нитриловые S, 100 шт", "pcs", 900, 0, 200, [160, 400, 300], 12],
  ["DISP-TOWEL", "Полотенца одноразовые, 100 шт", "pcs", 900, 0, 100, [450, 220, 600], 15],
  ["DISP-MASK", "Маски медицинские, 50 шт", "pcs", 300, 0, 100, [500, 300, 200], 10],
  ["DISP-ANTISEP", "Антисептик для рук, 1 л", "ml", 35, 0, 1000, [3800, 2500, 1500], 80],
  ["DISP-STERIL", "Крафт-пакеты для стерилизации, 100 шт", "pcs", 600, 0, 100, [320, 80, 150], 10],
  // Продажа клиентам
  ["RET-CREAM-HAND", "Крем для рук Christina, 75 мл", "pcs", 52000, 119000, 4, [9, 5, 6], 0.15],
  ["RET-OIL-CUT", "Масло для кутикулы с пипеткой, 10 мл", "pcs", 28000, 69000, 6, [14, 2, 7], 0.25],
  ["RET-SHAMPOO", "Шампунь Davines для дома, 250 мл", "pcs", 140000, 289000, 3, [6, 4, 0], 0.08],
  ["RET-WAX", "Воск для укладки, 75 мл", "pcs", 65000, 149000, 4, [3, 10, 0], 0.1],
  ["RET-BEARD", "Масло для бороды, 30 мл", "pcs", 48000, 109000, 4, [7, 8, 0], 0.08],
  ["RET-SERUM", "Сыворотка для ресниц и бровей", "pcs", 110000, 249000, 3, [5, 3, 2], 0.05],
  ["RET-CERT", "Подарочная коробка", "pcs", 15000, 35000, 10, [30, 12, 20], 0.2],
];

/** Tech cards: what one service uses, by service title. */
const TECH_CARDS = {
  "Маникюр с гель-лаком": [["NAIL-BASE-RUB", 0.4], ["NAIL-GEL-NUDE", 0.3], ["NAIL-TOP-NW", 0.4], ["NAIL-PRIMER", 0.1], ["NAIL-DEGR", 3], ["NAIL-FILE-180", 1], ["NAIL-BAF", 1], ["NAIL-CAP", 1], ["NAIL-SPONGE", 4], ["DISP-GLOVES-M", 2]],
  "Снятие + укрепление": [["NAIL-REMOVER", 5], ["NAIL-FOIL", 10], ["NAIL-BASE-CAM", 0.6], ["NAIL-TOP-NW", 0.3], ["NAIL-FILE-180", 1], ["NAIL-SPONGE", 4], ["DISP-GLOVES-M", 2]],
  "Покрытие гель-лак": [["NAIL-BASE-RUB", 0.3], ["NAIL-GEL-MILK", 0.3], ["NAIL-TOP-NW", 0.3], ["NAIL-SPONGE", 3], ["DISP-GLOVES-M", 2]],
  "Коррекция бровей": [["BROW-PAINT-BR", 0.5], ["BROW-OXID", 1], ["DISP-GLOVES-S", 2], ["DISP-TOWEL", 1]],
  "Ламинирование ресниц": [["LASH-LAM-1", 0.2], ["LASH-LAM-2", 0.2], ["LASH-PADS", 1], ["LASH-PATCH", 1], ["DISP-GLOVES-S", 2]],
  "Мужская стрижка": [["HAIR-SHAMPOO", 15], ["HAIR-COLLAR", 1], ["DISP-TOWEL", 1]],
  "Стрижка + борода": [["HAIR-SHAMPOO", 15], ["HAIR-COLLAR", 1], ["BEARD-OIL-PRO", 2], ["DISP-TOWEL", 2]],
  "Камуфляж седины": [["HAIR-COLOR-5", 20], ["HAIR-OXY-6", 30], ["HAIR-COLLAR", 1], ["DISP-GLOVES-M", 2]],
  "Классический массаж": [["SPA-OIL-ALM", 30], ["SPA-SHEET", 1], ["DISP-TOWEL", 2]],
  "SPA-программа": [["SPA-WRAP", 150], ["SPA-CREAM", 20], ["SPA-SHEET", 2], ["DISP-TOWEL", 2]],
  "Массаж спины": [["SPA-OIL-ALM", 20], ["SPA-SHEET", 1], ["DISP-TOWEL", 1]],
};

const SUPPLIERS = ["ООО «Нейл Маркет»", "ИП Соколова (Kodi Professional)", "ООО «Бьюти Опт»", "ООО «Эстель Дистрибуция»", "ООО «СпаЛайн»", "ООО «Медтехника-Снаб»"];
const WRITE_OFF_REASONS = ["Истёк срок годности", "Разбился флакон", "Брак поставки", "Загустел, непригоден"];

async function setUpWarehouse(client, { today, now, actor, branches, log }) {
  const hasMin = (await client.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'inventory_items' AND column_name = 'min_qty'")).rowCount > 0;
  const existing = new Map((await client.query("SELECT sku, id FROM inventory_items WHERE tenant_id = $1", [TENANT])).rows.map((row) => [row.sku, row.id]));
  const fresh = CATALOG.filter(([sku]) => !existing.has(sku));
  if (!fresh.length) return { created: 0 };

  const movements = [];
  const at = (daysAgo, minute) => new Date(momentOf(addDays(today, -daysAgo), minute).getTime()).toISOString();
  const usable = branches.slice(0, 3);
  const docNumber = () => String(1000 + rand(9000));

  for (const [sku, title, unit, cost, sell, minQty, perBranch, perDay] of fresh) {
    const id = crypto.randomUUID();
    existing.set(sku, id);
    await client.query(
      hasMin
        ? "INSERT INTO inventory_items (id, tenant_id, sku, title, unit, cost_minor, sell_price_minor, for_sale, min_qty, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() - interval '62 days')"
        : "INSERT INTO inventory_items (id, tenant_id, sku, title, unit, cost_minor, sell_price_minor, for_sale, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() - interval '62 days')",
      hasMin ? [id, TENANT, sku, title, unit, cost, sell, sell > 0, minQty] : [id, TENANT, sku, title, unit, cost, sell, sell > 0],
    );
    usable.forEach((branch, b) => {
      const target = perBranch[b] ?? 0;
      if (!target && !chance(0.1)) return;
      const daily = perDay * (b === 0 ? 1 : 0.7);
      // Outgoing over the last 60 days: daily use of materials, sales of retail, the odd write-off.
      const outs = [];
      for (let d = 59; d >= 1; d -= 1) {
        const qty = sell > 0 ? (chance(daily) ? 1 : 0) : Math.round(daily * (0.6 + rand(80) / 100) * 10) / 10;
        if (qty > 0) outs.push({ d, qty, type: sell > 0 ? "sale" : "consume" });
      }
      if (sell === 0 && chance(0.25)) outs.push({ d: 10 + rand(40), qty: Math.max(1, Math.round(daily * 2)), type: "write_off" });
      const used = outs.reduce((sum, row) => sum + row.qty, 0);
      // Two deliveries cover what went out plus what is on the shelf now.
      const total = Math.round((used + target) * 10) / 10;
      // The first one lasts until the second, so the shelf never goes below zero on the way.
      const early = outs.filter((row) => row.d > 24).reduce((sum, row) => sum + row.qty, 0);
      const firstPart = Math.min(total, Math.round((early + target * 0.4 + daily * 2) * 10) / 10);
      const supplier = pick(SUPPLIERS);
      movements.push({ branch: branch.id, item: id, type: "receipt", qty: firstPart, cost, at: at(60, 660), supplier, document: `Накладная № ${docNumber()} от ${ru(addDays(today, -60))}` });
      if (total - firstPart > 0) {
        movements.push({ branch: branch.id, item: id, type: "receipt", qty: Math.round((total - firstPart) * 10) / 10, cost, at: at(24, 690), supplier, document: `Накладная № ${docNumber()} от ${ru(addDays(today, -24))}` });
      }
      for (const row of outs) {
        movements.push({
          branch: branch.id,
          item: id,
          type: row.type,
          qty: -row.qty,
          cost,
          at: at(row.d, 1170),
          reason: row.type === "consume" ? "Расход по услугам за день" : row.type === "write_off" ? pick(WRITE_OFF_REASONS) : null,
          document: row.type === "sale" ? "Продажа на кассе" : null,
        });
      }
    });
  }

  // Branch to branch: the first branch helped the others with what was running out.
  const transfers = [];
  if (usable.length > 1) {
    for (const sku of ["NAIL-GEL-RED", "DISP-GLOVES-M", "NAIL-FOIL"]) {
      const item = existing.get(sku);
      const to = usable[1 + rand(usable.length - 1)];
      const transferId = crypto.randomUUID();
      const qty = sku === "NAIL-GEL-RED" ? 8 : 50;
      const cost = CATALOG.find(([s]) => s === sku)[3];
      const when = at(8 + rand(10), 720);
      movements.push({ branch: usable[0].id, item, type: "transfer", qty: -qty, cost, at: when, transferId, reason: `Перемещение в «${to.name}»` });
      movements.push({ branch: to.id, item, type: "transfer", qty, cost, at: when, transferId, reason: `Перемещение из «${usable[0].name}»` });
      // Keep the shelf where it was planned: the extra arrives earlier at the source.
      movements.push({ branch: usable[0].id, item, type: "receipt", qty, cost, at: at(40, 660), supplier: pick(SUPPLIERS), document: `Накладная № ${docNumber()}` });
      movements.push({ branch: to.id, item, type: "consume", qty: -qty, cost, at: at(3, 1170), reason: "Расход по услугам за день" });
      transfers.push(sku);
    }
  }

  // Last week's stocktake in the first branch: small differences found and booked.
  const countId = crypto.randomUUID();
  const countLines = [];
  await client.query(
    "INSERT INTO inventory_counts (id, tenant_id, branch_id, status, note, created_by, created_at, applied_by, applied_at) VALUES ($1,$2,$3,'applied','Плановая инвентаризация',$4,$5,$4,$6)",
    [countId, TENANT, usable[0].id, actor, at(7, 1200), at(7, 1260)],
  );
  for (const [sku, diff] of [["NAIL-FILE-180", -4], ["DISP-GLOVES-M", -10], ["NAIL-SPONGE", 20], ["RET-OIL-CUT", -1], ["NAIL-GEL-NUDE", 0]]) {
    const item = existing.get(sku);
    countLines.push({ item, diff, cost: CATALOG.find(([s]) => s === sku)[3] });
    if (diff !== 0) {
      movements.push({ branch: usable[0].id, item, type: "inventory_adjust", qty: diff, cost: CATALOG.find(([s]) => s === sku)[3], at: at(7, 1260), countId, reason: "Инвентаризация" });
      movements.push({ branch: usable[0].id, item, type: diff < 0 ? "receipt" : "consume", qty: -diff, cost: CATALOG.find(([s]) => s === sku)[3], at: at(9, 660), document: diff < 0 ? `Накладная № ${docNumber()}` : null, reason: diff < 0 ? null : "Расход по услугам за день", supplier: diff < 0 ? pick(SUPPLIERS) : null });
    }
  }

  // Write everything and the balances it adds up to.
  movements.sort((a, b) => a.at.localeCompare(b.at));
  const balances = new Map();
  for (const row of movements) {
    const key = `${row.item}|${row.branch}`;
    const after = Math.round(((balances.get(key) ?? 0) + row.qty) * 1000) / 1000;
    balances.set(key, after);
    await client.query(
      `INSERT INTO stock_movements (id, tenant_id, branch_id, item_id, type, qty, cost_minor, negative, transfer_id, count_id, supplier, document, reason, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [crypto.randomUUID(), TENANT, row.branch, row.item, row.type, row.qty, row.cost, after < 0, row.transferId ?? null, row.countId ?? null, row.supplier ?? null, row.document ?? null, row.reason ?? null, actor, row.at],
    );
  }
  for (const [key, qty] of balances) {
    const [item, branch] = key.split("|");
    await client.query("INSERT INTO stock_balances (tenant_id, item_id, branch_id, qty) VALUES ($1,$2,$3,$4) ON CONFLICT (item_id, branch_id) DO UPDATE SET qty = stock_balances.qty + EXCLUDED.qty", [TENANT, item, branch, qty]);
  }
  for (const line of countLines) {
    const actual = balances.get(`${line.item}|${usable[0].id}`) ?? 0;
    await client.query("INSERT INTO inventory_count_lines (tenant_id, count_id, item_id, expected_qty, counted_qty, cost_minor) VALUES ($1,$2,$3,$4,$5,$6)", [TENANT, countId, line.item, actual - line.diff, actual, line.cost]);
  }

  // Items from the first seed get shelves in the other branches too.
  const oldItems = (await client.query("SELECT id, cost_minor FROM inventory_items WHERE tenant_id = $1 AND sku NOT LIKE ALL($2::text[])", [TENANT, CATALOG.map(([sku]) => sku)])).rows;
  for (const item of oldItems) {
    for (const branch of usable.slice(1)) {
      const has = await client.query("SELECT 1 FROM stock_balances WHERE item_id = $1 AND branch_id = $2", [item.id, branch.id]);
      if (has.rowCount) continue;
      const qty = 10 + rand(60);
      await client.query(
        "INSERT INTO stock_movements (id, tenant_id, branch_id, item_id, type, qty, cost_minor, supplier, document, created_by, created_at) VALUES ($1,$2,$3,$4,'receipt',$5,$6,$7,$8,$9,$10)",
        [crypto.randomUUID(), TENANT, branch.id, item.id, qty, item.cost_minor, pick(SUPPLIERS), `Накладная № ${docNumber()}`, actor, at(30, 660)],
      );
      await client.query("INSERT INTO stock_balances (tenant_id, item_id, branch_id, qty) VALUES ($1,$2,$3,$4)", [TENANT, item.id, branch.id, qty]);
    }
  }

  // Tech cards: completing a visit writes its materials off by itself.
  let cards = 0;
  const services = (await client.query("SELECT id, title FROM services WHERE tenant_id = $1", [TENANT])).rows;
  for (const service of services) {
    for (const [sku, qty] of TECH_CARDS[service.title] ?? []) {
      const item = existing.get(sku);
      if (!item) continue;
      const added = await client.query("INSERT INTO service_consumables (tenant_id, service_id, item_id, qty_per_service) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [TENANT, service.id, item, qty]);
      cards += added.rowCount;
    }
  }
  log(`demo-month: ${fresh.length} warehouse items, ${movements.length} movements, transfers ${transfers.length}, ${cards} tech card lines`);
  return { created: fresh.length, movements: movements.length, cards, now };
}

// Run directly: node scripts/demo-month.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  const client = new pg.Client({ connectionString: process.env.MIGRATE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/ambeauty" });
  await client.connect();
  try {
    await demoMonth(client);
  } finally {
    await client.end();
  }
}
