# Результаты этапа 8

Дата: 2026-07-22. Ветка: `fix/agentic-tool-loop`.

## Обновлённая документация

Изменён пользовательский `README.md` и добавлен этот итоговый отчёт. Рабочий код, тесты, scripts, конфигурации CLI и панель не менялись.

README теперь описывает:

- назначение Bridge и зависимость от внутреннего DeepSeek Web API;
- требования Windows 10/11, Node.js 20+, Chrome и собственного аккаунта;
- скачивание ZIP, запуск `START_DEEPSEEK.cmd`, авторизацию и панель;
- полный состав `npm run doctor`, а не только проверку auth-файла;
- четыре доступных режима Chat/Reasoner с вариантами Search;
- недоступность Expert и V4 Pro;
- запуск Claude Code и OpenCode через панель и вручную;
- подключение другого OpenAI-совместимого клиента;
- актуальные OpenAI, Responses, Anthropic, model/session/health маршруты;
- streaming SSE;
- tool call и tool result для всех трёх протоколов;
- один ограниченный reasoning-only retry без третьей попытки;
- изоляцию сессий и продолжение tool result по call id;
- локальный приблизительный `POST /v1/messages/count_tokens`;
- безопасность auth-файла, Chrome-профиля, loopback, CORS и внешнего API-ключа;
- диагностику типичных ошибок;
- отдельный невыполненный live-чек-лист перед merge.

## Явно указанные ограничения

- Bridge не является официальным DeepSeek API.
- DeepSeek может изменить внутренние маршруты, PoW, WASM, лимиты и сессии.
- Финальная live-проверка Claude Code/OpenCode после изменений этапов 3–7 ещё не завершена.
- Offline-тесты подтверждают протоколы и логику Bridge, но не заменяют реальную проверку аккаунта и CLI.
- Bridge не выполняет tools, MCP или команды самостоятельно.
- Сторонние MCP и skills настраиваются в CLI, а полная совместимость каждого MCP не гарантируется.
- Token count является локальной приблизительной оценкой и не считается официальным токенизатором или значением для биллинга.
- `deepseek-expert` и `deepseek-v4-pro` не объявлены рабочими.

## Что подтверждено offline

Последний набор `npm test` до документационного коммита содержит 93 успешных теста. Он подтверждает:

- обычные и streaming ответы OpenAI, Anthropic Messages и Responses;
- строгий parser tool call и отклонение неизвестных/повреждённых/опасных вызовов;
- единственный ограниченный retry reasoning-only результата;
- передачу tool result и продолжение mock-модели во всех трёх протоколах;
- два последовательных инструмента без смешивания call id и arguments;
- разделение явных и анонимных сессий;
- временное продолжение по `tool_call_id`, `tool_use_id` и `call_id`;
- безопасные ошибки и редактирование секретов;
- локальный `count_tokens`, CORS, авторизацию, лимит тела и отсутствие обращения к `completeImpl`/SessionStore;
- mock-диагностику каждого этапа doctor.

## Что ранее подтверждал doctor

На этапе 2 реальный doctor успешно проходил загрузку auth, доступность DeepSeek Web, создание отдельной удалённой сессии, PoW challenge, загрузку/компиляцию WASM, решение PoW, completion, streaming, разбор SSE и диагностический маркер.

Последний разрешённый запуск doctor на этапе 5 имел другой результат: публичный хост вернул HTTP 403 и подтвердил сетевую доступность, но создание внутренней сессии завершилось `fetch failed`. Поэтому последующий `npm run test:live` не запускался. Эта более новая незавершённая проверка явно указана в README.

## Что пока не подтверждено live

- реальный DeepSeek tool-result цикл после всех последних изменений;
- актуальный полный запуск `npm run test:live`;
- чтение файла и продолжение после tool result в Claude Code после этапов 3–7;
- такой же цикл OpenCode;
- два последовательных реальных CLI-инструмента;
- изоляция двух реальных параллельных CLI-сессий;
- совместимость каждого стороннего MCP-сервера;
- автоматическое обращение Claude Code 2.1.216 к `count_tokens` в длительном реальном сеансе.

## Точные команды финальной ручной проверки

В чистом рабочем дереве и только с собственным аккаунтом:

```powershell
npm run doctor
npm run test:live
claude --version
opencode --version
```

Подготовка двух отдельных тестовых папок из корня Bridge:

```powershell
$bridgeRoot = (Get-Location).Path
$claudeProbe = Join-Path $env:TEMP "deepseek-bridge-claude-probe"
$openCodeProbe = Join-Path $env:TEMP "deepseek-bridge-opencode-probe"
New-Item -ItemType Directory -Path $claudeProbe -Force
New-Item -ItemType Directory -Path $openCodeProbe -Force
Set-Content -LiteralPath (Join-Path $claudeProbe "marker.txt") -Value "CLAUDE_MARKER_2026" -Encoding utf8
Set-Content -LiteralPath (Join-Path $openCodeProbe "marker.txt") -Value "OPENCODE_MARKER_2026" -Encoding utf8
```

Claude Code можно запустить через панель в `$claudeProbe` либо вручную:

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:9655"
$env:ANTHROPIC_AUTH_TOKEN="local-key"
$env:CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="1"
Set-Location $claudeProbe
claude --model deepseek-reasoner
```

OpenCode можно запустить через панель в `$openCodeProbe` либо вручную:

```powershell
$env:OPENCODE_CONFIG=(Join-Path $bridgeRoot "opencode.json")
Set-Location $openCodeProbe
opencode --model deepseek-web/deepseek-reasoner
```

После успешных команд:

1. Создать отдельную временную папку Claude Code и записать в `marker.txt` уникальный маркер.
2. Запустить Claude Code через панель в этой папке.
3. Попросить прочитать `marker.txt`; проверить настоящий tool call, возвращённый tool result и продолженный финальный ответ.
4. Попросить сначала получить список файлов, затем прочитать `marker.txt`; проверить два последовательных инструмента.
5. Повторить в отдельной папке OpenCode с другим маркером.
6. Запустить два независимых тестовых сеанса с разными маркерами и проверить отсутствие смешивания контекста.

Тестовые папки не должны содержать пользовательские проекты. Нельзя разрешать удаление, установку пакетов или сетевые команды.

## Перед merge в main

1. Убедиться, что `git status` чистый и ветка синхронизирована с GitHub.
2. Проверить, что `deepseek-auth.json`, `.env` и `.chrome-profile-deepseek` игнорируются и отсутствуют в diff.
3. Успешно выполнить `npm test`.
4. После отдельного разрешения выполнить описанный выше doctor/live/CLI-чек-лист.
5. Если live-проверка выявит ошибку, исправлять её отдельным этапом и отдельным коммитом, не меняя документацию задним числом.
6. Сверить README с фактическими live-результатами.
7. Только после отдельного разрешения пользователя создавать pull request или выполнять merge в `main`.

На этапе 8 merge и pull request не выполнялись.
