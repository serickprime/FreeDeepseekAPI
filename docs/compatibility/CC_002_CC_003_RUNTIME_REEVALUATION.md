# CC-002 / CC-003 Runtime Re-evaluation

## Environment

- Date: 2026-08-11
- Main SHA: `aef6ab62c55b11f87550534e094955f1297dd456`
- Audit branch: `audit/cc-002-cc-003-runtime-reevaluation`
- Claude Code: `2.1.226`
- Node.js: `v24.12.0`
- OS: Windows 11 Home 64-bit (`10.0.26200`)
- Intended model: `deepseek-reasoner`
- Bridge endpoint: loopback port 9655
- Diagnostics: `BRIDGE_TOOL_DIAGNOSTICS=1`

## Scope and safety

This was a documentation-only re-evaluation of CC-002 (`Write`) and CC-003
(Windows shell tools). Production code, tests, configuration, model aliases,
parser behavior, retry behavior, session behavior, and network behavior were
not changed.

The disposable fixture was outside the production repository. The test
instrumentation retained no prompts, tool arguments, tool-result text, model
content, reasoning, credentials, session IDs, or call IDs.

## Baseline

- `npm.cmd test`: 202/202 PASS before the attempted live run.
- Required `node --check` commands: PASS.
- `git diff --check`: PASS.
- Independent Claude roots before launch: 0.
- Port 9655 before Bridge startup: free.
- Relevant documented CLI flags: `--allowedTools`, `--permission-mode`, and
  `--tools`. The attempted normal-inventory launch did not pass `--tools`.

## Live attempt boundary

One Claude Code foreground process was launched. The process received one
planned user turn, then exited with code 1 before producing a structured
Claude event and before sending any request to the Bridge.

The safety harness recorded only that stderr was present. It intentionally did
not retain arbitrary stderr text. Therefore the exact client-side launch cause
is `UNKNOWN`; no Bridge, upstream, tool-runtime, or network cause is proven.
The run was not repeated because this phase authorized one foreground
invocation only.

Safe attempt statistics:

| Metric | Observed |
| --- | --- |
| Foreground invocations | 1 |
| User turns submitted to the process | 1 |
| Structured Claude result events | 0 |
| `/v1/messages` requests | 0 |
| Tool-capable requests | 0 |
| Tool inventory captured | No |
| Real `tool_use` events | 0 |
| Real `tool_result` events | 0 |
| Raw tool-like JSON visible | 0 |
| CC-001 recovery events | 0 |
| Upstream completions | 0 |
| Network errors | 0 observed; no network request was made |

## Request correlation

No Bridge request existed, so no `request_ref`, `selected_tool_name`, strict
parse result, retry reason, continuation count, or tool-result error count was
available.

| Test | Request ref | Selected tool | Result count | Error count | Strict | Retry | Outcome | Network | Physical result |
| --- | --- | --- | ---: | ---: | --- | --- | --- | --- | --- |
| CC-002A Write + Read | none | none | 0 | 0 | not reached | none | client process exited before request | not reached | file not created |
| CC-002B independent Write + Read | none | not reached | 0 | 0 | not reached | none | not run | not reached | not run |
| CC-003 shell read | none | not reached | 0 | 0 | not reached | none | not run | not reached | not run |
| CC-003 shell write + Read | none | not reached | 0 | 0 | not reached | none | not run | not reached | not run |

## CC-002 — Write

### Original finding

The historical compatibility audit classified `Write` as FAIL. Later
controlled CC-009 and CC-001 validations demonstrated successful strict
`Write` and `Edit` lifecycles, so CC-002 required re-evaluation rather than an
assumed production fix.

### New evidence

- `Write` advertised: `UNKNOWN` (no request reached the Bridge).
- `Write` selected: not reached.
- Strict tool call: not reached.
- Explicit tool-result error: not reached.
- Read continuation: not reached.
- Physical verification: the first planned file was not created; the tool was
  never invoked.
- Raw tool JSON: none observed.
- Recovery: none triggered.
- Network: not reached.
- Reproducibility: not evaluated; the single authorized process exited before
  the first API request.

### CC-002 decision

