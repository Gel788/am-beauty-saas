# Поведение: журнал записи (Timetable)

**ID prefix:** `TT-`  
**Фазы:** ядро P1; DnD/resize/неделя — P1–P2 как отмечено  
**Связи:** клиенты, услуги, мастера, касса/смены, лояльность, ЗП, склад

---

## 1. Объект Appointment

| Поле | Тип | Обязательность |
|---|---|---|
| id | uuid | да |
| tenant_id, branch_id | uuid | да |
| staff_id | uuid | да |
| client_id | uuid \| null | null только пока «бронь без клиента» (разрешено ≤ N мин или до Save — см. TT-CREATE) |
| starts_at, ends_at | timestamptz | да; ends > starts; длительность ≥ шага сетки |
| status | enum | да |
| services[] | {service_id, duration_min, price_minor, staff_id?} | ≥1 при Save |
| comment | text | нет |
| source | `admin` \| `online` \| `api` \| `master` | да |
| color | derived from first service | — |
| version | int | optimistic concurrency |
| paid_total_minor | derived | — |
| created_by, updated_by | uuid | да |

**Инвариант:** на одного `staff_id` не пересекаются интервалы записей в статусах ≠ `cancelled` (hard), кроме явного soft-override с правом `admin+` и причиной.

---

## 2. Permissions

| Действие | owner | admin | master | accountant |
|---|---|---|---|---|
| Смотреть журнал филиала | ✓ | ✓ | свой столбец / свой день* | ✗ / read-only выручка* |
| Создать запись | ✓ | ✓ | ✓ (на себя, если включено) | ✗ |
| Редактировать чужую | ✓ | ✓ | ✗ | ✗ |
| Drag/resize | ✓ | ✓ | только свои, если флаг | ✗ |
| Отменить | ✓ | ✓ | свои future, если флаг | ✗ |
| Hard-delete | ✓ | ✗ | ✗ | ✗ |
| Статусы arrived→completed | ✓ | ✓ | свои | ✗ |
| no_show | ✓ | ✓ | ограничено | ✗ |
| Soft-override конфликта | ✓ | ✓ | ✗ | ✗ |

\* настройки филиала: `master_sees_all_columns` default false.

---

## 3. State machine статусов

Разрешённые переходы:

| Из | В | Кто | Условие |
|---|---|---|---|
| scheduled | confirmed | admin/owner/system | — |
| scheduled/confirmed | arrived | admin/owner/master | starts_at − now ≤ 4h (настраиваемо) или admin override |
| arrived | in_progress | admin/owner/master | — |
| in_progress | completed | admin/owner/master | — |
| scheduled/confirmed | cancelled | см. permissions | причина обязательна если < 24h или online |
| arrived/in_progress | cancelled | admin/owner | confirm + причина |
| scheduled/confirmed | no_show | admin/owner | now ≥ starts_at + grace (default 15m) |
| completed | scheduled | **запрещено** | только новая запись |
| cancelled/no_show | * | restore → scheduled | admin+, если слот свободен |

Оплата не двигает статус автоматически. Рекомендация UI: при `completed` без оплаты — badge «не оплачено».

---

## 4. Сетка и навигация

### TT-VIEW-01 · Открытие журнала дня
- **Актёр:** admin/owner/master  
- **Предусловия:** выбран филиал; дата = сегодня default  
- **Триггер:** вход в app / nav «Журнал»  
- **Шаги:**  
  1. Загрузка staff колонок (работают в этот день по графику + явно «показать выходных» toggle).  
  2. Загрузка appointments за локальный день филиала.  
  3. Рендер: time gutter слева, колонки staff, блоки по starts/ends.  
- **Результат:** интерактивная сетка.  
- **Loading:** skeleton колонок; не пустой empty.  
- **Empty:** нет мастеров на день → EmptyState «Нет смен» + CTA «Расписание».

### TT-VIEW-02 · Смена даты
- Prev/Next day, date picker, «Сегодня».  
- URL sync: `?date=YYYY-MM-DD&branch=`.  
- При смене — abort in-flight fetch, новый load.

### TT-VIEW-03 · Фильтр мастеров
- Chips: все / выбранные.  
- Скрытые колонки не участвуют в hit-test drag.

