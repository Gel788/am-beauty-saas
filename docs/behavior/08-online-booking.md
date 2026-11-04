# Поведение: онлайн-запись

**ID prefix:** `OB-`  
**Фаза:** P2

---

## 1. Поверхности

- Public page `/b/{tenantSlug}/{branchSlug}`  
- Embed widget (iframe)  
- Branding: logo, accent, cover optional (не stock junk)

---

## 2. Воронка (строго 3 шага)

1. **Услуга** (категории → услуга; только `online_visible` + active)  
2. **Мастер + слот** (мастер «любой» = первый свободный алгоритм)  
3. **Контакты + confirm**

Назад можно; смена услуги сбрасывает слот.

---

## 3. Слоты

### OB-SLOT-01 · Расчёт свободных окон
- Inputs: branch, date range, service duration (+ buffer), staff filter.  
- Учесть: working hours, existing non-cancelled appointments, min booking notice, max advance days.  
- Step = 5 или 15 (настройка).  
- Не отдавать слоты в прошлом.

### OB-SLOT-02 · Race на один слот
- Hold: при переходе к шагу 3 создать `SlotHold` TTL 5–10 мин.  
- Confirm: convert hold → appointment source=`online` status=`scheduled` или `confirmed` (если оплата/авто).  
- Если hold истёк / заняли — ошибка «слот недоступен», вернуть к шагу 2.

---

## 4. Клиент

### OB-CLIENT-01
- Телефон + имя обяз.  
- Найти existing by phone в tenant → привязать; иначе create.  
- OTP optional P3.

---

## 5. Предоплата / депозит

### OB-PAY-01
- Настройка филиала (владелец): предоплата в % от цены и время на оплату (10 минут – сутки). В услуге можно задать свою сумму или 0 — без предоплаты.
- Работает, только когда включена онлайн-оплата. Клиент видит размер предоплаты в списке услуг и на кнопке записи.
- Запись создаётся сразу и держит время, `deposit_due_at` = сейчас + время на оплату; клиенту выдаётся ссылка на оплату (purpose `deposit`). В журнале на блоке метка «Ждёт предоплату».
- Успешная оплата проводит предоплату (line `deposit`) и снимает ожидание.
- Не оплатили к сроку → минутная задача отменяет запись с причиной «Не внесена предоплата», закрывает ссылку, сообщает администратору. Время снова свободно.
- Оплата, пришедшая после отмены, учитывается как прочий приход с пометкой «Оформите возврат клиенту» (ACQ-LINK-02).
- Если ссылку создать не удалось, запись остаётся без предоплаты и администратор получает уведомление.

---

## 6. Отмена клиентом

### OB-CANCEL-01
- Link в SMS/email.  
- Разрешено если now < starts_at − cancel_hours.  
- Иначе — только запрос админу.  
- Deposit refund policy: full / partial / none.

---

## 7. Админ-связка

- Online записи в журнале с badge.  
- Уведомление admin (sound/toast P2).  
- Нельзя online на услугу без online_visible.

---

## 8. Permissions / abuse

- Rate limit per IP/phone.  
- Cap active future bookings per phone.  
- Honeypot / captcha P3.

---

## 9. Edge cases

1. Мастер стал inactive после показа слота — fail on confirm.  
2. График изменили — пересчёт.  
3. Widget на чужом домене — CORS/embed token.  
4. Double submit confirm — idempotency key.

---

## 10. Чеклист

- [ ] 3 шага  
- [ ] SlotHold TTL  
- [ ] Race-safe confirm  
- [ ] Cancel window  
- [ ] Badge в журнале  
