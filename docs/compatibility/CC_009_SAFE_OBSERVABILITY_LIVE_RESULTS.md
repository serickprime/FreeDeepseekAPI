# CC-009 Safe Observability Live Results

Date: 2026-08-11

Production baseline: `259a46bd360be3540c4c7b70f52683c3dae35e35`

Branch: `fix/cc-009-safe-tool-diagnostics`

Implementation tested live: `e4dfce25690f530f443a5104d5ce819c37c161f8`

Post-live counter-scope correction: `05b5b179dd59937f5459bc94e09d83b797b8b2cf`

Claude Code: `2.1.226`

Node.js: `v24.12.0`

Model: `deepseek-reasoner`

Diagnostics: `BRIDGE_TOOL_DIAGNOSTICS=1`

## Invocation boundary

The validation used one foreground harness and one descendant Claude Code
invocation. Four user turns were sent sequentially through one realtime
`stream-json` stdin. The observed process tree was one harness process, one
wrapper, and one `claude.exe`; no independent second root appeared.

- foreground Claude invocations: 1
- user prompts: 4
- distinct Bridge client refs: 1
- `/v1/messages` requests: 7
- tool-capable requests: 7
- continuation requests: 3
- network errors: 0
- maximum upstream completions per request: 1
- raw tool-like JSON visible in Claude output: 0

The actual tool inventory reaching Bridge contained `Read` and `Write` only.
`PowerShell` was requested for the controlled CLI tool set but was absent from
the API tool array. `Bash` was also absent. The shell turn therefore could not
reach a shell runtime, and the test was not repeated.

## Test results

| Test | Expected tool | Selected tool | Strict call | Continuation | Current tool result | Physical result | Classification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Read success | Read | Read | Yes | Reached | 1 result, `is_error=false` | source file remained present | PASS |
| Read missing | Read | Read | Yes | Reached | 1 result, `is_error=true` | missing file remained absent | PASS |
| Write | Write | Write | Yes | Reached | client event reported 1 result, `is_error=false` | file created with the expected synthetic content | `WRITE_SUCCESS` |
| Platform shell | PowerShell, otherwise Bash | none | No | Not reached | no shell result | no shell action | `SHELL_TOOL_CALL_NOT_REACHED` |

No tool arguments, result text, file contents, or model text are retained in
this report.

## Request correlation

| Sequence | request_ref | Continuation | tool_result_count | Observed error count | selected_tool_name | Parse | Retry | Outcome |
| ---: | --- | --- | ---: | ---: | --- | --- | --- | --- |
| 1 | `552265294acf3b19` | No | 0 | 0 | Read | accepted | none | tool_call |
| 2 | `38d97cd8578a29a6` | Yes | 1 | 0 | none | invalid_json final text | none | final_text |
| 3 | `ad9bd63079ff9dcf` | No | 0 | 0 | Read | accepted | none | tool_call |
| 4 | `453ada8ee84ed6a5` | Yes | 1 | 1 | none | invalid_json final text | none | final_text |
| 5 | `ed7237fdb8de863c` | No | 0 | 1 (stale) | Write | accepted | none | tool_call |
| 6 | `7bc5527e579f9690` | Yes | 1 | 1 (stale) | none | invalid_json final text | none | final_text |
| 7 | `7cc3dd5960e695be` | No | 0 | 1 (stale) | none | invalid_json final text | none | final_text |

Every request reached `completion_completed`, `stream_received`,
`stream_read`, and `stream_parsed`. Each used one upstream completion. There
were no upstream errors or network retries.

The continuation final texts were ordinary responses without a tool-call
marker. Their parser reason is therefore not evidence of a malformed
tool-like output. No CODE_FENCE, PREFIXED_TOOL_LIKE, reasoning-only, or
repeated-tool recovery ran.

## Live-discovered counter-scope issue

The implementation under test initially counted every explicit Anthropic
`is_error=true` block in the full request transcript. Claude Code retains prior
turns in that transcript, so the missing-Read error was incorrectly carried
into later Write and shell requests. This is proven by sequences 5 and 7:
`tool_result_count=0` but the observed error count was 1. The Write client
event independently reported a non-error result and the requested file was
physically created.

The issue was corrected within CC-009 in
`05b5b179dd59937f5459bc94e09d83b797b8b2cf`: the count now uses only current
call-ID-linked results after the same known-result filtering that defines
`tool_result_count`. A regression test covers an old errored Read followed by
a successful Write continuation. OpenAI and Responses remain fixed at zero.

The one-run limit was respected. The corrected counter was revalidated
offline only; no second Claude invocation was made.

## Final counter-scope live validation

A separate, explicitly authorized minimal validation tested the current-result
scoping correction without repeating the broader Claude Code audit.

- branch HEAD at start: `96173259d10a2d7b357ee944376c0e01c6e6f02e`
- initial observability implementation: `e4dfce25690f530f443a5104d5ce819c37c161f8`
- current-result counter correction: `05b5b179dd59937f5459bc94e09d83b797b8b2cf`
- Claude Code: `2.1.226`
- Node.js: `v24.12.0`
- foreground Claude invocations: 1
- user prompts: 2
- `/v1/messages` requests: 4
- independent Claude roots: 0

The safe diagnostic sequence was:

| Sequence | Turn | Continuation | tool_result_count | tool_result_error_count | selected_tool_name | Strict call | Outcome |
| ---: | --- | --- | ---: | ---: | --- | --- | --- |
| 1 | Missing Read | No | 0 | 0 | Read | Yes | tool_call |
| 2 | Missing Read result | Yes | 1 | 1 | none | No | final_text |
| 3 | New Write | No | 0 | 0 | Write | Yes | tool_call |
| 4 | Write result | Yes | 1 | 0 | none | No | final_text |

This confirms that the historical errored Read result was excluded both from
the new independent Write turn and from its successful continuation. The
Write target was physically created and its synthetic content matched the
expected value before the disposable fixture was removed.

All four requests reached `completion_completed`, `stream_received`,
`stream_read`, and `stream_parsed`, with one upstream completion per request.
There were no network errors, retries, raw tool-like JSON events, or payload
leaks. The single Claude process was a descendant of the one foreground
invocation. Cleanup left port 9655 free and zero test Claude processes.

The earlier audit classified Write as FAIL. Subsequent controlled CC-009
validation demonstrated a successful strict Write → tool_result lifecycle with
physical file creation. Therefore the original CC-002 runtime-failure finding
requires re-evaluation before any production fix is attempted. CC-002 status:
`REQUIRES_REEVALUATION`; it is not closed by this observability validation.

## Recovery and safety

- reasoning retry attempted: 0
- CODE_FENCE retry attempted: 0
- PREFIXED_TOOL_LIKE retry attempted: 0
- repeated-tool retry attempted: 0
- safe failures: 0
- raw payload retained: no
- third correction completion: no

The Bridge logs contained only safe structured diagnostics. The report omits
prompts, raw content, reasoning, arguments, results, paths, commands,
credentials, full session IDs, and call IDs.

## Cleanup

- Claude process tree exited: yes
- leftover test Claude processes: 0
- Bridge stopped: yes
- port 9655: free
- disposable fixture removed: yes

## Classification

`CC_009_COMPLETE`

The selected tool name, explicit boolean semantics, and current-result counter
scope are now demonstrated live. The platform-native shell inventory is a
separate capability investigation and does not block CC-009 diagnostics.