### TT-VIEW-04 · Неделя (P2)
- Строки = мастера или дни — зафиксировать UI: **колонки = дни, группы по мастеру** tab.  
- DnD между днями = смена starts_at date.

---

## 5. Создание записи

### TT-CREATE-01 · Клик по пустой ячейке
- **Триггер:** click на свободный слот (staff × time).  
- **Шаги:**  
  1. Открыть `RecordDrawer` в режиме create.  
  2. Prefill: `staff_id`, `starts_at` = snap(click), `ends_at` = starts + default service duration (если услуга ещё не выбрана — +30m placeholder, не сохранять без услуги).  
  3. Фокус: поиск клиента.  
  4. Пользователь выбирает клиента (или «Новый клиент» inline).  
  5. Добавляет ≥1 услугу → пересчёт `ends_at` = starts + sum(durations) с учётом порядка.  
  6. Comment optional.  
  7. **Сохранить**.  
- **Валидации Save:** клиент обязателен; ≥1 услуга; нет hard-конфликта; staff работает в интервале (soft-warn если вне графика); услуга привязана к staff (hard если не в list).  
- **Результат:** блок на сетке; drawer остаётся на edit или закрывается (настройка; default **закрыть**).  
- **Аудит:** `appointment.created`.

### TT-CREATE-02 · Кнопка «+ Запись»
- Без prefill staff/time → пользователь выбирает в форме.  
- Остальное = TT-CREATE-01.

### TT-CREATE-03 · Новый клиент inline
- Поля: имя (обяз.), телефон (обяз., нормализация E.164 RU), comment.  
- Создаёт Client, затем подставляет в запись.  
- Дубликат телефона → предложить существующего (не молча создать второго).

### TT-CREATE-04 · Keyboard (P1 базовый)
- `N` — новая запись.  
- `Esc` — закрыть drawer (если dirty → confirm «Сбросить?»).  
- `/` — фокус поиск клиента в top bar.

### TT-CREATE-05 · Отмена черновика
- Close drawer с dirty → modal «Выйти без сохранения?».  
- Ничего не пишется в БД.

---

## 6. Редактирование

### TT-EDIT-01 · Открытие карточки
- Click по блоку → drawer edit, load by id + version.  
- Параллельное изменение другим админом → при Save `STALE` → «Запись изменена. Обновить?» (reload vs overwrite только с правом owner).

### TT-EDIT-02 · Изменение полей
- Меняются: клиент, услуги, staff, starts/ends, comment, status.  
- Смена услуг → пересчёт длительности и цены (цена фиксируется snapshot на позиции; флаг «обновить цену из прайса»).  
- Save → audit `appointment.updated` с diff.

### TT-EDIT-03 · Запрет редактирования
- `completed` + есть фискальный чек (P3): услуги/сумма locked; comment/status limited.  
- `cancelled`: только restore или просмотр.

---

## 7. Удаление / отмена

### TT-CANCEL-01 · Отмена записи
- Действие «Отменить» (не «Удалить»).  
- Modal: причина (select + text), уведомлять клиента? (P2).  
- Результат: status=`cancelled`, блок пропадает из сетки (toggle «Показать отменённые» — ghost стиль).  
- Если была предоплата — поток возврата в кассе (ссылка на CASH-REFUND).  
- Аудит: `appointment.cancelled`.

### TT-DELETE-01 · Hard-delete
- Только `owner`.  
- Доступно если cancelled/no_show **или** test-tenant.  
- Confirm «Безвозвратно».  
- Недоступно при связанных платежах (сначала reverse).

### TT-RESTORE-01 · Восстановление
- Из отменённых → scheduled, если слот свободен; иначе предложить ближайший свободный.

---

## 8. Drag and Drop

### TT-DRAG-01 · Перенос по времени (вертикаль)
- **Предусловия:** право drag; статус не cancelled/completed (completed — запрет; in_progress — soft-warn).  
- **Шаги:**  
  1. Pointer down на блок > 150ms → drag mode (отличие от click).  
  2. Ghost полупрозрачный; оригинал dimmed.  
  3. Snap preview к сетке 5m; duration сохраняется.  
  4. Drop на валид → optimistic move → API `PATCH starts_at/ends_at`.  
  5. Invalid (выход за границы дня / конфликт hard) → snap-back + toast.  
- **Аудит:** `appointment.moved` {from, to}.

