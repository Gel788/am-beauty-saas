# Поведение: ресурсы (кабинеты, аппараты)

**ID prefix:** `RES-`  
**Фаза:** P2  
**YC parity:** занятость кабинетов/аппаратов в журнале  
**Дизайн:** view toggle «Мастера | Кабинеты» — см. `yclients-parity-matrix.md` §1.R

---

## 1. Сущности

### Resource
| Поле | |
|---|---|
| id, tenant_id, branch_id | |
| type | `room` \| `equipment` \| `other` |
| title, color, capacity | capacity default 1 |
| active | |

### ServiceResource
- service_id, resource_id, required bool (default true)

### AppointmentResource
- appointment_id, resource_id (snapshot на время визита)

---

## 2. Permissions

CRUD resources: owner/admin.  
Master: read.  
Conflict checks: server-side на любой Save/drag.

---

## 3. Сценарии

### RES-CRUD-01 · Создание ресурса
- Title обяз.; type; capacity ≥1.  
- Deactivate: future appointments keep snapshot; нельзя назначить новым.

### RES-LINK-01 · Услуга требует ресурс
- В карточке услуги multi-select resources.  
- При Save appointment: автоподбор свободного resource из required set; если несколько — admin выбирает; если none free → `CONFLICT_RESOURCE`.

### RES-BOOK-01 · Занятие на интервале
- Инвариант: для capacity=1 нет overlapping non-cancelled appointments на том же resource.  
- capacity>1: count concurrent < capacity.

### RES-VIEW-01 · Журнал по ресурсам
- Toggle viewMode=`staff`|`resource`.  
- Columns = active resources with bookings that day (or all with schedule).  
- Drag между resource columns = смена AppointmentResource (+ optional staff unchanged).  
- Invalid drop → danger preview.

### RES-DRAG-STAFF-01
- Drag в staff view не обязан менять resource; если услуга requires resource и новый time занят — hard/soft как conflict policy.

### RES-SCHEDULE-01
- Resource может иметь working hours (кабинет доступен 10–22).  
- Booking вне часов — soft-warn.

---

## 4. Edge cases

1. Услуга требует 2 resources (room+device) — оба должны быть free.  
2. Смена услуги в drawer → пересчёт required resources.  
3. Resource deleted while booked — forbid; deactivate only.  
4. Parallel tabs STALE on resource assignment.

---

## 5. Чеклист

- [x] Conflict hard capacity  
- [x] Auto-assign + manual override  
- [ ] Resource timetable view + drag (вид «Кабинеты» есть, перетаскивание пока только в виде «Мастера»)  
- [x] Service link

**Реализация:** `db/migrations/016_resources_groups_fields.sql`, `src/server/resources.ts` (planResources: свободный ресурс каждого нужного вида, CONFLICT_RESOURCE → 409, RESOURCE_HOURS — предупреждение), онлайн-слоты учитывают кабинеты, групповое занятие занимает зал целиком. UI: «Настройки → Кабинеты и аппараты», выбор кабинета в карточке записи, переключатель «Мастера | Кабинеты» в журнале. Тесты: `tests/tz10-12.test.ts`.
