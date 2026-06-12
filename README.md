# Veyra

Локальное desktop-приложение в стиле Clash-клиентов: импортирует `vless://` ссылки или подписку, дает выбрать один сервер, настраивает профиль и генерирует YAML для `mihomo`.

## Структура

```text
apps/
  api/
    server.js          HTTP API, сохранение профилей, статическая раздача UI
  desktop/
    launch.js          Безопасный запуск Electron из npm-скрипта
    main.js            Electron-окно и запуск API на свободном локальном порту
  web/
    index.html         Разметка SPA
    styles.css         Интерфейс конфигуратора
    app.js             Состояние UI, импорт, генерация, сохранение
packages/
  mihomo-engine/
    index.js           Парсер VLESS, нормализация профиля, сборка YAML
data/
  profiles/            Сохраненные JSON/YAML профили
engine/
  bin/                  Положи сюда mihomo.exe
  configs/              Активный YAML для запуска
  logs/                 Runtime-логи mihomo
docs/
  ARCHITECTURE.md      Детальная архитектура
examples/
  profile.request.json Пример тела для API генерации
```

## API

```text
GET  /api/health
GET  /api/sample
POST /api/import
POST /api/parse
POST /api/generate
GET  /api/profiles
POST /api/profiles
GET  /api/profiles/:id/download
GET  /api/runtime/status
POST /api/runtime/start
POST /api/runtime/stop
GET  /api/runtime/logs
```

Пример импорта удаленной подписки:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/import -ContentType 'application/json' -Body '{"text":"https://example.com/subscription-token"}'
```

Пример генерации:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/generate -ContentType 'application/json' -Body (Get-Content examples/profile.request.json -Raw)
```

## Mihomo runtime

Положи бинарник сюда:

```text
engine/bin/mihomo.exe
```

При нажатии `Старт` интерфейс отправит текущий профиль на backend, backend соберет `engine/configs/active.yaml` и запустит:

```text
engine/bin/mihomo.exe -f engine/configs/active.yaml
```

Если бинарник лежит в другом месте, запусти сервер с переменной:

```powershell
$env:MIHOMO_BIN='C:\path\to\mihomo.exe'
node apps/api/server.js
```
