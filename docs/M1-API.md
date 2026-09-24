> Исторический проект до начала разработки. Новое ТЗ упростило MVP; действующая реализация и API описаны в [ROUND1.md](ROUND1.md).

# Контракт API M1, v0.1

Проект контракта, не описание существующего сервера. Префикс `/api/v1`. JSON: camelCase, UTF-8; UUID для идентификаторов. Все бизнес-маршруты ограничены домом. `P` ниже означает `/properties/{propertyId}`; это сокращение документации, не буквальный URL.

## Общие правила

- HTTPS. Cookie session + CSRF для браузера или Bearer session для native, как определено в [архитектуре](M1-FOUNDATION.md).
- Неизвестные поля DTO отклоняются, mass assignment запрещён. Пустой PATCH — 422. API не принимает actor, timestamps, computed status, aggregate counts или propertyId в body дочерних сущностей.
- Все успешные ответы содержат `X-Request-Id`, объекты — `id`, `version`, `createdAt`, `updatedAt`, где они существуют в модели. Список: `{ "items": [], "nextCursor": null }`.
- Пагинация: `limit` 1–100, по умолчанию 30; opaque cursor привязан к фильтрам. Справочники — порядок `(createdAt,id)` asc, аудит — `(occurredAt,id)` desc. Повтор с другим фильтром и прежним курсором — 422. Один ответ не обещает snapshot между страницами при параллельных изменениях.
- Чтение Room/Bed/Membership/Property возвращает `ETag: "<version>"`. Команды изменения/архивирования/восстановления требуют If-Match; отсутствие — 428, несовпадение — 412. Создание места требует If-Match текущей **комнаты**, не несуществующего Bed.
- Inventory/membership POST и PATCH требуют Idempotency-Key UUID. Успешный результат хранится 24 часа. Повтор проверяется до If-Match, но после актуальной авторизации; совпадающий запрос возвращает первоначальный статус/body/ETag. Изменение запроса с тем же ключом — 409. Правила не распространяются на auth и выдачу секретов приглашения.
- `archived=false` по умолчанию; `archived=true` — только архив; `archived=all` — оба. Восстановление — явная команда. Все detail endpoints включают archivedAt, историю можно читать после архива.
- Валидация номеров: trim + uppercase, 1–20 символов. Цена — строка `^\d{1,12}\.\d{2}$`, 0…999999999999.99. Дробные числа JSON и отрицательные суммы отклоняются. Capacity — целое 1…100 (технический предел M1, не реальная вместимость конкретной комнаты).
- String lengths считаются Unicode code points. Имя дома 1–120, ФИО 1–160, адрес 0–500, причина/заметка 1–500. Пробельные обязательные строки недопустимы. Контактный телефон optional, E.164. Login — lowercase ASCII `[a-z0-9][a-z0-9._-]{2,63}`.

## Auth

| Метод и путь | Вход | Выход / доступ |
|---|---|---|
| POST `/auth/login` | login, password, clientKind BROWSER/NATIVE | 200: user, expiresAt; BROWSER: Set-Cookie + csrfToken; NATIVE: token |
| GET `/auth/me` | — | 200: user, memberships [{propertyId, role, version}], permissions; только активные членства |
| POST `/auth/reauthenticate` | password | 204; подтверждает текущую сессию, rate limit как для login |
| POST `/auth/logout` | — | 204, сессия отозвана; уже отозванный токен также 204, без новой записи audit |
| POST `/auth/change-password` | currentPassword, newPassword | 204, отзывает все сессии, следующий запрос требует login |
| POST `/auth/accept-invitation` | token, fullName, password, contactPhone? | 201: userId, propertyId; автоматического входа нет |

Login/accept-invitation публичные, rate limited. Для cookie flow CSRF применяется ко всем изменяющим запросам с сессией; login дополнительно требует допустимый Origin. Токен приглашения передаётся в теле, не query string. GET `/auth/me` для браузера может выдавать новый csrfToken с заменой digest, если клиент потерял его после перезагрузки; параллельные вкладки после отказа CSRF перечитывают me и повторяют команду с прежним Idempotency-Key. Ошибка auth/me — 401, клиент не считает cached role достаточным правом.

