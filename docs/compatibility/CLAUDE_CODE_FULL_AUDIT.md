# Claude Code ↔ FreeDeepseekAPI Compatibility Audit

Audit date: 2026-08-11

Bridge SHA: `b49bf745fd6cbc70bb008eb7e90c58edfccd9d14`

Claude Code version: `2.1.226`

Node.js version: `v24.12.0`

Model: `deepseek-reasoner` for the main audit; `deepseek-chat` for one declared-alias check and the API adapter checks

OS: Microsoft Windows 11 Home, version 10.0.26200, 64-bit

Audit branch: `audit/claude-code-full-compatibility`

Bridge endpoint: `http://127.0.0.1:9655`

Diagnostics: `BRIDGE_TOOL_DIAGNOSTICS=1`

## Executive summary

Overall verdict: **PARTIALLY_COMPATIBLE**.

Claude Code can use the current Bridge for ordinary chat, live Anthropic
streaming, individual `Glob`, `Read`, and `Grep` calls, successful and failed
tool-result continuation, automatic read-tool selection, local token counting,
and the OpenAI Chat Completions and Responses adapters. The direct read flows
were real end-to-end lifecycles: Bridge emitted Anthropic `tool_use`, Claude
Code executed the tool, returned `tool_result`, and the model produced a final
response.

Compatibility is not complete. Five turns produced a newly confirmed
brace-delimited tool-like structural shape which the strict parser correctly
rejected but neither bounded format recovery covers. That output was visible
as ordinary text and blocked `Edit`, multi-step read flows, and the moderate
multi-file flow. A strict `Write` call and all shell calls reached the Claude
tool runtime but returned tool errors. The subagent parent tool ran, but nested
requests selected unsupported model alias `claude-opus-5`; a completed
subagent result was not independently proven. Explicit resume failed in the
Claude Code client before any Bridge request.

The 40-row capability matrix contains:

- `FULL_PASS`: 15
- `PARTIAL`: 6
- `FAIL`: 11
- `NOT_AVAILABLE`: 1
- `NOT_CONFIGURED`: 1
- `NOT_TESTED_COST`: 1
- `OFFLINE_PASS_LIVE_NOT_TRIGGERED`: 5

The tool inventory contains 30 API-advertised tools. Ten tool names were
directly requested or naturally exercised; eight distinct names produced a
real Claude Code tool event. Tools with scheduling, notification, worktree, or
other mutating external behavior were not invoked merely for coverage.

No network error, timeout, or upstream retry occurred. No format/reasoning/
repeated-tool correction was triggered naturally. Every corrected-path status
therefore remains the combination of prior live structural evidence and the
185-test offline suite, not a claim that correction ran in this audit.

## Scope and safety boundary

The main audit used one foreground Claude Code invocation and 18 sequential
user turns in a disposable fixture outside the production repository. It
tested reads, writes, shell execution, automatic selection, tool errors,
multi-step work, agent, task-management, and web behavior. Four later,
sequential foreground invocations were limited to session start, resume,
continue, and one declared model alias. There were no detached launchers.

Before the main invocation, independent Claude roots were 0. The controlled
root/wrapper PID was `10264`; no independent root was observed, the process
exited with code 0, and no Claude process remained afterward. The WMI
name/command matcher did not observe a separately named Claude descendant in
its snapshots, so this run does not infer session count from descendant PID
count. Bridge correlation is stronger evidence here: all 35 main-session
requests used one `client_session_ref`.

The fixture contained only synthetic TypeScript, JSON, Markdown, and notebook
files. It was deleted after the audit. Write/Edit/shell changes did not occur:
the expected Edit text and all three expected created/updated files were
absent at physical verification. The production repository was not modified.

The report contains no raw prompt, reasoning, model content, rejected JSON,
tool arguments, tool-result contents, cookie, token, authorization value,
secret environment value, full session ID, or full call ID. Request refs and
process-scoped diagnostic refs are safe local correlation values.

## Environment and invocation evidence

| Property | Observed value |
| --- | --- |
| Main foreground invocations | 1 |
| Main user prompts | 18 |
| Independent second root | No |
| Main distinct Bridge client refs | 1 |
| Main `/v1/messages` | 35 |
| Main continuation requests | 15 |
| Main real tool-use events | 15 |
| Main tool-result events | 15 |
| Main tool-result errors | 6 |
| Main raw-tool-like visible turns | 5 |
| Main network errors | 0 |
| Main safe failures | 2 (nested unsupported-model requests) |
| Main maximum completions/request | 1 |
| Additional session/model prompts | 4 |
| Total Claude Code prompts | 22 |