- Final status: `CC_002_BLOCKED`
- Production fix required: `UNKNOWN`
- Historical cause: `UNKNOWN / NOT RE-EVALUATED`

This result neither reproduces nor clears CC-002. It provides no evidence for
a Bridge production change.

## CC-003 — Bash / PowerShell

### Actual inventory

- `PowerShell` advertised: `UNKNOWN`
- `Bash` advertised: `UNKNOWN`

The normal tool inventory was not observable because Claude Code sent no
request. Absence from the captured inventory must not be inferred as
`SHELL_NOT_ADVERTISED`.

### Tool results

| Tool | Selected | Permission prompt | Permission approved | Error count | Read-only command | File operation | Continuation | Physical result | Status |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |
| PowerShell | not reached | not reached | not reached | 0 | not run | not run | not reached | not run | `SHELL_NOT_TESTED` |
| Bash | not reached | not reached | not reached | 0 | not run | not run | not reached | not run | `SHELL_NOT_TESTED` |

### CC-003 decision

- Final status: `CC_003_BLOCKED`
- Production fix required: `UNKNOWN`
- First failing boundary: `CLAUDE_CODE_CLIENT` launch, before Bridge contact.
- Root cause confidence: `UNKNOWN`

This result does not reproduce a shell runtime error and provides no evidence
for a Bridge production change.

## Cleanup and post-attempt validation

- Claude process leftovers: 0.
- Bridge stopped; port 9655: free.
- Disposable fixture: removed.
- `npm.cmd test`: 202/202 PASS.
- `node --check server.js`: PASS.
- `node --check lib/tool_diagnostics.js`: PASS.
- `node --check lib/tool_retry.js`: PASS.
- `git diff --check`: PASS.
- Production files changed: no.

## Decision

- CC-002: `CC_002_BLOCKED`
- CC-003: `CC_003_BLOCKED`
- Next action: `INVESTIGATE_CC002` and `INVESTIGATE_CC003` in a separately
  authorized controlled run that first establishes a successful normal Claude
  Code client launch. Do not begin a production fix from this evidence.
- Overall classification: `CC_002_CC_003_REEVALUATION_BLOCKED`

## Follow-up client launch investigation

The earlier blocked attempt remains recorded above. It exited before Bridge
contact, and its discarded stderr means its exact cause remains `UNKNOWN`.
It must not be reclassified as a Bridge or tool failure.

The follow-up was explicitly limited to two diagnostic launch attempts:

| Attempt | Claude process started | Structured events | `/v1/messages` | Result |
| --- | --- | ---: | ---: | --- |
| 1 | No | 0 | 0 | `HARNESS_OUTPUT_PATH_ERROR` before process start |
| 2 | Yes | 5 | 2 | Read lifecycle PASS; exit code 0 |

Attempt 1 proved a new, narrow harness error: PowerShell resolved a relative
temporary output path from the disposable fixture and failed redirection
before starting Claude. The path was changed to an absolute temporary path;
no Bridge, Claude configuration, or production file was changed. No raw
stderr was retained. The safe error summary is `temporary output directory
not found`.

Attempt 2 used a direct native Claude executable rather than a shell wrapper.
The prompt was supplied as a CLI argument with `--print`, structured
`stream-json` output, `--verbose`, `deepseek-reasoner`, and a temporary
Read-only tool policy. It produced:

`Read -> tool_result -> final_text`

The Bridge received two Messages requests. The first selected strict `Read`;
the continuation reported one current result, zero explicit errors, and a
final response. Both requests had safe request references and one upstream
completion.

For the full multi-turn invocation, the established direct executable pattern
was retained. Realtime `stream-json` stdin was used for sequential turns,
`stream-json` output and `--verbose` remained enabled, and the native process
was launched without `shell:true`. No `--tools` flag was supplied, so Claude
Code advertised its normal tool inventory. Only exact temporary permission
rules for the tested tools and shell commands were supplied; no bypass or
persistent global permission was used.

- Diagnostic launch attempts: 2.
- Successful diagnostic Claude processes: 1.
- Original exit-1 cause: `UNKNOWN`.
- Safe sanitized stderr retained: no.
- Working invocation established: yes.
- First successful `/v1/messages` reached: yes.
- Client launch status: `CLIENT_LAUNCH_FIXED`.

