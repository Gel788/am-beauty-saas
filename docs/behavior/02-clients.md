# Поведение: клиенты

**ID prefix:** `CL-`  
**Фаза:** P1 CRUD; merge/RFM/import P2

---

## 1. Сущность Client

| Поле | Правила |
|---|---|
| name | обяз., trim, 1–120 |
| phones[] | ≥1 для Save в большинстве сценариев; primary phone unique в tenant (нормализованный) |
| email | optional, validate |
| tags[] | |
| notes | внутренние |
| source | walk-in / online / instagram / … |
| balance_minor | долг (>0 клиент должен) |
| birth_date | optional |
| consents | marketing/personal data flags P2 |
| deleted_at | soft |

---

## 2. Permissions

| Действие | owner | admin | master | client |
|---|---|---|---|---|
| Список/поиск | ✓ | ✓ | ✓ ограничено | свои |
| Создать/править | ✓ | ✓ | ✓ create | свои контакты P3 |
| Merge | ✓ | ✓ | ✗ | ✗ |
| Hard anonymize | ✓ | ✗ | ✗ | GDPR request P2 |
| Видеть баланс/долг | ✓ | ✓ | ✓ | свой |

---

## 3. Сценарии

### CL-CREATE-01 · Создание из раздела Клиенты
- Форма: имя, телефон, optional fields.  
- Дубликат телефона → block + link на существующего.

### CL-CREATE-02 · Из записи (см. TT-CREATE-03)
- Тот же пайплайн уникальности телефона.

### CL-EDIT-01
- Save с version; смена primary phone — re-check unique.

### CL-DELETE-01 · Soft-delete
- Если есть будущие appointments — confirm «отменить N записей / оставить».  
- Default: нельзя soft-delete без решения по future (modal choice).  
- История визитов сохраняется.

### CL-SEARCH-01
- По имени, телефону (suffix), email.  
- Debounce 200ms; min 2 chars (кроме полного телефона).

### CL-MERGE-01 · Объединение дублей (P2)
- Выбрать primary + secondary.  
- Перенос: appointments, payments, loyalty, notes, tags.  
- Secondary → merged_into_id + deleted.  
- Audit full.

### CL-BALANCE-01
- Отображение долга; CTA погасить → PAY-DEBT.  
- Ручная корректировка баланса — owner/accountant + reason.

### CL-HISTORY-01
- Timeline: визиты, оплаты, статусы no_show, сообщения P2.  
- Фильтр по филиалу если сеть.

### CL-IMPORT-01 · CSV (P2)
- Mapping columns; dry-run duplicates report; commit.

---

## 4. Edge cases

1. Два одинаковых имени, разные телефоны — ок.  
2. Пустой телефон только для «черновика» из журнала до Save — нет; телефон обяз.  
3. Международный номер — хранить E.164.  
4. Merge при open debt на обоих — суммировать balance.

---

## 5. Чеклист

- [ ] CRUD + unique phone  
- [ ] Soft-delete с future appointments  
- [ ] History  
- [ ] Merge P2  
- [ ] Balance sync с кассой  
