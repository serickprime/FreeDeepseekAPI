# Результаты исследования идентичности Claude Code session

Дата проверки: 2026-07-23.
Claude Code: `2.1.217`.

## Область проверки

Выполнен ровно один запуск `scripts/claude_session_identity_probe.mjs`. Probe запустил два последовательных процесса Claude Code: первый с заранее созданным синтетическим UUID через `--session-id`, второй — с `--resume` того же Claude session ID. Каждый процесс получил отдельный случайный synthetic process ID в `x-agent-session`.

Оба процесса обращались только к временному HTTP mock-серверу на `127.0.0.1` со случайным свободным портом. Использовались фиктивный `ANTHROPIC_AUTH_TOKEN`, временная конфигурация и два небольших синтетических файла. Разрешён был только встроенный инструмент `Read`. Bridge, DeepSeek, Anthropic, OpenAI, Chrome, OpenCode, doctor и live smoke tests не запускались.

Временная папка и локальная история probe удалены после завершения. Probe завершился с exit code `0`; оба процесса Claude Code также завершились с exit code `0`.

## Безопасность результата

Значения заголовков, полный Claude session ID, prompt, system, messages, tool arguments, tool results, содержимое файлов, authorization, cookie и token не сохранялись.

Для session-подобных значений фиксировались только:

- наличие;
- тип;
- длина;
- первые 12 hex-символов HMAC-SHA-256.

HMAC salt создавалась случайно в памяти для текущего запуска и не сохранялась. Поэтому fingerprint пригоден только для сравнений внутри этого запуска и не позволяет восстановить исходное значение или сопоставлять разные запуски.

## Результат HTTP probe

Получено четыре `POST /v1/messages`:

1. первый пользовательский ход первого процесса;
2. продолжение после первого `tool_result`;
3. следующий пользовательский ход через новый процесс с `--resume`;
4. продолжение после второго `tool_result`.

`POST /v1/messages/count_tokens` не вызывался. Оба синтетических результата `Read` были связаны с ожидаемыми tool use и подтверждены только в памяти.

### Собственный Claude session header

Claude Code передавал `X-Claude-Code-Session-Id` во всех четырёх запросах.

- тип: string;
- длина: 36;
- fingerprint заголовка во всех четырёх запросах: `0e4e21446f83`;
- fingerprint совпал с заранее переданным через `--session-id` значением;
- fingerprint не изменился после `tool_result`;
- fingerprint не изменился при новом пользовательском ходе;
- fingerprint не изменился после запуска нового процесса с `--resume`.

Структурированный `stream-json` также содержал session ID: по пять безопасно распознанных значений в первом и resumed-процессе. Их общий fingerprint внутри отдельной output salt был `d66ce648cc81`. Полное значение не сохранялось.

Таким образом, Claude Code 2.1.217 уже передаёт собственный стабильный session ID в HTTP-заголовке, и он сохраняется через подтверждённый `--resume`.

### Session-подобные поля body

На верхнем уровне body поля `session_id`, `sessionId`, `conversation_id`, `conversationId` и `user_id` отсутствовали.

В `metadata` присутствовал только `user_id`:

- тип: string;
- длина: 150;
- fingerprint во всех четырёх запросах: `252f670f20bf`.

Значение было стабильным в этом probe, но его внутренний формат и назначение не исследовались. Поэтому использовать `metadata.user_id` как Claude session ID на основании этого наблюдения нельзя.

## Пользовательские заголовки

Локальный код Claude Code 2.1.217 подтверждает настройку:

```text
ANTHROPIC_CUSTOM_HEADERS
```

Формат значения — строки `Header-Name: value`, разделённые переводами строк. Probe использовал одну строку:

```text
x-agent-session: <synthetic process UUID>
```

`x-agent-session` присутствовал во всех четырёх запросах:

- первый процесс, оба запроса: fingerprint `c2e6e43915b4`;
- resumed-процесс, оба запроса: fingerprint `6f3185c05bcc`;
- внутри каждого процесса fingerprint не менялся после `tool_result`;
- между двумя процессами fingerprints различались;
- значение не появилось в stdout, безопасном результате или обычных логах в полном виде.

Это подтверждает, что `ANTHROPIC_CUSTOM_HEADERS` передаёт пользовательский заголовок в `POST /v1/messages` и сохраняет его во всех запросах одного процесса. Передача в `/v1/messages/count_tokens` фактически не проверена, потому что Claude Code не вызвал этот маршрут.

## Resume

Первый процесс получил заранее созданный UUID через `--session-id`. Это безопасный подтверждённый способ узнать Claude session ID до первого API-запроса, не извлекая его из логов или истории.

Второй процесс был запущен с `--resume` того же session ID:

- `X-Claude-Code-Session-Id` сохранился;
- структурированный session ID сохранился;
- `metadata.user_id` сохранился;
- новый synthetic process-scoped `x-agent-session` отличался от первого.

Следствие для текущего Bridge: если launcher генерирует новый `x-agent-session` при каждом процессе, resumed Claude session будет воспринята как новая Bridge session. Если launcher повторно использует старый synthetic ID, потребуется безопасное хранение и привязка к Claude session. Нативный `X-Claude-Code-Session-Id` уже решает задачу идентичности Claude session без отдельного synthetic mapping, но Bridge пока его не использует.

Автоматически сгенерированный Claude session ID без явного `--session-id` до первого запроса не проверялся.

## Можно ли генерировать process-scoped ID в launcher

