# Поведение: аналитика, коммуникации, сеть, платформа

**ID prefix:** `AN-` / `MSG-` / `NET-` / `PLAT-`  
**Фазы:** аналитика база P2; коммуникации P2–P4; сеть/платформа P4

---

## 1. Аналитика

### AN-DAY-01 · Отчёт дня
- Выручка posted payments (не путать с суммой прайса).  
- Разбивка: услуги / товары / tips.  
- Записи: создано / completed / cancelled / no_show.  
- Загрузка: occupied_min / available_min по staff.  
- Drill-down в список платежей/записей.

### AN-RANGE-01 · Период
- Фильтры: branch, staff, service, source (admin/online).  
- Сравнение с предыдущим периодом.

### AN-RFM-01 (P4)
- Сегменты клиентов; списки под рассылку.

### AN-EXPORT-01
- CSV; audit who exported.

**Permissions:** owner/admin/accountant; master — только self stats.

---

## 2. Коммуникации

### MSG-TEMPLATE-01
- Шаблоны: reminder, confirm, cancel, review.  
- Variables: {name} {date} {time} {branch} {service}.

### MSG-AUTO-01 · Напоминание
- Job: за N hours до starts_at; status in scheduled/confirmed.  
- Skip если already reminded / cancelled.  
- Channel order: Telegram → WhatsApp → SMS → push (fallback list per tenant).  
- Log OutboundMessage status delivered/failed.

### MSG-MANUAL-01
- Из карточки клиента/записи — send now.

### MSG-BROADCAST-01 (P3)
- Сегмент → async queue; unsubscribe / consent check.

**Edge:** не слать в тихие часы (22–09 local) — отложить.

---

## 3. Сеть (мультифилиал)

### NET-BRANCH-01 · CRUD филиала
- TZ, адрес, телефон, schedule defaults.  
- Клиентская база: `shared` \| `per_branch` (default shared в tenant).

### NET-SWITCH-01
- Переключатель филиала в shell; журнал не смешивает appointments разных branch.

### NET-DASH-01 · Owner dashboard
- Сравнение филиалов: revenue, load, no_show rate.  
- Click → branch journal/analytics.

### NET-STAFF-MULTI-01
- Staff на нескольких branch; график per branch; нельзя две записи в разном branch в одно время (hard).

---

## 4. Платформа SaaS

### PLAT-TENANT-01 · Signup
- Создать tenant + first branch + owner user.  
- Trial dates.

### PLAT-BILLING-01
- Seats count = active staff with login OR all staff (настройка тарифа).  
- Exceed seats → block STF-CREATE / soft read-only.  
- Invoice / card charge P4.

### PLAT-SUPER-01
- Список tenants, suspend, feature flags, impersonate with audit banner.

### PLAT-MIGRATE-01
- Import CSV clients/services/staff; YClients API import epic отдельным чеклистом.

---

## 5. Витрина привлечения (P4 sketch)

### VIT-01
- Публичный каталог салонов opted-in.  
- Карточка → online booking.  
- Ranking: distance / free slots / rating.  
- Комиссия platform optional на completed online from showcase.

---

## 6. Чеклист

- [ ] Day/range reports match cash  
- [ ] Reminder job + quiet hours  
- [ ] Branch isolation  
- [ ] Seats billing gate  
- [ ] Impersonate audited  
