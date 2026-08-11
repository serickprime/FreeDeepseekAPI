# Prefixed tool-like retry implementation

Date: 2026-08-11

Starting commit: `ef4af29ac946cd15a7bbf639854bcc379e5b5259`

This is an offline-only implementation. Claude Code, DeepSeek, OpenCode,
Chrome, doctor, and live-test commands were not run. Live validation after this
change has not yet been performed.

## Evidence boundary

The change is based on the process-tree live evidence for request
`10acf3cb15bc1bb4`. That request proved this selected-output structure:

- parser source: `content`;
- parser reason: `invalid_json`;
- content did not start with a code fence;
- trimmed content did not start with `{`;
- trimmed content ended with `}`;
- content contained the case-insensitive `tool_call` marker;
- a strict tool call was not detected.

The exact raw prefix is unknown and is not reconstructed or named. In
particular, this implementation does not claim that the live response used a
specific label, language, prose prefix, XML form, or bracket form. The bounded
recovery class is named `PREFIXED_TOOL_LIKE` and the diagnostic retry reason is
the deliberately generic `prefixed_tool`.

## Parser boundary

The strict parser was not changed. `parseToolCall()`,
`parseToolCallFromOutput()`, `inspectToolCall()`, and
`inspectToolCallFromOutput()` retain their existing acceptance rules and source
priority. A response with non-JSON text before an otherwise strict envelope is
still rejected at parser level as `invalid_json`.

The implementation does not strip a prefix, extract a JSON substring, search
for an envelope with a regular expression, repair JSON, remove Markdown, or
accept malformed output directly. Recovery exists only in server orchestration,
after strict rejection.

## Exact retry predicate

`shouldRetryPrefixedToolResponse()` returns true only when all of the following
are true:

1. the request has at least one allowed tool;
2. no strict `toolCall` was accepted;
3. the shared correction budget is unused (`retryCount === 0`);
4. `inspection.source === "content"`;
5. `inspection.reason === "invalid_json"`;
6. `content_starts_with_code_fence === false`;
7. `content_starts_with_brace === false`;
8. `content_ends_with_brace === true`;
9. `content_contains_tool_call_marker === true`.

It is false when any gate differs, including no tools, an accepted call, an
already-used budget, reasoning/none source, another rejection reason, a code
fence, an opening brace, no closing brace, or no marker. It is intentionally not
a general `invalid_json` retry.

## Bounded correction flow

The server keeps the existing priority and adds one separate recovery case:

1. accept a valid strict tool call;
2. recover the separately proven `CODE_FENCE` shape;
3. recover the proven `PREFIXED_TOOL_LIKE` shape;
4. recover the existing reasoning-only shape;
5. protect against an exact repeated completed tool call.

All paths share the existing `correctiveAttempted` budget. A single HTTP request
therefore performs at most the initial completion plus one correction
completion. A prefixed correction cannot be followed by a reasoning, fenced,
prefixed, or repeated-tool correction.

The prefixed path reuses the existing static strict-tool correction prompt. The
prompt contains only fixed instructions and bounded identifier-shaped allowed
tool names. It does not contain the rejected content, its unknown prefix,
reasoning, tool arguments, user prompt, or tool results. The correction uses
`MODELS['deepseek-chat']`, matching the existing correction model policy.

The correction output is inspected again by the unchanged
`inspectToolCallFromOutput()`. An accepted call follows the ordinary protocol
adapter path and becomes the normal OpenAI tool call, Anthropic `tool_use`, or
Responses function call. No handcrafted protocol call is created for this
recovery.

If the correction is not a strict accepted tool call, no third completion is
made. The rejected output and reasoning are replaced with the existing generic
`TOOL_RETRY_FAILURE_MESSAGE`, and diagnostics report `outcome = safe_failure`.
If a prefixed correction on a continuation produces the exact already-completed
call, the existing repeated-tool safe failure is used without another upstream
completion.

## Diagnostics and security

`tool_response` adds:

- `prefixed_tool_retry_attempted`, true only when this correction actually ran;
- `tool_retry_reason = prefixed_tool` for this path.

The permitted retry reasons are now `none`, `reasoning_only`, `code_fence`,
`prefixed_tool`, and `repeated_tool`. The existing
`fenced_tool_retry_attempted` remains specific to code fences.

No payload fields were added. Diagnostics still contain only the existing safe
parser metadata plus bounded booleans/enums. Tests use synthetic secrets,
arguments, paths, and reasoning to verify that the correction prompt,
structured diagnostics, logs, and successful client response do not copy the
rejected payload. A throwing logger remains observational, and functional
recovery remains available when structured diagnostics are disabled.

## Offline coverage

The focused tests cover:

- the exact true predicate and every required negative gate;
- synthetic `Tool request:` and bracket-prefixed shapes, both still
  `invalid_json` at parser level;
- one strict correction becoming a real Anthropic `tool_use`;
- failed correction returning a generic safe failure after exactly two calls;
- a correction followed by reasoning-only output without a third call;
- a correction returning an exact repeated completed continuation call without
  a second correction budget;
- strict JSON, ordinary final text, explanatory `tool_call` prose without a
  closing brace, invalid JSON starting with a brace, and brace-ending content
  without a marker;
- a prefixed `Read` after a real `Glob` tool result while retaining the linked
  upstream session and call-ID continuation behavior;
- payload isolation, diagnostics disabled, and a throwing logger;
- regression coverage for the separate `CODE_FENCE` path.

Offline test count increased from 174 to 185. The final validation result is
`185/185 PASS`.

## Unchanged areas

- strict parser semantics: unchanged;
- network retry, timeout, 429/5xx, PoW, and WASM behavior: unchanged;
- `SessionStore`, `SessionResolver`, client identity, upstream identity, and
  call-ID binding: unchanged;
- tool continuation construction and linked-session semantics: unchanged;
- API streaming and protocol adapters: unchanged;
- client code: unchanged.

The `CODE_FENCE` recovery remains a separate predicate and diagnostic reason;
it does not fall through to the prefixed predicate.