The API-level synthetic probes added one local `count_tokens` request, three
OpenAI Chat Completions requests, and two Responses requests. They are kept
separate from Claude Code tool statistics.

Across all diagnostic routes there were 44 requests: 39 Anthropic Messages,
three OpenAI Chat Completions, and two Responses. One OpenAI plain request had
no tools; the other 43 diagnostic requests were tool-capable. There were 18
continuation requests and 18 tool-result blocks. The only two safe failures
were local rejections of `claude-opus-5` nested-agent requests.

## Master capability matrix

| Capability | Claude tool/feature | Available | Tested | Actual sequence/evidence | Continuation | Retry | Result | Failure layer / notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Plain chat | Messages text | Yes | Yes | final text, no tool | N/A | None | FULL_PASS | One streamed response, no raw JSON |
| Anthropic live streaming | `/v1/messages` SSE | Yes | Yes | start → content/tool events → result | Yes | None | FULL_PASS | All completed requests reached `stream_parsed` |
| System/project context | fixture `CLAUDE.md` | Yes | Yes | no-tool 16-byte marker response | N/A | None | PARTIAL | Behavioral response strongly matched the marker, but the audit retained no response text or explicit marker boolean |
| Tool inventory transport | 30 API tools | Yes | Yes | Claude Code → Bridge tool array | N/A | None | FULL_PASS | Full identifier-only inventory retained |
| Glob | `Glob` | Yes | Yes | Glob → result → final | Yes | None | FULL_PASS | Successful real tool result |
| Read | `Read` | Yes | Yes | Read → result → final | Yes | None | FULL_PASS | Successful read and expected missing-file error both observed |
| Grep | `Grep` | Yes | Yes | Grep → result → final | Yes | None | FULL_PASS | Successful real tool result |
| Edit | `Edit` | Yes | Yes | no tool; malformed final text | No | None | FAIL | BRIDGE_RETRY / UPSTREAM_DEEPSEEK; finding CC-001 |
| Write | `Write` | Yes | Yes | Write → error result → final | Yes | None | FAIL | TOOL_RUNTIME, exact cause unknown; CC-002 |
| Notebook edit | `NotebookEdit` | Yes | Yes | no tool call | No | None | FAIL | UPSTREAM_DEEPSEEK tool selection; CC-008 |
| Bash | `Bash` | Yes | Yes | Bash → error result; write test retried shell tools | Yes | None | FAIL | TOOL_RUNTIME / platform or permission boundary unknown; CC-003 |
| PowerShell | `PowerShell` | Yes | Natural fallback | PowerShell → error result | Yes | None | FAIL | Not pre-authorized by the harness; client permission/runtime boundary likely, not confirmed; CC-003 |
| Automatic tool selection | model-selected read tool | Yes | Yes | Grep → result → final | Yes | None | FULL_PASS | No tool name was specified in the user task |
| Sequential multi-tool flow | Glob → Read → Grep | Yes | Yes | Glob → result → raw tool-like text | Stopped after 1 | None | FAIL | CC-001 |
| Long agentic flow | autonomous multi-step read | Yes | Yes | Glob → result → raw tool-like text | Stopped after 1 | None | FAIL | CC-001 |
| Tool-result continuation | Anthropic `tool_result` | Yes | Yes | Multiple one-step calls continued to final text | Yes | None | FULL_PASS | 15 main continuation requests total |
| Tool-error continuation | errored `Read` result | Yes | Yes | Read → error result → explanatory final | Yes | None | FULL_PASS | Session stayed usable |
| Agent/subagent | client `Task`, API `Agent` | Yes | Yes | Agent → result; nested requests followed | Partial | None | PARTIAL | Unsupported nested model alias and interleaving; CC-004 |
| Ask user | `AskUserQuestion` or equivalent | No | Conditional | Not advertised to Bridge | N/A | N/A | NOT_AVAILABLE | Not a Bridge failure |
| Task management | `TaskCreate/Get/List/Output/Stop/Update` | Yes | Group test | No independently isolated task-management call | Inconclusive | None | PARTIAL | Background-agent overlap and no selected Task tool; CC-005 |
| Web | `WebFetch`, `WebSearch` | Yes | Representative `WebFetch` task | final text, no web tool | No | None | FAIL | UPSTREAM_DEEPSEEK tool selection; CC-006 |
| MCP | configured server inventory | No API tool | Checked | `context7` status `failed`; no `mcp__...` tool | N/A | N/A | NOT_CONFIGURED | Claude Code client/config boundary |
| Token counting | `/v1/messages/count_tokens` | Yes | Yes | HTTP 200, nonnegative integer | N/A | N/A | FULL_PASS | Fully local route |
| CODE_FENCE recovery | bounded correction | Yes | Offline + prior evidence | Not triggered in this audit | N/A | Not triggered | OFFLINE_PASS_LIVE_NOT_TRIGGERED | Prior pre-fix shape plus focused unit coverage |
| PREFIXED_TOOL_LIKE recovery | bounded correction | Yes | Offline + prior evidence | Not triggered in this audit | N/A | Not triggered | OFFLINE_PASS_LIVE_NOT_TRIGGERED | Prior pre-fix shape plus focused unit coverage |
| Reasoning-only recovery | bounded correction | Yes | Offline | Not triggered | N/A | Not triggered | OFFLINE_PASS_LIVE_NOT_TRIGGERED | 185-test suite |
| Repeated-tool protection | completed-call guard | Yes | Offline | Not triggered | N/A | Not triggered | OFFLINE_PASS_LIVE_NOT_TRIGGERED | Deliberate live loop not provoked |
| Shared retry budget | maximum one correction | Yes | Offline + live observation | maximum live completions/request = 1 | N/A | 0 live corrections | OFFLINE_PASS_LIVE_NOT_TRIGGERED | Unit tests prove maximum total 2 when corrected |
| Raw JSON suppression | user-visible output | Yes | Yes | five raw-tool-like visible turns | N/A | No matching retry | FAIL | CC-001 |
| Network stability | DeepSeek/PoW/WASM/stream | Yes | Yes | 0 upstream errors | N/A | No network retry | FULL_PASS | Normal completion/stream stages reached |
| Normal local session | one foreground invocation | Yes | Yes | 18 sequential turns, one main client ref | Yes | N/A | FULL_PASS | Background Agent caused later event overlap, recorded separately |
| Resume | `--resume` | Yes | Yes | client exit 1, no Bridge request | Not reached | N/A | FAIL | CLAUDE_CODE_CLIENT; CC-007 |
| Continue | `--continue` | Yes | Yes | response succeeded with a different client ref | Not proven | N/A | PARTIAL | Intended session continuity was not proven; CC-007 |
| Compaction | `/compact`, autocompact | Advertised | No | no forced context saturation | N/A | N/A | NOT_TESTED_COST | Avoided artificial large-context spend |
| Model switch | `deepseek-chat` alias | Yes | Yes | two streamed requests including one tool cycle | Yes | None | PARTIAL | Transport worked, but model ignored the no-tool instruction and the selected tool name was not independently retained |
| Moderate multi-file context | four fixture files | Yes | Yes | malformed tool-like text before a real read | No | None | FAIL | CC-001 |
| OpenAI adapter | `/v1/chat/completions` | Yes | Yes | plain; function call → result → final | Yes | None | FULL_PASS | HTTP 200 throughout |
| Responses adapter | `/v1/responses` | Yes | Yes | function call → output → final | Yes | None | FULL_PASS | HTTP 200 throughout |
| Slash/model/context commands | 43 slash commands inventoried | Yes | Inventory only | client-side and Bridge-relevant groups classified | N/A | N/A | PARTIAL | Commands were not executed en masse |
| Anthropic protocol adapter | `/v1/messages` | Yes | Yes | text, tool-use, tool-result, error result | Yes | None | FULL_PASS | Real Claude Code path |

