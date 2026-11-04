import bcrypt from "bcryptjs";
import pg from "pg";
import { seedRetention, seedTechCard } from "./seed-retention.mjs";

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
await client.query("INSERT INTO tenants (id, name, slug, trial_ends_at) VALUES ($1, 'Am Beauty', 'am-beauty', now() + interval '9 days')", [tenant]);
// Insert the filled primary branch first so listBranches / UI default (branches[0]) is never empty.
await client.query(
  `INSERT INTO branches (id, tenant_id, name, address, timezone, require_payment_on_complete, slug,
     fiscal_enabled, fiscal_inn, fiscal_place, acquiring_enabled, created_at)
   VALUES ($1, $2, 'Am Beauty · Садовая', 'Садовая, 14', 'Europe/Moscow', true, 'sadovaya', true, '770123456789', 'г. Москва, ул. Садовая, 14', true, now() - interval '1 second')`,
  [branch, tenant],
);
await client.query(
  `INSERT INTO branches (id, tenant_id, name, address, timezone, require_payment_on_complete, slug,
     fiscal_enabled, fiscal_inn, fiscal_place, acquiring_enabled)
   VALUES ($1, $2, 'Am Beauty · Патриаршие', 'Патриаршие пруды', 'Europe/Moscow', true, 'patriarshie', false, '', '', false)`,
  [branch2, tenant],
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
  for (const staffBranch of [branch, branch2]) {
    await client.query("INSERT INTO staff_branches (staff_id, branch_id, tenant_id) VALUES ($1, $2, $3)", [id, staffBranch, tenant]);
    for (let weekday = 1; weekday <= 7; weekday += 1) {
      await client.query(
        `INSERT INTO schedule_templates (id, tenant_id, branch_id, staff_id, weekday, start_min, end_min, kind)
         VALUES ($1, $2, $3, $4, $5, 600, 1200, 'work')`,
        [crypto.randomUUID(), tenant, staffBranch, id, weekday],
      );
    }
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

const clients = [
  ["Анна Смирнова", "+79001110001"],
  ["Ксения Орлова", "+79001110002"],
  ["Виктория Павлова", "+79001110003"],
  ["Юлия Морозова", "+79001110004"],
  ["Ольга Белова", "+79001110005"],
  ["Мария Кузнецова", "+79001110006"],
  ["Полина Зайцева", "+79001110007"],
  ["Дарья Фёдорова", "+79001110008"],
  ["Алёна Егорова", "+79001110009"],
  ["Игорь Петров", "+79001110010"],
  ["Артём Новиков", "+79001110011"],
  ["Максим Ильин", "+79001110012"],
  ["Сергей Лебедев", "+79001110013"],
  ["Никита Попов", "+79001110014"],
  ["Роман Козлов", "+79001110015"],
  ["Олег Семёнов", "+79001110016"],
  ["Татьяна Волкова", "+79001110017"],
  ["Наталья Соловьёва", "+79001110018"],
  ["Ирина Васильева", "+79001110019"],
  ["Юлия Новикова", "+79001110020"],
  ["Елена Васильева", "+79001110021"],
  ["Ольга Новикова", "+79001110022"],
  ["Сергей Козлов", "+79001110023"],
  ["Марина Гусева", "+79001110024"],
  ["Дина Абрамова", "+79001110025"],
];
const clientIds = {};
for (const [name, phone] of clients) {
  const id = crypto.randomUUID();
  clientIds[name] = id;
  await client.query("INSERT INTO clients (id, tenant_id, name, source) VALUES ($1, $2, $3, 'walk-in')", [id, tenant, name]);
  await client.query(
    "INSERT INTO client_phones (id, tenant_id, client_id, phone_e164, is_primary) VALUES ($1, $2, $3, $4, true)",
    [crypto.randomUUID(), tenant, id, phone],
  );
}

const plan = [
  ["alina", "Анна Смирнова", "manicure", 10, 0, "scheduled"],
  ["alina", "Ксения Орлова", "removal", 12, 0, "confirmed"],
  ["alina", "Виктория Павлова", "gel", 13, 30, "in_progress"],
  ["alina", "Юлия Морозова", "brows", 17, 0, "scheduled"],
  ["alina", "Ольга Белова", "gel", 18, 0, "scheduled"],
  ["marina", "Мария Кузнецова", "brows", 10, 30, "arrived"],
  ["marina", "Полина Зайцева", "lashes", 12, 0, "scheduled"],
  ["marina", "Дарья Фёдорова", "brows", 14, 30, "scheduled"],
  ["marina", "Алёна Егорова", "lashes", 16, 0, "scheduled"],
  ["denis", "Игорь Петров", "hair", 10, 0, "completed"],
  ["denis", "Артём Новиков", "beard", 11, 0, "scheduled"],
  ["denis", "Максим Ильин", "hair", 12, 30, "scheduled"],
  ["denis", "Сергей Лебедев", "hair", 14, 0, "scheduled"],
  ["denis", "Никита Попов", "beard", 15, 0, "scheduled"],
  ["denis", "Роман Козлов", "color", 16, 30, "scheduled"],
  ["denis", "Олег Семёнов", "beard", 18, 30, "scheduled"],
  ["elena", "Татьяна Волкова", "massage", 11, 0, "scheduled"],
  ["elena", "Наталья Соловьёва", "spa", 14, 0, "confirmed"],
  ["elena", "Ирина Васильева", "back", 17, 0, "scheduled"],
];

// Юлия booked brows but Alina does not offer brows. Use gel instead.
plan[3][2] = "gel";

let paidAppointment = null;
for (const [person, clientName, serviceKey, hour, minute, status] of plan) {
  const service = services[serviceKey];
  const starts = at(hour, minute);
  const ends = new Date(starts.getTime() + service[1] * 60000);
  const id = crypto.randomUUID();
  if (status === "completed") paidAppointment = { id, price: service[2], clientId: clientIds[clientName] };
  await client.query(
    `INSERT INTO appointments (
      id, tenant_id, branch_id, staff_id, client_id, starts_at, ends_at, branch_tz, tz_offset_min,
      status, source, color, created_by, updated_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,'Europe/Moscow',180,$8,'admin',$9,$10,$10)`,
    [id, tenant, branch, staff[person], clientIds[clientName], starts.toISOString(), ends.toISOString(), status, service[3], users.admin],
  );
  await client.query(
    `INSERT INTO appointment_services (id, tenant_id, appointment_id, service_id, title_snapshot, duration_min, price_minor, position)
     VALUES ($1,$2,$3,$4,$5,$6,$7,0)`,
    [crypto.randomUUID(), tenant, id, serviceIds[serviceKey], service[0], service[1], service[2]],
  );
}

const shiftId = crypto.randomUUID();
await client.query(
  `INSERT INTO cash_shifts (id, tenant_id, branch_id, opened_by, opening_cash_minor, status, note)
   VALUES ($1, $2, $3, $4, 1000000, 'open', 'утро')`,
  [shiftId, tenant, branch, users.admin],
);
if (paidAppointment) {
  const paymentId = crypto.randomUUID();
  await client.query(
    `INSERT INTO payments (id, tenant_id, branch_id, appointment_id, client_id, shift_id, direction, status, total_minor, created_by, posted_at)
     VALUES ($1,$2,$3,$4,$5,$6,'in','posted',$7,$8, now())`,
    [paymentId, tenant, branch, paidAppointment.id, paidAppointment.clientId, shiftId, paidAppointment.price, users.admin],
  );
  await client.query(
    `INSERT INTO payment_lines (id, tenant_id, payment_id, line_type, title, amount_minor)
     VALUES ($1,$2,$3,'service','Мужская стрижка',$4)`,
    [crypto.randomUUID(), tenant, paymentId, paidAppointment.price],
  );
  await client.query(
    "INSERT INTO payment_tenders (id, tenant_id, payment_id, method, amount_minor) VALUES ($1,$2,$3,'card',$4)",
    [crypto.randomUUID(), tenant, paymentId, paidAppointment.price],
  );
}

await seedRetention(client, { tenant, branch, staff, serviceIds, services, clientIds, adminId: users.admin, today });
await seedTechCard(client, { tenant, staff, clientIds, userIds: users });

// TZ §10–12 demo: rooms linked to services, two custom fields, group classes with a waitlist.
const rooms = {
  massage: [crypto.randomUUID(), "Массажный кабинет", "room", 1, "#d9f3e4", ["massage", "spa", "back"]],
  brows: [crypto.randomUUID(), "Кабинет бровей и ресниц", "room", 1, "#f8e7c4", ["brows", "lashes"]],
  hall: [crypto.randomUUID(), "Зал для мастер-классов", "room", 1, "#ffe3ef", []],
};
let roomPos = 0;
for (const [id, title, kind, capacity, color, serviceKeys] of Object.values(rooms)) {
  await client.query(
    "INSERT INTO resources (id, tenant_id, branch_id, kind, title, color, capacity, open_min, close_min, position) VALUES ($1,$2,$3,$4,$5,$6,$7,540,1260,$8)",
    [id, tenant, branch, kind, title, color, capacity, roomPos++],
  );
  for (const key of serviceKeys) {
    await client.query("INSERT INTO service_resources (tenant_id, service_id, resource_id) VALUES ($1,$2,$3)", [tenant, serviceIds[key], id]);
  }
}
// Today's appointments for linked services already sit in their rooms.
await client.query(
  `INSERT INTO appointment_resources (tenant_id, appointment_id, resource_id)
   SELECT a.tenant_id, a.id, sr.resource_id FROM appointments a
   JOIN appointment_services s ON s.appointment_id = a.id
   JOIN service_resources sr ON sr.service_id = s.service_id
   WHERE a.tenant_id = $1 ON CONFLICT DO NOTHING`,
  [tenant],
);
await client.query(
  `INSERT INTO custom_fields (id, tenant_id, entity, key, label, type, options, required, show_in_online, show_in_journal, position) VALUES
   ($1,$4,'client','skin_type','Тип кожи','select','{Сухая,Нормальная,Жирная,Комбинированная}',false,true,false,0),
   ($2,$4,'client','allergies','Аллергии','text','{}',false,false,false,1),
   ($3,$4,'appointment','occasion','Повод','select','{Свадьба,Фотосессия,Праздник}',false,false,true,0)`,
  [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), tenant],
);
await client.query("UPDATE clients SET custom = '{\"skin_type\":\"Сухая\",\"allergies\":\"лидокаин\"}' WHERE id = $1", [clientIds["Анна Смирнова"]]);
function dayAt(offset, hours, minutes) {
  return new Date(at(hours, minutes).getTime() + offset * 86400000);
}
const groupPlan = [
  ["Мастер-класс: уход за руками дома", "Покажем базовый уход, подбор масел и кремов. Материалы включены.", staff.marina, 0, 19, 0, 90, 8, 150000, ["Анна Смирнова", "Ксения Орлова", "Юлия Морозова"], []],
  ["Йога для лица", "Упражнения для тонуса и лимфодренажа. Возьмите удобную одежду.", staff.elena, 2, 19, 0, 60, 4, 120000, ["Мария Кузнецова", "Полина Зайцева", "Дарья Фёдорова", "Алёна Егорова"], ["Ольга Белова"]],
  ["Макияж на каждый день", "Мини-группа, 3 часа практики на себе.", staff.marina, 5, 12, 0, 180, 6, 350000, ["Виктория Павлова"], []],
];
for (const [title, description, host, offset, hours, minutes, duration, capacity, price, enrolled, waitlisted] of groupPlan) {
  const id = crypto.randomUUID();
  const starts = dayAt(offset, hours, minutes);
  await client.query(
    `INSERT INTO group_events (id, tenant_id, branch_id, title, description, staff_id, resource_id, starts_at, ends_at, capacity, price_minor, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, tenant, branch, title, description, host, rooms.hall[0], starts.toISOString(), new Date(starts.getTime() + duration * 60000).toISOString(), capacity, price, users.admin],
  );
  for (const [list, status] of [[enrolled, "enrolled"], [waitlisted, "waitlisted"]]) {
    for (const name of list) {
      await client.query("INSERT INTO group_participants (id, tenant_id, event_id, client_id, status) VALUES ($1,$2,$3,$4,$5)", [crypto.randomUUID(), tenant, id, clientIds[name], status]);
    }
  }
}

// Stage: bonus tiers and lifetime, SPA asks for a deposit online, hosts are paid per attendee.
await client.query(
  `UPDATE tenants SET bonus_enabled = true, bonus_expire_days = 180,
     loyalty_tiers = '[{"title":"Серебро","minSpendMinor":0,"earnBps":300},{"title":"Золото","minSpendMinor":3000000,"earnBps":500},{"title":"Платина","minSpendMinor":8000000,"earnBps":700}]'::jsonb
   WHERE id = $1`,
  [tenant],
);
await client.query("UPDATE services SET online_deposit_minor = 100000 WHERE id = $1", [serviceIds.spa]);
await client.query("UPDATE group_events SET host_pay_mode = 'per_attendee', host_pay_minor = 50000 WHERE tenant_id = $1", [tenant]);

// OB-SRC-01: part of the visits came through the salon's booking links.
await client.query(
  `WITH picked AS (
     SELECT a.id, a.client_id, (ARRAY['yandex','yandex','2gis','instagram','site'])[1 + (row_number() OVER (ORDER BY a.starts_at) % 5)::int] AS channel
     FROM appointments a WHERE a.tenant_id = $1 AND a.client_id IS NOT NULL ORDER BY a.starts_at LIMIT 10
   ), upd AS (
     UPDATE appointments a SET source = 'online', channel = p.channel FROM picked p WHERE a.id = p.id RETURNING a.client_id, p.channel
   )
   UPDATE clients c SET source = 'online', channel = u.channel FROM upd u WHERE c.id = u.client_id`,
  [tenant],
);
// Phase 4 · NET demo: three branches with a month of paid visits, so «Сеть салонов» has something to compare.
const branch3 = "44444444-4444-4444-8444-444444444444";
await client.query(
  `INSERT INTO branches (id, tenant_id, name, address, phone, timezone, require_payment_on_complete, slug)
   VALUES ($1, $2, 'Am Beauty · Хамовники', 'Комсомольский проспект, 21', '+7 495 120-44-21', 'Europe/Moscow', true, 'khamovniki')`,
  [branch3, tenant],
);
await client.query("UPDATE branches SET phone = '+7 495 120-14-14' WHERE id = $1", [branch]);
await client.query("UPDATE branches SET phone = '+7 495 120-30-30' WHERE id = $1", [branch2]);
const netStaff = [
  [branch2, "Софья Миронова", "#f2a7c3", ["manicure", "gel", "removal"]],
  [branch2, "Кира Алексеева", "#b9a6f0", ["brows", "lashes"]],
  [branch2, "Глеб Тихонов", "#93b8f2", ["hair", "beard", "color"]],
  [branch3, "Вера Громова", "#9fd9bf", ["massage", "spa", "back"]],
  [branch3, "Лиза Карпова", "#f4b5cf", ["manicure", "gel"]],
];
const people = { [branch]: Object.entries(links).map(([person, keys]) => [staff[person], keys]), [branch2]: [], [branch3]: [] };
for (const [where, name, color, keys] of netStaff) {
  const id = crypto.randomUUID();
  await client.query("INSERT INTO staff (id, tenant_id, display_name, color) VALUES ($1, $2, $3, $4)", [id, tenant, name, color]);
  await client.query("INSERT INTO staff_branches (staff_id, branch_id, tenant_id) VALUES ($1, $2, $3)", [id, where, tenant]);
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    await client.query(
      `INSERT INTO schedule_templates (id, tenant_id, branch_id, staff_id, weekday, start_min, end_min, kind) VALUES ($1, $2, $3, $4, $5, 600, 1200, 'work')`,
      [crypto.randomUUID(), tenant, where, id, weekday],
    );
  }
  for (const key of keys) await client.query("INSERT INTO service_staff (service_id, staff_id, tenant_id) VALUES ($1, $2, $3)", [serviceIds[key], id, tenant]);
  people[where].push([id, keys]);
}
let seedState = 7;
const rand = (n) => { seedState = (seedState * 1103515245 + 12345) % 2147483648; return seedState % n; };
const clientList = Object.values(clientIds);
const netAt = (offset, hours, minutes) => { const base = at(hours, minutes); return new Date(base.getTime() + offset * 86400000); };
const netShifts = {};
for (const where of [branch2, branch3]) {
  netShifts[where] = crypto.randomUUID();
  await client.query(
    `INSERT INTO cash_shifts (id, tenant_id, branch_id, opened_by, opening_cash_minor, status, note) VALUES ($1, $2, $3, $4, 500000, 'open', 'утро')`,
    [netShifts[where], tenant, where, users.olga],
  );
}
netShifts[branch] = shiftId;
const busy = { [branch]: 3, [branch2]: 2, [branch3]: 2 };
const misses = { [branch]: 12, [branch2]: 25, [branch3]: 8 };
for (let offset = -59; offset <= -1; offset += 1) {
  for (const where of [branch, branch2, branch3]) {
    for (const [staffId, keys] of people[where]) {
      let hour = 10 + rand(2);
      const visits = busy[where] + rand(3) + (where === branch3 && offset > -30 ? 1 : 0) - (where === branch2 && offset > -30 && rand(3) === 0 ? 1 : 0);
      for (let n = 0; n < visits && hour < 19; n += 1) {
        const key = keys[rand(keys.length)];
        const service = services[key];
        const starts = netAt(offset, hour, rand(2) * 30);
        const ends = new Date(starts.getTime() + service[1] * 60000);
        hour += Math.ceil(service[1] / 60) + rand(2);
        const missed = rand(100) < misses[where];
        const id = crypto.randomUUID();
        const clientId = clientList[rand(clientList.length)];
        const online = rand(3) === 0;
        await client.query(
          `INSERT INTO appointments (id, tenant_id, branch_id, staff_id, client_id, starts_at, ends_at, branch_tz, tz_offset_min, status, source, color, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'Europe/Moscow',180,$8,$9,$10,$11,$11)`,
          [id, tenant, where, staffId, clientId, starts.toISOString(), ends.toISOString(), missed ? "no_show" : "completed", online ? "online" : "admin", service[3], users.admin],
        );
        await client.query(
          `INSERT INTO appointment_services (id, tenant_id, appointment_id, service_id, title_snapshot, duration_min, price_minor, position) VALUES ($1,$2,$3,$4,$5,$6,$7,0)`,
          [crypto.randomUUID(), tenant, id, serviceIds[key], service[0], service[1], service[2]],
        );
        if (missed) continue;
        const paymentId = crypto.randomUUID();
        await client.query(
          `INSERT INTO payments (id, tenant_id, branch_id, appointment_id, client_id, shift_id, direction, status, total_minor, created_by, posted_at)
           VALUES ($1,$2,$3,$4,$5,$6,'in','posted',$7,$8,$9)`,
          [paymentId, tenant, where, id, clientId, netShifts[where], service[2], users.admin, ends.toISOString()],
        );
        await client.query(`INSERT INTO payment_lines (id, tenant_id, payment_id, line_type, title, amount_minor) VALUES ($1,$2,$3,'service',$4,$5)`, [crypto.randomUUID(), tenant, paymentId, service[0], service[2]]);
        await client.query("INSERT INTO payment_tenders (id, tenant_id, payment_id, method, amount_minor) VALUES ($1,$2,$3,'card',$4)", [crypto.randomUUID(), tenant, paymentId, service[2]]);
      }
    }
  }
}
// PLAT-CABINET: a few more salons on the platform so the platform owner's cabinet has something to show.
// PLAT-CABINET-05: the platform owner signs in apart from any salon (PLATFORM_ADMIN_EMAILS=platform@ambeauty.local).
await client.query("INSERT INTO users (id, email, password_hash, name) VALUES ($1, 'platform@ambeauty.local', $2, 'Владелец платформы')", [crypto.randomUUID(), hash]);
const demoSalons = [
  { n: 1, name: "Studio Lumière", plan: "salon", months: 6, agoDays: 200, paidMonths: [190, 10], activityDays: 0, staff: 7, branches: 1 },
  { n: 2, name: "Nail Bar «Кокос»", plan: "start", months: 1, agoDays: 120, paidMonths: [110, 80, 50, 20], activityDays: 1, staff: 3, branches: 1 },
  { n: 3, name: "Сеть «Барбершоп 17»", plan: "network", months: 12, agoDays: 300, paidMonths: [290], activityDays: 0, staff: 26, branches: 4 },
  { n: 4, name: "Brow Lab", plan: "start", months: 1, agoDays: 75, paidMonths: [64, 33], activityDays: 19, staff: 2, branches: 1, ended: true },
  { n: 5, name: "Салон «Мята»", plan: "trial", agoDays: 12, paidMonths: [], activityDays: 2, staff: 4, branches: 1 },
  { n: 6, name: "Beauty Loft", plan: "trial", agoDays: 6, paidMonths: [], activityDays: 0, staff: 5, branches: 1 },
  { n: 7, name: "SPA «Лотос»", plan: "salon", months: 1, agoDays: 160, paidMonths: [150, 120, 90, 60, 31], activityDays: 3, staff: 9, branches: 2, pending: true },
  { n: 8, name: "Lash & Go", plan: "start", months: 1, agoDays: 95, paidMonths: [85, 55], activityDays: 40, staff: 2, branches: 1, suspended: "Долг за 2 месяца" },
];
const demoId = (n, kind) => `d${kind}${String(n).padStart(6, "0")}-0000-4000-8000-00000000000${n}`;
await client.query("DELETE FROM tenants WHERE id::text LIKE 'd0%' OR id::text LIKE 'd1%'");
await client.query("DELETE FROM users WHERE email LIKE '%@demo-salon.local'");
await client.query("DELETE FROM platform_tasks WHERE created_by = 'demo'");
await client.query("DELETE FROM platform_actions WHERE actor_email = 'demo'");
const priceOf = { start: 149000, salon: 349000, network: 799000 };
const discountOf = { 1: 1, 6: 0.9, 12: 0.8 };
for (const item of demoSalons) {
  const id = demoId(item.n, "0");
  const branchId = demoId(item.n, "1");
  const ownerId = crypto.randomUUID();
  const created = new Date(Date.now() - item.agoDays * 86400000);
  const lastPaid = item.paidMonths.at(-1);
  const paidUntil = lastPaid === undefined ? null : new Date(Date.now() + (item.months * 30 - lastPaid) * 86400000 - (item.ended ? 6 * 86400000 : 0));
  await client.query(
    `INSERT INTO tenants (id, name, slug, plan, trial_ends_at, paid_until, suspended_at, suspended_reason, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, item.name, `demo-${item.n}`, item.plan, new Date(created.getTime() + 14 * 86400000), paidUntil, item.suspended ? new Date(Date.now() - 5 * 86400000) : null, item.suspended ?? "", created],
  );
  for (let b = 0; b < item.branches; b += 1) {
    await client.query("INSERT INTO branches (id, tenant_id, name, slug, created_at) VALUES ($1, $2, $3, $4, $5)", [b === 0 ? branchId : crypto.randomUUID(), id, b === 0 ? item.name : `${item.name} · ${b + 1}`, `demo-${item.n}-${b}`, created]);
  }
  await client.query("INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, $3, $4)", [ownerId, `owner${item.n}@demo-salon.local`, hash, `Владелец ${item.n}`]);
  await client.query("INSERT INTO memberships (id, tenant_id, user_id, role, created_at) VALUES ($1, $2, $3, 'owner', $4)", [crypto.randomUUID(), id, ownerId, created]);
  for (let s = 0; s < item.staff; s += 1) {
    await client.query("INSERT INTO staff (id, tenant_id, display_name) VALUES ($1, $2, $3)", [crypto.randomUUID(), id, `Мастер ${s + 1}`]);
  }
  let number = 0;
  for (const ago of item.paidMonths) {
    number += 1;
    const at = new Date(Date.now() - ago * 86400000);
    await client.query(
      `INSERT INTO saas_invoices (id, tenant_id, number, plan, months, amount_minor, status, provider, created_at, paid_at, period_from, period_to)
       VALUES ($1, $2, $3, $4, $5, $6, 'paid', 'yookassa', $7, $7, $7, $8)`,
      [crypto.randomUUID(), id, number, item.plan, item.months, Math.round(priceOf[item.plan] * item.months * discountOf[item.months]), at, new Date(at.getTime() + item.months * 30 * 86400000)],
    );
  }
  if (item.pending) {
    await client.query(
      "INSERT INTO saas_invoices (id, tenant_id, number, plan, months, amount_minor, status, provider, created_at) VALUES ($1, $2, $3, 'salon', 6, $4, 'pending', 'yookassa', now() - interval '1 day')",
      [crypto.randomUUID(), id, number + 1, Math.round(349000 * 6 * 0.9)],
    );
  }
  await client.query(
    "INSERT INTO audit_log (id, tenant_id, branch_id, actor_id, entity, action, created_at) VALUES ($1, $2, $3, $4, 'appointment', 'appointment.created', $5)",
    [crypto.randomUUID(), id, branchId, ownerId, new Date(Date.now() - item.activityDays * 86400000 - 3600000)],
  );
}
const task = (n, title, dueDays) => client.query(
  "INSERT INTO platform_tasks (id, tenant_id, title, due_on, created_by) VALUES ($1, $2, $3, (now() + make_interval(days => $4))::date, 'demo')",
  [crypto.randomUUID(), n ? demoId(n, "0") : null, title, dueDays],
);
await task(4, "Позвонить: подписка закончилась, узнать почему не продлили", -1);
await task(5, "Пробный кончается — показать зарплаты и склад, предложить «Салон»", 1);
await task(7, "Счёт на 6 месяцев выставлен, проверить оплату", 2);
await task(3, "Сеть просит выгрузку по API в 1С — обсудить", 5);
await task(0, "Подключить боевую ЮKassa платформы", 7);
await client.query("INSERT INTO platform_actions (id, tenant_id, actor_email, action, created_at) VALUES ($1, $2, 'demo', 'olga@ambeauty.local: приостановлен', now() - interval '5 days')", [crypto.randomUUID(), demoId(8, "0")]);

await client.query("COMMIT");
await client.end();
console.log(`Seeded Am Beauty for ${today}. Login olga@ambeauty.local / ambeauty`);
