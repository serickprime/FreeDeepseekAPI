# Bounded fenced tool retry: clean live rerun

This is the clean one-session rerun after the previous invalid two-session run.

Date: 2026-08-11.

Starting commit: `9ca95cbd790232cae40207f4e769fb7434ec44f2`.

Branch: `fix/tool-parser-rejection-diagnostics`.

Node.js: `v24.12.0`.

Claude Code: `2.1.226`.

## Boundary and process guard result

- Old Claude test processes before Bridge start: 0.
- Claude test processes immediately before the run: 0.
- Foreground Claude invocations: 1.
- Prompt submissions: 1.
- Background, detached, resumed, or follow-up Claude invocations: 0.
- Bridge-observed client session refs: 1.
- Matching Claude Code process IDs observed from the single foreground
  invocation: 2.
- Maximum concurrent matching Claude Code processes: 2.
- Leftover Claude test processes after termination: 0.
- Duration before the process guard terminated the invocation: 1.62 seconds.

The invocation was started synchronously through a foreground process API and
was continuously monitored until exit. No `Start-Process`, job, detached shell,
timer, second command variant, resume, continuation, or second prompt was used
for Claude.

The guard observed two Claude-Code-matching process IDs associated with the one
foreground invocation and immediately stopped the first recorded test PID and
the foreground wrapper. Both matching PIDs then exited. Their parent/child
metadata was no longer available when queried after termination, so the
evidence does not prove that they were two independently launched sessions.
Bridge correlation shows only one process-scoped `client_session_ref`.

The strict requirement of exactly one matching Claude process was nevertheless
not met. The run was stopped before a tool-capable prompt request reached the
Bridge, and it is not a clean acceptance PASS. No second run was attempted.

## Request totals

- `/v1/messages` total: 1.
- Tool-capable requests: 0.
- Requests with `tools = 0`: 1.
- Client session count: 1.
- User task request observed by Bridge: no.
- Model-discovery request observed by Bridge: yes.
- Twelve-request limit exceeded: no.
- Ten-minute limit exceeded: no.

The only request used safe process-scoped client ref `c1cfb3a85cdb` and request
ref `f10d23aa7a14b527`. No full session ID or call ID is recorded.

## Correlated request evidence

Request `f10d23aa7a14b527`:

- `raw_tool_count = 0`;
- `normalized_tool_count = 0`;
- `Glob` present: no;
- `Read` present: no;
- `Grep` present: no;
- `is_tool_continuation = false`;
- `tool_result_count = 0`;
- `strict_tool_call_detected = false`;
- `tool_parse_source = content`;
- `tool_parse_reason = unexpected_envelope_keys`;
- `reasoning_nonempty = true`;
- `content_nonempty = true`;
- `reasoning_retry_attempted = false`;
- `fenced_tool_retry_attempted = false`;
- `repeated_tool_retry_attempted = false`;
- `tool_retry_reason = none`;
- `outcome = final_text`.

This was the tools=0 model-discovery request, not the requested read-only tool
task. Its parser outcome must not be interpreted as evidence about the task or
the fenced retry.

Safe structural metadata:

- `content_bytes = 61`;
- `content_trimmed_bytes = 61`;
- `reasoning_bytes = 1536`;
- `reasoning_trimmed_bytes = 1536`;
- `content_starts_with_brace = true`;
- `content_ends_with_brace = true`;
- `content_starts_with_code_fence = false`;
- `content_contains_tool_call_marker = false`;
- `reasoning_starts_with_brace = false`;
- `reasoning_ends_with_brace = false`;
- `reasoning_starts_with_code_fence = false`;
- `reasoning_contains_tool_call_marker = false`.

## Tool and retry evidence

- Actual tools executed: none.
- Independently proven tool sequence: none.
- `Glob` executed: no.
- `Read` executed: no.
- `Grep` executed: no.
- Tool-result continuation: not reached.
- CODE_FENCE observed: no.
- Fenced retry attempted: no.
- Fenced retry live triggered: no.
- Initial task parse reason: not available because the task request was not
  observed.
- Final parse reason after correction: not applicable.
- Raw tool JSON visible in Claude: no.
- Reasoning retry: no.
- Repeated-tool retry: no.
- Third correction completion: no.

The bounded CODE_FENCE retry remains offline verified and live not triggered.

## Network and completion evidence

The single discovery request completed this path:

`remote_session_start` -> `remote_session_created` -> `challenge_start` ->
`challenge_received` -> `wasm_download_start` -> `wasm_downloaded` ->
`wasm_compile_start` -> `wasm_compiled` -> `pow_solve_start` -> `pow_solved` ->
`completion_start` -> `completion_completed` -> `stream_received` ->
`stream_read` -> `stream_parsed`.

- Upstream completions in the observed request: 1.
- Corrected request: none.
- Network error: no.
- `upstream_error` records: 0.

## Classification and conclusion

Classification: **UNEXPECTED_FAILURE**.

Clean one-session acceptance: **FAIL**.

This run proves only that one foreground invocation created one Bridge client
ref and completed one tools=0 discovery request without a network error. It did
not reach the tool-capable task request and therefore did not validate direct
tool use, tool continuation, or fenced correction. Two matching Claude Code
process IDs appeared within the single invocation; because no independently
launched second session was proven, the result is not classified as
`INVALID_MULTI_SESSION_RUN`.

No raw prompt, reasoning, rejected content, tool arguments, tool results, local
file contents, credential, token, cookie, authorization value, full session ID,
or full call ID is included in this report.

Parser semantics changed: **NO**.

Production code changed: **NO**.

Post-live validation:

- required `node --check`: PASS;
- `git diff --check`: PASS;
- `npm.cmd test`: 174/174 PASS;
- port 9655: free;
- leftover Claude test processes: 0.
