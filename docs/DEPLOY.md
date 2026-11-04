# Развёртывание

Один сервер с Docker поднимает всё сразу: Postgres, приложение, HTTPS через Caddy, ночные резервные копии и отправку напоминаний раз в 5 минут. Файлы лежат в `deploy/`.

## Сервер

- Хостинг в РФ, потому что персональные данные клиентов должны храниться в России (152-ФЗ). Подойдут Yandex Cloud, Selectel или любой VPS в российском дата-центре.
- Для одного-трёх салонов хватит 2 vCPU, 4 ГБ RAM и 40 ГБ SSD.
- Ubuntu 22.04 или 24.04, Docker с плагином compose.
- Доменное имя, A-запись которого указывает на сервер. Порты 80 и 443 открыты.

## Первый запуск

```bash
git clone https://github.com/Gel788/am-beauty-saas.git && cd am-beauty-saas
cp deploy/.env.example deploy/.env
# Впишите домен и три длинных случайных значения, например из `openssl rand -hex 24`.
nano deploy/.env

C="docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env"
$C build
$C run --rm migrate        # миграции и пароль для роли app_user
$C up -d
curl https://<домен>/api/health   # {"ok":true,"db":true}
```

Сертификат HTTPS Caddy получает сам при первом запросе к домену.

Демо-данные (`npm run db:seed`) на боевом сервере не загружаются. Первый салон создаётся на странице `/register`.

## Интеграции салона

Владелец сам подключает свои аккаунты в «Настройки → Интеграции»: свой Telegram-бот, SMS.ru или SMSC, онлайн-кассу АТОЛ Онлайн, эквайринг ЮKassa или Т-Банк. Ключи шифруются ключом `INTEGRATIONS_KEY` из `deploy/.env` (`openssl rand -hex 32`). Сохраните его копию вне сервера: без него сохранённые ключи не расшифровать, и владельцам придётся вводить их заново.

Адреса для уведомлений провайдеров:
- ЮKassa: `https://<домен>/api/webhooks/acquiring/yookassa` (событие `payment.succeeded` и `payment.canceled`);
- Т-Банк: `https://<домен>/api/webhooks/acquiring/tbank` (в настройках терминала, «Нотификации по HTTP»);
- свой Telegram-бот: вебхук CRM регистрирует сама при включении.

## Общие каналы платформы (необязательно)

Если салон не подключил своих провайдеров, сообщения только записываются в журнал. Общий бот и общий SMS-ключ платформы работают как запасной вариант:

1. **Telegram.** Создайте бота у @BotFather, впишите `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` (без @) и случайный `TELEGRAM_WEBHOOK_SECRET` в `deploy/.env`, перезапустите `app` и зарегистрируйте вебхук:
   ```sh
   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
     -d url="https://$DOMAIN/api/webhooks/telegram" -d secret_token="$TELEGRAM_WEBHOOK_SECRET" \
     -d allowed_updates='["message","callback_query"]'
   ```
2. **SMS.** Зарегистрируйтесь в SMS.ru, впишите `SMS_RU_API_KEY` (и согласованное имя отправителя в `SMS_SENDER`).
3. Владелец салона включает каналы и их порядок в «Настройки → Сообщения клиентам».

## Обновление

```bash
git pull
$C build
$C run --rm migrate
$C up -d app
```

Миграции применяются только новые и запоминаются в таблице `schema_migrations`.

## Резервные копии

Контейнер `backup` раз в сутки делает `pg_dump` в `deploy/backups/` и удаляет копии старше `BACKUP_KEEP_DAYS` дней (по умолчанию 14).

Копии на том же сервере не спасут при потере диска, поэтому каждую ночь уносите папку на другой носитель. Например, в Yandex Object Storage через cron хоста:

```bash
0 4 * * * rclone sync /opt/am-beauty-saas/deploy/backups yandex:ambeauty-backups
```

### Восстановление

```bash
$C stop app
$C exec -T postgres dropdb -U postgres ambeauty
$C exec -T postgres createdb -U postgres ambeauty
$C exec -T postgres pg_restore -U postgres -d ambeauty --no-owner < deploy/backups/ambeauty_2026-11-03_0300.dump
$C run --rm migrate
$C up -d app
```

Раз в месяц проверяйте восстановление на отдельной машине. Копия, которую ни разу не восстанавливали, может оказаться нерабочей.

## Проверка перед запуском

- [ ] `deploy/.env` заполнен, пароли длинные и случайные, файл не в git.
- [ ] `/api/health` отвечает `{"ok":true}` по HTTPS.
- [ ] Вход работает, cookie сессии помечена `Secure`.
- [ ] В `deploy/backups/` появился первый дамп, копия уехала с сервера.
- [ ] Восстановление из дампа проверено.
- [ ] Внешний мониторинг (например, UptimeRobot) опрашивает `/api/health`.
- [ ] В журнале `docker compose logs cron` нет строк `reminders job failed`.

## CI

`.github/workflows/ci.yml` на каждый PR и push в `main` поднимает Postgres 16, применяет миграции, проверяет типы и линтер, гоняет тесты и собирает приложение.
