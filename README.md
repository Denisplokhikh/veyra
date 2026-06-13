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
