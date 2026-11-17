# Конфигурация

## Где хранится

`data/config.json`. Файл создаётся при первом запуске со значениями по умолчанию,
читается через `loadConfig()`, пишется атомарно (`*.tmp` → rename).
При любом изменении запускается отложенный бэкап (см. [DATA.md](DATA.md)).

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PORT` | `config.server.port` или `8787` | порт HTTP-сервера |
| `HOST` | `config.server.host` или `127.0.0.1` | адрес прослушивания |
| `OPEN_BROWSER` | не задана | `1` — открыть браузер после старта (Windows) |

`PORT`/`HOST` имеют приоритет над конфигом.

## Поля `config.json`

### Общие

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `clientId` | string | `""` | Client ID приложения EVE (создаётся на developers.eveonline.com) |
| `callbackUrl` | string | `http://127.0.0.1:8787/callback` | Callback URL, должен совпадать с настройкой приложения |
| `hubs` | object | все `true` | Какие NPC-хабы сканировать: `jita`, `amarr`, `dodixie`, `rens`, `hek` |
| `structures` | array | `[]` | Структуры: `{ "id": 1044752365771, "name": "…", "tax": 0.01 }` |
| `capture` | number | `0.5` | Доля дневного объёма, которую считаем реалистично «своей» |
| `historyBudget` | number | `250` | Сколько пар (тип, регион) максимум обогащать историей за скан |
| `defaultStructureTax` | number | `0.01` | Ставка владельца структуры, если неизвестна |
| `server` | object | `{ port: 8787, host: "127.0.0.1" }` | Сетевые настройки |

### `filters`

| Поле | По умолчанию | Описание |
|---|---|---|
| `minMargin` | `0.02` | Минимальная нетто-маржа (2%) |
| `minVolume` | `10` | Минимальный объём в день, шт |
| `minPrice` | `100` | Минимальная цена единицы |
| `maxPrice` | `2000000000` | Максимальная цена единицы |

### `intel`

| Поле | По умолчанию | Описание |
|---|---|---|
| `chatDir` | `""` | Папка чат-логов; пусто — определяется автоматически (Windows: `Documents/EVE/logs/Chatlogs`) |
| `channels` | `[]` | Какие каналы читать (по именам файлов) |
| `threshold` | `5` | Порог прыжков «до меня» для алертов |
| `sound` | `true` | Звук при новых алертах |
| `recentMinutes` | `30` | Окно актуальности сообщений |

## Настройки в интерфейсе

Часть настроек хранится не на сервере, а в браузере (`localStorage`):

| Ключ | Где | Что хранит |
|---|---|---|
| `eveflip.auto.enabled` | Настройки → Автоскан | `"1"` — автоскан включён |
| `eveflip.auto.minutes` | Настройки → Автоскан | интервал, минуты (≥5) |
| `eveflip.auto.margin` | Настройки → Автоскан | минимальная нетто-маржа, % |
| `eveflip.presets` | Сканер → Пресеты | JSON сохранённых фильтров и сортировки |
| `eveflip.pf.char` | Портфель | id выбранного персонажа |
| `eveflip.intel.notify` | Интел | `"1"` — системные уведомления браузера |

## Пример

```json
{
  "clientId": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "callbackUrl": "http://127.0.0.1:8787/callback",
  "hubs": { "jita": true, "amarr": true, "dodixie": true, "rens": true, "hek": true },
  "structures": [{ "id": 1044752365771, "name": "Perimeter - 0.0% Neutral States Market HQ", "tax": 0.01 }],
  "capture": 0.5,
  "historyBudget": 250,
  "defaultStructureTax": 0.01,
  "filters": { "minMargin": 0.02, "minVolume": 10, "minPrice": 100, "maxPrice": 2000000000 },
  "intel": {
    "chatDir": "",
    "channels": ["southeast.imperium", "Gank-Intel"],
    "threshold": 5,
    "sound": true,
    "recentMinutes": 30
  },
  "server": { "port": 8787, "host": "127.0.0.1" }
}
```

## Как менять

- **Через интерфейс** — вкладка «Настройки» (ставка структуры, лимиты, автоскан, резервные копии)
  и панели на вкладках «Сканер»/«Интел».
- **Вручную** — отредактируйте `data/config.json` и перезапустите сервер.
- **Через API** — `POST /api/config` (частичное обновление), см. [API.md](API.md).

После изменения `clientId` или `callbackUrl` перезапустите сервер и проверьте,
что callback совпадает с настройками приложения на портале EVE.
