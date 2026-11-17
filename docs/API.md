# HTTP API

Базовый адрес: `http://127.0.0.1:8787`. Все ответы — JSON, кроме статики, SSE и аудио.
Коды: `200` успех, `202` принято/в процессе, `400` неверные параметры, `401` нет авторизации,
`403` нет доступа, `404` не найдено, `409` конфликт (скан уже идёт), `500` внутренняя ошибка.

## Служебные

### `GET /api/health`

```json
{ "ok": true, "version": "2.0.0", "ai": { "agent": "DeepSeek Harness", "model": "deepseek-flash" }, "time": "..." }
```

### `GET /api/esi/status`

Состояние доступности ESI.

```json
{
  "down": false,
  "consecutiveErrors": 0,
  "lastOkAt": 1794921987804,
  "lastError": null,
  "lastErrorAt": null,
  "penaltyUntil": 0,
  "requests": 217,
  "errors": 0
}
```

### `POST /api/esi/retry`

Сбрасывает паузу, проверяет ESI через `/status/`, возвращает свежий статус.

## SSE

### `GET /api/events`

`text/event-stream`. События:

| Событие | Данные |
|---|---|
| `intel` | снапшот интелидженса (см. `/api/intel/state`) |
| `scan` | состояние скана (см. `/api/scan/status`) |
| `esi` | состояние ESI (см. `/api/esi/status`) |

Сервер шлёт `retry: 3000`, комментарий `: ping` раз в 20 секунд.
Если соединение потеряно, клиент переходит на опрос.

## Конфигурация

### `GET /api/config`

Возвращает конфиг без секретов и сводку:

- `clientId`, `callbackUrl`, `hubs`, `structures`, `capture`, `historyBudget`,
  `defaultStructureTax`, `filters`, `intel`, `server`;
- `characters[]` — `{ characterId, name, wallet, colonies, updatedAt, pending }`;
- `character` — полный профиль основного персонажа (если загружен);
- `fees`, `esiStats`, `esiStatus`, `version`, `ai`, `scan` (состояние).

### `POST /api/config`

Частичное обновление. Поля: `clientId`, `hubs`, `capture`, `historyBudget`,
`defaultStructureTax`, `filters` (`minMargin`, `minVolume`, `minPrice`, `maxPrice`),
`structures`.

## Авторизация EVE SSO

### `GET /api/auth/login`

Редирект на EVE SSO (PKCE). Открывается в браузере.

### `GET /callback`

Callback SSO. Сразу отдаёт HTML-страницу и завершает обмен кода в фоне.

### `POST /api/auth/manual`

Ручная вставка полного URL после редиректа (если браузер не смог открыть callback).

```json
{ "url": "http://127.0.0.1:8787/callback?code=...&state=..." }
```

### `GET /api/auth/status`

```json
{
  "auth": { "count": 3, "characters": [ ... ] },
  "characters": [ { "characterId": 12345678, "name": "Pilot Alpha", "wallet": 0, "pending": true } ],
  "character": { ... }
}
```

### `POST /api/auth/logout`

Тело: `{ "characterId": 12345678 }` — выйти из одного; пустое тело — из всех.

### `GET /api/auth/diagnose`

Диагностика конфигурации SSO: callback URL, наличие Client ID, состояние токенов.

### `POST /api/character/refresh`

Тело: `{ "characterId": 12345678 }` или пусто (все персонажи).
Возвращает `202 { ok: true, started: N }`, профили грузятся в фоне.

## Рынок

### `POST /api/scan`

Запускает скан. `202 { ok: true, scan: {...} }`. Если скан уже идёт — `409`.

### `GET /api/scan/status`

```json
{ "scan": { "running": true, "phase": "books", "pagesDone": 10, "pagesTotal": 120,
            "eta": 45, "message": "..." } }
```

### `GET /api/results`

```json
{ "rows": [ ... ], "meta": { "scannedAt": 179..., "locations": [ { "id": 60003760, "name": "Jita 4-4" } ] } }
```

Строка результата содержит: `key`, `typeId`, `typeName`, `locationId`, `locationName`, `kind`,
`bid`, `ask`, `spreadPct`, `marginNet`, `marginBook`, `exitPrice`, `profitUnit`, `breakEvenAsk`,
`tax`, `broker`, `volumeDay`, `iskVolumeDay`, `iskDay`, `roiDay`, `daysToSell`, `competition`,
`capital`, `depthAsk`, `volatility`, `fair`, `discountPct`.

### `GET /api/item?type=<typeId>&loc=<locationId>`

Детали по паре: стакан (до 8 уровней), история (до 365 дней), тип (объём, группа).

### `GET /api/compare?type=<typeId>`

Котировки по пяти NPC-хабам:

```json
{ "typeId": 587, "rows": [ { "hub": "Jita 4-4", "bid": 236000, "ask": 258400 } ] }
```

## Портфель

### `GET /api/portfolio?char=<characterId>`

Без `char` — основной персонаж. Если профиль ещё грузится — `202 { "pending": true }`.

