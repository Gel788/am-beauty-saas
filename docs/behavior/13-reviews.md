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
