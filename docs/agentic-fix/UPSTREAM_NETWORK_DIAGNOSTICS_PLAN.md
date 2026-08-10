# План диагностики нестабильности Bridge → DeepSeek Web

Дата: 2026-08-10.

Ветка: `fix/upstream-network-diagnostics`.

База: merge-коммит `main` `d4c92bb7c644b20c52848117f3523dd30c79036a`.

## Исходный симптом

В реальном сеансе Claude Code 2.1.217 подтверждён полный рабочий tool cycle: Claude Code передал tools, Bridge вернул строгий tool call, Claude Code выполнил `Glob`, вернул `tool_result`, после чего модель сформировала финальный ответ.

В том же запуске периодически появлялись отдельные upstream-ошибки `fetch failed` и `The operation was aborted due to timeout`. Несколько запросов `/v1/messages` могли выполняться параллельно, а прежние строки `tool_request` и `tool_response` не имели per-request correlation. Поэтому по их порядку нельзя было доказать, относится ли ошибка к основному tool cycle, его continuation или отдельному внутреннему запросу Claude Code.

Tool parser, tool continuation, client/upstream session routing и retry policy этим этапом не меняются. Исследуется только путь Bridge → DeepSeek Web.

## Request reference

Каждый входящий POST-запрос к:

- `/v1/chat/completions`;
- `/v1/messages`;
- `/v1/responses`

получает случайный 16-символьный hex `request_ref`. Он создаётся Bridge через криптографический генератор случайных байтов, существует только в памяти текущего процесса и не зависит от session ID, call ID, prompt, tool arguments или других пользовательских данных.

Один HTTP-запрос использует одинаковый `request_ref` в `tool_request`, `tool_response`, `upstream_stage` и `upstream_error`. Следующий HTTP-запрос, включая tool continuation, получает новый `request_ref`. При этом `client_session_ref` и upstream `session_ref` могут оставаться прежними согласно существующим правилам identity и call-ID linking.

`request_ref` не передаётся в DeepSeek, не добавляется в OpenAI/Anthropic payload и не возвращается клиенту. Все новые записи остаются opt-in и появляются только при `BRIDGE_TOOL_DIAGNOSTICS=1`.

## Реальные upstream stages

Диагностика использует только фактические точки выполнения:

1. `remote_session_start`;
2. `remote_session_created`;
3. `challenge_start`;
4. `challenge_received`;
5. `wasm_download_start` для владельца холодной загрузки, либо
   `wasm_wait_shared` для конкурентного ожидающего запроса, либо
   `wasm_cache_hit` для готового cache hit;
6. `wasm_downloaded`;
7. `wasm_compile_start`;
8. `wasm_compiled`;
9. `pow_solve_start`;
10. `pow_solved`;
11. `completion_start`;
12. `completion_completed`;
13. `stream_received`;
14. `stream_read`;
15. `stream_parsed`.

`remote_session_*` добавлены вокруг фактического вызова создания DeepSeek chat session. `stream_read` устанавливается непосредственно перед чтением `ReadableStream`, поэтому падение `reader.read()` однозначно отделяется от HTTP completion.

## Категории ошибок

Структурированная запись допускает только категории:

- `dns` — доказанные `ENOTFOUND` и `EAI_AGAIN`;
- `connect` — доказанные `ECONNREFUSED` и `ECONNRESET` до чтения активного stream;
- `tls` — ограниченный список известных TLS/certificate codes;
- `timeout` — `ETIMEDOUT`, `TimeoutError` или `AbortError`;
- `http` — известный HTTP status;
- `stream` — ошибка во время чтения уже полученного streaming response;
- `pow` — неклассифицированная ошибка на фактическом WASM compile/PoW solve stage;
- `unknown` — причина не доказана безопасными метаданными.

Приоритет основан только на `error.name`, безопасном `cause.code`, HTTP status и текущем stage. Сообщение cause и stack trace не записываются. Для ошибки чтения активного stream категория всегда `stream`, даже если доступен безопасный network `cause_code`.

## Формат upstream_error

Записываются только:

- `event`;
- `request_ref`;
- `stage`;
- `error_name`;
- `error_category`;
- `status`;
- `cause_code`;
- `retryable`;
- `timeout`;
- `attempt`;
- `max_attempts`.

Prompt, reasoning, content, tool definitions, arguments/results, session/call IDs, URL, headers, token, cookie, authorization, upstream response body, локальные пути и stack trace не входят в запись.

## Fetch failed

