# M2 — Residents & Occupancy: production release

Проверено 26 сентября 2026. M3 не запускался. Первая production-версия M2: `7a89826d5cd432accd5e2ffcac6295185322a4d7`; последующее обновление документации выпускается через тот же механизм. Актуальную полную ревизию показывают NAS `DEPLOYED_COMMIT` и main обоих Git remote.

## Persistence — PASS

`scripts/test-m2-persistence.cjs before` создаёт явно тестового жильца в отдельном NAS test environment, заселяет и переселяет в другую комнату, оставляя новое проживание ACTIVE, прежнее CLOSED. Сохраняются идентификаторы, условия, полная карточка и история, аудит, комнаты, счётчики и сессия в игнорируемом `.local/m2-persistence.json`.

После рестарта **test PostgreSQL, API, frontend и gateway** команда `after` сравнила все данные и проверила отображение занятого места и двух проживаний через браузер. `M2 PERSISTENCE: PASS`. Production в этом сценарии не использовался.

## Production backup и migration — PASS

Свежая предмиграционная копия: `/volume1/docker/ijara360/backups/ijara360-20260926T074747Z-193091.dump`, **23 332 байта**, время **2026-09-26 07:47:47 UTC / 12:47:47 Asia/Tashkent**. `pg_dump` завершился с кодом 0; SHA-256 и полное восстановление в scratch PostgreSQL прошли. Файл находится вне контейнера, mode 600, каталог mode 700. Предыдущие копии не перезаписаны.

Применена только `202609250002_residents_occupancy` через `prisma migrate deploy`, завершена в 07:48:00 UTC. Foundation migration сохранена побайтно; контрольные суммы обеих миграций совпали с исходниками. `db push` и demo seed не запускались.

До/после совпали количества и отпечатки **properties, rooms, beds, users, sessions, audit_logs**. Доказательства: `/volume1/docker/ijara360/deployments/20260926T074734Z-192075/{before.txt,after.txt,backup-path}`. Существующие 1 дом, 7 комнат, 56 мест, 2 пользователя, 1 сессия и 7 событий аудита сохранены.

## Production — PASS

PostgreSQL, API, frontend, gateway имеют Docker health status `healthy`. HTTPS endpoint `https://mynas.tail4bf75c.ts.net:8446/api/health` отвечает 200 с валидным сертификатом. Сам NAS не разрешает MagicDNS, поэтому его release-check использует `curl --resolve` на известный Tailscale IP, сохраняя проверку сертификата и имени хоста.

`Deploy-Nas.ps1` теперь строит образы, создаёт свежий backup, проверяет восстановление, сохраняет отпечатки существующих таблиц, выполняет compose с ожиданием здоровья сервисов и сверяет данные. `DEPLOYED_COMMIT` записывается только после этих проверок и HTTPS health.

## Database

| Сущность | Количество |
|---|---:|
| Properties | 1 |
| Rooms | 7 |
| Beds | 56 |
| Residents | 0 |
| ACTIVE occupancies | 0 |
| CLOSED occupancies | 0 |

Оба частичных уникальных индекса ACTIVE присутствуют. Runtime-роль имеет SELECT/INSERT/UPDATE для жильцов и проживаний, без DELETE. Занятость определяется ACTIVE Occupancy; свободные места = всего мест − занятые. Условия и история проверены в изолированной среде с ненулевой занятостью.

## Final regression — PASS

- Backend: **36/36**, включая двойное заселение, два ACTIVE у жильца, гонки, аудит, rollback при ошибке аудита, повторное выселение, чужие ID и историю.
- Playwright: **14/14**, один полный успешный прогон на production-сборке в отдельной тестовой среде после последних изменений скриптов. Добавлен сценарий пустого списка и восстановления после некорректных ссылок на жильца/комнату.
- TypeScript: **PASS**.
- API и Next.js production build: **PASS**, локально и в NAS Docker.
- Responsive widths 320/390/1440: горизонтального переполнения нет; скриншоты просмотрены.
- Сохранность Property/Room/Bed при тестовой миграции дополнительно подтверждена равенством сохранённых отпечатков.

