# Upstream network diagnostics: controlled live result

## Environment

- Date: 2026-08-10
- Branch: `fix/upstream-network-diagnostics`
- Commit: `7020820fb62369e4b9a2c59d81188fce0a388d4b`
- Node.js: `v24.12.0`
- Claude Code: `2.1.226`
- Doctor: PASS. The already completed single doctor run passed auth, remote
  session creation, challenge, WASM download and compilation, PoW, completion,
  and stream parsing. Doctor was not run again.

Previous Claude 2.1.217 experiments are historical evidence and were not treated as equivalent to this 2.1.226 run.

## Experiment outcome

One new non-persistent Claude Code session and one user prompt were used in the
NOCTIS working tree. Claude Code was restricted to read-only tools. The CLI
delivered only the first line of the intended multiline prompt to the model.
The model therefore requested clarification instead of performing the requested
Glob and Read sequence. The experiment was not repeated.

The Bridge received two parallel `/v1/messages` requests:

- Total `/v1/messages`: 2
- Requests with tools > 0: 1
- Requests with tools = 0: 1

The `tools = 0` request was separate from the tool-capable request. It is treated
as an internal Claude Code request, not as a defect or as evidence that tool
capabilities should be inherited.

### Correlation by request_ref

| Request role | request_ref | Tools | Result |
| --- | --- | --- | --- |
| Internal parallel request | `864b02b744021ef5` | 0 | `final_text`; no strict tool call |
| User-facing request | `838c8d7794af661f` | `Read` | `final_text`; no strict tool call |

For both requests, the same `request_ref` appeared in `tool_request`, every
`upstream_stage`, and the matching `tool_response`. The two concurrent requests
had different references, so their interleaved stages and responses were
unambiguous without relying on log order or `client_session_ref`.

### Glob and Read

- Glob: not executed. `Glob` was absent from the normalized tools of both HTTP
  requests. There was no strict Glob detection and no Glob `tool_result`
  continuation.
- Read: advertised on the user-facing request, but not executed. The response
  had `strict_tool_call_detected = false` and `outcome = final_text`; there was no
  Read `tool_result` continuation.
- Raw tool JSON was not emitted to the Claude Code UI.
- Because no tool call occurred, this run provides no evidence about a new
  continuation `request_ref` or preservation of the originating upstream
  session reference across a tool result.

## Network diagnostics

Both request references progressed through remote session creation, challenge,
WASM download/compile, PoW solving, completion, streaming read, and stream
parsing. No `upstream_error` event was recorded.

- `fetch failed`: not reproduced.
- Timeout: not reproduced.
- Retry observed: no.
- Effect on the user-facing request: no upstream network failure occurred. The
  requested tool cycle failed to start for a separate prompt-delivery/tool-list
  reason and must not be interpreted as a network success for Glob/Read.

The evidence therefore supports conclusion D: a network error was not
reproduced in this single controlled experiment. It also confirms that
`request_ref` separates concurrent user-facing and internal requests. It does
not establish the cause of earlier `fetch failed` or timeout reports, does not
validate the complete Glob -> tool_result -> Read -> tool_result cycle on Claude
Code 2.1.226, and does not justify changing production network or retry logic.

## Decision

No production code or retry policy was changed. A future experiment, if
separately authorized, should first ensure that the complete multiline prompt
and both read-only tools reach Claude Code while retaining the one-session and
no-retry constraints. Until then, the only factually supported network decision
is to leave the current implementation unchanged.
