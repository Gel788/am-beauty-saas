# Am Beauty

Мультитенантный журнал салона красоты: записи, клиенты, услуги, мастера, график и базовая оплата. Интерфейс на русском. Это первая фаза по `docs/TZ.md`: операционное ядро без онлайн-записи, склада, лояльности и зарплат.

Поведение продукта описано в `docs/behavior`. Если сценария там нет, его нет и в продукте.

## Запуск

Нужны Node.js 22 и Postgres 16.

```bash
docker compose up -d
cp .env.example .env
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

Приложение: http://127.0.0.1:43123

Миграции идут от суперпользователя (`MIGRATE_URL`), приложение подключается как `app_user` и подчиняется RLS. В Docker это `postgres` / `postgres` и база `ambeauty` на порту 5432.

Демо-салон **Am Beauty**, филиал Садовая, часовой пояс Europe/Moscow:

| Кто | Почта | Пароль |
|---|---|---|
| Владелец | olga@ambeauty.local | ambeauty |
| Администратор | admin@ambeauty.local | ambeauty |
| Мастер Алина | alina@ambeauty.local | ambeauty |
| Бухгалтер | buh@ambeauty.local | ambeauty |

Новый салон можно создать на `/register`: появится отдельный тенант и филиал.

## Design guard

Экраны дашборда и журнала повторяют макеты в `docs/design/` (PNG и HTML в `docs/design/src/`). Токены и правило «port from mockups HTML, verify with visual-compare, diff must not regress» — в `docs/design/DESIGN-SYSTEM.md`. Локальный агент обязан следовать `.cursor/rules/design-guard.mdc`.

Перед сдачей UI:

```bash
npm run visual:check
```

Скрипт `scripts/visual-compare` снимает макет и приложение в 1440×900, кладёт side-by-side PNG в `scripts/visual-compare/out/` и падает, если pixelmatch выше `scripts/visual-compare/baseline.json` больше чем на 0,5 п.п. Приложение должно быть запущено и засеяно. Отдельно проверьте, что на 1440×900 и 1280×800 ничего не переносится и не обрезается.

## Тесты

```bash
npm test
```

Имена тестов совпадают с ID сценариев (`TT-*`, `CL-*`, `SVC-*`, `STF-*`, `SCH-*`, `PAY-*`, `SHIFT-OPEN-*`). Нужна уже мигрированная база из `DATABASE_URL`.

## Деньги и время

Суммы хранятся целыми копейками. Время записи — `timestamptz` в UTC плюс снимок часового пояса филиала. Сетка журнала — 5 минут. Запись не может перейти через местную полночь.

## Что входит в эту фазу

Авторизация, тенант и филиал, роли, услуги, мастера и недельный график, клиенты, журнал (создание, правка, отмена, статусы, конфликты, перенос и изменение длительности), открытие смены и проведение оплаты.

Закрытие смены, возвраты, неделя/месяц, онлайн-запись и модули фаз 3–4 не сделаны. Список допущений — в отчёте к поставке: не было файлов `design-direction.md` и `yclients-parity-matrix.md`.
