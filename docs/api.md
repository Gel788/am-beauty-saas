# API v1 Am Beauty CRM

Справочник для разработчиков открыт без входа: `/developers` (`src/app/developers/page.tsx`). Здесь кратко то же самое и устройство изнутри.

## Ключи (API-KEY-01, API-KEY-02)
- Ключи выдаёт владелец: «Настройки → API и вебхуки».
  - Вид ключа: `ab_live_` и 32 hex-символа. Показывается один раз.
  - В базе хранится только sha256 (`api_keys.key_hash`). Найти салон по хешу можно только через `api_key_lookup()` (SECURITY DEFINER).
- Права: `read` (только GET) или `write`. Ключ может быть ограничен одним филиалом.
- Запросы по ключу идут от роли «администратор». Пользователем записывается тот, кто выдал ключ, с именем «API: <название>». RLS работает как обычно.
- Лимит: 120 запросов в минуту на ключ, в памяти одного экземпляра сервера. При превышении ответ `RATE_LIMITED` (429).

## Методы
| | Путь | Права |
|---|---|---|
| GET | `/api/v1/branches` | read |
| GET | `/api/v1/services` | read |
| GET | `/api/v1/staff` | read |
| GET | `/api/v1/slots?branchId&serviceId&staffId&from&days` | read |
| GET | `/api/v1/clients?phone=&q=&updatedSince=&limit=` | read |
| GET | `/api/v1/clients/{id}` | read |
| POST | `/api/v1/clients` | write |
| GET | `/api/v1/appointments?from&to` или `?updatedSince` (+ branchId, staffId, clientId, status, limit) | read |
| GET | `/api/v1/appointments/{id}` | read |
| POST | `/api/v1/appointments` | write |
| POST | `/api/v1/appointments/{id}/cancel` | write |

- Форма ответа: `{ data, nextUpdatedSince? }`, ошибка: `{ error: { code, message, details } }`.
- Деньги передаются в копейках, время — в ISO 8601.
- Запись создаётся через тот же `createAppointment`, что у администратора, с `source = 'api'`.

## Вебхуки (API-HOOK-01)
- Источник событий — `audit()`. Доставка ставится в очередь `webhook_deliveries` в той же транзакции, поэтому откатившееся изменение ничего не отправит.
- В теле только идентификаторы, без персональных данных: `{ id, event, occurredAt, data: { <entity>Id, branchId, action } }`.
- Подпись: заголовок `X-AmBeauty-Signature: sha256=<HMAC-SHA256(секрет, тело)>`. Секрет `whsec_…` показывается один раз и хранится зашифрованным (`INTEGRATIONS_KEY`).
- Когда отправляем:
  - сразу после изменения через API;
  - по cron `POST /api/jobs/webhooks` с заголовком `x-jobs-token`.
- Повторы через 1, 5, 30, 120 и 360 минут, после этого доставка помечается `failed`.
- Адреса из внутренней сети (localhost, 10/8, 192.168/16, 169.254/16 и т. п.) не принимаются. В продакшене нужен https.
