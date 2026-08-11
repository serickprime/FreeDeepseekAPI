# Bounded prefixed tool retry: live results

This is the single process-tree guarded live validation after the bounded PREFIXED_TOOL_LIKE recovery implementation.

Date: 2026-08-11.

Starting commit: `54791a4e5e86b5ef8a7adfd7238787680e43ba87`.

Branch: `fix/tool-parser-rejection-diagnostics`.

Node.js: `v24.12.0`.

Claude Code: `2.1.226`.

## Test boundary

- Old Claude test roots before Bridge start: 0.
- Claude runtime processes immediately before the invocation: 0.
- User-initiated foreground Claude invocations: 1.
- User prompts: 1.
- Background, detached, resumed, continued, or follow-up Claude invocations: 0.
- Distinct Bridge `client_session_ref` values: 1.
- `/v1/messages` requests: 5, below the limit of 12.
- Invocation duration: 31.93 seconds, below the ten-minute limit.
- Foreground invocation exit code: 0.
- Hard request or time limit exceeded: no.

The single prompt was a read-only task requiring the ordered
`Glob` -> `Read` -> `Grep` flow. The prompt text, tool arguments, tool results,
and file contents are not retained in this report.

## Process-tree evidence

- Foreground root/wrapper PID: `21312` (`cmd.exe`).
- Observed descendant PIDs over the invocation lifetime: 12.
- Unique Claude runtime descendant PIDs observed over time: 4.
- Maximum simultaneous Claude-matching descendant PIDs: 2.
- Independent second Claude root: no.
- All observed Claude runtime PIDs were descendants of root `21312`.
- Root and descendants exited naturally.
- Leftover test Claude processes after the run: 0.

Safe runtime relationships:

| PID | Parent PID | Name | Relationship |
| ---: | ---: | --- | --- |
| `21312` | not retained | `cmd.exe` | foreground root/wrapper |
| `10264` | `21312` | `claude.exe` | root child |
| `10020` | `10264` | `claude.exe` | root grandchild |
| `12040` | `10264` | `claude.exe` | root grandchild |
| `18360` | `10264` | `claude.exe` | root grandchild |

The four runtime PIDs were observed at different points in the same tree; at
most two were simultaneous. PID count is not treated as session count. No
Claude runtime outside the root tree appeared during the invocation.

Bridge wrapper PID was `12240`; the verified listener was `node server.js` PID
`14188`. Both Bridge and Claude trees were gone after cleanup, and port 9655 was
free.

## Request summary

- `/v1/messages` total: 5.
- `tools = 0` discovery requests: 1.
- Tool-capable requests: 4.
- Tool-result continuation requests: 3.
- Distinct Bridge client refs: 1 (`c01fefe245a0`).
- `Glob` allowed: yes.
- `Read` allowed: yes.
- `Grep` allowed: yes.
- `Glob` executed: yes.
- `Read` executed: yes.
- `Grep` executed: yes.
- Proven tool sequence: `Glob` -> `Read` -> `Grep`.
- Corresponding Claude lifecycle `tool_result` events: 3.

The safe Claude stream summary recorded the three tool-use names in that order
and three corresponding tool-result events. Raw tool arguments, result values,
file contents, full call IDs, and full session IDs are omitted.

## Correlated request evidence

All requests used process-scoped client ref `c01fefe245a0`.

Internal discovery request `fa988ac5d29b0298`:

- raw / normalized tools: 0 / 0;
- continuation: no;
- tool results: 0;
- parse source / reason: `content` / `unexpected_envelope_keys`;
- strict tool call: no;
- reasoning / content nonempty: yes / yes;
- reasoning / fenced / prefixed / repeated retries: no / no / no / no;
- retry reason: `none`;
- outcome: `final_text`;
- upstream completions: 1.

This was the normal tools=0 internal discovery request and is not evidence
about the user tool task.

Initial tool-capable task request `ec15f100132a2bcd`:

- raw / normalized tools: 35 / 35;
- `Glob` / `Read` / `Grep` present: yes / yes / yes;
- continuation: no;
- tool results: 0;
- parse source / reason: `content` / `accepted`;
- strict tool call: yes;
- reasoning / content nonempty: yes / yes;
- reasoning / fenced / prefixed / repeated retries: no / no / no / no;
- retry reason: `none`;
- outcome: `tool_call`;
- upstream completions: 1.

First continuation `3b19074a166bfd7f`:

