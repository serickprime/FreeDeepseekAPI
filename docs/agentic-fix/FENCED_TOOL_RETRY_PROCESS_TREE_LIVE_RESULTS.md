# Bounded fenced tool retry: process-tree live results

This run replaces PID-count guarding with process-tree guarding. Multiple child PIDs belonging to one foreground Claude invocation are not treated as multiple sessions.

Date: 2026-08-11.

Starting commit: `4e3548ffdb40ee977d65998bdd31457c3a820729`.

Branch: `fix/tool-parser-rejection-diagnostics`.

Node.js: `v24.12.0`.

Claude Code: `2.1.226`.

## Process and session evidence

- Old Claude roots before the run: 0.
- Claude roots immediately before the run: 0.
- User-initiated foreground Claude invocations: 1.
- User prompts: 1.
- Foreground root/wrapper PID: `12060`.
- Observed descendant PIDs in the root process tree: 4.
- Maximum simultaneous Claude-matching PIDs: 2.
- Claude-matching PIDs proven to be root descendants: 2.
- Independent second Claude root: no.
- Distinct Bridge `client_session_ref` values: 1.
- Background, detached, resumed, continued, or second Claude invocations: 0.
- Run duration: 9.86 seconds.
- Foreground invocation exit code: 0.
- Hard request/time limit exceeded: no.

Safe process-tree records:

| PID | Parent PID | Name | Type | Root relationship |
| ---: | ---: | --- | --- | --- |
| `12060` | not retained | `cmd.exe` | foreground wrapper | root |
| `13328` | `12060` | `claude.exe` | Claude runtime | child of root |
| `296` | `13328` | `claude.exe` | Claude runtime | grandchild of root |

Both Claude-matching processes were descendants of the single foreground root.
The appearance of two runtime PIDs therefore did not indicate a second launch
or session and did not stop the test. The root and all observed Claude
descendants exited naturally. Leftover test Claude processes after the run: 0.

OS process count and Claude client correlation are separate facts: the one root
invocation had two matching descendant PIDs, while Bridge observed one stable
process-scoped client ref, `7abfc7afa7c1`, across both requests.

## Request summary

- `/v1/messages` total: 2.
- `tools = 0` discovery requests: 1.
- Tool-capable user-task requests: 1.
- Continuation requests: 0.
- Distinct client session refs: 1.
- `Glob` present in the task allowlist: yes.
- `Read` present in the task allowlist: yes.
- `Grep` present in the task allowlist: yes.
- `Glob` executed: no.
- `Read` executed: no.
- `Grep` executed: no.
- Proven tool sequence: none.
- Claude stream events contained no `tool_use` or `tool_result` blocks.

The task request carried 31 raw and 31 normalized tools. Tool names are safe to
record, but only the three task-relevant names are listed here. No tool
arguments or payloads are included.

## Correlated request evidence

Discovery request `d990b32f8b93c588`:

- `raw_tool_count = 0`;
- `normalized_tool_count = 0`;
- `is_tool_continuation = false`;
- `tool_result_count = 0`;
- `tool_parse_source = content`;
- `tool_parse_reason = unexpected_envelope_keys`;
- `strict_tool_call_detected = false`;
- `reasoning_nonempty = true`;
- `content_nonempty = true`;
- `reasoning_retry_attempted = false`;
- `fenced_tool_retry_attempted = false`;
- `repeated_tool_retry_attempted = false`;
- `tool_retry_reason = none`;
- `outcome = final_text`;
- upstream completions: 1.

This was an internal tools=0 discovery request and is not evidence about the
user tool task.

Tool-capable task request `10acf3cb15bc1bb4`:

- `raw_tool_count = 31`;
- `normalized_tool_count = 31`;
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
- `fenced_tool_retry_attempted = false`;
- `repeated_tool_retry_attempted = false`;
- `tool_retry_reason = none`;
- `outcome = final_text`;
- upstream completions: 1.

Safe structural metadata for the rejected task output:

- `content_bytes = 391`;
- `content_trimmed_bytes = 391`;
- `reasoning_bytes = 1369`;
- `reasoning_trimmed_bytes = 1369`;
- `content_starts_with_brace = false`;
- `content_ends_with_brace = true`;
- `content_starts_with_code_fence = false`;
- `content_contains_tool_call_marker = true`;
- `reasoning_starts_with_brace = false`;
- `reasoning_ends_with_brace = false`;
- `reasoning_starts_with_code_fence = false`;
- `reasoning_contains_tool_call_marker = false`.

The selected content was malformed tool-like final text, but it did not begin
with a code fence. The bounded `CODE_FENCE` predicate therefore did not match,
and the absence of a fenced retry is expected for this shape. Parser semantics
were not changed.

## Tool, retry, and UI evidence

- CODE_FENCE observed: no.
- Initial task parse reason: `invalid_json`.
- Fenced retry attempted: no.
- `tool_retry_reason`: `none`.
- Final parse reason after correction: not applicable; there was no correction.
- Strict task tool call detected: no.
- Upstream completions in a corrected request: not applicable.
- Maximum upstream completions in any request: 1.
- Third correction completion: no.
- Reasoning retry: no.
- Repeated-tool retry: no.
- Tool-result continuation: not reached.
- Raw tool JSON/tool-like output visible as ordinary Claude text: yes, based on
  the correlated `final_text`, tool-call-marker, and closing-brace structural
  evidence. No raw text is retained in this report.

The safe CLI summarizer recorded no real tool execution. The requested
`Glob` -> `Read` -> `Grep` chain therefore did not occur.

## Network evidence

Both requests reached `completion_completed`, `stream_received`, `stream_read`,
and `stream_parsed`. The discovery request used the initial remote-session and
WASM download/compile path; the task request used the cached WASM path.

- Network error: no.
- `upstream_error` records: 0.
- Timeout: no.
- Network retry: no.

## Classification and acceptance

Primary classification: **UNEXPECTED_FAILURE**.

Clean process-tree invocation acceptance: **PASS**.

The invocation acceptance passes because there were no old test roots, exactly
one user-initiated foreground invocation, one prompt, no independent second
root, one Bridge client ref, and the tool-capable task reached Bridge. The task
itself did not pass: malformed non-fenced tool-like output remained final text,
so no requested tool or continuation occurred.

Bounded CODE_FENCE retry live validated: **NOT_TRIGGERED**.

This is not a bounded-retry regression: the task output lacked the required
`content_starts_with_code_fence = true` signal. The bounded retry remains
offline validated and was not exercised by this final live run.

No raw reasoning, content, rejected JSON, prompt, tool arguments, file contents,
credentials, tokens, cookies, authorization values, secret environment values,
full session IDs, or full call IDs are included in this report.

Parser semantics changed: **NO**.

Production code changed: **NO**.

Post-live validation:

- required `node --check`: PASS;
- `git diff --check`: PASS;
- `npm.cmd test`: 174/174 PASS;
- port 9655: free;
- foreground root and descendants: exited;
- leftover test Claude processes: 0.
