# Tool parser rejection diagnostics: offline stage

Date: 2026-08-10.

Branch: `fix/tool-parser-rejection-diagnostics`.

Base commit: `1ca1174ba54eb9853919bd1e0accb7af7849fa3b`.

## Confirmed symptom

The controlled Claude Code 2.1.226 run produced two relevant requests. The
problem request carried 39 raw and 39 normalized tools, and its current
allowlist included `Glob`, `Grep`, and `Read`. The upstream network path
completed through `completion_start`, `completion_completed`,
`stream_received`, `stream_read`, and `stream_parsed`; no `upstream_error` was
recorded.

For request `ba3befd2c4db1b5b`, diagnostics reported nonempty reasoning and
content, no reasoning retry, `strict_tool_call_detected = false`, and
`outcome = final_text`. Claude Code displayed tool-like JSON for `Glob`, but no
real `Glob` execution occurred. Request `0487807e2b633707` had the same 39-tool
allowlist boundary and also ended as `final_text` without a strict tool call.

The UI rendering does not prove the exact upstream payload. It can omit or
transform surrounding whitespace, prose, Markdown fences, channel placement,
or other characters. The displayed JSON is therefore insufficient evidence
for changing strict parser acceptance rules.

## Shared inspection path

`inspectToolCall()` and `inspectToolCallFromOutput()` expose the decision made
by the strict parser. The existing `parseToolCall()` and
`parseToolCallFromOutput()` remain public and still return only
`toolCall | null`; they delegate to the same inspection path. There is no
second parser implementation.

The stable reasons are:

- `accepted`;
- `input_not_string`;
- `input_too_large`;
- `empty_input`;
- `invalid_json`;
- `invalid_envelope`;
- `unexpected_envelope_keys`;
- `invalid_tool_shape`;
- `invalid_tool_name`;
- `tool_not_allowed`;
- `arguments_not_object`;
- `unsafe_arguments`;
- `excessive_nesting`;
- `arguments_too_large`;
- `invalid_output` when an output container cannot be inspected;
- `not_inspected` for a diagnostic response emitted before parser execution.

No reason contains an exception message or user-controlled text.

## Current content and reasoning selection

The existing priority is unchanged:

1. A nonempty `content` is the only selected parser source, even when
   `reasoning` contains a valid strict tool call.
2. `reasoning` is selected only when `content` is empty or whitespace.
3. Invalid output containers select `none`.

Offline fixtures confirm that strict tool JSON in content is accepted even
when reasoning is nonempty. Ordinary prose in content shadows valid strict
tool JSON in reasoning and is rejected as `invalid_json`. Empty content with a
strict reasoning envelope remains accepted.

The exact visually observed fixture:

```json
{"tool_call":{"name":"Glob","arguments":{"pattern":"**/InteractiveStars.tsx"}}}
```

is accepted with `source = content` when the allowlist is
`["Glob", "Read", "Grep"]`. This confirms that the actual rejected upstream
output differed structurally from the JSON shown by the UI, or was located in
a shadowed channel.

## Safe structural metadata

When `BRIDGE_TOOL_DIAGNOSTICS=1`, `tool_response` now includes
`tool_parse_source` and `tool_parse_reason` under the existing `request_ref`.
For an accepted call, those two fields are sufficient. For a rejection, the
same record also contains only:

- `content_bytes` and `content_trimmed_bytes`;
- `reasoning_bytes` and `reasoning_trimmed_bytes`;
- `content_starts_with_brace` and `content_ends_with_brace`;
- `content_starts_with_code_fence`;
- `content_contains_tool_call_marker`;
- `reasoning_starts_with_brace` and `reasoning_ends_with_brace`;
- `reasoning_starts_with_code_fence`;
- `reasoning_contains_tool_call_marker`.

Lengths use UTF-8 byte counts, matching the parser input limit. Boolean marker
checks do not retain the matching text.

## Data that is never logged

Parser diagnostics do not log content, reasoning, substrings, prefixes,
suffixes, raw JSON, tool arguments, tool results, prompts, URLs, paths, tokens,
cookies, authorization values, session IDs, call IDs, or hashes of content and
reasoning. The accepted inspection result may contain the in-process tool call
needed by production, but the logger receives only allowlisted parse metadata.

Security regression coverage uses synthetic URL, Windows path, Bearer value,
and tool-argument path markers and verifies that none appears in the structured
diagnostic log. Logger exceptions remain observational and cannot change the
parser or HTTP response.

## Scope boundary

Parser acceptance semantics did not change. Tool-name validation, allowlist
checking, dangerous keys, maximum nesting, and byte limits are unchanged.
Retry semantics did not change, including the existing reasoning-only
condition. Streaming adapters, tool continuation, call-ID linking, and session
routing did not change.

This document records only the offline implementation and regression evidence.
No doctor, Claude Code, DeepSeek, Chrome, OpenCode, or external network test was
run in this stage. A live run requires separate explicit authorization.