Неверный логин/пароль: 401 INVALID_CREDENTIALS. Недействительный/истёкший/отозванный invite: 422 INVALID_INVITATION; повтор уже принятого: 409 INVITATION_ALREADY_USED. В публичном ответе не раскрываются участники дома или новый пароль.

## Пользователи и приглашения

Все маршруты этого раздела — OWNER текущего дома. Управление доступом требует свежей повторной аутентификации ≤10 минут.

| Метод и путь | Вход | Результат |
|---|---|---|
| GET `P/users` | active=true/false/all, limit, cursor | 200: userId, fullName, login, contactPhone, role, active, membershipVersion; без passwordHash |
| GET `P/users/{userId}` | — | 200: тот же профиль + ETag членства |
| POST `P/invitations` | login | 201: id, login, token, expiresAt; роль всегда ADMIN |
| GET `P/invitations` | limit, cursor | 200: id, login, expiresAt, acceptedAt, revokedAt; без token/hash |
| POST `P/invitations/{id}/revoke` | reason | 204; повтор отзыва 204; принятое приглашение — 409 |
| PATCH `P/users/{userId}/membership` | role? OWNER/ADMIN, active?, reason | 200: членство, новая version/ETag; нужен If-Match |

Выдача приглашения не кэширует ответ с секретом. Если ответ потерян, OWNER видит приглашение в списке, отзывает и создаёт новое. На create одновременно допустимо одно pending-приглашение на логин. Истёкшее pending-приглашение отзывается в той же транзакции перед заменой. Существующий user или действующее pending-приглашение — 409 LOGIN_UNAVAILABLE. Роль или дом в body приглашения — 422.

Создание второго OWNER через массовое редактирование user запрещено: меняется только scoped membership. Нельзя отключить последнего OWNER — 409 LAST_OWNER. Отзыв роли/членства владельца аннулирует его ещё не принятые приглашения в этой же транзакции; принятие дополнительно проверяет создателя. Списки пользователей/приглашений недоступны ADMIN.

## Дом, комнаты, места

| Метод и путь | Вход / фильтры | Доступ и результат |
|---|---|---|
| GET `/properties` | limit, cursor | Любой authenticated: только дома активного членства |
| GET `P` | — | OWNER/ADMIN, 200: Property |
| PATCH `P` | name?, address?, reason | OWNER, 200: Property; currency/timezone неизменяемы в M1 |
| GET `P/summary` | — | OWNER/ADMIN, 200: сводка M1 |
| GET `P/rooms` | archived, limit, cursor | OWNER/ADMIN, 200: Room[] с агрегатами |
| POST `P/rooms` | number, capacity | OWNER, 201: Room, Location header |
| GET `P/rooms/{roomId}` | — | OWNER/ADMIN, 200: Room с агрегатами |
| PATCH `P/rooms/{roomId}` | number?, capacity?, reason | OWNER, 200: Room |
| POST `P/rooms/{roomId}/archive` | reason | OWNER, 200: Room |
| POST `P/rooms/{roomId}/restore` | reason | OWNER, 200: Room |
| POST `P/rooms/{roomId}/beds` | placeNumber, monthlyPrice | OWNER, 201: Bed; If-Match комнаты |
| GET `P/beds` | roomId?, status?, archived, limit, cursor | OWNER/ADMIN, 200: Bed[] |
| GET `P/beds/{bedId}` | — | OWNER/ADMIN, 200: Bed |
| PATCH `P/beds/{bedId}` | placeNumber?, monthlyPrice?, reason | OWNER, 200: Bed |
| POST `P/beds/{bedId}/state` | state AVAILABLE/RESERVED/MAINTENANCE, reason | OWNER/ADMIN, 200: Bed |
| POST `P/beds/{bedId}/archive` | reason | OWNER, 200: Bed |
| POST `P/beds/{bedId}/restore` | reason | OWNER, 200: Bed |

State-команда хранит reason в audit и stateNote для RESERVED/MAINTENANCE; при AVAILABLE stateNote=null. PATCH архивных room/bed и смена состояния архивного bed — 409 ENTITY_ARCHIVED. Restore/archive возвращают 409 ALREADY_ACTIVE/ALREADY_ARCHIVED, кроме повторов того же idempotency key. Детали и история доступны в архиве. Пустая созданная комната не создаёт места автоматически.

