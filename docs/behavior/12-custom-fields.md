# Поведение: кастомные поля

**ID prefix:** `CF-`  
**Фаза:** P2  
**YC parity:** доп. поля клиента и записи (§42)  
**Дизайн:** после системных полей, muted labels — parity-matrix §2.F

---

## 1. Сущности

### CustomFieldDefinition
| Поле | |
|---|---|
| tenant_id | |
| entity | `client` \| `appointment` \| `service` (P3) |
| key | slug unique per tenant+entity |
| label | |
| type | `text` \| `textarea` \| `number` \| `select` \| `multiselect` \| `date` \| `bool` |
| options[] | for select |
| required | bool |
| show_in_online | bool (appointment/client on booking) |
| show_in_journal_block | bool (short value on block — max 1 field) |
| sort | int |
| active | |

### CustomFieldValue
- entity_id, field_id, value_json

---

## 2. Permissions

Define fields: owner/admin.  
Fill values: who can edit parent entity.  
Online: only show_in_online.

---

## 3. Сценарии

### CF-DEF-01 · Создать поле
- Validate key slug `[a-z0-9_]`.  
- Select requires ≥1 option.  
- Limit: max 30 fields per entity (performance).

### CF-DEF-02 · Деактивация
- Hide from forms; values retained; exclude from online.

### CF-VAL-01 · Сохранение с родителем
- Appointment/Client Save validates required custom fields.  
- Type coercion: number finite; date ISO; select in options.

### CF-FILTER-01
- Client list / appointment export filter by field value.

### CF-ONLINE-01
- Booking step 3 shows ≤3 online fields; required blocks submit.

### CF-JOURNAL-01
- If show_in_journal_block — one line muted under service name (truncate).

### CF-EXPORT-01
- CSV columns `cf_{key}`.

---

## 4. Edge cases

1. Delete option in use — soft keep value, show «устаревшее».  
2. Change type of field — forbid if values exist; clone new field instead.  
3. Multi-branch: definitions tenant-wide.

---

## 5. Чеклист

- [ ] CRUD definitions  
- [ ] Validation on Save  
- [ ] Online subset  
- [ ] Filter/export  