## Main live test results

| Test | Expected tools | Actual tools | Tool results | Retry | Raw JSON/tool-like text | Network | Result |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| A — plain chat | none | none | 0 | none | no | ok | PASS |
| System context marker | none | none | 0 | none | no | ok | PARTIAL evidence |
| B — Glob | Glob | Glob | 1 success | none | no | ok | PASS |
| C — Read | Read | Read | 1 success | none | no | ok | PASS |
| D — Grep | Grep | Grep | 1 success | none | no | ok | PASS |
| E — multi-read | Glob, Read, Grep | Glob | 1 success | none | yes | ok | FAIL |
| F — Edit then Read | Edit, Read | none | 0 | none | yes | ok | FAIL |
| G — Write then Read | Write, Read | Write | 1 error | none | no | ok | FAIL |
| H — Bash read-only | Bash | Bash | 1 error | none | no | ok | FAIL |
| I — shell write then Read | Bash, Read | Bash, PowerShell, Bash | 3 errors | none | no | ok | FAIL |
| J — automatic selection | model choice | Grep | 1 success | none | no | ok | PASS |
| K — long agentic read | multiple reads/searches | Glob | 1 success | none | yes | ok | FAIL |
| L — missing file | Read | Read | 1 expected error | none | no | ok | PASS |
| Moderate context | Read | none | 0 | none | yes | ok | FAIL |
| NotebookEdit | NotebookEdit, Read | none | 0 | none | no | ok | FAIL |
| Agent/subagent | Agent/Task + nested read | Agent | 1 parent result | none | no | ok | PARTIAL |
| Task-management group | Task tools | attribution not isolated | 2 interleaved read results | none | yes | ok | PARTIAL |
| Web representative | WebFetch | none | 0 | none | no | ok | FAIL |