### TT-DRAG-02 · Смена мастера (горизонталь)
- Drop в другую колонку → смена `staff_id`.  
- Проверка: услуга доступна у нового мастера (hard).  
- Вне графика нового — soft-warn confirm.

### TT-DRAG-03 · Dual-axis
- Одновременно время + мастер. Правила = сумма TT-DRAG-01/02.

### TT-DRAG-04 · Конфликт при drop
- **Hard:** пересечение с non-cancelled → нельзя drop.  
- **Soft (admin+):** modal «Пересекается с записью X. Всё равно?» + reason → создаёт overlap flag `force_overlap=true` (отчёт «аномалии»).

### TT-DRAG-05 · Drag отменён / Esc
- Esc или drop outside → snap-back, без API.

### TT-DRAG-06 · Concurrent
- Если version stale на drop → rollback + toast STALE.

---

## 9. Resize длительности

### TT-RESIZE-01 · Тянем нижний край
- Меняет `ends_at` (не starts).  
- Min duration = min(service step, 5m).  
- Max: до конфликта / конец рабочего дня (soft).  
- Если несколько услуг — resize меняет **буфер** или пропорционально? **Решение:** resize меняет только `ends_at`; сумма duration услуг остаётся; появляется `buffer_min` или последняя услуга абсорбирует delta с confirm.  
- **Зафиксировано:** delta добавляется к последней услуге в списке (duration_min += delta); цена не пересчитывается автоматически.

### TT-RESIZE-02 · Тянем верхний край (P2)
- Меняет `starts_at`, ends фиксирован или duration фиксирован — **duration фиксирован** (сдвиг окна).

---

## 10. Статусы из UI

### TT-STATUS-01 · Быстрые действия на блоке
- Context menu / hover actions: Пришёл · В работе · Завершить · Неявка · Отменить.  
- Невалидный переход → disabled + tooltip почему.

### TT-STATUS-02 · Завершение
- `in_progress` → `completed`.  
- Если настройка `require_payment_on_complete` — открыть блок оплаты (не блокировать статус, но показать CTA).  
- Триггер ЗП-начисления: событие `appointment.completed` (см. payroll).  
- Триггер складского списания: P3.

### TT-STATUS-03 · Неявка
- `no_show`; опционально штраф/списание предоплаты (настройка филиала).

---

## 11. Мультиуслуги и длительность

- Порядок услуг в drawer = порядок оказания.  
- `ends_at = starts_at + sum(duration_min)`.  
- Смена порядка — drag list в drawer (не путать с DnD сетки).  
- Удаление услуги из списка: если остаётся 0 — нельзя Save.

---

## 12. Отображение блока на сетке

Минимум:
- Имя клиента (или «Без имени» — не должно после Save)  
- Первая услуга (+N)  
- Индикатор статуса (цвет полоски)  
- Индикатор неоплаты  
- Иконка online source  

Высота блока ∝ duration.  
Overflow text: ellipsis; полный текст в drawer.

---

## 13. Конфликты и график

| Ситуация | Тип | Поведение |
|---|---|---|
| Overlap same staff | hard | нельзя Save/drop |
| Вне working hours | soft | confirm |
| Услуга не у мастера | hard | нельзя |
| Staff на другой филиал в это время | hard | нельзя |
| Double booking force | soft+reason | admin+ |

---

## 14. Поиск и фокус

### TT-SEARCH-01
- Top search: клиент по имени/телефону → список ближайших записей → click открывает день + drawer.

---

## 15. Связи с другими модулями

| Событие | Эффект |
|---|---|
| Save create/update | — |
| completed | payroll accrual candidate; inventory consume P3 |
| cancelled с оплатой | cash refund flow |
| payment posted | badge оплачено; кассовая смена |
| client merge | appointments переезжают |

---

## 16. Edge cases (обязательные тесты)

1. Запись через полночь → запрет P1 (ends same local day) или split P4. **P1: запрет.**  
2. Смена TZ филиала — старые appointments хранят snapshot offset.  
3. Удаление мастера с будущими записями — reassign flow, не silent.  
4. Две вкладки браузера — version / STALE.  
5. Drag на скрытую фильтром колонку — нельзя.  
6. Master drag чужой записи — FORBIDDEN.  
7. Создание при закрытой кассовой смене — см. `SHIFT_REQUIRED` policy в cash doc.  
8. 50 мастеров × 200 записей — virtualize columns/blocks (NFR).

