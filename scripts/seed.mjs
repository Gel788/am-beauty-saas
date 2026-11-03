import bcrypt from "bcryptjs";
import pg from "pg";

const connectionString = process.env.MIGRATE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/ambeauty";
const client = new pg.Client({ connectionString });
await client.connect();

const tenant = "11111111-1111-4111-8111-111111111111";
const branch = "22222222-2222-4222-8222-222222222222";
const branch2 = "33333333-3333-4333-8333-333333333333";
const users = {
  olga: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  admin: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  alina: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
  buh: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
};
const staff = {
  alina: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  marina: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
  denis: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3",
  elena: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4",
};
const services = {
  manicure: ["Маникюр с гель-лаком", 90, 240000, "#f7d4e6"],
  removal: ["Снятие + укрепление", 90, 180000, "#f8e0ea"],
  gel: ["Покрытие гель-лак", 60, 160000, "#f6d0e2"],
  brows: ["Коррекция бровей", 60, 150000, "#f8e7c4"],
  lashes: ["Ламинирование ресниц", 75, 220000, "#f6e3b0"],
  hair: ["Мужская стрижка", 60, 180000, "#d7e6fb"],
  beard: ["Стрижка + борода", 75, 240000, "#d5e2f8"],
  color: ["Камуфляж седины", 90, 280000, "#d9e7ff"],
  massage: ["Классический массаж", 60, 250000, "#d9f3e4"],
  spa: ["SPA-программа", 120, 420000, "#d4f0e0"],
  back: ["Массаж спины", 60, 220000, "#e5f7ee"],
};

const hash = bcrypt.hashSync("ambeauty", 8);
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

function at(hours, minutes) {
  const [year, month, day] = today.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, hours - 3, minutes, 0));
}

await client.query("BEGIN");
await client.query("DELETE FROM tenants WHERE id = $1", [tenant]);
await client.query("DELETE FROM users WHERE email LIKE '%@ambeauty.local'");
await client.query("INSERT INTO tenants (id, name) VALUES ($1, 'Am Beauty')", [tenant]);
await client.query(
  `INSERT INTO branches (id, tenant_id, name, address, timezone, require_payment_on_complete)
   VALUES ($1, $3, 'Am Beauty · Садовая', 'Садовая, 14', 'Europe/Moscow', true),
          ($2, $3, 'Am Beauty · Патриаршие', 'Патриаршие пруды', 'Europe/Moscow', true)`,
  [branch, branch2, tenant],
);
await client.query(
  `INSERT INTO users (id, email, password_hash, name) VALUES
   ($1, 'olga@ambeauty.local', $5, 'Ольга Воронова'),
   ($2, 'admin@ambeauty.local', $5, 'Администратор'),
   ($3, 'alina@ambeauty.local', $5, 'Алина Ковалёва'),
   ($4, 'buh@ambeauty.local', $5, 'Бухгалтер')`,
  [users.olga, users.admin, users.alina, users.buh, hash],
);
await client.query(
  `INSERT INTO memberships (id, tenant_id, user_id, role, branch_id) VALUES
   ($1, $5, $6, 'owner', NULL),
   ($2, $5, $7, 'admin', $8),
   ($3, $5, $9, 'master', $8),
   ($4, $5, $10, 'accountant', $8)`,
  [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), tenant, users.olga, users.admin, branch, users.alina, users.buh],
);

const staffRows = [
  [staff.alina, users.alina, "Алина Ковалёва", "#e59ab8"],
  [staff.marina, null, "Марина Соколова", "#c7b4ef"],
  [staff.denis, null, "Денис Волков", "#8eb4f5"],
  [staff.elena, null, "Елена Лебедева", "#8ed7b5"],
];
for (const [id, userId, name, color] of staffRows) {
  await client.query(
    "INSERT INTO staff (id, tenant_id, user_id, display_name, color) VALUES ($1, $2, $3, $4, $5)",
    [id, tenant, userId, name, color],
  );
  await client.query("INSERT INTO staff_branches (staff_id, branch_id, tenant_id) VALUES ($1, $2, $3)", [id, branch, tenant]);
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    await client.query(
      `INSERT INTO schedule_templates (id, tenant_id, branch_id, staff_id, weekday, start_min, end_min, kind)
       VALUES ($1, $2, $3, $4, $5, 600, 1200, 'work')`,
      [crypto.randomUUID(), tenant, branch, id, weekday],
    );
  }
}