The proven successful read sequences were `Glob → tool_result → final`,
`Read → tool_result → final`, `Grep → tool_result → final`, and an automatic
`Grep → tool_result → final`. The requested `Glob → Read → Grep` chain did not
complete in this audit: after the first real Glob continuation, the next
intended call became rejected text.

## Tool inventory

The Claude stream init exposed the display name `Task`; the actual Anthropic
request reaching Bridge used `Agent`. The table uses the 30 names actually
passed through the API, because those define Bridge compatibility.

| Tool name | Category | Advertised to Bridge | Tested | Executed | Tool result received | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Agent | AGENT | Yes | Yes | Yes | Yes | PARTIAL |
| Bash | SHELL | Yes | Yes | Yes | Yes, error | FAIL |
| CronCreate | SCHEDULING | Yes | No | No | No | NOT_TESTED_SAFETY |
| CronDelete | SCHEDULING | Yes | No | No | No | NOT_TESTED_SAFETY |
| CronList | SCHEDULING | Yes | No | No | No | NOT_TESTED_SAFETY |
| DesignSync | EXTERNAL/DESIGN | Yes | No | No | No | NOT_TESTED_SAFETY |
| Edit | FILESYSTEM_WRITE | Yes | Yes | No | No | FAIL |
| EnterWorktree | WORKTREE | Yes | No | No | No | NOT_TESTED_SAFETY |
| ExitWorktree | WORKTREE | Yes | No | No | No | NOT_TESTED_SAFETY |
| Glob | FILESYSTEM_READ | Yes | Yes | Yes | Yes | FULL_PASS |
| Grep | FILESYSTEM_READ | Yes | Yes | Yes | Yes | FULL_PASS |
| Monitor | AGENT/PROCESS | Yes | No | No | No | NOT_TESTED_SAFETY |
| NotebookEdit | FILESYSTEM_WRITE | Yes | Yes | No | No | FAIL |
| PowerShell | SHELL | Yes | Natural fallback | Yes | Yes, error | FAIL |
| PushNotification | EXTERNAL/INTERACTION | Yes | No | No | No | NOT_TESTED_SAFETY |
| Read | FILESYSTEM_READ | Yes | Yes | Yes | Yes, success and error | FULL_PASS |
| ReportFindings | AGENT/REVIEW | Yes | No | No | No | NOT_TESTED_SAFETY |
| ScheduleWakeup | SCHEDULING | Yes | No | No | No | NOT_TESTED_SAFETY |
| SendMessage | AGENT/INTERACTION | Yes | No | No | No | NOT_TESTED_SAFETY |
| Skill | CLIENT CUSTOMIZATION | Yes | No | No | No | NOT_TESTED_SAFETY |
| TaskCreate | TASK MANAGEMENT | Yes | Group test | No isolated event | No | PARTIAL |
| TaskGet | TASK MANAGEMENT | Yes | Group test | No isolated event | No | PARTIAL |
| TaskList | TASK MANAGEMENT | Yes | Group test | No isolated event | No | PARTIAL |
| TaskOutput | TASK MANAGEMENT | Yes | Group test | No isolated event | No | PARTIAL |
| TaskStop | TASK MANAGEMENT | Yes | Group test | No isolated event | No | PARTIAL |
| TaskUpdate | TASK MANAGEMENT | Yes | Group test | No isolated event | No | PARTIAL |
| WebFetch | WEB | Yes | Yes | No | No | FAIL |
| WebSearch | WEB | Yes | Representative web test only | No | No | NOT_TESTED_COST |
| Workflow | CLIENT WORKFLOW | Yes | No | No | No | NOT_TESTED_SAFETY |
| Write | FILESYSTEM_WRITE | Yes | Yes | Yes | Yes, error | FAIL |

