# Локальный прокси DeepSeek Web

Локальный API-прокси для **собственной** сессии DeepSeek Web. Предоставляет OpenAI Chat Completions, OpenAI Responses и Anthropic Messages на `http://127.0.0.1:9655` для OpenCode, Claude Code, Open WebUI и LiteLLM.

> Важно: это не официальный DeepSeek API. Он использует внутренние веб-эндпоинты, которые DeepSeek может изменить, ограничить или отключить. `deepseek-auth.json` даёт доступ к аккаунту: не публикуйте, не пересылайте и не коммитьте его.

## Windows 10/11: установка и запуск

1. Установите Node.js 20+ и Google Chrome.
2. В PowerShell из папки проекта запустите `npm test`.
3. Запустите `npm run auth`. В открытом отдельном профиле Chrome войдите в `https://chat.deepseek.com`, самостоятельно пройдите все проверки и отправьте `ok`. Вернитесь в PowerShell и нажмите Enter.
4. Убедитесь в состоянии: `npm run doctor`.
5. Запустите прокси: `npm start`.
6. Проверьте: `Invoke-RestMethod http://127.0.0.1:9655/health`.

### Простой запуск с интерфейсом

Дважды нажмите `START_DEEPSEEK.cmd` или выполните `npm run ui`. Лаунчер запустит прокси при необходимости и откроет мастер по адресу `http://127.0.0.1:9655/setup`. В нём можно войти в DeepSeek, запустить диагностику, выбрать доступную модель и открыть Claude Code или OpenCode с готовыми настройками.

Перед запуском агента укажите **папку проекта** вручную или нажмите «Выбрать папку…». Путь проверяется локально, после чего новое окно CLI открывается с этой папкой как рабочей. Для OpenCode мастер передаёт `opencode.json` прокси через `OPENCODE_CONFIG`, поэтому конфигурацию не нужно копировать в каждый проект.

Авторизация не получает логин или пароль, не обходит CAPTCHA/2FA и не печатает cookie/token. Профиль хранится в `.chrome-profile-deepseek`; он также исключён из Git.

## API

- `GET /health`, `GET /readyz`
- `GET /v1/models`, `GET /v1/model-capabilities`, `GET /v1/sessions`
- `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/messages`
- `POST /reset-session`

`stream: true` передаёт upstream delta в реальном времени в формате OpenAI, Responses или Anthropic. Если запрос содержит tools, служебный markup буферизуется до строгой проверки полного tool call; прокси никогда не выполняет инструмент самостоятельно. Сессия выбирается по заголовку `x-agent-session` (либо `metadata.user_id`) и создаётся заново по TTL. Upstream 429/5xx и timeout ограниченно повторяются с учётом `Retry-After`; при 401/403 повторите `npm run auth`.

Последняя live-проверка подтвердила четыре режима: `deepseek-chat`, `deepseek-reasoner`, `deepseek-chat-search`, `deepseek-reasoner-search`. Они доступны в `GET /v1/models` и в мастере запуска. Aliases `deepseek-expert` и `deepseek-v4-pro` сохранены в `GET /v1/model-capabilities`, но помечены как недоступные: текущий Web API возвращает для них пустой ответ. `deepseek-v4-pro` не является утверждением о запуске официального API-модельного ID V4 Pro.

## Инструменты

OpenAI tools, Anthropic tools и Responses function tools преобразуются в инструкцию для модели. Прокси принимает tool call только в единственной полной обёртке:

```text
<tool_call>{"name":"tool_name","arguments":{}}</tool_call>
```

Он проверяет имя, JSON и размер, затем возвращает вызов агенту. Ничего не запускается самим прокси; обычный пример JSON не считается вызовом инструмента.

## OpenCode

Скопируйте [opencode.json](opencode.json) в конфигурацию OpenCode. Base URL уже задан: `http://127.0.0.1:9655/v1`.

## Claude Code

В PowerShell, когда прокси запущен:

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:9655"
$env:ANTHROPIC_AUTH_TOKEN="local-key"
$env:CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="1"
claude --model deepseek-reasoner
```

Claude Code выполняет чтение/изменение файлов и инструменты сам; прокси лишь возвращает model-request. Реальный smoke-тест подтвердил цикл `Read → tool_result → Write` с `deepseek-reasoner`. Режим `deepseek-chat` подходит для обычных ответов, но в текущем DeepSeek Web иногда завершает агентный ход текстом о намерении вместо tool call, поэтому для Claude Code и OpenCode по умолчанию выбран reasoner.

## Безопасность

Сервер слушает только `127.0.0.1`. Внешний `HOST` заблокирован без `PROXY_API_KEY` длиной от 24 символов. CORS разрешён только для localhost и адресов `PROXY_CORS_ORIGINS`; вход ограничен `REQUEST_MAX_BYTES`, upstream имеет таймаут. Телеметрии нет. Не используйте внешний bind без защищённой сети и отдельного ключа.

## Проверки

`npm test` не обращается к DeepSeek. После авторизации и запуска сервера выполните `npm run test:live`: строгий набор проверяет auth/session, обычный ответ, сборку OpenAI SSE delta, reasoning, валидированный tool call, Responses API, Anthropic Messages и web search.
