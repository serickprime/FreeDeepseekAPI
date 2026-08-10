# Tool parser rejection diagnostics: live results

Date: 2026-08-10.

Node.js: `v24.12.0`.

Claude Code: `2.1.226`.

Branch: `fix/tool-parser-rejection-diagnostics`.

Starting commit: `0c75ace75d5908f842847124e26659202aac689e`.

## Test boundary

- Claude sessions: 1.
- User prompts: 1.
- `/v1/messages` requests: 1.
- Tool-capable requests: 1.
- Requests with `tools = 0`: 0.
- The prompt requested a read-only `Glob` -> `Read` -> `Grep` workflow.
- No prompt was repeated and no follow-up was sent.
- The ten-minute and twelve-request limits were not reached.

The only request carried 39 raw tools and 39 normalized tools. `Glob`, `Read`,
and `Grep` were all present in the normalized allowlist. No tool was actually
executed because the response remained ordinary final text. Tool-like JSON was
visible in Claude Code as ordinary fenced text rather than as a normal tool
display.

## Correlated request evidence

Request `435017840edd2d00`:

- `raw_tool_count = 39`;
- `normalized_tool_count = 39`;
- `Glob` present: yes;
- `Read` present: yes;
- `Grep` present: yes;
- `is_tool_continuation = false`;
- `tool_result_count = 0`;
- `tool_parse_source = content`;
- `tool_parse_reason = invalid_json`;
- `strict_tool_call_detected = false`;
- `reasoning_nonempty = true`;
- `content_nonempty = true`;
- `reasoning_retry_attempted = false`;
- `repeated_tool_retry_attempted = false`;
- `outcome = final_text`.

Safe rejection metadata:

- `content_bytes = 91`;
- `content_trimmed_bytes = 91`;
- `reasoning_bytes = 1407`;
- `reasoning_trimmed_bytes = 1407`;
- `content_starts_with_brace = false`;
- `content_ends_with_brace = false`;
- `content_starts_with_code_fence = true`;
- `content_contains_tool_call_marker = true`;
- `reasoning_starts_with_brace = false`;
- `reasoning_ends_with_brace = false`;
- `reasoning_starts_with_code_fence = false`;
- `reasoning_contains_tool_call_marker = false`.

No raw content, reasoning, tool arguments, prompt text, local path, credential,
authorization value, or full session identifier was recorded in this report.

## Network and retry evidence

The request completed the expected upstream path:

`remote_session_start` -> `remote_session_created` -> `challenge_start` ->
`challenge_received` -> `wasm_download_start` -> `wasm_downloaded` ->
`wasm_compile_start` -> `wasm_compiled` -> `pow_solve_start` -> `pow_solved` ->
`completion_start` -> `completion_completed` -> `stream_received` ->
`stream_read` -> `stream_parsed`.

- Network error: no.
- `upstream_error`: none.
- Parser/reasoning retry: no.
- Repeated-tool retry: no.

## Classification and conclusion

Classification: **CODE_FENCE** (`invalid_json`).

The live evidence proves that the rejected `content` was not a clean strict
JSON document. It began with a Markdown code fence, contained a tool-call
marker, did not begin or end with a brace, and was therefore rejected by
`JSON.parse` as `invalid_json`. The visually JSON-like rendering did not expose
this structural wrapper. The `Glob` allowlist and upstream network path were
both correct; the failure occurred before the Anthropic tool protocol adapter.

This run does not support a content/reasoning-priority change: the reasoning
signals do not indicate a tool-like envelope. It does provide evidence for a
separately authorized next-stage decision between narrowly handling fenced
tool output and a bounded retry. No parser, retry, streaming, or session
semantics were changed during this live stage.