`AskUserQuestion`, `TodoWrite`, and every `mcp__...` name were absent from the
actual Bridge request. They are not silently counted as failures.

## Request and retry statistics

| Statistic | Main Claude session | All Claude invocations | All diagnostic API routes |
| --- | ---: | ---: | ---: |
| User prompts | 18 | 22 | N/A |
| Requests | 35 | 39 `/v1/messages` | 44 |
| Tools=0 requests | 0 | 0 | 1 |
| Tool-capable requests | 35 | 39 | 43 |
| Continuation requests | 15 | 16 | 18 |
| Real/synthetic tool-use calls | 15 | 16 | 18 |
| Tool-result blocks | 15 | 16 | 18 |
| Distinct tools available | 30 | 30 | 31 including synthetic `audit_lookup` |
| Distinct known Claude tools executed | 8 | at least 8 | N/A |
| Network errors | 0 | 0 | 0 |
| Safe failures | 2 | 2 | 2 |
| Raw tool-like visible turns | 5 | 5 | 5 |
| CODE_FENCE retries | 0 | 0 | 0 |
| PREFIXED retries | 0 | 0 | 0 |
| Reasoning retries | 0 | 0 | 0 |
| Repeated-tool retries | 0 | 0 | 0 |
| Maximum upstream completions/request | 1 | 1 | 1 |

The model-switch invocation performed one structured tool cycle, but its tool
name was not retained by the safe session harness. It is therefore counted in
the total while the distinct-name count remains “at least eight.”

## Raw tool JSON reproduction — CC-001 (P1)

The previously reported Edit symptom reproduced as part of a broader, newly
confirmed structural class. The exact raw text and tool arguments were not
retained, so this report does not claim the precise malformed syntax or the
selected tool name. Safe diagnostics prove all five outputs had:

- selected source `content`;
- parse reason `invalid_json`;
- `content_starts_with_brace = true`;
- `content_ends_with_brace = true`;
- `content_starts_with_code_fence = false`;
- `content_contains_tool_call_marker = true`;
- no accepted strict call;
- no format retry;
- `outcome = final_text`;
- one upstream completion.

| Test | request_ref | content bytes | reasoning bytes | reasoning marker | Raw visible |
| --- | --- | ---: | ---: | --- | --- |
| Multi-read continuation | `798fe7e0e72b26b2` | 279 | 2039 | No | Yes |
| Edit | `8d8fbe586c68cd30` | 409 | 2015 | No | Yes |
| Long agentic continuation | `e56a9ca356573576` | 426 | 2701 | No | Yes |
| Moderate context | `1c99fa2f724f3b0c` | 493 | 939 | Yes | Yes |
| Task/agent-overlap continuation | `f22a3587c1455645` | 338 | 2954 | Yes | Yes |

This shape is neither `CODE_FENCE` nor `PREFIXED_TOOL_LIKE`: the existing
predicates correctly did not run. The strict parser also correctly rejected
invalid JSON. The compatibility gap is the absence of a bounded recovery for
this repeatedly observed shape, not parser strictness.

## Tool runtime failures

`Write` request `4684c5979422ef56` was accepted as a strict tool call and
Claude Code emitted a tool-result error. Continuation request
`7ca6b51c595785f5` reached a normal final response, but the file was physically
absent. No `Read` verification occurred.

`Bash` request `f8330d4df058ce30` was accepted and returned a tool error even
for the read-only Node version task. The disposable shell-write task produced
three accepted shell calls (`Bash`, `PowerShell`, `Bash`) and three error
results; no file was created. `PowerShell` was discovered only after the main
invocation started and was not in the audit harness's pre-approved list, so a
permission failure is plausible for that call but is not claimed as fact.