При пересоздании тестового API необходимо передавать `ADDITIONAL_APP_ORIGINS=http://100.126.164.29:3187`. Первый повторный UI-прогон выявил пропуск этой настройки; после восстановления разрешённого тестового Origin полный прогон прошёл. Production origins не расширялись.

## Smoke

**READ: PASS в существующем OWNER-сеансе.** После deployment сеанс сохранился; в браузере открылись dashboard, существующая комната, список жильцов. Dashboard: 7 комнат, 56 мест, 56 свободно, 0 занято, 0 жильцов. Room Detail показывает «По активным проживаниям». Residents: «Жильцов пока нет» и primary action «+ Заселить». Персональные данные в отчёт не включены. Повторный ввод пароля владельцем проверяется отдельно от сохранённого сеанса.

**WRITE SMOKE: NOT RUN — production data protection.** Тестовый жилец оставил бы постоянную историю в рабочей базе; полный create → check-in → transfer → checkout проверен в isolated production build environment. Финансовые данные не создавались.

## GitHub / Gitea / NAS

Изменения разделены на логические commits. Секреты, дампы, env, сессии, скриншоты и тестовые артефакты исключены из Git. GitHub и Gitea main синхронизируются с актуальным HEAD. Release содержит source.tar, repository.bundle и проверенный SHA-256 manifest; `COMPLETE` отмечает завершённую публикацию.

**GITEA SYNC: SYNCED.** Копия до исправления ownership: `/volume1/docker/gitea/ownership-backups/before-ownership-20260926T073827Z.tar.gz` (8 941 827 байт), проверены tar и SHA-256. Символических ссылок в исправляемых каталогах не было; права других проектов и `/data` целиком не менялись. После исправления сервис снова может писать SQLite и Git repositories, SSH и fast-forward push работают.

## Backup automation

Подготовлен и успешно выполнен `scripts/backup-daily-nas.sh`: `pg_dump -Fc`, UTC timestamp, внешний каталог NAS, retention 14 дней, `flock` от параллельного запуска, приватный журнал (60 дней) с exit code, SHA-256 и автоматическое полное восстановление в PostgreSQL без сети и host data mounts. Скрипт читает актуальную ревизию из `DEPLOYED_COMMIT`.

Контрольный запуск: **07:50:09–07:50:12 UTC**, dump `ijara360-20260926T075009Z-201249.dump`, **35 151 байт**, restore PASS, exit 0. Журнал: `/volume1/docker/ijara360/backups/logs/backup-20260926T075009Z-201235.log`.

**Ежедневное расписание ещё не включено.** Служба cron активна, но `crontab` пользователя Joseph возвращает `/var/spool/cron/: mkstemp: Permission denied`; `sudo -n` требует пароль. Системные права NAS не изменялись. Администратору нужно добавить в crontab Joseph следующую строку (03:15 по локальному времени NAS, Asia/Tashkent), сохранив другие задания:

```cron
15 3 * * * /bin/sh /volume1/docker/ijara360/releases/7a89826d5cd432accd5e2ffcac6295185322a4d7/source/scripts/backup-daily-nas.sh # ijara360-daily-backup
```

Путь закреплён на существующем immutable release; сам runner выбирает backup/restore скрипты текущего deployed commit. Это operational follow-up, разрешённый заданием закрытия M2. Внешняя копия резервных данных за пределами NAS также не настроена.

## Исправление проверки restore

Первый deployment остановился **до production migration**, когда `pg_isready` принял временный socket-only сервер инициализации за готовую scratch DB. Проверка теперь ждёт TCP на 127.0.0.1, который появляется у финального PostgreSQL. Тот же dump успешно восстановлен исправленным скриптом; последующие предмиграционный и автоматический restore также PASS.
