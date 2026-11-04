# Поведение: зарплаты мастеров

**ID prefix:** `PAYROLL-`  
**Фаза:** P3 (правила можно завести в данных раньше, расчёт — P3)  
**Связи:** completed/paid appointments, tips, refunds, services, staff

---

## 1. Зачем модуль

Посчитать, **сколько начислить мастеру за период**, из факта работ и правил, затем утвердить и зафиксировать выплату. Без «Excel сбоку».

---

## 2. Сущности

### PayrollRule (схема оплаты труда)
| Поле | Описание |
|---|---|
| id, tenant_id | |
| staff_id \| null | null = правило по умолчанию для роли master |
| service_id \| null | null = на все услуги staff |
| scheme | `percent` \| `fixed_per_service` \| `salary` \| `hybrid` |
| percent_bps | basis points, 5000 = 50% |
| fixed_minor | фикс за услугу |
| salary_minor | оклад за период (см. period_unit) |
| period_unit | `month` \| `biweekly` \| `week` для salary |
| base | `service_price` \| `paid_amount` \| `price_after_discount` |
| deduct_materials | bool — вычитать себестоимость расходников |
| include_tips | bool |
| split_with_assistant | bool |
| assistant_percent_bps | |
| valid_from, valid_to | |
| priority | int — более специфичное (service+staff) побеждает |

**Резолв правила для позиции услуги в записи:**  
1. staff+service rule  
2. staff default  
3. tenant default  
4. иначе 0 + warning в расчёте

### PayrollPeriod
| Поле | |
|---|---|
| branch_id \| tenant-wide | настройка: считать по филиалу |
| starts_on, ends_on | локальные даты |
| status | `draft` \| `calculated` \| `approved` \| `paid` \| `locked` |

### PayrollRun
- Расчёт по всем staff за period (или один staff).

### PayrollItem
| Поле | |
|---|---|
| staff_id | |
| period_id | |
| lines[] | детализация |
| accrual_minor | начислено |
| deduction_minor | удержания |
| tip_minor | |
| total_minor | к выплате |
| status | `draft` \| `approved` \| `paid` |

### PayrollLine
| type | смысл |
|---|---|
| `service` | из appointment service line |
| `salary` | окладная часть |
| `tip` | чаевые |
| `bonus` | ручная премия |
| `penalty` | удержание |
| `adjustment` | ручная корректировка |
| `refund_clawback` | сторно после возврата |

Каждая service-line: appointment_id, service_id, base_amount_minor, rate_snapshot, result_minor.

---

## 3. Permissions

| Действие | owner | admin | master | accountant |
|---|---|---|---|---|
| Настройка rules | ✓ | ✓* | ✗ | ✓ |
| Считать период | ✓ | ✓ | ✗ | ✓ |
| Смотреть свой расчёт | ✓ | ✓ | ✓ only self | ✓ |
| Утвердить | ✓ | ✗ / ✓ flag | ✗ | ✓ |
| Отметить выплачено | ✓ | ✗ | ✗ | ✓ |
| Ручные adjustment | ✓ | ✗ | ✗ | ✓ |

---

## 4. Что входит в базу расчёта

### Источник факта (настраиваемый предикат филиала)
Default **строгий (рекомендуется):**
- Appointment status = `completed`
- И сумма оплаченного по услугам > 0 (пропорция)
- Не cancelled/no_show

Alternative soft: completed даже без оплаты (долг) — флаг `accrue_on_complete_unpaid` default **false**.

### Момент начисления
- По `completed_at` ∈ period **или** по `paid_at` ∈ period — настройка `accrual_basis`:  
  - default `completed_at`  
  - enterprise: `paid_at`

### Refunds
- Если оплата возвращена после completed → clawback line в периоде возврата (или пересчёт исходного если ещё draft).

---

## 5. Схемы расчёта (поведение)

### PAYROLL-SCHEME-01 · Percent
`result = base_amount * percent_bps / 10000`  
`base_amount` по rule.base:
- `service_price` — snapshot цены услуги до скидки  
- `price_after_discount` — после скидки записи  
- `paid_amount` — доля оплаты, атрибутированная услуге  

### PAYROLL-SCHEME-02 · Fixed per service
`result = fixed_minor` за факт оказания (1× на позицию).

### PAYROLL-SCHEME-03 · Salary
- На период: `salary_minor` пропорционально дням периода, если period ≠ rule.period_unit.  
- Не умножается на число услуг.  
- Hybrid: salary + percent с услуг.

### PAYROLL-SCHEME-04 · Hybrid
`total = salary_part + sum(service_parts) + tips? − deductions`

### PAYROLL-SCHEME-05 · Materials deduct
Если `deduct_materials`:  
`base_amount -= cost_of_consumed_inventory` (из inventory consume linked to appointment).  
Не уходить ниже 0 без флага `allow_negative_base`.