The security-safe harness intentionally retained only `is_error`, not tool
arguments or result text. The exact Write/Bash error cause is therefore
**UNKNOWN**. Bridge parsing and protocol conversion succeeded before the
failure, establishing `TOOL_RUNTIME` as the first confirmed failing boundary.

## Agent, task, web, and MCP

The parent `Agent` call (`c0f50622a4d47e16`) was a strict accepted tool call
and returned a parent tool result. Nested Agent activity then sent two
`claude-opus-5` requests (`b312f510cb844304`, `335b8808873c6d17`). Bridge
rejected both locally as safe failures before any upstream stage because that
model alias is not in its available model table. A later nested
`deepseek-reasoner` request reached and accepted a tool call, but the audit did
not prove a completed nested read result returning to the parent. Background
events overlapped the following task-management turn.

Because of that overlap, the group task-management prompt is `PARTIAL`, not a
claim that all six task tools are broken. No isolated Task tool event was
proven. This is an evidence gap that requires an isolated future test after
Agent model compatibility is fixed.

Both web tools were advertised. The representative explicit `WebFetch` turn
(`8f1e5ed875595893`) returned ordinary final text without any tool call or
network error. The first failing boundary is upstream tool selection, not the
web runtime.

Claude init reported MCP server `context7` with status `failed`; no MCP tool
was included in the Anthropic tool array. MCP is therefore `NOT_CONFIGURED`,
not a demonstrated Bridge tool failure.

## Session and context matrix

| Scenario | Result | Evidence |
| --- | --- | --- |
| Normal session | FULL_PASS | 18 sequential turns, one main client ref, clean process exit |
| Tool-result continuation | FULL_PASS for one-step flows | Real successful and error tool results returned to the model |
| Multi-tool chain | FAIL | First tool succeeded; next intended calls appeared as CC-001 text |
| Error continuation | FULL_PASS | Missing `Read` result was handled and followed by final text |
| System/project context | PARTIAL | no-tool marker-sized response; exact marker boolean was not retained |
| Moderate multi-file context | FAIL | CC-001 occurred before real multi-file reads |
| Compact | NOT_TESTED_COST | command advertised; no artificial context saturation |
| Resume | FAIL | exit 1 and result error before any Bridge request |
| Continue | PARTIAL | request succeeded, but client ref differed from the intended start session |
| Model switch | PARTIAL | `deepseek-chat` worked through stream and continuation; no-tool instruction was not followed |

The resume failure boundary is `CLAUDE_CODE_CLIENT`: Bridge received no HTTP
request. The continue run reached Bridge, but its new client ref proves only a
working new/other client conversation, not continuity with the controlled
start. No Bridge session-reuse claim is made from that run.

## Streaming matrix

| Stream case | Status | Evidence |
| --- | --- | --- |
| Plain text | FULL_PASS | Claude result event and complete upstream stages |
| Tool use | FULL_PASS | real Anthropic tool event executed by Claude Code |
| Post-tool continuation | FULL_PASS | real tool-result request and final response |
| Tool error continuation | FULL_PASS | errored Read result followed by final response |
| Retry-corrected response | OFFLINE_PASS_LIVE_NOT_TRIGGERED | no stochastic format recovery occurred |
| Safe format failure | OFFLINE_PASS_LIVE_NOT_TRIGGERED | focused tests cover generic failure; not observed live |

All 42 normal live responses in the combined diagnostics reached
`completion_completed`, `stream_received`, `stream_read`, and `stream_parsed`.
The two local unsupported-model safe failures correctly had no upstream
stages. There were no duplicate client errors or malformed SSE failures
observed.

## Protocol adapter results

| Endpoint | Plain response | Tool call | Tool-result continuation | Result |
| --- | --- | --- | --- | --- |
| `/v1/messages` | Yes | Yes | Yes | FULL_PASS for protocol transport |
| `/v1/chat/completions` | HTTP 200 | structured `audit_lookup` | HTTP 200 final text | FULL_PASS |
| `/v1/responses` | Not separately needed | structured `audit_lookup` | HTTP 200 final text | FULL_PASS |
| `/v1/messages/count_tokens` | HTTP 200, integer | N/A | N/A | FULL_PASS |

