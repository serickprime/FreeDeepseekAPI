# Текущее поведение Bridge

Этот документ описывает код на ветке `docs/agentic-tool-fix-plan` до исправления agentic tool calling. Утверждения ниже относятся к реализации, а не к обещаниям внешнего DeepSeek Web API.

## Запуск и локальный сервер

- `npm start` запускает `node server.js` ([package.json](../../package.json), скрипт `start`). В точке входа `server.js` вызываются `assertConfig(process.env)` и `createProxyServer(...).listen(...)` ([server.js](../../server.js), основной блок в конце файла).
- `createProxyServer` обслуживает локальные маршруты `/health`, `/readyz`, `/v1/models`, `/v1/model-capabilities`, `/v1/sessions`, `/reset-session`, `/v1/chat/completions`, `/v1/responses` и `/v1/messages` ([server.js](../../server.js), функция `createProxyServer`). Ограничения привязки, CORS, ключа и размера тела задаются через `lib/security.js` и конфигурацию, создаваемую в `server.js`.
- Для панели настройки сервер создаёт `setupController`; она открывается через `/setup` и запускает локальные команды в новом терминале ([server.js](../../server.js), `createProxyServer`; [lib/setup.js](../../lib/setup.js), `createSetupController`).

## Авторизация через отдельный Chrome

- `npm run auth` запускает `scripts/auth.js`, который передаёт управление `scripts/deepseek_chrome_auth.js` ([package.json](../../package.json), скрипт `auth`; [scripts/auth.js](../../scripts/auth.js)).
- `scripts/deepseek_chrome_auth.js` создаёт профиль `.chrome-profile-deepseek`, запускает Chrome с `--remote-debugging-port` и открывает `https://chat.deepseek.com` ([scripts/deepseek_chrome_auth.js](../../scripts/deepseek_chrome_auth.js), основной async-блок, функция `chrome`). Пользователь сам проходит вход, CAPTCHA и 2FA, затем отправляет сообщение.
- Скрипт подключается к Chrome DevTools Protocol собственным классом `Cdp`, включает `Network`/`Runtime`, читает storage и cookies DeepSeek, а также перехватывает заголовки сетевых событий ([scripts/deepseek_chrome_auth.js](../../scripts/deepseek_chrome_auth.js), `Cdp`, `token`, основной async-блок).
- В `deepseek-auth.json` записываются `token`, строка `cookie`, обнаруженный `wasmUrl`, `baseUrl` и, при наличии, служебные заголовки `hif_dliq`/`hif_leim`; логин и пароль не сохраняются ([scripts/deepseek_chrome_auth.js](../../scripts/deepseek_chrome_auth.js), объект `auth` и `fs.writeFileSync`). Файл, профиль и `.env` исключены из Git ([.gitignore](../../.gitignore)).
- Клиент загружает этот файл и требует непустые `token` и `cookie` ([client.js](../../client.js), `loadAuth`). Значения используются только при построении заголовков DeepSeek ([client.js](../../client.js), `headers`).

## Сессия DeepSeek, PoW и completion

- Для локального клиента `SessionStore` хранит запись с `id`, `parentMessageId` и ограниченной историей ([lib/session.js](../../lib/session.js), класс `SessionStore`, методы `get`, `add`, `reset`). `createProxyServer` выбирает ключ из `x-agent-session`, `metadata.user_id`, `user` или значения `default` ([server.js](../../server.js), `createProxyServer`, вычисление `sessionKey`).
- При первом completion `completeOnce` создаёт удалённую Web-сессию запросом `POST /api/v0/chat_session/create` ([client.js](../../client.js), `completeOnce`, `createRemoteSession`).
- Затем тот же метод получает challenge через `GET /api/v0/chat/create_pow_challenge`, берёт `data.biz_data.challenge` и вызывает `solvePOW` с URL WASM и ограниченным временем ([client.js](../../client.js), `completeOnce`; [lib/pow.js](../../lib/pow.js), `solvePOW`).
- Completion отправляется в `POST /api/v0/chat/completion` с удалённым `chat_session_id`, `parent_message_id`, выбранной конфигурацией модели и PoW-ответом ([client.js](../../client.js), `completeOnce`). Метод `complete` ограниченно повторяет временные ошибки, соблюдает `Retry-After` и сбрасывает удаленную сессию при 401/403 ([client.js](../../client.js), `complete`, `parseRetryAfter`, `shouldRetry`).
- Режимы, которые Bridge сейчас считает доступными, определены в `SUPPORTED_MODELS`: Chat, Reasoner, Chat Search и Reasoner Search ([lib/models.js](../../lib/models.js), `SUPPORTED_MODELS`, `modelConfig`).

