# Поведение: групповые события

**ID prefix:** `GRP-`  
**Фаза:** P2–P3  
**YC parity:** групповые события, онлайн-запись на группу, участники, оплата, напоминания  
**Дизайн:** отдельный режим «Группы», capacity `12/16` — parity-matrix §1.G

---

## 1. Сущности

### GroupEvent
| Поле | |
|---|---|
| tenant_id, branch_id | |
| title, description | |
| staff_id | ведущий |
| resource_id \| null | зал |
| starts_at, ends_at | |
| capacity | int ≥1 |
| status | `scheduled` \| `in_progress` \| `completed` \| `cancelled` |
| service_id \| null | для цены/онлайн |
| price_minor | default per seat |
| recurrence_rule \| null | P3 |
| online_visible | bool |

### GroupParticipant
| Поле | |
|---|---|
| event_id, client_id | |
| status | `enrolled` \| `waitlisted` \| `arrived` \| `no_show` \| `cancelled` |
| payment_id \| null | |
| source | `admin` \| `online` |
| enrolled_at | |

---

## 2. Permissions

| | owner | admin | master | client |
|---|---|---|---|---|
| CRUD event | ✓ | ✓ | свои как staff edit limited | ✗ |
| Enroll/cancel others | ✓ | ✓ | ✓ на своём событии | self cancel |
| Online enroll | | | | ✓ |

---

## 3. Сценарии

### GRP-CREATE-01 · Создать событие
- Prefill from empty slot in Groups view или форма.  
- capacity, price, staff, resource.  
- Conflict: staff overlap individual appointments — soft-warn; resource — hard if capacity resource.

### GRP-RECUR-01 · Серия (P3)
- RRULE weekly; generate N occurrences; edit one vs series.

### GRP-ENROLL-01 · Записать участника (admin)
- Search client → add.  
- If enrolled_count ≥ capacity → offer waitlist.  
- Duplicate client on event — hard.

### GRP-WAIT-01 · Waitlist promote
- On cancel enrolled → FIFO promote waitlisted + MSG notify + hold TTL for confirm.

### GRP-STATUS-01 · Отметить приход
- Bulk: checkbox list → arrived.  
- no_show after start+grace.

### GRP-PAY-01 · Оплата места
- Per participant PAY-CREATE style linked event_id+participant_id.  
- Or mark «оплачено на месте» cash.  
- Group unpaid badge on event card.

### GRP-CANCEL-PART-01
- Participant cancel: restore seat; refund policy if paid.  
- Admin cancel event: cascade cancel participants + MSG + refunds queue.

### GRP-ONLINE-01 · Виджет
- List online_visible events by date.  
- Select → contacts → SlotHold equivalent `EventHold` on seat.  
- Confirm → enrolled.  
- Full → waitlist opt-in.

### GRP-REMIND-01
- MSG template group_reminder to enrolled; quiet hours apply.

### GRP-COMPLETE-01
- Event → completed; payroll: staff gets scheme for group service × attendees arrived (rule flag `per_attendee` \| `flat_per_event`).

### GRP-ANALYTICS-01
- Fill rate, revenue, no_show rate per event type.

---

## 4. Связь с индивидуальным журналом

- Groups view **отдельный** mode (не колонки мастеров).  
- Optional: ghost block on staff column showing group busy (non-interactive or click opens group).

---

## 5. Edge cases

1. Capacity decrease below enrolled — forbid until cancel extras.  
2. Staff sick: reassign staff on event.  
3. Online race two last seats — one wins, other waitlist.  
4. Recurring edit «this only» vs «future».

---

## 6. Чеклист

- [ ] CRUD + capacity/waitlist  
- [ ] Pay per seat  
- [ ] Online enroll + hold  
- [ ] Reminders  
- [ ] Payroll hook  
- [ ] Analytics fill rate  
