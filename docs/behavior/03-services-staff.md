# Поведение: услуги, мастера, расписание

**ID prefix:** `SVC-` / `STF-` / `SCH-`  
**Фаза:** P1 базово; рабочие места / сложные графики P2

---

## 1. Услуги

### Сущность Service
- category_id, title, duration_min (кратна 5), price_minor, color, online_visible, active, sort  
- staff_ids[] — кто оказывает  
- buffer_after_min optional  
- resources[] P2 (кресло)

### SVC-CREATE-01 / SVC-EDIT-01
- Валидация duration ≥ 5, price ≥ 0.  
- Деактивация (`active=false`): скрыть из новых записей; старые snapshot title/price остаются.

### SVC-DELETE-01
- Soft: active=false предпочтительнее hard.  
- Hard только без исторических lines или owner+archive.

### SVC-ORDER-01
- Drag reorder в категории.

### SVC-STAFF-LINK-01
- Назначение мастеров; если снять последнего мастера с услуги — soft-warn.  
- Запись на мастера без услуги в его list → hard (см. timetable).

---

## 2. Мастера (Staff)

### Сущность
- user_id optional (если есть логин), display_name, color, specialties, active, branch_ids[]  
- payroll default rule link  
- online_bookable

### STF-CREATE-01
- Создать профиль ± invite user.  
- Seat биллинга: если нет свободных seats — block + upgrade CTA (P4).

### STF-DEACTIVATE-01
- active=false: будущие записи → modal reassign/cancel.  
- Не удалять историю.

### STF-PERMISSIONS-01
- Роль membership отдельно от staff profile (admin может не быть мастером).

---

## 3. Расписание

### SCH-WEEK-01 · Недельный шаблон
- Для staff+branch: intervals per weekday [{start_local, end_local}].  
- Breaks внутри дня.  
- Копировать неделю → следующая.

### SCH-EXCEPTION-01 · Исключения
- Дата: выходной / особые часы / отпуск range.  
- При создании записи вне часов — soft-warn (timetable).

### SCH-VIEW-01 · В журнале
- Колонка мастера без смены в день: скрыта default; toggle «Показать без смены».  
- Серые зоны вне working hours — не hard disable click (admin may book).

### SCH-CONFLICT-01
- Два интервала overlap в шаблоне — validation error.

---

## 4. Permissions

| | owner | admin | master |
|---|---|---|---|
| CRUD услуги | ✓ | ✓ | ✗ |
| CRUD staff | ✓ | ✓ | ✗ |
| Свой график edit | ✓ | ✓ | request-only P3 |
| Чужой график | ✓ | ✓ | ✗ |

---

## 5. Edge cases

1. Смена duration услуги не ресайзит прошлые appointments.  
2. Цена изменилась — новые записи берут новую; draft drawer показывает «цена прайса».  
3. Мастер в двух филиалах — график per branch; конфликт филиалов hard в timetable.  
4. Удаление категории с услугами — запрет или move.

---

## 6. Чеклист

- [ ] Услуги CRUD + link staff  
- [ ] Деактивация без потери истории  
- [ ] Недельный график + exceptions  
- [ ] Журнал уважает часы (soft)  