## Преобразование API-запросов и streaming

- `normalize` приводит OpenAI Chat Completions, OpenAI Responses и Anthropic Messages к общей структуре `{ model, stream, tools, prompt }` ([server.js](../../server.js), `normalize`, `messagesText`, `responsesText`, `anthropicMessageText`). Для Anthropic блоки `tool_use` и `tool_result` сейчас сериализуются в текст prompt, а не в отдельные нативные поля ([server.js](../../server.js), `anthropicMessageText`).
- Обычный результат DeepSeek преобразуется в OpenAI-формат функцией `toOpenAI`, затем при необходимости в Anthropic или Responses функциями `toAnthropic` и `toResponses` ([server.js](../../server.js), соответствующие функции).
- `parseStream` читает поток DeepSeek, собирает `content`, `reasoning` и `parentMessageId`, включая fragment-патчи Web API, и передаёт дельты callback-у ([client.js](../../client.js), `parseStream`, `consumeDeepSeekEvent`, `applyEvent`).
- Для локального SSE `createProtocolStream` создаёт адаптер выбранного протокола; `push` отправляет дельты, а `finish` завершает OpenAI, Anthropic или Responses последовательностью событий ([lib/api_stream.js](../../lib/api_stream.js), `createProtocolStream`, `openAIStream`, `anthropicStream`, `responsesStream`). В `createProxyServer` completion запускается асинхронно, поэтому первые SSE-события могут прийти до завершения upstream ([server.js](../../server.js), ветка `input.stream`).

## Tools и CLI-агенты

- Полученные от клиента tools включаются в prompt через `toolPrompt`; там перечислены только первые 32 допустимых описания и дано требование вернуть точный JSON tool call ([lib/tool_parser.js](../../lib/tool_parser.js), `toolPrompt`).
- После ответа сервер извлекает tool call только из `output.content` функцией `parseToolCall` и только среди имён tools текущего запроса ([server.js](../../server.js), вызов `parseToolCall`; [lib/tool_parser.js](../../lib/tool_parser.js), `parseToolCall`). Парсер принимает лишь весь ответ в `<tool_call>…</tool_call>` или целиком JSON с полем `tool_call`, ограничивает размер и не исполняет ничего.
- Если вызов валиден, `toOpenAI` формирует `tool_calls`, а streaming-адаптер буферизует текст разметки и выдаёт tool-call-событие протоколу клиента ([server.js](../../server.js), `toOpenAI`; [lib/api_stream.js](../../lib/api_stream.js), `finish`). Сам Bridge не запускает инструменты.
- OpenCode подключается как OpenAI-compatible provider с `baseURL` `http://127.0.0.1:9655/v1` ([opencode.json](../../opencode.json)). Панель запускает его с `OPENCODE_CONFIG` и выбранной моделью ([lib/setup.js](../../lib/setup.js), `createSetupController`, действие `opencode`).
- Claude Code запускается панелью с `ANTHROPIC_BASE_URL=http://127.0.0.1:9655`, локальным токеном и включённым gateway model discovery ([lib/setup.js](../../lib/setup.js), действие `claude`). README описывает эти же переменные и ручное подключение ([README.md](../../README.md), раздел Claude Code).