```json
{
  "character": { "id": 12345678, "name": "Pilot Alpha", "wallet": 1234567890.12 },
  "summary": {
    "wallet": 1234567890.12, "escrow": 0, "ordersValue": 0, "inventoryValue": 2222222222.22,
    "realized": 3333333333.33, "boughtIsk": 1111111111, "soldIsk": 3333333333.33, "undercut": 0
  },
  "orders": [ { "orderId": 1, "typeId": 34, "typeName": "Tritanium", "locationName": "Jita 4-4",
                "isBuy": true, "price": 4.1, "bestBid": 4.12, "bestAsk": 4.34, "undercut": false,
                "deltaPct": -0.005, "volumeRemain": 100, "volumeTotal": 100, "value": 410 } ],
  "pnl": [ { "typeId": 17930, "typeName": "Worm", "boughtQty": 10, "soldQty": 50,
             "avgBuy": 61000000, "avgSell": 65045200, "realized": 202260000, "costQty": 0 } ],
  "inventory": [ { "typeId": 34, "typeName": "Tritanium", "locationId": 60003760,
                   "locationName": "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
                   "systemName": "Jita", "qty": 100000, "price": 4.12, "value": 412000 } ],
  "generatedAt": 179...
}
```

### `POST /api/portfolio/refresh`

Тело: `{ "characterId": 12345678 }` (необязательно). Сбрасывает кэш и пересобирает.

## Планетарка

### `GET /api/pi/overview?refresh=1`

`refresh=1` — принудительно обновить колонии с ESI.

```json
{
  "characters": [ { "characterId": 12345678, "name": "Pilot Alpha", "colonies": 6 } ],
  "colonies": [ { "characterId": 12345678, "characterName": "Pilot Alpha", "planetId": 40000001,
                  "planetName": "Planet IX", "systemName": "System", "pins": [ ... ],
                  "queue": [ ... ] } ],
  "queue": [ { "characterId": 12345678, "characterName": "Pilot Alpha", "planetId": 40000001,
               "planetName": "Planet IX", "pinId": 1001, "productName": "Noble Gas",
               "qtyPerHour": 3200, "expiresAt": 179..., "status": "expired" } ],
  "summary": { ... }
}
```

### `POST /api/pi/refresh`

То же, что `GET` с `refresh=1`.

## Интел

### `GET /api/intel/state`

```json
{
  "own": [ { "id": 12345678, "name": "Pilot Alpha", "systemId": 30000142, "systemName": "Jita", "online": true } ],
  "warnings": [ ... ],
  "pilots": [ { "key": "...", "names": [ { "name": "Pilot", "id": 1, "zkb": "..." } ],
                "extra": 0, "ship": "Deluge", "systemName": "Jita", "regionName": "The Forge",
                "jumps": 0, "nearest": "Pilot Alpha", "trend": "toward", "ageSec": 12, "channel": "..." } ],
  "alerts": [ ... ], "zkb": [ ... ],
  "channels": [ { "name": "southeast.imperium", "messages": 10 } ],
  "config": { "threshold": 5, "sound": true, "hasSound": false, "channels": [...], "recentMinutes": 30 },
  "stats": { "messages": 5, "pilots": 1, "events": 5, "routes": 3, "zkill": { ... } }
}
```

### `GET /api/intel/channels`

Список доступных каналов из чат-логов: `{ channels: [ { name, messages } ] }`.

### `POST /api/intel/config`

Тело: `{ "channels": ["southeast.imperium"], "threshold": 5, "recentMinutes": 30, "sound": true }`.
Любое подмножество полей.

### `POST /api/intel/refresh`

Перечитать логи и сбросить состояние интеля.

### `POST /api/intel/recalc`

Сбросить кэш маршрутов и пересчитать прыжки.

### `GET /api/intel/sound` · `POST /api/intel/sound`

`GET` — отдаёт загруженный WAV; `POST` — загрузка `{ "dataUrl": "data:audio/wav;base64,..." }`.

### `GET /api/notifier/alerts`

Единый фид для окна-нотификатора:

```json
{
  "now": 179...,
  "items": [
    { "id": "intel:<eventKey>", "type": "intel", "ts": 179..., "title": "Интел · 2 пр.",
      "text": "Pilot A, Pilot B — Jita (The Forge) · Deluge · движется к вам",
      "names": ["Pilot A", "Pilot B"], "extra": 6, "system": "Jita", "region": "The Forge",
      "jumps": 2, "ship": "Deluge", "trend": "toward" },
    { "id": "zkb:<link>", "type": "zkb", "ts": 179..., "title": "ZKB · убит",
      "text": "Pilot — Jita (The Forge) · 2 пр.", "names": ["Pilot"], "ship": "Rifter",
      "system": "Jita", "region": "The Forge", "jumps": 2, "isLoss": true },
    { "id": "pi:...", "type": "pi", "ts": 179..., "title": "Планетарка · остановлен",
      "text": "Planet IX: Noble Gas · Pilot Beta" }
  ]
}
```

## Структуры

### `POST /api/structures`

Тело: `{ "id": 1044752365771, "name": "Optional", "tax": 0.01 }` — добавляет структуру в конфиг.
Ответ: `{ "ok": true, "structures": [...] }`.