The original exit-1 is not attributed to the relative-path error from the new
first diagnostic attempt. Direct native execution and removal of shell-wrapper
argument handling are proven working differences, but the historical cause
cannot be established without its discarded stderr.

## Follow-up runtime re-evaluation

### Runtime boundary

- Claude Code: `2.1.226`.
- Node.js: `v24.12.0`.
- Model: `deepseek-reasoner`.
- Full foreground invocations: 1.
- Full-invocation user turns: 4.
- Diagnostic user turns that reached Claude: 1.
- Total Messages requests: 15 (2 launch probe + 13 runtime).
- Network errors: 0.
- Maximum upstream completions per request: 1.
- Raw tool-like JSON visible: 0.
- `brace_tool` recovery events: 0.
- Other tool retry reasons: none.

### Normal tool inventory

The first full-invocation request advertised 27 tools:

`Agent`, `Bash`, `CronCreate`, `CronDelete`, `CronList`, `Edit`,
`EnterWorktree`, `ExitWorktree`, `Glob`, `Grep`, `NotebookEdit`, `Read`,
`ReportFindings`, `ScheduleWakeup`, `SendMessage`, `Skill`, `TaskCreate`,
`TaskGet`, `TaskList`, `TaskOutput`, `TaskStop`, `TaskUpdate`,
`WaitForMcpServers`, `WebFetch`, `WebSearch`, `Workflow`, and `Write`.

Relevant availability:

| Tool | Advertised in first request |
| --- | --- |
| Read | Yes |
| Write | Yes |
| Edit | Yes |
| Bash | Yes |
| PowerShell | No |

Some continuations contained additional MCP-related names. They were not
tested because this phase was restricted to Read, Write, Bash, and
PowerShell. The first normal-inventory count remains 27.

### Safe request correlation

All request rows below retain only safe diagnostics. No prompt, argument,
result text, reasoning, session ID, or call ID is stored.

| Seq. | Test | request_ref | Continuation | Results/errors | Selected | Strict | Parse | Retry | Outcome | Completions |
| ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: |
| P1 | Launch Read | `0247edf24ad09628` | No | 0/0 | Read | Yes | content/accepted | none | tool_call | 1 |
| P2 | Launch Read result | `d583b0573f15c984` | Yes | 1/0 | none | No | content/invalid_json | none | final_text | 1 |
| 1 | Write 1 | `0bc887788ce90fbb` | No | 0/0 | Write | Yes | content/accepted | none | tool_call | 1 |
| 2 | Write 1 result | `71bf39f52b533a2a` | Yes | 1/0 | Read | Yes | content/accepted | none | tool_call | 1 |
| 3 | Read 1 result | `2ffdac13e8d902f1` | Yes | 1/0 | none | No | content/invalid_json | none | final_text | 1 |
| 4 | Write 2 | `2be55ed2d6b5f82a` | No | 0/0 | Write | Yes | content/accepted | none | tool_call | 1 |
| 5 | Write 2 result | `6f7fd12b0ba44954` | Yes | 1/0 | Read | Yes | content/accepted | none | tool_call | 1 |
| 6 | Read 2 result | `5b78a0d486ddfeb1` | Yes | 1/0 | none | No | content/invalid_json | none | final_text | 1 |
| 7 | Bash version | `7cec4050d8534704` | No | 0/0 | Bash | Yes | content/accepted | none | tool_call | 1 |
| 8 | Bash version result | `2009eb1beb832ad2` | Yes | 1/0 | none | No | content/invalid_json | none | final_text | 1 |
| 9 | Bash file operation | `2b3d8627acd70d4a` | No | 0/0 | Bash | Yes | content/accepted | none | tool_call | 1 |
| 10 | First Bash error | `524c316658ba1eb9` | Yes | 1/1 | Bash | Yes | content/accepted | none | tool_call | 1 |
| 11 | Second Bash error | `e0732d5c071e5279` | Yes | 1/1 | Write | Yes | content/accepted | none | tool_call | 1 |
| 12 | Write fallback result | `5660bc23d975c671` | Yes | 1/0 | none | No | reasoning/empty_input | none | safe_failure | 1 |
| 13 | Shell-turn final request | `da3ae8744317d794` | No | 0/0 | none | No | content/invalid_json | none | final_text | 1 |

