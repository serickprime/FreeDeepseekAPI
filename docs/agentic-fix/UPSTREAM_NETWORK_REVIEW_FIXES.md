# Upstream network diagnostics: independent review fixes

## Scope

This follow-up addresses the three MEDIUM and two LOW findings from the
independent review of PR #3. It does not claim to fix the historical `fetch
failed` or timeout reports: neither failure was reproduced in the bounded live
runs, and their original root cause remains unknown. Retry, session, tool and
PoW calculation semantics remain unchanged.

## MEDIUM #1 — shared WASM stage correlation

- Original problem: the cached module promise captured the first request's
  `onStage`, while `client.js` emitted `wasm_download_start` even for a warm
  cache hit. Concurrent waiters could miss the real shared failure phase.
- Root cause: shared module state and request-specific diagnostic state were
  coupled in one promise closure.
- Minimal fix: the cache still owns one promise per URL, but keeps generic
  phase state and a bounded-lived observer set. A cold owner reports
  `wasm_download_start`, an in-flight waiter reports `wasm_wait_shared`, and a
  ready entry reports `wasm_cache_hit`. Shared download/compile failure carries
  only its safe factual `upstreamStage` to every waiter.
- Tests added: production `solvePOW` concurrency with one fetch/compile, warm
  cache reuse, shared download failure, shared compile failure, callback
  separation, two HTTP requests with distinct `request_ref`, and throwing
  stage callbacks.
- Remaining limitation: the first cold request still determines the timeout of
  the shared load, preserving the pre-existing cache semantics.

## MEDIUM #2 — unsafe stream logger

- Original problem: an exception from `reader.read()` retained its arbitrary
  message and could reach `[deepseek-bridge] request error: ...` with a URL or
  local path.
- Root cause: fetch errors were normalized by `checked()`, but active-stream
  read errors bypassed that boundary.
- Minimal fix: `parseStream()` now replaces a reader exception message with
  `Upstream stream read failed`, retaining only safe name/status/retry metadata
  and allowlisted `cause_code`. `safeError()` additionally redacts HTTP/file
  URLs and Windows, UNC and Unix-like absolute paths.
- Tests added: a production server request with a synthetic URL, query marker
  and Windows path verifies the ordinary logger, API response and structured
  diagnostics independently; direct logger tests cover URL/path forms and
  preserve safe operational messages.
- Remaining limitation: redaction is intentionally limited to known
  credential, URL and absolute-path forms rather than a universal PII scrubber.

## MEDIUM #3 — stream timeout evidence

- Original problem: `stream_read` correctly forced category `stream`, but the
  `timeout` boolean was derived from the category and therefore became false.
- Root cause: timeout evidence and the primary category were coupled.
- Minimal fix: a separate predicate uses only `TimeoutError`, `AbortError` and
  safe `ETIMEDOUT` code evidence. Category remains `stream` while timeout can be
  true.
- Tests added: `AbortError`, `TimeoutError`, `ETIMEDOUT` and `ECONNRESET` at
  `stream_read` verify category, timeout and cause code.
- Remaining limitation: no timeout is inferred from an arbitrary message.

## LOW #4 — printable tool names

- Original problem: arbitrary printable strings were logged as tool names
  after only control-character removal and truncation.
- Root cause: `safeToolName()` did not validate identifier syntax.
- Minimal fix: names must match `[A-Za-z0-9_.:-]{1,128}`. This retains current
  built-ins and MCP-style names such as
  `mcp__context7__resolve-library-id`; everything else becomes `invalid`.
- Tests added: built-in and MCP names remain intact, while URL, Windows path,
  credential-like, spaced and control-character values become `invalid`
  without retaining their marker.
- Remaining limitation: identifier-shaped values are treated as names; the
  Bridge does not attempt semantic secret detection.

## LOW #5 — probe isolation

- Original problem: the probe inherited user settings and exposed configured
  `context7` MCP tools, while the review document claimed otherwise.
- Root cause: the child used normal setting discovery and did not enable strict
  MCP isolation.
- Minimal fix: all probes now use the documented Claude Code 2.1.226 flags
  `--safe-mode` and `--strict-mcp-config`, with no supplied MCP configuration.
  The documentation now states the remaining admin-policy boundary.
- Tests added: argument tests require both isolation flags for all five probe
  modes. One bounded localhost `glob-read` recheck produced two requests with
  exactly `Glob` and `Read`, including the tool-result continuation; `context7`
  was absent.
- Remaining limitation: admin-managed policy settings cannot be disabled by
  these CLI flags.

## Validation

- `node --check`: changed production, probe and test files passed.
- `git diff --check`: passed.
- `npm.cmd test`: 155/155 passed.
- The isolation recheck used only the local mock Anthropic endpoint. No
  DeepSeek, doctor, Chrome, Bridge-to-DeepSeek or VPN experiment was run.