The four models advertised by `/v1/models` were `deepseek-chat`,
`deepseek-reasoner`, `deepseek-chat-search`, and
`deepseek-reasoner-search`. Claude Code was exercised with the first two. The
search variants were not mass-tested; one declared alias check was sufficient
for model-switch transport.

## Slash-command inventory

Claude Code reported 43 slash commands. Commands likely to affect prompts,
context, tools, sessions, or model traffic included `context7-mcp`,
`deep-research`, `design-sync`, `verify`, `debug`, `code-review`, `simplify`,
`batch`, `claude-api`, `run`, `run-skill-generator`, `agents`, `autocompact`,
`clear`, `compact`, `context`, `effort`, `fast`, `mcp`, `model`,
`security-review`, `recap`, `goal`, and the design/workflow commands.

Primarily client-side or administrative commands included `color`, `config`,
`heapdump`, `init`, `rename`, `usage`, `insights`, `reload-skills`, and
`team-onboarding`. `doctor` was inventoried but deliberately not run. The
inventory itself is evidence of availability; it is not evidence that every
slash command is Bridge-compatible.

## Recovery evidence

No live recovery flag was true:

- `reasoning_retry_attempted`: 0
- `fenced_tool_retry_attempted`: 0
- `prefixed_tool_retry_attempted`: 0
- `repeated_tool_retry_attempted`: 0
- maximum upstream completions in one request: 1
- third correction completion: 0

Historical evidence is used with explicit boundaries:

- `CODE_FENCE` was observed live before its implementation; its bounded
  recovery is covered offline; post-fix live recovery remains not triggered.
- `PREFIXED_TOOL_LIKE` was observed live before its implementation; its
  bounded recovery is covered offline; post-fix live recovery remains not
  triggered.
- The final post-fix validation before this audit completed a strict
  `Glob → Read → Grep` chain.
- This audit found a third, distinct brace-delimited structural shape and does
  not relabel it as either existing class.

The absence of a stochastic format retry is not itself a failure. CC-001 is a
failure because the new structural class occurred five times and remained
user-visible.

## Findings

### CC-001 — P1 — Unhandled brace-delimited tool-like output

- **Expected:** the intended tool becomes a real `tool_use`, or a bounded safe
  recovery prevents raw payload exposure.
- **Actual:** five selected contents were `invalid_json`, started and ended
  with braces, contained the marker, and became final text.
- **First failing boundary:** `BRIDGE_RETRY`, following malformed output from
  `UPSTREAM_DEEPSEEK`.
- **Evidence:** the five request refs and structural table above.
- **Reproducibility:** 5/18 main turns, across initial and continuation cases.
- **Impact:** Edit, multi-step read, long agentic, task/agent-overlap, and
  moderate-context flows stopped; raw tool-like text was visible.
- **Root cause confidence:** confirmed that no existing narrow predicate
  matches; exact upstream syntax remains unknown.

### CC-002 — P1 — Write reaches the runtime but does not write

- **Expected:** `Write → tool_result → Read`, with a physical file.
- **Actual:** strict Write call, error result, final response, no file.
- **First failing boundary:** `TOOL_RUNTIME`.
- **Evidence:** request refs `4684c5979422ef56` and `7ca6b51c595785f5`, plus
  physical absence.
- **Reproducibility:** 1/1 controlled Write test.
- **Impact:** Claude Code write capability is unavailable end-to-end.
- **Root cause confidence:** unknown; no raw arguments or error text retained.

### CC-003 — P1 — Advertised shell tools return errors

- **Expected:** read-only Node version and a disposable file write succeed.
- **Actual:** four shell tool results (`Bash` ×3, `PowerShell` ×1) were errors;
  no file was created.
- **First failing boundary:** `TOOL_RUNTIME`; `CLAUDE_CODE_CLIENT` permission or
  Windows runtime behavior is plausible but unconfirmed.
- **Evidence:** `f8330d4df058ce30`, `110436cc4f0c5202`,
  `40f22822f0a491f5`, `ee0f88625f6e08d7`, and their continuations.
- **Reproducibility:** both controlled shell tasks failed.
- **Impact:** shell-backed Claude Code workflows do not work.
- **Root cause confidence:** unknown.

### CC-004 — P1 — Agent nested model alias is unsupported

- **Expected:** parent Agent → nested read → nested result → parent final.
- **Actual:** parent call ran, but two nested `claude-opus-5` requests were
  locally rejected; no complete nested read lifecycle was independently proven.
