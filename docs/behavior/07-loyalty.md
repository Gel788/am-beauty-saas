# Поведение: лояльность

**ID prefix:** `LOY-`  
**Фаза:** P3

---

## 1. Продукты лояльности

| Тип | Суть |
|---|---|
| BonusAccount | баллы; earn % от оплаты; burn как tender |
| Membership (абонемент) | N визитов / срок / услуга-ограничение |
| Certificate | номинал ₽, срок, код |
| PromoCode | % или fixed на запись/онлайн |

---

## 2. Бонусы

### LOY-BONUS-EARN-01
- После payment posted: earn = f(paid services) по правилам программы.  
- Не начислять на tips / debt repayment (настройка).  
- Refund → clawback баллов (не ниже 0 без debt points flag).

### LOY-BONUS-BURN-01
- В оплате tender `bonus`; лимиты: max % чека, мин. остаток.  
- Нельзя burn больше balance.

---

## 3. Абонементы

### LOY-SUB-01 · Продажа
- Payment line membership; создаёт MembershipAccount: visits_left / valid_to / services_allowed.

### LOY-SUB-02 · Списание визита
- При complete записи (или при оплате) — −1 visit если услуга eligible.  
- Если visits_left=0 — нельзя применить; предложить обычную оплату.  
- Отмена визита → restore visit если списание было.

### LOY-SUB-03 · Заморозка / продление
- Admin: freeze dates; extend valid_to + reason.

---

## 4. Сертификаты

### LOY-CERT-01 · Выпуск
- Номинал, код (auto), valid_to, sold via payment.

### LOY-CERT-02 · Оплата сертификатом
- Tender certificate; partial ok; остаток на сертификате.  
- Сдача наличными с сертификата — default **запрет**.

### LOY-CERT-03 · Отмена/потеря
- Void certificate owner only; если частично использован — только остаток void.

---

## 5. Промокоды (онлайн + админ)

### LOY-PROMO-01
- Constraints: даты, услуги, мин. чек, max uses, per phone.  
- Применение пересчитывает lines до оплаты.

---

## 6. Permissions

Настройка программ: owner/admin.  
Ручное начисление баллов: admin+ reason.  
Клиент видит баланс в ЛК P3.

---

## 7. Чеклист

- [ ] Earn/burn + refund clawback  
- [ ] Абонемент visit lifecycle  
- [ ] Сертификат partial  
- [ ] Promo limits  