The `invalid_json` final-text rows contained ordinary final responses, not
raw tool-like JSON. They did not satisfy the CC-001 brace predicate and did
not trigger recovery.

### CC-002 — Write

| Test | Actual sequence | Write result | Read result | Physical verification | Result |
| --- | --- | --- | --- | --- | --- |
| Write 1 | Write -> Read -> final | 1 result, 0 errors | 1 result, 0 errors | exact expected file content | PASS |
| Write 2 | Write -> Read -> final | 1 result, 0 errors | 1 result, 0 errors | exact expected file content | PASS |

Both independent Write calls were strict and accepted, their Claude Code tool
results were successful, the Bridge continued into strict Read calls, and
independent physical verification matched both expected synthetic values.
There were no permission prompts, retries, raw tool JSON events, or network
errors.

- Current classification: `CC_002_REEVALUATED_PASS`.
- Production fix required: `NO`.
- Historical audit failure: `NOT_REPRODUCED`.
- Historical root cause: `UNKNOWN`.

The historical CC-002 finding is superseded for the current main by two newer
controlled end-to-end Write lifecycles. This does not invent a cause for the
old failure.

### CC-003 — PowerShell and Bash

| Tool/test | Advertised | Selected | Permission prompt | Results/errors | Continuation | Physical attribution | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PowerShell | No | No | Not applicable | 0/0 | Not reached | none | `SHELL_NOT_ADVERTISED` |
| Bash version | Yes | Yes | No | 1/0 | final reached | not applicable | `SHELL_FULL_PASS` for read-only command |
| Bash file operation, first call | Yes | Yes | No | 1/1 | continued | no file success attributable to Bash | `SHELL_RUNTIME_FAIL` |
| Bash file operation, second call | Yes | Yes | No | 1/1 | continued | no file success attributable to Bash | `SHELL_RUNTIME_FAIL` |
| Write fallback | Yes | Yes | No | 1/0 | safe failure then final | created exact expected file | not a shell success |

The Bash version command completed through a strict `Bash` tool call with one
non-error result and a final response. Its safe outcome is
`NODE_VERSION_SUCCESS = YES`.

The Bash file operation then produced two strict Bash calls. Each returned an
explicit current `is_error=true` result. Claude subsequently selected `Write`,
which created the expected file. The physical file therefore proves the
fallback Write, not Bash file creation. No Read tool call followed the
fallback, so the requested shell-created-file Read verification did not pass.
Exact shell error text was not retained; the runtime cause remains `UNKNOWN`.

- Current classification: `CC_003_PARTIAL`.
- Production fix required: `UNKNOWN` pending isolated runtime cause.
- First failing boundary for the file operation:
  `CLAUDE_CODE_TOOL_RUNTIME` after strict Bridge acceptance.
- PowerShell status: `SHELL_NOT_ADVERTISED`.
- Bash status: read-only `SHELL_FULL_PASS`; file operation
  `SHELL_RUNTIME_FAIL`.

This evidence does not prove a Bridge parser, retry, continuation, session, or
network defect. No production fix is authorized by this result.

### Follow-up cleanup and validation

- Full Claude process tree exited normally: yes.
- Leftover Claude processes: 0.
- Bridge stopped: yes.
- Port 9655: free.
- Disposable fixture removed: yes.
- `npm.cmd test`: 202/202 PASS.
- Required `node --check`: PASS.
- `git diff --check`: PASS.
- Production files changed: no.

## Follow-up decision

- CC-002: `CC_002_REEVALUATED_PASS`.
- CC-002 production fix: `NO`.
- CC-003: `CC_003_PARTIAL`.
- CC-003 production fix: `UNKNOWN`.
- Next action: `NO_CC002_FIX`; separately `INVESTIGATE_CC003` at the proven
  Claude Code tool-runtime boundary without changing Bridge first.
- Overall classification: `CC_002_CC_003_REEVALUATION_COMPLETE`.
