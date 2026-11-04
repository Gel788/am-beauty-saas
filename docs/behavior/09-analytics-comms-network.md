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

### AN-RANGE-01 Отчёт за период (сделано)
- Вкладка «Период» в отчётах: любой диапазон до 366 дней, сравнение с предыдущим таким же периодом (изменение в %).
- Выручка, средний чек, визиты, новые клиенты, отмены и неявки, ряд по дням, мастера (услуги, чаевые, загрузка), топ услуг, источники записей.
- Мастер видит только свои показатели («Мои показатели»).

### AN-EXPORT-01 Выгрузка CSV (сделано)
- `GET /api/reports/period.csv`: UTF-8 с BOM, разделитель `;` (открывается в Excel). Каждая выгрузка пишется в аудит `report.exported`.

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

### Реализовано (этап 3, без внешнего провайдера по умолчанию)
- **Каналы:** `telegram` (один бот платформы, вебхук `/api/webhooks/telegram`), `sms` (SMS.ru при `SMS_RU_API_KEY`), `log`. Порядок задаёт владелец (`tenants.message_channels`); сообщение уходит первым каналом, который может достучаться до клиента, остальные — запасные. Каждая попытка пишется в `outbound_messages`.
- **MSG-TEMPLATE-01:** ключи `reminder`, `booking_created`, `booking_cancelled`, `pay_link`; подстановки `{имя} {салон} {адрес} {когда} {услуги} {мастер} {сумма} {ссылка}`. Неизвестная подстановка — ошибка. Пустой текст или стандартный возвращают шаблон по умолчанию.
- **MSG-TG-LINK-01:** клиент (или сотрудник) открывает `t.me/<бот>?start=<токен>`; токен одноразовый, живёт 7 дней, выбирает салон. `/stop` отвязывает чат.
- **MSG-CONFIRM-01/02:** в напоминании своя ссылка управления (`reminder_token_hash`) и, в Telegram, кнопки «Подтверждаю» / «Отменить». Кнопка работает только из чата, привязанного к клиенту этой записи. Подтвердить можно запись в статусе `scheduled`, не позже часа после начала; повтор отвечает «уже подтверждён». Отмена — по правилам онлайн-отмены (OB-CANCEL-01).
- **MSG-MANUAL-01:** из карточки клиента (админ и выше), до 1000 символов.
- **MSG-PAY-01:** при создании ссылки на оплату галочка «отправить клиенту» шлёт шаблон `pay_link` с кнопкой «Оплатить».
- **MSG-DESK-01:** уведомления для администраторов: онлайн-запись, подтверждение, отмена или просьба отменить, оплата по ссылке (и проблемная оплата), непробитый чек, запрос мастера по графику. Видны в колокольчике (фильтр по филиалу сотрудника) и дублируются в Telegram сотрудникам, подключившим бота.
- **MSG-CONSENT-01 (152-ФЗ, 38-ФЗ):** онлайн-запись требует согласие на обработку ПД; согласие на акции — отдельная необязательная галочка. В карточке клиента согласия можно отметить или отозвать (отзыв ПД снимает и маркетинговое). Политика `/b/<салон>/<филиал>/privacy` берёт реквизиты оператора из настроек владельца.


---

### MSG-RETAIN-01 Возврат клиентов (сделано, этап 6)
- У услуги задаётся «повтор через N дней» (маникюр 21, брови 28, стрижка 35 по умолчанию).
- «Удержание» → «Пора вернуть»: клиенты, у которых срок подошёл (или подойдёт за 7 дней) и нет будущей записи; звонок или «Напомнить» (шаблон `rebook`).
- Автоматически (`rebook_enabled`): напоминание в день срока, один раз после визита. Поздравление с днём рождения (`birthday_enabled`), раз в год.
- И то, и другое — только с согласием на рассылки (38-ФЗ) и не в тихие часы. Новые подстановки: `{дней}`.

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
