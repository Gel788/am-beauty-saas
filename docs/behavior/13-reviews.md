# Поведение: отзывы

**ID prefix:** `REV-`  
**Фаза:** P3  
**YC parity:** сбор/модерация/выгрузка отзывов онлайн-записи  
**Дизайн:** moderation queue, спокойные звёзды — parity-matrix §8

---

## 1. Сущности

### Review
| Поле | |
|---|---|
| tenant_id, branch_id | |
| appointment_id \| null | |
| client_id, staff_id \| null | |
| rating | 1–5 |
| body | text ≤2000 |
| status | `pending` \| `published` \| `hidden` \| `rejected` |
| source | `invite` \| `widget` \| `manual` |
| created_at, moderated_by, moderated_at | |

---

## 2. Permissions

Request/auto: system.  
Moderate: admin/owner.  
Public read published: anyone on widget.  
Master: see own published + pending about self (no moderate).

---

## 3. Сценарии

### REV-REQUEST-01 · Запрос отзыва
- Trigger: appointment completed + delay T (default 2h).  
- MSG review_request with signed link token.  
- One active request per appointment.

### REV-CREATE-01 · Клиент оставляет отзыв
- Token or auth ЛК.  
- rating required; body optional.  
- status=`pending` if moderation_required else `published`.  
- Duplicate for appointment — hard.

### REV-MOD-01 · Модерация
- Queue pending: Publish / Hide / Reject+reason.  
- Audit.

### REV-SHOW-01 · Виджет / карточка мастера
- Aggregate avg rating + count (published only).  
- List latest N texts if enabled.

### REV-EXPORT-01
- CSV period; export audit.

### REV-DELETE-01
- Soft hide; hard delete owner only.

---

## 4. Edge cases

1. Appointment cancelled after request — invalidate token.  
2. Staff changed on appointment — review still linked original staff_id snapshot.  
3. Fake spam: rate limit per phone/IP.

---

## 5. Чеклист

- [ ] Request → create → moderate → show  
- [ ] Aggregates  
- [ ] Export  

---

## 6. Реализовано (этап 6)

- **REV-REQUEST-01:** задача `POST /api/jobs/retention` (раз в 5 минут в prod-compose) отправляет шаблон `review_request` через `review_delay_hours` (по умолчанию 2 ч) после окончания визита, не позже 3 дней, не в тихие часы, один раз на визит (`appointments.review_requested_at`, уникальный индекс `outbound_one_review`). Ссылка `/r/<токен>`, в базе только sha256.
- **REV-CREATE-01:** страница `/r/<токен>`: звёзды 1–5 и текст до 2000 символов. Повтор по тому же визиту — отказ. Визит, отменённый после запроса, отзыв не принимает. Оценка ≤ 3 сразу приходит в уведомления салона («Низкая оценка»).
- **REV-MOD-01:** «Удержание» → «Отзывы»: Опубликовать / Скрыть / Отклонить (с причиной), публичный ответ салона. Без модерации (`review_moderation = false`) отзыв публикуется сразу. Всё в аудите.
- **REV-SHOW-01:** рейтинг мастера (только опубликованные) показывается в виджете онлайн-записи рядом с именем; `GET /api/public/b/:t/:b/reviews` отдаёт рейтинги и последние тексты (имя автора — только первое слово).
- **REV-EXPORT-01:** CSV за период, запись `report.exported` в аудите.
- **REV-DELETE-01:** удалить отзыв может только владелец.
- Мастер видит свои опубликованные и ожидающие отзывы («Мои отзывы»), без модерации.
