# Разделение client identity и upstream identity

Дата: 2026-07-23.

## Цель этапа

Разделить безопасную корреляцию запросов одной Claude Code session и выбор stateful DeepSeek session. Нативный `X-Claude-Code-Session-Id` должен помогать диагностировать одну клиентскую сессию, но не должен автоматически продолжать remote session между обычными пользовательскими ходами.

Этап выполнен только offline. Claude Code, Bridge против DeepSeek, doctor, live smoke, OpenCode, Chrome и внешние запросы не запускались.

## Две независимые identity

`SessionResolver.resolve()` теперь возвращает:

- `upstreamKey`;
- `upstreamSource`;
- `clientKey`;
- `clientSource`;
- `callIds`.

### Client identity

Client identity используется только для корреляции и безопасной диагностики.

Приоритет валидных значений:

1. `x-claude-code-session-id` → `claude_header`;
2. `x-agent-session` → `explicit_header`;
3. `metadata.user_id` → `explicit_metadata`;
4. `body.user` → `explicit_user`;
5. отсутствие значения → `unavailable`.

Принимаются только непустые строки размером не более 128 байт. Числа, объекты, пустые, пробельные и слишком длинные значения отклоняются. Имя Claude header читается в нижнем регистре, как его предоставляет Node.js.

Исходное значение сразу преобразуется в внутренний SHA-256 key. Исходное значение и постоянный digest не передаются диагностике и не возвращаются через HTTP.

Client identity не используется для `SessionStore`, remote DeepSeek session, `parentMessageId`, prompt, history, tools, parser или retries.

### Upstream identity

Upstream identity сохраняет прежний routing:

- валидный `x-agent-session`, `metadata.user_id` или `body.user` явно включает stateful upstream session;
- известный tool result call ID продолжает связанную upstream session;
- без explicit identity и известного call ID каждый запрос получает новый anonymous upstream key.

`x-claude-code-session-id` не входит в upstream candidates.

Только `upstreamKey` используется для:

- `SessionStore`;
- remote DeepSeek session и `parentMessageId`;
- `resolver.bind()`, `resolver.release()` и `resolver.releaseSession()`;
- `/reset-session` по прежним upstream-правилам.

`/v1/sessions` и reset API не раскрывают client identity и не получили client-wide reset.

## Обычная Claude Code session

Offline HTTP-сценарий использовал один `X-Claude-Code-Session-Id` и четыре streaming-запроса:

1. обычный пользовательский ход и `Read` tool call;
2. связанный `tool_result` и финальный текст;
3. новый обычный пользовательский ход и новый `Read` tool call;
4. второй связанный `tool_result` и финальный текст.

Подтверждено:

- `client_session_ref` одинаков во всех четырёх запросах;
- запросы 1 и 2 используют один upstream `session_ref`;
- запросы 3 и 4 используют второй upstream `session_ref`;
- upstream refs первого и второго пользовательских ходов различаются;
- источники upstream последовательно равны `anonymous`, `tool_result`, `anonymous`, `tool_result`;
- объекты `SessionStore` различаются между обычными пользовательскими ходами;
- новый полный transcript не отправляется в старую remote session;
- tool continuation отправляет bounded continuation prompt вместо полного transcript;
- строгий parser вернул оба `Read` как настоящие Anthropic `tool_use`;
- streaming lifecycle завершился штатно.

Таким образом, новый пользовательский ход без explicit upstream identity остаётся stateless, а tool call → tool result продолжает связанную upstream session по call ID.

## Явный stateful режим

Отдельный offline-сценарий передал одновременно:

- `X-Claude-Code-Session-Id`;
- `x-agent-session`.

Client identity выбрана из Claude header, upstream identity — из `x-agent-session`. Два обычных пользовательских хода получили один объект `SessionStore`, как и до этапа.

Этот режим остаётся явным opt-in. Он сохраняет существующий риск: если клиент повторно присылает полный transcript, одна stateful DeepSeek session может получить старую историю повторно. Этап не меняет prompt/history strategy explicit-режима.

