# Поведение: склад

**ID prefix:** `INV-`  
**Фаза:** P3

---

## 1. Сущности

- **InventoryItem:** sku, title, unit, track_stock, cost_minor, sell_price_minor, active  
- **StockBalance:** item_id, branch_id, qty (decimal)  
- **StockMovement:** type `receipt` \| `write_off` \| `sale` \| `consume` \| `transfer` \| `inventory_adjust`, qty, cost snapshot, ref (appointment_id/payment_id), user_id  
- **ServiceConsumable:** service_id, item_id, qty_per_service  

---

## 2. Сценарии

### INV-ITEM-01 · CRUD номенклатуры
- Unique sku в tenant.  
- Нельзя удалить при ненулевых остатках / движениях → archive.

### INV-RECEIPT-01 · Приход
- Выбрать branch, lines[], supplier optional, document #.  
- Увеличивает StockBalance; movement receipt.

### INV-WRITEOFF-01 · Списание вручную
- Причина обяз.; qty ≤ balance (или allow negative flag default false).

### INV-TRANSFER-01 · Между филиалами
- Atomic: −from +to; dual movements linked.

### INV-CONSUME-01 · Автосписание по услуге
- Trigger: appointment → `completed` (или payment — настройка).  
- Для каждой услуги взять ServiceConsumable × qty.  
- Недостаточно остатка:  
  - policy `block_complete` — нельзя завершить  
  - или `allow_negative` + warning  
  - default: **warn + allow**, movement с negative flag  
- Reverse consume при отмене completed / refund услуги.

### INV-SALE-01 · Продажа товара в кассе
- Line product на payment; movement sale; qty −1.

### INV-COUNT-01 · Инвентаризация
- Сессия: snapshot expected → ввод counted → adjust movements.  
- Variance report.

---

## 3. Permissions

CRUD/движения: owner, admin, accountant.  
Master: read only / consume auto only.

---

## 4. Связи

- Payroll materials deduct читает consume cost.  
- Аналитика маржи: sell − cost.

---

## 5. Чеклист

- [ ] Приход/списание/трансфер  
- [ ] Автоconsume + reverse  
- [ ] Инвентаризация  
- [ ] Нет silent negative без policy  