### PAYROLL-SCHEME-06 · Assistant split
Если на записи указан assistant_staff_id:  
master gets `(10000 − assistant_percent_bps)`, assistant gets rest.  
Оба получают свои PayrollLine.

---

## 6. Сценарии периода

### PAYROLL-PERIOD-01 · Создать период
- Указать branch (или вся сеть P4), starts_on, ends_on.  
- Не пересекать locked периоды.  
- status=`draft`.

### PAYROLL-CALC-01 · Рассчитать / пересчитать
- **Актёр:** admin+/accountant  
- **Шаги:**  
  1. Собрать все appointment service lines по предикату.  
  2. Для каждой — resolve rule, посчитать result.  
  3. Добавить salary parts.  
  4. Tips за период если include.  
  5. Применить уже существующие manual adjustments (не затирать).  
  6. Clawbacks по refunds.  
  7. status period → `calculated`; items → draft totals.  
- **UI:** таблица staff × total; drill-down lines.  
- **Warnings:** no rule; unpaid completed; force_overlap appointments; missing assistant.

### PAYROLL-CALC-02 · Идемпотентность
- Повторный расчёт **заменяет** auto lines, **сохраняет** manual bonus/penalty/adjustment с флагом `manual=true`.

### PAYROLL-APPROVE-01 · Утверждение
- Confirm: «После утверждения автопересчёт ограничен».  
- status item/period → `approved`.  
- Master видит свой листок.

### PAYROLL-APPROVE-02 · Снять утверждение
- Только owner/accountant если ещё не `paid`.  
- → обратно `calculated`.

### PAYROLL-PAY-01 · Отметить выплату
- Указать дату, метод (cash/transfer), reference.  
- status → `paid`.  
- Optional: создать cash expense в смене (link).  

### PAYROLL-LOCK-01
- Period `locked` — никаких правок; только сторно-период.

---

## 7. Ручные операции

### PAYROLL-ADJ-01 · Премия / штраф
- На staff в period: amount + reason (обяз.).  
- Видно в листе отдельно.

### PAYROLL-ADJ-02 · Исключить визит из расчёта
- Flag на appointment `exclude_from_payroll` + reason (admin+).  
- Пересчёт убирает line.

### PAYROLL-ADJ-03 · Переопределить % на один визит
- Override snapshot на line; audit.

---

## 8. Пересчёты после факта

### PAYROLL-RECALC-01 · Возврат в открытом (draft/calculated) периоде
- Автоматически включить clawback / убрать service line при следующем calc.

### PAYROLL-RECALC-02 · Возврат после approved
- Не молча менять approved.  
- Создать `adjustment` draft в **текущем** open period + notify accountant.  
- Или явный «Переоткрыть период» (owner).

### PAYROLL-RECALC-03 · Возврат после paid
- Только новый clawback item в новом period (долг мастера / удержание).  
- Никакого silent rewrite истории выплат.

---

## 9. Листок мастера (UI поведение)

### PAYROLL-VIEW-SELF-01
- Master: период, total, список визитов (дата, услуга, база, %), чаевые, корректировки.  
- Без чужих данных и без правил % других.  
- Export PDF: «Расчётный листок» в периоде, кнопка «Печать / PDF» (браузер сохраняет PDF).

---

## 10. Настройка правил (UI)

### PAYROLL-RULE-01 · CRUD правила
- Форма scheme + поля.  
- Preview: «На услуге 5000 ₽ при 40% = 2000 ₽».  
- Overlap valid_from/to — warning.  
- Удаление rule с будущими периодами — soft disable valid_to=today.

---

## 11. Связи

| Модуль | Связь |
|---|---|
| Timetable | completed appointments |
| Cash | paid_amount basis; payout expense |
| Inventory | materials deduct |
| Loyalty | скидки влияют на price_after_discount |
| Tips | include_tips |

---

## 12. Edge cases

1. Смена правила mid-period — применяется rule.valid на дату completed_at.  
2. Два правила одинакового priority — hard error на calc.  
3. Услуга удалена из прайса — line хранит title snapshot.  
4. Staff уволен — считается до date_terminated.  
5. Нулевая оплата + accrue_on_complete_unpaid false — line skip + warning.  
6. Split 100% assistant — master 0, ок.  
7. Отрицательный total после clawback — показать, выплата 0, carry debt flag.

---

## 13. Чеклист приёмки

- [ ] Percent / fixed / salary / hybrid считаются верно на фикстурах  
- [ ] Пересчёт не убивает manual adjustments  
- [ ] Refund после paid → clawback, не rewrite  
- [ ] Master видит только себя  
- [ ] Approve → pay → lock  
- [ ] Materials + tips flags  
- [ ] Audit rule change / approve / pay  
