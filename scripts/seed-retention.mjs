/**
 * Demo data for stage 6 (retention): past visits that are due again, reviews, a waitlist and
 * a cancelled slot somebody is waiting for. Called from seed.mjs inside its transaction.
 */
export async function seedRetention(client, { tenant, branch, staff, serviceIds, services, clientIds, adminId, today }) {
  const day = (offset) => {
    const [y, m, d] = today.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
  };
  const moscow = (date, hours, minutes = 0) => {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d, hours - 3, minutes));
  };
  async function visit(person, clientName, serviceKey, date, hours, status, extra = {}) {
    const service = services[serviceKey];
    const id = crypto.randomUUID();
    const starts = moscow(date, hours);
    const ends = new Date(starts.getTime() + service[1] * 60000);
    await client.query(
      `INSERT INTO appointments (id, tenant_id, branch_id, staff_id, client_id, starts_at, ends_at, branch_tz, tz_offset_min, status, source, color, cancel_reason, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Europe/Moscow',180,$8,'admin',$9,$10,$11,$11)`,
      [id, tenant, branch, staff[person], clientIds[clientName], starts.toISOString(), ends.toISOString(), status, service[3], extra.cancelReason ?? null, adminId],
    );
    await client.query(
      `INSERT INTO appointment_services (id, tenant_id, appointment_id, service_id, title_snapshot, duration_min, price_minor, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0)`,
      [crypto.randomUUID(), tenant, id, serviceIds[serviceKey], service[0], service[1], service[2]],
    );
    return id;
  }

  // "Come back in N days" per service.
  const rebook = { manicure: 21, removal: 21, gel: 21, brows: 28, lashes: 28, hair: 35, beard: 35, color: 42 };
  for (const [key, days] of Object.entries(rebook)) await client.query("UPDATE services SET rebook_days = $2 WHERE id = $1", [serviceIds[key], days]);

  // Marketing consent for part of the base, so "Напомнить" is available for them.
  for (const name of ["Юлия Новикова", "Елена Васильева", "Ольга Новикова", "Марина Гусева"]) {
    if (clientIds[name]) await client.query("UPDATE clients SET consent_marketing = true, consent_marketing_at = now() WHERE id = $1", [clientIds[name]]);
  }

  // Due for a return visit: last manicure 3–5 weeks ago, nothing booked since.
  await visit("alina", "Юлия Новикова", "manicure", day(-26), 12, "completed");
  await visit("alina", "Елена Васильева", "manicure", day(-23), 15, "completed");
  await visit("marina", "Ольга Новикова", "brows", day(-30), 11, "completed");
  await visit("denis", "Сергей Козлов", "hair", day(-40), 18, "completed");
  await visit("marina", "Марина Гусева", "lashes", day(-25), 13, "completed");
  await visit("alina", "Дина Абрамова", "manicure", day(-17), 10, "completed");
  // Two no-shows: online booking will ask her to call.
  await visit("alina", "Дина Абрамова", "manicure", day(-50), 10, "no_show");
  await visit("alina", "Дина Абрамова", "manicure", day(-12), 10, "no_show");

  // Reviews: some published, two waiting for moderation, one low score.
  const reviews = [
    ["alina", "Юлия Новикова", "manicure", -26, 5, "Алина — волшебница! Покрытие держится третью неделю, ни одного скола.", "published", "Спасибо, Юлия! Ждём вас снова 💅"],
    ["marina", "Ольга Новикова", "brows", -30, 5, "Брови идеальные, Марина очень внимательная.", "published", ""],
    ["alina", "Елена Васильева", "manicure", -23, 4, "Всё понравилось, но пришлось подождать 10 минут.", "published", ""],
    ["denis", "Сергей Козлов", "hair", -40, 5, "Лучший барбер в районе.", "published", ""],
    ["marina", "Марина Гусева", "lashes", -25, 5, "Ресницы как в рекламе! Приду ещё.", "pending", ""],
    ["alina", "Дина Абрамова", "manicure", -17, 3, "Мастер хороший, но администратор перепутала время записи.", "pending", ""],
  ];
  for (const [person, name, serviceKey, offset, rating, body, status, reply] of reviews) {
    const appointment = (await client.query(
      "SELECT id FROM appointments WHERE client_id = $1 AND staff_id = $2 AND status = 'completed' AND starts_at::date = $3::date LIMIT 1",
      [clientIds[name], staff[person], day(offset)],
    )).rows[0];
    await client.query(
      `INSERT INTO reviews (id, tenant_id, branch_id, appointment_id, client_id, staff_id, rating, body, status, source, reply, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'invite',$10,$11)`,
      [crypto.randomUUID(), tenant, branch, appointment?.id ?? null, clientIds[name], staff[person], rating, body, status, reply, moscow(day(offset), 16).toISOString()],
    );
    if (appointment) await client.query("UPDATE appointments SET review_requested_at = $2 WHERE id = $1", [appointment.id, moscow(day(offset), 15).toISOString()]);
  }

  // Waitlist: two clients want Alina this week; tomorrow 15:00 was just cancelled.
  await visit("alina", "Наталья Соловьёва", "manicure", day(1), 15, "cancelled", { cancelReason: "Заболела" });
  const waiting = [
    ["Ирина Васильева", "manicure", "alina", day(0), day(4), 14 * 60, 19 * 60, "После работы"],
    ["Полина Зайцева", "manicure", null, day(1), day(2), 10 * 60, 18 * 60, ""],
    ["Анна Смирнова", "brows", "marina", day(3), day(7), 600, 1260, "Хочет к Марине"],
  ];
  for (const [name, serviceKey, person, from, to, startMin, endMin, note] of waiting) {
    await client.query(
      `INSERT INTO waitlist_entries (id, tenant_id, branch_id, client_id, service_id, staff_id, date_from, date_to, time_from_min, time_to_min, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [crypto.randomUUID(), tenant, branch, clientIds[name], serviceIds[serviceKey], person ? staff[person] : null, from, to, startMin, endMin, note, adminId],
    );
  }
}