Технически да: launcher может создать случайное bounded-значение до запуска Claude Code и передать его через `ANTHROPIC_CUSTOM_HEADERS`.

Но process-scoped ID имеет важное ограничение: новый процесс с `--resume` не сохранит его автоматически. Для продолжения одной Bridge session launcher должен либо безопасно переиспользовать synthetic ID, либо Bridge должен использовать нативный `X-Claude-Code-Session-Id`.

Любой принимаемый идентификатор должен:

- использоваться только на loopback-интерфейсе или считаться недоверенным;
- иметь строгий предел длины и допустимый тип;
- преобразовываться во внутренний hash/HMAC key;
- не выводиться полностью в `/v1/sessions`, логах и ошибках;
- не смешиваться с call ID, другими headers или анонимными запросами.

## Риски текущей архитектуры Bridge

### Режим A: stateless обычные пользовательские ходы

Сейчас отдельные пользовательские ходы Claude без поддерживаемого Bridge ID получают новые анонимные upstream-сессии. Claude присылает полный актуальный transcript, а tool continuation кратковременно связывается по call ID.

Плюсы:

- удалённая сессия не содержит предыдущую копию transcript;
- recap и resume определяются клиентским transcript;
- низкий риск дублирования истории.

Минусы:

- нет общей upstream-сессии между пользовательскими ходами;
- удалённый контекст и кэш не переиспользуются;
- диагностика одной Claude session сложнее.

### Режим B: стабильная Bridge session без изменения prompt strategy

Если просто начать использовать стабильный header как текущий session key, Bridge будет продолжать одну stateful DeepSeek-сессию через `parent_message_id`, но Claude продолжит отправлять полный transcript. `normalize()` преобразует весь transcript в prompt, а upstream session уже содержит предыдущие сообщения.

Результат:

- старые сообщения могут передаваться повторно;
- история может дублироваться;
- после смены задачи старый план может получить лишний вес;
- recap/resume может перестать быть префиксом ранее отправленной истории;
- простой stable session header сам по себе не исправляет длинную сессию.

Поэтому включать режим B на основании identity probe нельзя.

## Сравнение стратегий истории

| Стратегия | Преимущества | Основные риски | Recap / resume | Tool result | Необходимые тесты |
| --- | --- | --- | --- | --- | --- |
| 1. Stateless обычные ходы | Простая модель; transcript клиента — источник истины; минимальный риск дублирования | Новая upstream-сессия на каждый ход; нет долгоживущего remote context | Компактный transcript отправляется целиком в новую сессию | Продолжение текущего tool cycle сохраняется по call ID | Смена задачи, recap, два tools, потерянный/просроченный call ID |
| 2. Stable Bridge session + delta | Меньше повторной передачи; возможен remote context/cache | Сложное и чувствительное определение delta; высокий риск дублей или потери сообщений | Нужно распознавать сокращение, замену, fork и resume и делать rollover | Должен продолжать текущую remote session без повторной отправки старых results | Prefix fingerprints, recap, fork, resume, parallel turns, bounded memory |
| 3. Stable ID для корреляции, stateless upstream между пользовательскими ходами | Стабильная диагностика и привязка tool calls без дублирования полного transcript | Нужно надёжно отличать новый пользовательский ход от tool continuation | Resume сохраняет correlation ID, но создаёт новую upstream-сессию для нового хода | Call ID продолжает только незавершённый tool cycle | Границы ходов, одновременные tool results, resume, отзыв/подмена ID |
| 4. Hybrid rollover | Может переиспользовать remote context до подтверждённого recap/замены | Самая сложная state machine; неверное обнаружение rollover дублирует или теряет историю | При compaction/не-префиксе создаётся новая upstream-сессия с актуальным transcript | Последние связанные results нужно переносить один раз | Все тесты стратегии 2 плюс compaction threshold, rollover budget и recovery |

Стратегия 3 теперь имеет фактическое основание как следующий ограниченный эксперимент: стабильный нативный Claude session ID доступен, но его можно сначала использовать только для безопасной корреляции и диагностики, не продолжая одну DeepSeek session между обычными пользовательскими ходами. Это не окончательный выбор стратегии истории.

Стратегии 2 и 4 требуют отдельной модели transcript fingerprints/delta и тестов recap/resume. Простое включение stable upstream session не допускается.

## Следующий обоснованный этап

Следующий небольшой offline-этап:

1. Спроектировать отдельные понятия `client session correlation` и `upstream continuation`.
2. Добавить тесты, где один `X-Claude-Code-Session-Id` проходит через два пользовательских хода и tool continuation, но новый пользовательский ход создаёт новую upstream-сессию.
3. Проверить precedence и изоляцию между `x-agent-session`, `X-Claude-Code-Session-Id`, `metadata.user_id`, call ID и анонимными запросами.
4. Проверить spoofing, oversized/invalid headers, parallel sessions, reset и TTL.
5. Только после этого решать, следует ли поддерживать нативный header в `SessionResolver`.

Launcher, `server.js`, `SessionResolver`, upstream session strategy, retries, capability cache, delta extraction и rollover на этом этапе не менялись.

## Проверки

- `node --check scripts/claude_contract_probe.mjs` — успешно;
- `node --check scripts/claude_session_identity_probe.mjs` — успешно;
- `node --check tests/unit.test.js` — успешно;
- `git diff --check` — успешно;
- `npm.cmd test` — 123/123 успешно;
- identity probe — один запуск, успешно;
- четыре `POST /v1/messages`, два связанных read-only tool result;
- `/v1/messages/count_tokens` — не вызывался.