Бизнес-ошибки: ROOM_CAPACITY_EXCEEDED, CAPACITY_BELOW_BED_COUNT, ROOM_HAS_ACTIVE_BEDS, BED_NOT_AVAILABLE, PARENT_ARCHIVED, DUPLICATE_ROOM_NUMBER, DUPLICATE_BED_NUMBER — 409; INVALID_STATE_TRANSITION — 422. Попытка менять roomId существующего места — 422 IMMUTABLE_FIELD. Фильтр `status=OCCUPIED` допустим как публичный статус и возвращает пустой список в M1.

Room: id, propertyId, number, capacity, totalBeds, availableBeds, reservedBeds, maintenanceBeds, archivedAt, version, createdAt, updatedAt. Bed: id, propertyId, roomId, placeNumber, displayNumber, status, stateNote, monthlyPrice, currency, archivedAt, version, createdAt, updatedAt. Текущий жилец/дата занятия/история проживания добавляются в M2, не возвращаются как фиктивные данные M1.

## Примеры

Создать комнату:

```http
POST /api/v1/properties/00000000-0000-4000-8000-000000000001/rooms
Authorization: Bearer <session-token>
Idempotency-Key: 10000000-0000-4000-8000-000000000001
Content-Type: application/json

{"number":"3","capacity":9}
```

Создать место в комнате версии 1:

```http
POST /api/v1/properties/00000000-0000-4000-8000-000000000001/rooms/00000000-0000-4000-8000-000000000003/beds
Authorization: Bearer <session-token>
If-Match: "1"
Idempotency-Key: 10000000-0000-4000-8000-000000000002
Content-Type: application/json

{"placeNumber":"1","monthlyPrice":"900000.00"}
```

Иллюстрация ответа сводки (числа не являются seed-данными):

```json
{
  "propertyId": "00000000-0000-4000-8000-000000000001",
  "asOf": "2026-09-25T10:00:00Z",
  "roomsCount": 7,
  "configuredBeds": 59,
  "availableBeds": 54,
  "reservedBeds": 3,
  "maintenanceBeds": 2
}
```

Это сводка настроенных мест. Полей residentsCount, debt, revenue, cameraOnline, peopleInside в M1 нет.

## История

| Метод и путь | Доступ / фильтры |
|---|---|
| GET `P/audit` | OWNER; actorUserId?, entityType?, entityId?, action?, from?, to?, limit, cursor |
| GET `P/rooms/{roomId}/history` | OWNER/ADMIN; from?, to?, limit, cursor; только события самой комнаты |
| GET `P/beds/{bedId}/history` | OWNER/ADMIN; from?, to?, limit, cursor; только события этого места |

Интервал времени `[from,to)`, RFC 3339 с offset, from < to. Событие: id, actorDisplayName, action, entityType, entityId, before, after, reason, occurredAt, requestId. ADMIN получает только allowlist событий inventory, не приглашения/auth и не произвольные записи по известному UUID. EntityId проверяется в scope дома до получения истории. Полные глобальные security logs не выдаются через API дома.

## Ошибки и health

```json
{
  "error": {
    "code": "ROOM_CAPACITY_EXCEEDED",
    "message": "В комнате уже настроены все 9 мест.",
    "fields": {},
    "requestId": "20000000-0000-4000-8000-000000000001"
  }
}
```

400 — malformed JSON; 401 — нет/истекла сессия; 403 — нет permission, CSRF_INVALID или REAUTH_REQUIRED; 404 — не существует/чужой объект; 409 — бизнес-конфликт; 412 — версия устарела; 422 — DTO/переход; 428 — нет If-Match; 429 — лимит + Retry-After; 500 — непредвиденная ошибка с requestId без внутренних деталей.

`GET /health/live` — 200 при работающем процессе; `GET /health/ready` — 200 при доступной БД и применённой нужной версии миграций, иначе 503. Ответ только `{ "status": "ok" }` или `{ "status": "unavailable" }`. Не входят в /api/v1, rate limit на proxy отдельно.

Residents, Occupancies, Payments, Debts и CameraEvents не регистрируются как пустые handlers M1. Полный OpenAPI и контрактные тесты генерируются/проверяются в ходе реализации по этому документу.
