# Архитектура

Проект разделен на пять слоев: desktop shell, фронтенд, API, движок генерации `mihomo` и runtime-управление процессом.

## 1. Desktop Shell

Путь: `apps/desktop/main.js`

Задачи:

- Запускает Electron-окно.
- Поднимает backend API на свободном локальном порту.
- Открывает интерфейс как локальное desktop-приложение.
- Закрывает API-сервер при выходе из приложения.

## 2. Frontend

Путь: `apps/web`

Задачи:

- Держит состояние профиля в браузере.
- Импортирует VLESS ссылки через API.
- Разделяет интерфейс на вкладки `Серверы` и `Настройки`.
- Позволяет выбрать один сервер из импортированной подписки.
- Скрывает детали импортированных узлов в интерфейсе и позволяет редактировать DNS, TUN, группы и правила.
- Показывает live-preview YAML.
- Отправляет профиль на сохранение и показывает список сохраненных YAML.

Фронтенд не знает деталей YAML. Он работает с нормальной JSON-моделью профиля и передает ее в API.

## 3. Backend API

Путь: `apps/api/server.js`

Задачи:

- Раздает статический интерфейс.
- Принимает JSON-запросы.
- Скачивает удаленные subscription URL для импорта.
- Вызывает `mihomo-engine`.
- Сохраняет JSON-метаданные и YAML в `data/profiles`.
- Отдает сохраненные YAML как скачиваемые файлы.
- Управляет runtime-слоем `mihomo`: пишет активный конфиг, запускает процесс, останавливает его, читает логи.

API сделан на встроенном `node:http`, поэтому проект не требует установки пакетов.

## 4. Mihomo Config Engine

Путь: `packages/mihomo-engine/index.js`

Задачи:

- `parseVlessUri` преобразует `vless://` ссылку в объект узла.
- `parseSubscriptionText` достает VLESS узлы из текста или base64-подписки.
- `buildMihomoProfile` нормализует профиль и собирает итоговый объект `mihomo`.
- `toMihomoYaml` сериализует объект в YAML с kebab-case ключами.

Движок не зависит от HTTP и DOM. Его можно переиспользовать в CLI, desktop-приложении или сервисе подписок.

## 5. Mihomo Runtime

Путь: `apps/api/mihomo-runtime.js`

Задачи:

- Проверяет наличие `engine/bin/mihomo.exe` или бинарника из `MIHOMO_BIN`.
- Записывает активный YAML в `engine/configs/active.yaml`.
- Запускает `mihomo.exe -f engine/configs/active.yaml`.
- Пишет stdout/stderr в `engine/logs/mihomo.log`.
- Возвращает статус процесса и последние логи.

## Поток данных

```text
User input
  -> apps/web/app.js
  -> POST /api/generate
  -> packages/mihomo-engine
  -> Mihomo YAML
  -> preview/save/download
```

Runtime-поток:

```text
Current profile
  -> POST /api/runtime/start
  -> packages/mihomo-engine
  -> engine/configs/active.yaml
  -> engine/bin/mihomo.exe
  -> engine/logs/mihomo.log
```

## Модель профиля

```js
{
  name: 'Mihomo VLESS Profile',
  mode: 'rule',
  mixedPort: 7890,
  socksPort: 7891,
  tun: { enabled: false },
  dns: { enabled: true, enhancedMode: 'fake-ip' },
  groups: { auto: true, fallback: true },
  rules: { bypassPrivate: true, custom: [] },
  nodes: []
}
```

## Расширение до полноценного клиента

Ближайшие точки роста:

- WebSocket или SSE для стриминга логов.
- Импорт удаленных подписок по URL с автообновлением.
- Профили политик для разных устройств.
- Валидация YAML через настоящий `mihomo -t`.
