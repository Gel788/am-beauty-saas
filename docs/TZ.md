# ТЗ: Salon CRM SaaS (индекс + продукт)

**Версия:** 2.0 (поведенческое)  
**Дата:** 2026-11-03  
**Статус:** на утверждение  
**Важно:** детальное поведение — в `docs/behavior/*`. Этот файл — продукт, рынок, домен, фазы, индекс. Каркас v1 без behavior **отменён**.

---

## 1. Продукт

Мультитенантный SaaS для салонов/сетей: операционный контур **не уже YClients**, дизайн **сильнее класса**.

| Цель | Как измеряем |
|---|---|
| Макс. функционал | Закрыты behavior-чеклисты модулей P1–P4 |
| Сильный дизайн | `design-direction.md` quality gate на каждой фазе |
| Реализуемость | Поставка фазами; scope ТЗ не режется |

**Запрещено:** логин в YClients для копирования; пиксель-клон; «модуль из 4 буллетов» без behavior.

---

## 2. Рынок (кратко)

- **YClients** — floor по полноте и IA журнала  
- **DIKIDI** — витрина/простота входа  
- **Altegio** — все модули в тарифе, мультифилиал  
Позиция: полный контур + лучший product UI + тариф без доплаты за склад/ЗП.

---

## 3. Индекс поведенческих спецификаций

| Файл | Содержание | Глубина |
|---|---|---|
| [behavior/00-conventions.md](behavior/00-conventions.md) | Формат сценариев, статусы записи, ошибки, аудит | стандарт |
| [behavior/01-timetable.md](behavior/01-timetable.md) | Журнал: create/edit/cancel, **drag/resize**, конфликты, статусы | **максимум** |
| [behavior/02-clients.md](behavior/02-clients.md) | Клиенты CRUD, merge, долг, история | высокая |
| [behavior/03-services-staff.md](behavior/03-services-staff.md) | Услуги, мастера, расписание | высокая |
| [behavior/04-cash-shifts.md](behavior/04-cash-shifts.md) | Оплаты, долг, **открытие/закрытие смен**, возвраты | **максимум** |
| [behavior/05-payroll.md](behavior/05-payroll.md) | **Зарплаты:** схемы, период, approve/pay, clawback | **максимум** |
| [behavior/06-inventory.md](behavior/06-inventory.md) | Склад, автосписание | высокая |
| [behavior/07-loyalty.md](behavior/07-loyalty.md) | Бонусы, абонементы, сертификаты | высокая |
| [behavior/08-online-booking.md](behavior/08-online-booking.md) | Виджет, SlotHold, race, отмена | высокая |
| [behavior/09-analytics-comms-network.md](behavior/09-analytics-comms-network.md) | Отчёты, MSG, сеть, billing платформы | высокая |
| [behavior/10-resources.md](behavior/10-resources.md) | Кабинеты/аппараты | высокая |
| [behavior/11-group-events.md](behavior/11-group-events.md) | Групповые события | высокая |
| [behavior/12-custom-fields.md](behavior/12-custom-fields.md) | Кастом-поля | высокая |
| [behavior/13-reviews.md](behavior/13-reviews.md) | Отзывы | высокая |
| [yclients-parity-matrix.md](yclients-parity-matrix.md) | Полный каталог YClients → паритет + дизайн | обязателен |
| [design-direction.md](design-direction.md) | UI + состояния DnD/смен | обязателен |

Если сценария нет в behavior — его нет в продукте.  
Интеграции (ККМ, площадки, телефония) — ADAPTER в parity-matrix, не ядро MVP.

---

## 4. Роли

`super` · `owner` · `admin` · `master` · `accountant` · `client`  
Матрицы прав — внутри каждого behavior-файла.

---

## 5. Домен (карта)

```
Tenant → Branch → Staff / Service / Client
                → Appointment → Payment → CashShift
                → StockMovement ← ServiceConsumable
                → PayrollRule / PayrollPeriod / PayrollItem
                → Loyalty* / OutboundMessage
```

Изоляция: `tenant_id` + RLS. Деньги — integer minor units. Время — UTC + TZ филиала.

---

## 6. Стек

Next.js App Router · TypeScript · Postgres + RLS · Auth · jobs для MSG · S3-files · VPS deploy.

---

## 7. Фазы

| Фаза | Scope | Behavior must-pass |
|---|---|---|
| **0** | Эти docs | апрув |
| **1 MVP** | Auth, tenant, branch, services, staff, clients, journal CRUD+статусы, pay без полной смены | 01 (без DnD ok?), 02, 03, PAY-CREATE базово |
| **1b** | DnD + resize + shift open/close | 01 drag, 04 shifts |
| **2** | Online booking, roles master, schedule, day report, 1 channel reminder | 08, SCH, AN-DAY, MSG-AUTO |
| **3** | Inventory, loyalty, payroll full | 05, 06, 07 |
| **4** | Network, SaaS billing, API, showcase | 09 NET/PLAT |

**Уточнение P1:** в MVP-коде журнал обязан иметь create/edit/cancel/statuses; **drag обязателен до приёмки фазы 1b** (нельзя звать MVP «как YClients» без DnD). Рекомендация: делать DnD сразу в P1, если хватает времени спринта.

---

## 8. NFR

См. v1 кратко: журнал плотного дня p95 UI; API p95; WCAG AA critical path; audit чувствительных действий; design gate.

---

## 9. Апрув

| Артефакт | Статус |
|---|---|
| Behavior пакет `00`–`09` | ☐ |
| Design direction | ☐ |
| Этот индекс | ☐ |

После апрува — scaffold + реализация по behavior ID (тесты на сценарии `TT-*`, `SHIFT-*`, `PAYROLL-*`).
