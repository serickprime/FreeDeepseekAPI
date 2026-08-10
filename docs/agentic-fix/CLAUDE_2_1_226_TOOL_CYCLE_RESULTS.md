# Claude Code 2.1.226 tool-cycle live result

## Classification

`TOOL_MISSING_FROM_REQUEST`

This is not `MODEL_SKIPPED_GLOB`: `Glob` was absent from the tool allowlist
received by the Bridge, so the model was never offered that tool.

## Environment and scope

- Date: 2026-08-10
- Claude Code: `2.1.226`
- Node.js: `v24.12.0`
- Branch: `fix/upstream-network-diagnostics`
- Starting commit: `66ae7a96ff9b330aa6b7a84e7733169f2226dda1`
- One new non-persistent Claude session and one single-line prompt
- No repeated prompt or second experiment

The complete single-line prompt reached Claude Code. Its response explicitly
recognized that both `Glob` and `Read` had been requested.

## Request summary

- `/v1/messages`: 4
- Requests with tools > 0: 3
- Requests with tools = 0: 1
- Tool-capable request tools: `Read` only
- `Read` calls: 2
- Tool results: 2
- `Glob`: unavailable

The first `Read` attempted to read the `src` directory and returned the expected
local `EISDIR` tool error. After that tool result, the model issued a second
strict `Read` for the requested page file. That read succeeded, and the final
answer correctly identified its default `Home` component export.

The initial tool-capable request produced a strict tool call. Each tool result
arrived in a new HTTP request with a new `request_ref`,
`is_tool_continuation = true`, and `tool_result_count = 1`. Both continuations
retained the upstream session reference of the originating tool call.

The separate parallel `tools = 0` request ended as ordinary final text. The
per-request references unambiguously separated it from the user-facing tool
cycle despite interleaved upstream stages.

## Negative observations

- Raw tool JSON: false
- `fetch failed`: false
- Timeout: false
- `upstream_error`: 0
- Retry: 0

All four upstream requests reached stream parsing. No production Bridge,
network, retry, session, or tool logic was changed. The evidence justifies a
separate offline investigation of Claude Code tool exposure; it does not
justify adding, inheriting, or synthesizing missing tools in the Bridge.
