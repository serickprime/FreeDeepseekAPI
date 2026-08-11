# CC-009 Safe Tool Runtime Observability

Date: 2026-08-11

Finding: `CC-009`

Baseline: `259a46bd360be3540c4c7b70f52683c3dae35e35`

Status: offline implementation complete; live validation has not yet been performed.

## Purpose

The compatibility audit proved that accepted `Write` and shell calls reached
the Claude Code tool runtime, but the existing safe diagnostics could not
independently retain the selected tool name or distinguish an explicit errored
Anthropic tool result. This change adds only the minimum metadata needed to
locate that boundary. It does not classify or fix a runtime error.

## Diagnostic semantics

`selected_tool_name` is emitted on `tool_response`:

- the accepted strict tool-call name when it matches the existing bounded
  identifier policy `[A-Za-z0-9_.:-]{1,128}`;
- `none` when no strict tool call was accepted;
- `invalid` when a response is marked as an accepted call but the supplied
  diagnostic name does not satisfy that policy.

The field never contains tool arguments.

`tool_result_error_count` is emitted on `tool_request`, beside
`tool_result_count` and `is_tool_continuation`:

- for Anthropic Messages, it counts only current call-ID-linked continuation
  results whose `is_error` property is exactly the boolean `true`;
- historical `tool_result` blocks retained in a full Claude transcript are
  excluded by the same known-call filtering that defines
  `tool_result_count`;
- strings, numbers, result text, stderr-like text, and error-like words do not
  affect the count;
- OpenAI Chat Completions and Responses emit `0`, because the current
  normalized continuation path has no equivalent explicit boolean and this
  change does not infer one from payload text.

## Security boundary

The implementation does not log or inspect tool arguments, result content,
user prompts, reasoning, raw model output, paths, URLs, commands, credentials,
session IDs, call IDs, payload hashes, or payload-derived fingerprints. The
new values are one validated identifier/sentinel and one nonnegative count.

Structured records remain opt-in through `BRIDGE_TOOL_DIAGNOSTICS=1`. Logging
remains observational: a missing or throwing logger cannot change the HTTP
response, tool execution, or continuation.

## Unchanged behavior

- strict parser acceptance and rejection rules are unchanged;
- CODE_FENCE, PREFIXED_TOOL_LIKE, reasoning-only, and repeated-tool retry
  behavior and their shared correction budget are unchanged;
- SessionStore, SessionResolver, call-ID binding, and tool-result continuation
  semantics are unchanged;
- network retry, timeout, PoW, WASM, streaming, and protocol adapter behavior
  are unchanged;
- no runtime error category is inferred in production.

## Offline coverage

Focused tests cover accepted, absent, and unsafe selected names; zero, one,
and multiple Anthropic error results; strict boolean-only counting; result
text isolation; exclusion of a historical errored result from a later
continuation; OpenAI and Responses zero behavior; diagnostics disabled;
throwing logger behavior; and an end-to-end Anthropic errored continuation.

The separately authorized bounded live validation remains to be recorded in
`CC_009_SAFE_OBSERVABILITY_LIVE_RESULTS.md`.