- raw / normalized tools: 35 / 35;
- `Glob` / `Read` / `Grep` present: yes / yes / yes;
- continuation: yes;
- tool results: 1;
- parse source / reason: `content` / `accepted`;
- strict tool call: yes;
- reasoning / content nonempty: yes / yes;
- reasoning / fenced / prefixed / repeated retries: no / no / no / no;
- retry reason: `none`;
- outcome: `tool_call`;
- upstream completions: 1.

Second continuation `779d955eac9055cd`:

- raw / normalized tools: 35 / 35;
- `Glob` / `Read` / `Grep` present: yes / yes / yes;
- continuation: yes;
- tool results: 1;
- parse source / reason: `content` / `accepted`;
- strict tool call: yes;
- reasoning / content nonempty: yes / yes;
- reasoning / fenced / prefixed / repeated retries: no / no / no / no;
- retry reason: `none`;
- outcome: `tool_call`;
- upstream completions: 1.

Final continuation `01df28e1167bdacb`:

- raw / normalized tools: 35 / 35;
- `Glob` / `Read` / `Grep` present: yes / yes / yes;
- continuation: yes;
- tool results: 1;
- parse source / reason: `content` / `invalid_json`;
- strict tool call: no;
- reasoning / content nonempty: no / yes;
- reasoning / fenced / prefixed / repeated retries: no / no / no / no;
- retry reason: `none`;
- outcome: `final_text`;
- upstream completions: 1.

The final continuation was ordinary final text, not a third tool-like recovery
shape. Its safe structural signals were:

- `content_bytes = 460`;
- `content_trimmed_bytes = 460`;
- `reasoning_bytes = 560`;
- `reasoning_trimmed_bytes = 559`;
- `content_starts_with_brace = false`;
- `content_ends_with_brace = false`;
- `content_starts_with_code_fence = false`;
- `content_contains_tool_call_marker = false`;
- `reasoning_starts_with_brace = false`;
- `reasoning_ends_with_brace = false`;
- `reasoning_starts_with_code_fence = false`;
- `reasoning_contains_tool_call_marker = false`.

Because the selected content had neither a closing-brace signal nor a
tool-call marker, it correctly did not match `PREFIXED_TOOL_LIKE`. No raw final
text is retained here.

## Format recovery result

- Initial task parse source: `content`.
- Initial task parse reason: `accepted`.
- CODE_FENCE observed: no.
- PREFIXED_TOOL_LIKE shape observed: no.
- Fenced retry attempted: no.
- Prefixed retry attempted: no.
- Reasoning retry attempted: no.
- Repeated-tool retry attempted: no.
- Tool retry reason: `none`.
- Final parse reason after correction: not applicable; no correction ran.
- Strict initial tool call detected: yes.
- Initial outcome: `tool_call`.
- Upstream completions in a corrected request: not applicable.
- Maximum upstream completions per HTTP request: 1.
- Third correction completion: no.
- More than one correction reason active in any request: no.
- Raw tool JSON visible in Claude: no.

This run therefore did not exercise either format-recovery predicate. It did
prove that the new implementation did not regress direct strict tool calls or
the three-step tool-result continuation chain. The bounded prefixed recovery
remains offline validated and live not triggered; no second live run was made.

## Network evidence

Every request reached `completion_completed`, `stream_received`, `stream_read`,
and `stream_parsed`. Each request recorded one `completion_start` and one
`completion_completed`.

- Network error: no.
- `upstream_error` records: 0.
- Timeout: no.
- Network retry: no.

## Classification and acceptance

Primary classification: **NO_FORMAT_RETRY_DIRECT_SUCCESS**.

Continuation: **PASS**.

Clean process-tree invocation acceptance: **PASS**.

The clean invocation passes because there were zero old Claude roots, one
foreground invocation, one prompt, no independent second root, one Bridge
client ref, and a tool-capable user task reached Bridge. The requested
`Glob` -> `Read` -> `Grep` lifecycle completed with three real tool results.

PREFIXED_TOOL_LIKE retry live validation: **NOT_TRIGGERED**.

CODE_FENCE retry live status: **NOT_TRIGGERED**.

Parser semantics changed: **NO**.

Production code changed after live: **NO**.

No raw content, reasoning, rejected JSON, prompt, tool arguments, tool results,
file contents, credentials, tokens, cookies, authorization values, secret
environment values, full session IDs, or full call IDs are included in this
report.

Post-live validation:

- required `node --check`: PASS;
- `git diff --check`: PASS;
- `npm.cmd test`: 185/185 PASS;
- port 9655: free;
- leftover test Claude processes: 0.
