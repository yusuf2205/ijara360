# Ijara360

Управление частным студенческим домом. Единица аренды — спальное место.

**M2: жильцы и история проживания. Финансовые начисления и платежи — отдельный следующий этап M3.**

На NAS доступны вход, настройки OWNER/ADMIN, комнаты/места, жильцы, заселение → переселение → выселение, история проживания и реальные счётчики занятости. Подробности API, правил и эксплуатации: [M2 — Residents & Occupancy](docs/M2-RESIDENTS.md).

## Открыть на NAS

**https://mynas.tail4bf75c.ts.net:8446/login** — дома и вне домашней сети, при включённом Tailscale на вашем устройстве. Эта ссылка использует доверенный HTTPS-сертификат; установка локального CA для неё не нужна.

**https://192.168.1.105:8446/login** — из вашей локальной сети.

При первом открытии задайте свои телефон, пароль и параметры дома. Ключ первоначальной настройки передан в локальном файле `.local/FIRST-RUN.txt` на компьютере владельца; он не публикуется в Git. После создания первого дома повторная инициализация запрещена.

HTTPS по локальному IP использует локальный центр сертификации Caddy. Публичный корневой сертификат передан в `.local/ijara360-ca.crt`. Для доверенного открытия установите этот сертификат на используемом устройстве (Windows: открыть сертификат → установить для текущего пользователя → «Доверенные корневые центры сертификации»). В приложении проверка HTTPS не отключается. Доверие на устройствах не устанавливалось автоматически.

Первоначальная настройка владельцем уже выполнена. Рабочий дом, комнаты и места сохраняются при обновлении; demo в production не импортируется.

## Стек и каталоги

- `apps/api` — NestJS 11, серверные сессии, права и транзакции.
- `apps/web` — Next.js 16, TypeScript, responsive UI.
- `prisma/schema.prisma` и `prisma/migrations` — действующая схема и миграции PostgreSQL.
- `tests/ui`, `apps/api/test` — Playwright и backend/integration tests.
- `compose.yaml`, `infra` — отдельный Docker Compose project `ijara360` на NAS.
- [M2: актуальные модели, API, правила, тесты и backup](docs/M2-RESIDENTS.md).
- [Исторический отчёт первого раунда](docs/ROUND1.md).

## Локальный запуск

Нужны Node.js 22+ и Docker. Команды выполняются из корня проекта.

```powershell
Copy-Item .env.example .env
npm.cmd ci
npm.cmd run db:generate
docker compose -f compose.dev.yaml up -d
npm.cmd run db:migrate
npm.cmd run build
```

В `.env` задайте случайный SETUP_TOKEN длиной не менее 32 символов. Для локальной БД `.env.example` соответствует настройкам `compose.dev.yaml`; при изменении пароля обновите DATABASE_URL и DEV_DB_PASSWORD вместе.

В двух терминалах:

```powershell
npm.cmd run dev:api
npm.cmd run dev:web
```

Откройте http://localhost:3000/login. API использует порт 4000. После изменений TypeScript backend повторите `npm.cmd run build -w @ijara360/api`; dev-процесс перечитает изменённый dist. Роли на форме входа не выбираются.

## Тесты

Только отдельная БД `ijara360_test`: backend tests очищают её таблицы и отказываются работать с другим именем БД или NODE_ENV.

```powershell
docker compose -f compose.dev.yaml exec db createdb -U ijara360 ijara360_test
Copy-Item .env.test.example .env.test
node --env-file=.env.test node_modules/prisma/build/index.js migrate deploy
npm.cmd run build -w @ijara360/api
npm.cmd run test:api
```

Для UI после backend tests запустите API на этой же тестовой базе в отдельном терминале:

```powershell
node --env-file=.env.test apps/api/dist/main.js
```

Затем:

```powershell
npm.cmd exec playwright install chromium
npm.cmd run test:ui
```