---

## 17. Добивка паритета YClients (журнал)

### TT-PREV-CLIENT-01 · Подсказка «Предыдущий клиент»
- Chip под поиском в create drawer.  
- Источник: последний completed/arrived клиент этого staff сегодня; fallback — последний созданный в филиале.  
- Click → подставить client_id.

### TT-GUEST-01 · Гость от имени клиента
- Поля: `client_id` (гость) + `booked_by_client_id` (плательщик/контакт).  
- История визитов гостя отдельная.  
- Уведомления: default на booked_by; toggle «слать гостю» если телефон есть.  
- Badge на блоке «Гость».

### TT-VISIT-MERGE-01 · Объединение записей дня в визит (P2)
- Несколько appointments одного client_id в одном local day.  
- Action «Объединить»: общий `visit_id`, общая оплата возможна одним payment на visit.  
- UI: визуальная скобка; drawer siblings list.  
- Unmerge: снять visit_id если нет общего posted payment (иначе сначала split payment).

### TT-AUDIT-UI-01 · История изменений в drawer
- Tab «История»: записи audit entity=appointment.  
- Показ: время, актор, поле, old→new.

### TT-COMPACT-01 · Compact / comfortable
- User preference; row height и font size блока.  
- Default comfortable desktop, compact если >12 columns.

### TT-EXPORT-01 · Выгрузка записей
- CSV по фильтру даты/staff/status; audit export log.

### TT-SERVICE-CLIENT-PARAMS-01 (P2)
- Override duration/price на позиции для клиента (сохранить как client preference optional).

### TT-VIEW-04 Неделя и месяц (сделано)
- Переключатель День / Неделя / Месяц. Неделя: 7 колонок, карточки визитов по времени, загрузка дня в %, сумма по прайсу.
- Месяц: сетка с числом записей и загрузкой (цветовая шкала). Клик по дню открывает дневной журнал.
- Фильтр по мастеру; мастер видит только свои записи. Максимум 42 дня за запрос (`GET /api/journal/calendar`).

### TT-VIEW-05 «Мой день» мастера (сделано)
- Экран `/me` для роли master, рассчитан на телефон: записи дня, заметки клиента (аллергии), отметка «первый визит», телефон, кнопка «Клиент пришёл».
- Итог дня: клиенты, оплачено услуг, чаевые; список ближайших дней с записями (`GET /api/me/day`).

### TT-WAIT-01 Лист ожидания (сделано, этап 6)
- Клиент, которому не нашлось времени: услуга и мастер (или «любой»), период дат, удобное время дня, комментарий.
- Отмена будущей записи (администратором или клиентом онлайн) сверяется с листом: если кто-то ждёт это время, салон получает уведомление «Освободилось окно: N в листе ожидания».
- «Удержание» → «Лист ожидания»: освободившиеся окна на 3 недели вперёд (если время никто не занял) и кто под них подходит; «Предложить» отправляет шаблон `waitlist_offer` со ссылкой на онлайн-запись. Записи с прошедшим периодом закрываются сами.

### TT-REBOOK-01 Записать снова (сделано, этап 6)
- В карточке визита (клиент пришёл / в работе / завершён): «через 2 / 3 / 4 / 6 недель». Тот же мастер, те же услуги, то же время; если занято — ближайшее свободное в тот же день (±30 мин … ±4 ч), затем следующие 6 дней.

### TT-NOSHOW-02 Политика неявок (сделано, этап 6)
- В карточке записи метка «неявок: N» за последний год.
- Онлайн-запись не пускает телефон с `noshow_block_after` (по умолчанию 2) неявками за год: клиент видит просьбу позвонить. 0 — без ограничения. Администратор записывает как обычно.

---

## 18. Чеклист приёмки модуля журнала

- [ ] Create / edit / cancel покрыты сценариями выше  
- [ ] Drag время + мастер + conflict hard/soft  
- [ ] Resize нижней границы  
- [ ] Статусная машина без дыр  
- [ ] Permissions соблюдены  
- [ ] STALE concurrent  
- [ ] Аудит move/cancel/create + UI tab  
- [ ] UI states: ghost, snap-back, dirty close  
- [ ] Prev client / guest / compact  
- [ ] Visit merge (P2)  
- [ ] Export CSV  