Node.js fetch часто возвращает верхнеуровневый `TypeError: fetch failed` и помещает доказуемый системный код в `error.cause.code`. Bridge переносит только безопасный код формата `A-Z0-9_` в `cause_code`. Полный `cause.message` не переносится.

Если код равен `ENOTFOUND`/`EAI_AGAIN`, категория — `dns`; `ECONNREFUSED`/`ECONNRESET` — `connect`; известный TLS code — `tls`; `ETIMEDOUT` — `timeout`. Если кода нет или он неизвестен, категория — `unknown`.

Обычный `fetch failed` не становится retryable только из-за новой диагностики. Если он был non-retryable в текущем коде, попытка остаётся единственной.

## Timeout

Существующее поведение `checked()` сохранено: `TimeoutError` и `AbortError` получают status 504 и `retryable = true`. Диагностика добавляет `error_category = timeout`, `timeout = true`, номер попытки и текущий stage. `ETIMEDOUT` также классифицируется как timeout, но его retryable-флаг не изменяется автоматически.

## Streaming response

После успешного HTTP completion Bridge фиксирует `completion_completed`, `stream_received`, затем `stream_read`. Если `ReadableStreamDefaultReader.read()` отклоняется, исходное сообщение заменяется безопасным `Upstream stream read failed`, а ошибка записывается со stage `stream_read` и category `stream`. Безопасный `cause_code` может сохраниться для анализа, но не меняет категорию и retry policy. Независимый признак `timeout` остаётся `true` для `AbortError`, `TimeoutError` и `ETIMEDOUT`, даже когда основной category остаётся `stream`.

## WASM и PoW

`lib/pow.js` по-прежнему использует глобальный `fetch`, прежний URL, прежний cache и тот же PoW-алгоритм. Shared cache entry хранит один module promise и общую фактическую фазу, а request-specific callbacks подписываются только на время ожидания. Холодный owner, concurrent waiter и warm cache hit поэтому получают разные честные стадии; shared failure передаёт обоим запросам одну фактическую WASM-фазу без общего `request_ref`.

Минимально добавлена передача безопасного `cause_code` для network failure и отдельного `upstreamStatus` для HTTP-ответа WASM. Это поле используется только диагностическим classifier и не меняет HTTP contract Bridge или retryable-правила. Неизвестная ошибка compile/solve классифицируется как `pow`; доказанный DNS/connect/TLS/timeout/HTTP сохраняет более точную категорию.

## Обычный logger

Строка `[deepseek-bridge] request error: ...` сохранена. `checked()` больше не читает и не включает произвольное upstream response body в `error.message`. Fetch exceptions преобразуются в безопасное `fetch failed` или `Upstream request timed out`, а stream-reader exceptions — в `Upstream stream read failed`; отдельно сохраняются только безопасные status/retry metadata и `cause_code`. Defence-in-depth logger удаляет HTTP/file URL, Windows/UNC и Unix-like абсолютные пути.

Клиентский API error contract не менялся: streaming и обычные ответы по-прежнему получают существующие обобщённые сообщения без внутренней диагностики.

## Retry policy

Не менялись:

- `maxRetries`;
- `Retry-After`;
- exponential backoff;
- `maxRetryDelayMs`;
- `retryable` правила;
- `resetRemoteSession`;
- session routing;
- reasoning-only и repeated-tool retries.

Новые callbacks только наблюдают каждую существующую попытку. `attempt` начинается с 1, `max_attempts` равен существующему `maxRetries + 1`. Успешный retry и исчерпание budget остаются видимыми под одним `request_ref`.

## Tools = 0

`raw_tool_count = 0` и `normalized_tool_count = 0` сами по себе не считаются дефектом. Claude Code может отправлять дополнительные внутренние `/v1/messages` без tools. `request_ref` нужен в том числе для отделения таких запросов от основного tool cycle; capability cache и автоматическое наследование старого allowlist не добавлялись.

## Offline validation перед live

Mock-тесты без сетевых запросов покрывают:

- один и разные параллельные `request_ref`;
- новый ref у tool continuation при сохранении client/upstream refs;
- отсутствие ref в API response и upstream completion options;
- DNS, connect, TLS, timeout, HTTP 403/429/500;
- WASM network и HTTP metadata;
- stream read failure;
- успешный существующий retry;
- исчерпание существующего retry budget;
- выключенную по умолчанию диагностику;
- отсутствие секретов, URL, response body и локальных путей в обоих видах журнала.

Live-проверки этим этапом не выполняются.