const serviceIds = {};
let sort = 0;
for (const [key, [title, duration, price, color]] of Object.entries(services)) {
  const id = crypto.randomUUID();
  serviceIds[key] = id;
  await client.query(
    `INSERT INTO services (id, tenant_id, title, duration_min, price_minor, color, sort)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, tenant, title, duration, price, color, sort],
  );
  sort += 1;
}
const links = {
  alina: ["manicure", "removal", "gel"],
  marina: ["brows", "lashes"],
  denis: ["hair", "beard", "color"],
  elena: ["massage", "spa", "back"],
};
for (const [person, keys] of Object.entries(links)) {
  for (const key of keys) {
    await client.query("INSERT INTO service_staff (service_id, staff_id, tenant_id) VALUES ($1, $2, $3)", [
      serviceIds[key],
      staff[person],
      tenant,
    ]);
  }
}

await client.query("UPDATE branches SET grid_label_min = 60 WHERE tenant_id = $1", [tenant]);

function shiftDate(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function atOn(iso, hours, minutes) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, hours - 3, minutes, 0));
}

const named = [
  "Анна Смирнова",
  "Ксения Орлова",
  "Виктория Павлова",
  "Юлия Морозова",
  "Ольга Белова",
  "Мария Кузнецова",
  "Полина Зайцева",
  "Дарья Фёдорова",
  "Алёна Егорова",
  "Игорь Петров",
  "Артём Новиков",
  "Максим Ильин",
  "Сергей Лебедев",
  "Никита Попов",
  "Роман Козлов",
  "Олег Семёнов",
  "Татьяна Волкова",
  "Наталья Соловьёва",
  "Ирина Васильева",
];
const fresh = new Set(["Юлия Морозова", "Ольга Белова", "Максим Ильин", "Ирина Васильева"]);
const firstNames = ["Светлана", "Надежда", "Вера", "Людмила", "Галина", "Инна", "Лариса", "Оксана", "Жанна", "Регина", "Карина", "Милана", "Алиса", "Валерия", "Диана", "Екатерина", "Кристина", "Маргарита", "София", "Ульяна", "Яна", "Борис", "Глеб", "Кирилл", "Лев", "Матвей", "Павел", "Степан", "Тимур", "Фёдор"];
const lastNames = ["Ильина", "Ким", "Белых", "Орлова", "Кузнецова", "Соколова", "Морозова", "Волкова", "Лебедева", "Новикова", "Павлова", "Семёнова", "Козлова", "Егорова", "Зайцева"];
const used = new Set(named);
const generated = [];
let nameCursor = 0;
while (generated.length < 53 && nameCursor < 2000) {
  const name = `${firstNames[nameCursor % firstNames.length]} ${lastNames[Math.floor(nameCursor / firstNames.length) % lastNames.length]}`;
  nameCursor += 1;
  if (used.has(name)) continue;
  used.add(name);
  generated.push(name);
}
if (generated.length < 53) throw new Error("Not enough unique demo client names");
const repeatExtras = generated.slice(0, 30);
const dormantNames = generated.slice(30);

const clientIds = {};
let phoneSeq = 1;
async function addClient(name, createdAt) {
  const id = crypto.randomUUID();
  clientIds[name] = id;
  const phone = `+7900${String(phoneSeq).padStart(7, "0")}`;
  phoneSeq += 1;
  await client.query(
    "INSERT INTO clients (id, tenant_id, name, source, created_at) VALUES ($1, $2, $3, 'walk-in', $4)",
    [id, tenant, name, createdAt],
  );
  await client.query(
    "INSERT INTO client_phones (id, tenant_id, client_id, phone_e164, is_primary) VALUES ($1, $2, $3, $4, true)",
    [crypto.randomUUID(), tenant, id, phone],
  );
}

for (const name of named) {
  const createdAt = fresh.has(name) ? at(0, 10).toISOString() : atOn(shiftDate(today, -50), 11, 0).toISOString();
  await addClient(name, createdAt);
}
for (const name of repeatExtras) await addClient(name, atOn(shiftDate(today, -40), 11, 0).toISOString());
for (const name of dormantNames) await addClient(name, atOn(shiftDate(today, -90), 11, 0).toISOString());

const shiftId = crypto.randomUUID();
await client.query(
  `INSERT INTO cash_shifts (id, tenant_id, branch_id, opened_by, opening_cash_minor, status, note, opened_at)
   VALUES ($1, $2, $3, $4, 1000000, 'open', 'утро', $5)`,
  [shiftId, tenant, branch, users.admin, atOn(shiftDate(today, -40), 9, 0).toISOString()],
);

async function book({ person, clientName, serviceKey, title, iso, hour, minute, duration, status, source, pay }) {
  const service = services[serviceKey];
  const starts = atOn(iso, hour, minute);
  const ends = new Date(starts.getTime() + duration * 60000);
  const id = crypto.randomUUID();
  const price = service[2];
  await client.query(
    `INSERT INTO appointments (
      id, tenant_id, branch_id, staff_id, client_id, starts_at, ends_at, branch_tz, tz_offset_min,
      status, source, color, created_by, updated_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,'Europe/Moscow',180,$8,$9,$10,$11,$11)`,
    [id, tenant, branch, staff[person], clientIds[clientName], starts.toISOString(), ends.toISOString(), status, source, service[3], users.admin],
  );
  await client.query(
    `INSERT INTO appointment_services (id, tenant_id, appointment_id, service_id, title_snapshot, duration_min, price_minor, position)
     VALUES ($1,$2,$3,$4,$5,$6,$7,0)`,
    [crypto.randomUUID(), tenant, id, serviceIds[serviceKey], title, duration, price],
  );
  if (pay) {
    const paymentId = crypto.randomUUID();
    await client.query(
      `INSERT INTO payments (id, tenant_id, branch_id, appointment_id, client_id, shift_id, direction, status, total_minor, created_by, posted_at)
       VALUES ($1,$2,$3,$4,$5,$6,'in','posted',$7,$8,$9)`,
      [paymentId, tenant, branch, id, clientIds[clientName], shiftId, price, users.admin, ends.toISOString()],
    );
    await client.query(
      `INSERT INTO payment_lines (id, tenant_id, payment_id, line_type, title, amount_minor)
       VALUES ($1,$2,$3,'service',$4,$5)`,
      [crypto.randomUUID(), tenant, paymentId, title, price],
    );
    await client.query(
      "INSERT INTO payment_tenders (id, tenant_id, payment_id, method, amount_minor) VALUES ($1,$2,$3,'card',$4)",
      [crypto.randomUUID(), tenant, paymentId, price],
    );
  }
}

const todayPlan = [
  ["alina", "Анна Смирнова", "manicure", "Маникюр + гель-лак", 10, 0, 90, "scheduled", "admin"],
  ["alina", "Ксения Орлова", "removal", "Снятие + укрепление", 12, 0, 60, "confirmed", "admin"],
  ["alina", "Виктория Павлова", "manicure", "Маникюр с дизайном", 13, 0, 90, "in_progress", "online"],
  ["alina", "Юлия Морозова", "gel", "Коррекция покрытия", 17, 0, 60, "scheduled", "admin"],
  ["alina", "Ольга Белова", "gel", "Покрытие гель-лак", 18, 0, 60, "scheduled", "admin"],
  ["marina", "Мария Кузнецова", "brows", "Коррекция бровей", 10, 30, 60, "arrived", "admin"],
  ["marina", "Полина Зайцева", "lashes", "Ламинирование ресниц", 12, 0, 90, "scheduled", "admin"],
  ["marina", "Дарья Фёдорова", "brows", "Окрашивание бровей", 14, 30, 60, "scheduled", "online"],
  ["marina", "Алёна Егорова", "brows", "Брови «под ключ»", 16, 0, 90, "scheduled", "admin"],
  ["denis", "Игорь Петров", "hair", "Мужская стрижка", 10, 0, 60, "scheduled", "admin"],
  ["denis", "Артём Новиков", "beard", "Стрижка + борода", 11, 0, 60, "scheduled", "admin"],
  ["denis", "Максим Ильин", "beard", "Оформление бороды", 12, 30, 45, "scheduled", "admin"],
  ["denis", "Сергей Лебедев", "hair", "Мужская стрижка", 14, 0, 60, "scheduled", "online"],
  ["denis", "Никита Попов", "hair", "Стрижка машинкой", 15, 0, 60, "scheduled", "admin"],
  ["denis", "Роман Козлов", "color", "Камуфляж седины", 16, 30, 90, "scheduled", "admin"],
  ["denis", "Олег Семёнов", "beard", "Стрижка + борода", 18, 30, 60, "scheduled", "admin"],
  ["elena", "Татьяна Волкова", "massage", "Классический массаж", 11, 0, 90, "scheduled", "admin"],
  ["elena", "Наталья Соловьёва", "spa", "SPA-программа", 14, 0, 120, "confirmed", "admin"],
  ["elena", "Ирина Васильева", "back", "Массаж спины", 17, 0, 60, "scheduled", "admin"],
];

for (const [person, clientName, serviceKey, title, hour, minute, duration, status, source] of todayPlan) {
  await book({ person, clientName, serviceKey, title, iso: today, hour, minute, duration, status, source, pay: false });
}

const historyPool = [...named.filter((name) => !fresh.has(name)), ...repeatExtras];
let visit = 0;
let poolCursor = 0;
for (let offset = 1; offset <= 40; offset += 1) {
  const iso = shiftDate(today, -offset);
  for (const person of ["alina", "marina", "denis", "elena"]) {
    let minuteOfDay = 10 * 60;
    const menu = links[person];
    while (minuteOfDay < 19 * 60) {
      const serviceKey = menu[visit % menu.length];
      const duration = services[serviceKey][1];
      if (minuteOfDay + duration > 20 * 60) break;
      const clientName = historyPool[poolCursor % historyPool.length];
      poolCursor += 1;
      let title = services[serviceKey][0];
      if (serviceKey === "brows") title = "Брови «под ключ»";
      if (serviceKey === "manicure" && visit % 6 === 0) title = "Маникюр с дизайном";
      const noShow = offset <= 30 ? visit % 45 === 0 : visit % 14 === 0;
      await book({
        person,
        clientName,
        serviceKey,
        title,
        iso,
        hour: Math.floor(minuteOfDay / 60),
        minute: minuteOfDay % 60,
        duration,
        status: noShow ? "no_show" : "completed",
        source: "admin",
        pay: !noShow,
      });
      visit += 1;
      minuteOfDay += duration + 30;
    }
  }
}

for (let index = 0; index < dormantNames.length; index += 1) {
  const person = ["alina", "marina", "denis", "elena"][index % 4];
  const serviceKey = links[person][0];
  await book({
    person,
    clientName: dormantNames[index],
    serviceKey,
    title: services[serviceKey][0],
    iso: shiftDate(today, -70 - index),
    hour: 11,
    minute: 0,
    duration: services[serviceKey][1],
    status: "completed",
    source: "admin",
    pay: true,
  });
}

await client.query("COMMIT");
await client.end();
console.log(`Seeded Am Beauty for ${today}. Login olga@ambeauty.local / ambeauty`);
