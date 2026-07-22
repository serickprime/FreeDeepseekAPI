# Анализ проблем agentic tool calling

Документ отделяет наблюдаемые пути в коде от гипотез, которые требуют отдельного live-воспроизведения. Секреты авторизации в диагностику и фикстуры не включать.

## Подтверждено кодом

### 1. Tool call ищется только в обычном контенте

В `createProxyServer` после получения `output` вызывается `parseToolCall(output.content, allowedTools)` ([server.js](../../server.js), обработчик completion). Поле `output.reasoning` туда не передаётся. Сам `parseToolCall` принимает только строго полный `<tool_call>{…}</tool_call>` или весь JSON-конверт с `tool_call` ([lib/tool_parser.js](../../lib/tool_parser.js), `parseToolCall`).

Следствие подтверждено логикой: если модель изложила намерение вызвать `Read`, `Glob` или иной инструмент в `reasoning`, но не выдала разрешённый строгий вызов в `content`, `toolCall` равен `null`. Обычный адаптер тогда формирует `finish_reason: "stop"` ([server.js](../../server.js), `toOpenAI`), а Anthropic-адаптер сопоставляет это с `end_turn` ([server.js](../../server.js), `toAnthropic`). Поэтому агент получает завершённый текстовый ход вместо запроса на выполнение инструмента.

Это объясняет описанный пользователем инцидент «план виден, но инструмент не запущен». Точная частота и причина, по которой конкретная модель выбирает reasoning вместо конверта, требуют воспроизводимого live-фикстура.

### 2. Streaming скрывает исходную ошибку

В streaming-ветке обработчик `catch` передаёт только фиксированную строку `DeepSeek streaming request failed…` ([server.js](../../server.js), `createProxyServer`, `catch` для `input.stream`). `createProtocolStream().fail` сериализует именно это безопасное сообщение в SSE ([lib/api_stream.js](../../lib/api_stream.js), `fail`). Исходный объект ошибки, HTTP-статус и контекст не записываются локально этим путём, поэтому диагностика не видит фактическую причину.

### 3. Doctor проверяет лишь наличие auth и выдачу challenge

`scripts/doctor.js` вызывает `loadAuth`, затем один `fetch` к `/api/v0/chat/create_pow_challenge` и проверяет наличие `challenge` ([scripts/doctor.js](../../scripts/doctor.js), основной async-блок). Он не создаёт удалённую сессию, не загружает WASM, не вызывает `solvePOW`, не делает completion и не пропускает ответ через `parseStream`.

### 4. У разных клиентов возможна общая сессия `default`

При отсутствии `x-agent-session`, `metadata.user_id` и `user` ключ равен строке `default` ([server.js](../../server.js), `createProxyServer`, вычисление `sessionKey`). `SessionStore.get` возвращает одну запись для равного ключа ([lib/session.js](../../lib/session.js), `get`). Следовательно, два независимых процесса без идентификатора могут переиспользовать одну удалённую сессию и `parentMessageId`.

### 5. Локальная история почти не участвует в новом запросе

`SessionStore.add` сохраняет пары prompt/output с ограничением длины ([lib/session.js](../../lib/session.js), `add`). Однако `completeOnce` формирует payload из текущего `prompt`, идентификаторов удалённой сессии и родительского сообщения; `session.history` в payload не добавляется ([client.js](../../client.js), `completeOnce`). В текущем коде история служит для локального хранения, но не для восстановления контекста нового upstream-запроса.

### 6. Совместимость Claude Code реализована частично

Роут `/v1/messages` и Anthropic SSE существуют, но преобразование контента упрощённое: `anthropicMessageText` превращает блоки `tool_use`/`tool_result` в строки, а `toAnthropic` выдаёт минимальный набор типов содержимого ([server.js](../../server.js), `anthropicMessageText`, `toAnthropic`; [lib/api_stream.js](../../lib/api_stream.js), `anthropicStream`). Это подтверждает неполное отображение протокола, хотя не доказывает несовместимость каждой версии Claude Code.

### 7. Маршрут count_tokens отсутствует

Список маршрутов в `createProxyServer` не содержит `/v1/messages/count_tokens` или иного `count_tokens`; остальные неизвестные пути оканчиваются 404 ([server.js](../../server.js), `createProxyServer`).

## Предположения, которые надо проверить до изменения поведения

- Для каких моделей и формулировок DeepSeek стабильно помещает решение о tool call именно в `reasoning`, а не в допустимый `content`-конверт. Нужны обезличенные live-фрагменты и тестовый prompt.
- Нужен ли фактически конкретной версии Claude Code endpoint `count_tokens`, в каком точном пути и формате. Это следует подтвердить документацией версии или безопасным журналом входящих запросов.
- Будет ли один дополнительный запрос эффективнее строгого формата первого prompt и не приведёт ли он к дублированию намерений в удалённой сессии.
- Какая стратегия fallback-идентификатора сессии совместима с OpenCode, Claude Code и обычными OpenAI-клиентами. Изменять `default` без параллельных тестов рискованно.
- Полный цикл MCP/skills зависит от клиента: Bridge передаёт tool call, но сторонние MCP-серверы и сами skills в репозитории не реализованы. Их совместимость надо проверять отдельными live сценариями.
