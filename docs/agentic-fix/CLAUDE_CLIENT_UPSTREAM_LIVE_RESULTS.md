# Claude client/upstream identity: live results

Дата проверки: 2026-07-23
Commit: `68fe6a8da4279d352c052c8a9047d1fc0d408a77`
Node.js: `v24.12.0`
Claude Code: `2.1.217`

## Объём проверки

Выполнен один контролируемый read-only live-сеанс Claude Code через локальный Bridge:

- одна новая Claude Code session;
- два отдельных пользовательских хода;
- по одному настоящему `Read` tool cycle на каждый ход;
- только инструмент `Read`;
- без `x-agent-session`, resume и изменения рабочей логики Bridge;
- четыре запроса к `/v1/messages`.

Перед сеансом успешно прошли DNS- и TCP-проверки обоих используемых доменов DeepSeek. Безавторизационные Node.js fetch-запросы достигли обоих серверов и получили HTTP 403. Единственный разрешённый запуск `doctor` полностью прошёл все стадии, включая создание удалённой сессии, PoW и streaming completion.

## Identity-инварианты

В таблице используются только условные обозначения. Реальные идентификаторы и fingerprints не сохраняются.

| Запрос | Назначение | Client | Client source | Upstream | Upstream source | Tool continuation |
|---:|---|---|---|---|---|---|
| 1 | Первый пользовательский ход | C1 | `claude_header` | U1 | `anonymous` | нет |
| 2 | Tool result первого хода | C1 | `claude_header` | U1 | `tool_result` | да |
| 3 | Второй пользовательский ход | C1 | `claude_header` | U2 | `anonymous` | нет |
| 4 | Tool result второго хода | C1 | `claude_header` | U2 | `tool_result` | да |

Подтверждено:

- `client_session_ref` оставался одним и тем же C1 во всех четырёх запросах;
- U1 сохранялся только внутри первого tool cycle;
- второй обычный пользовательский ход получил новый U2, отличный от U1;
- U2 сохранился внутри второго tool cycle;
- нативный `X-Claude-Code-Session-Id` обеспечивал клиентскую корреляцию, но не превращал обычные пользовательские ходы в одну stateful upstream-сессию;
- call-ID continuation вернула каждый `tool_result` в upstream-сессию соответствующего tool call.

## Tools и ответы

- Поле `tools` присутствовало во всех четырёх запросах.
- Форма поля оставалась `array`.
- `raw_tool_count` и `normalized_tool_count` были равны 1; единственным инструментом был `Read`.
- Два ответа с tool call имели `strict_tool_call_detected = true` и outcome `tool_call`.
- Два завершающих ответа имели outcome `final_text`.
- `reasoning_retry_attempted = false`.
- `repeated_tool_retry_attempted = false`.
- Сырой JSON tool call пользователю не выводился.
- Зацикливания и запрещённых tool calls не возникло.
- Оба ожидаемых синтетических результата были получены.
- Временные read-only файлы не изменились, новые файлы в проекте не появились.

## Вывод

Live-данные подтверждают главный инвариант разделения identity: стабильная Claude client identity используется для безопасной корреляции и диагностики, а новые обычные пользовательские ходы без явного upstream opt-in остаются stateless. Stateful upstream-продолжение ограничено соответствующим tool call → tool result cycle.

## Сохраняющиеся риски

- Проверена одна версия Claude Code и один короткий двухходовый сценарий.
- Process-scoped диагностические fingerprints намеренно меняются после перезапуска Bridge.
- Явный `x-agent-session` остаётся opt-in stateful режимом с ранее зафиксированным риском дублирования полного клиентского transcript.
- Поведение при длинной сессии, recap и compaction не проверялось этим экспериментом.
- Сетевые и upstream-условия могут отличаться в последующих запусках.

## Обоснованный следующий этап

Следующий контролируемый этап — отдельная ограниченная read-only проверка длинной Claude Code session до наблюдаемого recap или compaction. Она должна повторно контролировать стабильность client identity, stateless upstream-семантику новых ходов, call-ID continuation, наличие `tools` и отсутствие повторных tool loops. Этот этап требует отдельного разрешения и не выполнялся в рамках текущей проверки.