- **First failing boundary:** `BRIDGE_NORMALIZATION` / model resolution.
- **Evidence:** `b312f510cb844304` and `335b8808873c6d17` had no upstream
  stages and `safe_failure`; later background activity overlapped another turn.
- **Reproducibility:** both nested requests using that alias failed.
- **Impact:** default subagent behavior is not reliably compatible.
- **Root cause confidence:** high for the unsupported alias; background
  sequencing details remain partially unknown.

### CC-005 — P2 — Task-management E2E behavior is not isolated

- **Expected:** an available Task management tool records a two-step plan.
- **Actual:** no isolated Task tool event; read events overlapped the preceding
  background Agent activity and one CC-001 response.
- **First failing boundary:** `UNKNOWN` (audit isolation/client scheduling).
- **Evidence:** one client stream with background Agent interleaving.
- **Reproducibility:** one inconclusive group test.
- **Impact:** Task-management compatibility cannot be claimed.
- **Root cause confidence:** low; do not change production before isolation.

### CC-006 — P2 — Advertised web tool is not selected

- **Expected:** one real read-only WebFetch lifecycle.
- **Actual:** final text, no tool call, no network error.
- **First failing boundary:** `UPSTREAM_DEEPSEEK` tool selection.
- **Evidence:** request `8f1e5ed875595893`.
- **Reproducibility:** 1/1 representative web task.
- **Impact:** Claude Code web capability is not usable in the tested model.
- **Root cause confidence:** unknown; web runtime was never reached.

### CC-007 — P2 — Resume/continue continuity is not compatible

- **Expected:** explicit resume and continue retain the intended client
  conversation and Bridge correlation.
- **Actual:** resume exited before HTTP; continue succeeded under another
  client ref.
- **First failing boundary:** `CLAUDE_CODE_CLIENT` for resume; session selection
  is unknown for continue.
- **Evidence:** resume had zero Bridge requests; start and continue refs differed.
- **Reproducibility:** one controlled start/resume/continue chain.
- **Impact:** cross-process local conversation continuity cannot be relied on.
- **Root cause confidence:** confirmed client-side boundary, exact client cause
  unknown.

### CC-008 — P2 — NotebookEdit is advertised but not invoked

- **Expected:** NotebookEdit → result → Read and a physical notebook update.
- **Actual:** no tool call and no file change.
- **First failing boundary:** `UPSTREAM_DEEPSEEK` tool selection/output.
- **Evidence:** request `c3b752aa1d1c1c48`; marker absent, no raw JSON flag.
- **Reproducibility:** 1/1 controlled notebook task.
- **Impact:** notebook write compatibility is unproven and failed behaviorally.
- **Root cause confidence:** unknown.

### CC-009 — P3 — Safe diagnostics cannot identify runtime-error causes

- **Expected:** audit-safe correlation identifies the accepted tool name and a
  bounded error category without payload logging.
- **Actual:** tool names required separate client event capture; the
  model-switch name and Write/Bash error categories remained unknown.
- **First failing boundary:** `BRIDGE_NORMALIZATION` diagnostics visibility.
- **Evidence:** `tool_response` has no selected-tool name, and request
  diagnostics count tool results but not error results.
- **Reproducibility:** every accepted tool response and all six main tool errors.
- **Impact:** future compatibility failures require custom client harnesses and
  still may lack a safe first-cause category.
- **Root cause confidence:** confirmed observability gap.

## Security notes

Diagnostics contained only allowed identifiers, counts, flags, structural
metadata, stages, and process-scoped refs. The capture harness discarded
assistant text, reasoning, tool inputs, tool-result bodies, stderr text, and
full session identifiers. Runtime failure causes are deliberately marked
unknown rather than recovered from sensitive payloads. The fixture was
resolved to the exact expected absolute path before recursive deletion.

## Final verdict

**PARTIALLY_COMPATIBLE.** Core text, streaming, read tools, individual
tool-result continuation, tool-error continuation, count tokens, networking,
and all three protocol adapters work. Available key capabilities do not all
work: Edit and multi-step agentic flows expose a repeated malformed structural
shape, Write and shell tools return errors, Web and Notebook tools are not
invoked, subagents hit an unsupported model alias, and explicit resume fails
before Bridge. These are concrete blockers to calling the integration fully or
mostly compatible, but they do not invalidate the working core read path.
