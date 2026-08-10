# Финальный review ветки Claude long-session tools

Дата аудита: 2026-07-23

База: `origin/main` на `4b88d3958dc98ec071485f43536ea25a87fdbdf0`

Проверенная ветка: `fix/claude-long-session-tools`

## Цель ветки

Цель изменений — безопасно исследовать поведение tools в длинных Claude Code sessions, добавить выключенную по умолчанию диагностику и отделить стабильную client correlation от выбора stateful upstream DeepSeek session. Ветка не реализует capability cache, transcript delta, rollover или новые model retries.

## Production-изменения

Изменены только три production-файла:

- `server.js` использует отдельный upstream key для `SessionStore`, remote session, bind/release и reset; передаёт обе identity в безопасную диагностику;
- `lib/session_resolver.js` возвращает раздельные upstream/client identity и принимает `X-Claude-Code-Session-Id` только как bounded client correlation;
- `lib/tool_diagnostics.js` добавляет opt-in записи `tool_request`/`tool_response` с ограниченным allowlist полей.

Рабочая логика parser, tool continuation, retries, streaming adapters, DeepSeek client, launcher и `count_tokens` не изменялась этой веткой.

## Разделение identity

Upstream identity выбирается по прежним правилам:

1. `x-agent-session`;
2. `metadata.user_id`;
3. `body.user`;
4. известная связь tool-result call ID;
5. новый anonymous key.

Только upstream identity используется для `SessionStore`, `parentMessageId`, remote DeepSeek session и reset. Поэтому новые обычные Claude Code ходы без explicit upstream identity остаются stateless, а tool call → tool result продолжает только текущую upstream-сессию через call ID.

Client identity выбирается отдельно:

1. `x-claude-code-session-id`;
2. `x-agent-session`;
3. `metadata.user_id`;
4. `body.user`;
5. `unavailable`.

Client identity используется только для корреляции и диагностики. Исходное значение ограничивается 128 байтами и сразу преобразуется во внутренний SHA-256 key. Оно не используется как `SessionStore` key и не влияет на prompt, history, tools, parser, retries или remote routing.

## Безопасная диагностика

`BRIDGE_TOOL_DIAGNOSTICS=1` включает ограниченные JSON-записи; по умолчанию диагностика выключена. Существующие `session_source`/`session_ref` продолжают обозначать upstream identity. Новые `client_session_source`/`client_session_ref` обозначают только client correlation.

Оба диагностических ref являются 12-символьными process-scoped HMAC fingerprints со случайной солью Bridge. Исходные session IDs, внутренние постоянные SHA-256 keys, prompt, messages, reasoning, content, tool arguments/results, authorization, cookie, token и полные call IDs в журнал не передаются. Исключение logger перехватывается и не меняет HTTP-ответ.

Диагностика проверена для OpenAI Chat Completions, Anthropic Messages и OpenAI Responses, включая streaming. `count_tokens`, `/v1/sessions` и reset не раскрывают client identity и не получили скрытого client-wide поведения.

## Известный конфликт resolver

Сохранено прежнее поведение: если запрос содержит valid explicit upstream identity и tool-result call ID, связанный с другой upstream-сессией, explicit identity имеет приоритет.

Это поведение покрыто отдельным resolver-тестом и описано в `CLAUDE_CLIENT_UPSTREAM_IDENTITY_RESULTS.md` как риск совместимости. Оно не представлено как новая гарантия безопасности. Изменять precedence в рамках финального аудита не требуется; для этого нужен отдельный security/compatibility этап.

## Offline и contract validation

Финальный offline-набор:

- все обязательные `node --check` — успешно;
- `git diff --check origin/main...HEAD` — успешно после удаления трёх trailing spaces из исследовательского отчёта;
- `npm.cmd test` — 131/131 успешно.