Playwright сам запускает Next.js. Нужна пустая тестовая база: первый сценарий проходит первоначальную настройку. После прогона можно повторить backend tests для очистки, затем снова UI. Порт 3000 не должен быть занят другим приложением. Для тестов на NAS предусмотрен `infra/test-nas.sh`; это изолированная среда, не production.

## Demo seed

Создайте отдельную БД с именем, оканчивающимся `_demo`, примените миграции. В локальной `.env` для неё укажите DEMO_SEED=true, NODE_ENV=development, DEMO_OWNER_PHONE и сильный DEMO_OWNER_PASSWORD, затем выполните:

```powershell
npm.cmd run db:demo
```

Seed создаёт **7 комнат, 59 мест, 5 жильцов, 4 активных и 1 завершённое проживание**; на непустой БД и в production отказывается запускаться. Seed не входит в команду развёртывания.

## Публикация и развёртывание

Вне домашней сети используйте параметр `-NasHost 100.126.164.29` для обоих PowerShell-скриптов. Git-доступ к Gitea также должен использовать доступный адрес NAS и проверенный SSH host key.

Удалённый доступ настроен через Tailscale Serve в существующем контейнере `tailscale`: `docker exec tailscale tailscale serve --bg --https=8446 http://127.0.0.1:8447`. Сервис доступен только внутри вашей Tailscale-сети. Caddy публикует дополнительный HTTP-вход исключительно на loopback NAS; HTTPS завершается в Tailscale Serve. В `production.env` задано `ADDITIONAL_APP_ORIGINS=https://mynas.tail4bf75c.ts.net:8446`; API проверяет точное совпадение origin и защитный заголовок для изменений данных. Для отключения только этого входа: `docker exec tailscale tailscale serve --https=8446 off`.

Репозитории: [GitHub](https://github.com/yusuf2205/ijara360) и [mygithub.uz](https://mygithub.uz/joseph/ijara360). NAS: UGREEN DXP4800 Plus, `192.168.1.105`.

После commit чистого дерева `main`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Publish-Project.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Deploy-Nas.ps1
```

ExecutionPolicy изменяется только для указанного процесса. Publish отправляет один commit обоим remote и сохраняет архив + Git bundle на NAS с SHA-256-проверкой. Deploy запускает **только** compose-проект `ijara360` из опубликованного snapshot, применяет миграции и обновляет контейнеры. Пароли на NAS находятся в `secrets/production.env` (пример — `infra/production.env.example`), не в исходниках.

- `/volume1/docker/ijara360/releases/<commit>/source` — опубликованные исходники.
- `/volume1/docker/ijara360/data/postgres` — постоянные данные production PostgreSQL.
- `/volume1/docker/ijara360/data/caddy` — сертификаты локального HTTPS.
- `/volume1/docker/ijara360/secrets/production.env` — секреты.
- `/volume1/docker/ijara360/DEPLOYED_COMMIT` — версия развёрнутого приложения.

PostgreSQL и API production не публикуют собственные порты; доступ идёт через HTTPS gateway. Подготовлены `scripts/backup-nas.sh` (pg_dump, SHA-256, retention 14 дней) и `scripts/verify-backup-nas.sh` (восстановление в изолированную временную БД). Предмиграционная копия создана и проверена. Ежедневное расписание и внешняя копия пока не включены. Git bundle сохраняет код, а не рабочую БД.

## Следующие раунды

1. M2 Resident + Occupancy реализован; результаты проверок — в отчёте M2.
2. Начисления, платежи, частичная оплата, долг, финансовый dashboard.
3. Сквозные тесты полного MVP, backup/restore, приёмка владельцем.

Камеры, AI, гости, договоры, SMS/Telegram automation и импорт сейчас не реализуются. Старые `docs/M1-*` и `docs/schema/m1-design.sql` сохранены как исторический проект; они не являются контрактом текущего приложения. Новое ТЗ и [ROUND1.md](docs/ROUND1.md) имеют приоритет.