## Конфликт explicit identity и tool result

До изменения resolver отдельный тест зафиксировал существующий приоритет: валидный explicit upstream identity выбирается раньше call-ID link.

Если запрос содержит explicit upstream ID, но tool result call ID связан с другой upstream session, explicit identity побеждает. Это может привести к тому, что результат не будет распознан как известное продолжение в выбранной session. Поведение сохранено для совместимости и не исправлялось молча. Для изменения нужен отдельный security/compatibility этап.

## Диагностика

Существующие поля не изменили смысл:

- `session_source` — источник upstream identity;
- `session_ref` — process-scoped HMAC fingerprint upstream key.

Добавлены:

- `client_session_source`;
- `client_session_ref`.

Допустимые client sources:

- `claude_header`;
- `explicit_header`;
- `explicit_metadata`;
- `explicit_user`;
- `unavailable`.

Для `unavailable` выбран стабильный контракт: `client_session_ref: null`.

Для доступной client identity `client_session_ref` — первые 12 hex-символов HMAC-SHA-256 от внутреннего client key со случайной salt текущего процесса Bridge. Он стабилен только внутри запуска, различается при другой process salt и не раскрывает исходное значение или постоянный SHA-256 digest.

## Offline-инварианты безопасности

Тесты подтверждают:

- одинаковый Claude ID создаёт одинаковый client key;
- разные Claude IDs создают разные client keys;
- исходный ID не входит в client key;
- invalid Claude headers отклоняются;
- Claude header не становится upstream key;
- два обычных хода одной Claude session получают разные anonymous upstream keys;
- tool result возвращается к связанному upstream key;
- client key при continuation остаётся тем же;
- `x-agent-session`, `metadata.user_id` и `body.user` сохраняют upstream-поведение;
- Claude header имеет client-приоритет над другими client candidates;
- logger exception не ломает запрос;
- одинаковые process salt и client key дают одинаковый fingerprint;
- разные process salts дают разные fingerprints;
- полный client ID, постоянный digest, explicit IDs, authorization, cookie, token, prompt, message text и tool payloads не попадают в диагностическую запись.

## Что намеренно не менялось

Не менялись:

- launcher и команды запуска Claude Code;
- автоматическая установка `ANTHROPIC_CUSTOM_HEADERS`;
- `SessionStore`;
- prompt и нормализация transcript;
- tool parser и allowlist;
- tool continuation;
- retries;
- capability cache;
- delta extraction;
- rollover/recovery;
- streaming adapters;
- `/v1/sessions`;
- рабочая логика DeepSeek client.

## Сохраняющиеся риски

- Явный stateful режим может дублировать полный transcript поверх remote history.
- Конфликт explicit upstream ID и call-ID link по-прежнему отдаёт приоритет explicit ID.
- Client correlation живёт только в диагностике; она не решает recap/compaction сама по себе.
- Настоящее поведение после compaction всё ещё не воспроизведено.

## Следующая проверка

После отдельного разрешения нужен один контролируемый read-only live-сеанс Claude Code с `BRIDGE_TOOL_DIAGNOSTICS=1`:

1. два обычных пользовательских хода одной Claude session;
2. по одному tool call/tool result в каждом ходе;
3. без `x-agent-session`;
4. неизменный `client_session_ref` на всех запросах;
5. отдельный upstream `session_ref` для каждого пользовательского хода;
6. сохранение upstream ref только внутри соответствующего tool cycle;
7. отсутствие prompt, identifiers и tool payloads в журнале.

До успешной проверки не следует добавлять stateful routing по Claude header, delta extraction или rollover.

## Проверки этапа

- `node --check server.js` — успешно;
- `node --check lib/session_resolver.js` — успешно;
- `node --check lib/tool_diagnostics.js` — успешно;
- `node --check tests/unit.test.js` — успешно;
- `git diff --check` — успешно;
- `npm.cmd test` — 131/131 успешно.