В `tests/unit.test.js` добавлены resolver, diagnostics и integration-сценарии. Они подтверждают stateless новые ходы, call-ID continuation, explicit opt-in stateful mode, process-scoped fingerprints, отсутствие закрытых данных, logger isolation и сохранение OpenAI/Anthropic/Responses streaming.

Локальный contract probe Claude Code 2.1.217 против loopback mock подтвердил:

- `tools: [Read]` присутствовал и не менялся после двух последовательных `tool_result`;
- связи `tool_use`/`tool_result` сохранялись;
- два read-only результата дошли до следующих запросов;
- compaction не вызывалась и не имитировалась.

Identity probe подтвердил стабильный нативный `X-Claude-Code-Session-Id` через tool result и отдельный процесс с resume. Probe не использовал значение header для upstream routing.

## Live validation

Подтверждено:

- в 12-ходовой диагностике tools присутствовали во всех 17 запросах и сохраняли форму/состав;
- пять tool calls получили связанные tool results;
- двухходовый live-сценарий сохранил C1, использовал отдельные U1/U2 для обычных ходов и вернул каждый tool result в соответствующий upstream cycle;
- минимальная проверка Claude Code 2.1.217 успешно выполнила `Read` → `tool_result` → правильный финальный ответ;
- существующие doctor-проверки проходили remote session, PoW, completion и streaming.

Опровергнуто для проверенных сценариев:

- tools обязательно исчезают после обычного tool result;
- `X-Claude-Code-Session-Id` автоматически делает обычные ходы stateful;
- observed final text без `Read` был следствием отсутствующего или пустого tools allowlist.

## Непроверенное и ограничения

- Явный recap/compaction не удалось воспроизводимо достигнуть в установленных безопасных лимитах.
- Наличие tools, client correlation и новый `Read` после настоящей compaction остаются непроверенными.
- DeepSeek дважды возвращал обычный `final_text` без строгого обязательного `Read`, хотя актуальный allowlist tools присутствовал. Это классифицировано как `MODEL_SKIPPED_TOOL` и не подтверждено как ошибка Bridge.
- Explicit stateful режим может дублировать полный transcript поверх remote history, если клиент повторно присылает всю историю.
- Process-scoped links и diagnostics не переживают перезапуск Bridge.
- Проект зависит от внутреннего DeepSeek Web API.

Capability cache не добавлялся, потому что contract и live evidence показывали присутствующий и стабильный список tools. Новые retries не добавлялись, потому что существующие коррекции уже ограничены, а stochastic `MODEL_SKIPPED_TOOL` не даёт безопасного критерия для ещё одной попытки.

## Аудит probe scripts

- `scripts/claude_contract_probe.mjs` — исследовательский loopback contract probe;
- `scripts/claude_session_identity_probe.mjs` — исследовательский loopback identity probe;
- `scripts/claude_long_session_live_probe.mjs` — ограниченный ручной live-orchestrator для уже запущенного локального Bridge.

Probe scripts не включены в `npm test` как live-команды: unit-тесты импортируют только их безопасные функции. Mock-серверы слушают `127.0.0.1`, имеют request/body/time limits и очищают временные данные. Live-orchestrator запускается только явно, имеет предел ходов, запросов и времени и удаляет временную папку. Скрипты следует сохранить как исследовательские инструменты, не добавляя их в обычные npm-команды и не позиционируя как пользовательский workflow.

## Security и merge compatibility

Tracked-файлы и diff проверены без вывода совпавших значений. Auth-файл, `.env`, Chrome profile, журналы и реальные credentials в ветку не добавлены. Полные live session/call IDs, пользовательские пути, содержимое файлов и полные диагностические журналы отсутствуют.

Read-only `git merge-tree` не обнаружил конфликтов с актуальным `origin/main`. Local `main` не изменялась и совпадает с `origin/main`.

## Готовность

После исправления документационных блокеров, полного offline-набора, повторного security scan и проверки PR diff ветка готова к pull request в `main`.

Merge и auto-merge этим review не разрешаются.
