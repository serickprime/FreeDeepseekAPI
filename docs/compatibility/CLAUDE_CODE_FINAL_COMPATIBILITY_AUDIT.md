# Claude Code Final Compatibility Audit

Date: 2026-08-13

`FINAL_AUDIT_MAIN_SHA = fce78c14f662f99de3b3f4603c178f0852265a26`

`CLAUDE_CODE_VERSION_RANGE = 2.1.226-2.1.231; FINAL_LIVE_MATRIX = 2.1.231 FOR ALL SIX RUNS`

`NODE_VERSION = v24.12.0`

`TESTS = 215/215 PASS`

`FOREGROUND_LIVE_INVOCATIONS = 6`

`HARNESS_RETRIES = 0`

`REQUEST_BYTES_IDENTICAL = YES`

`RAW_TOOL_OUTPUT_EXPOSURE = NO`

`CC010_REGRESSION_EVIDENCE = NO`

`OPEN_PROVEN_BRIDGE_DEFECTS = 0`

`PRODUCTION_FIX_REQUIRED = NO`

`FINAL_COMPATIBILITY_VERDICT = MOSTLY_COMPATIBLE_WITH_DOCUMENTED_LIMITATIONS`

`ORDINARY_CHAT = FULL_PASS`

`SYSTEM_CONTEXT = PASS`

`CORE_READ_FLOW = PASS`

`EDIT_PHYSICAL = PASS`

`WRITE_PHYSICAL = PASS`

`BASH_READ_ONLY = PASS`

`AGENT_SUBAGENT = PASS`

`WEBFETCH = FORMAT_LIMITATION`

`WEBSEARCH = PASS`

`NOTEBOOKEDIT = RUNTIME_LIMITATION`

`RESUME = PASS`

`CONTINUE = PASS`

`TASK_CORE = MODEL_SELECTION_LIMITATION`

## Executive summary

FreeDeepseekAPI is currently mostly compatible with Claude Code for ordinary
conversation, streaming, project context, core read/write/edit tools,
read-only Bash, multi-step continuation, Agent/subagent work, session
resume/continue, token counting, and the OpenAI and Responses adapters. The
final bounded matrix added six fresh Claude Code 2.1.231 invocations against
unchanged production code. It produced 12 strict tool calls, 12 non-error
tool results, 12 continuation requests, zero corrections, zero raw tool-output
exposures, and zero network errors. Every Bridge request used one completion.

Compatibility is not universal. WebFetch remains limited by a DeepSeek output
format failure before runtime, although CC-010 contains it safely. WebSearch
passes end to end. NotebookEdit reaches Claude Code as a strict call but its
Claude runtime returned errors in both targeted runs and made no physical
change. Core Task operations work when selected, but per-turn selection is
nondeterministic. POSIX-style Bash redirection has a command-form permission
limitation, PowerShell is not in the current observed inventory, MCP is not
configured, AskUserQuestion is unavailable, and compact/autocompact remains
untested.

No current evidence locates a remaining failure inside Bridge-owned schema
transport, strict parsing, protocol adaptation, result correlation, session
correlation, bounded recovery, or diagnostics. There are therefore no open
proven Bridge defects and no production fix is justified by this audit.

## Audit baseline

| Property | Value |
| --- | --- |
| Production baseline | `fce78c14f662f99de3b3f4603c178f0852265a26` |
| Audit branch | `audit/final-claude-code-compatibility` |
| Node.js | `v24.12.0` |
| Final-run Claude Code | `2.1.231` immediately before each of six invocations |
| Wider targeted evidence range | `2.1.226` through `2.1.231` |
| Baseline suite | `215/215 PASS` |
| Baseline syntax checks | five required `node --check` commands: PASS |
| Baseline diff check | PASS |
| Production changes | 0 |
| Test changes | 0 |

The repository was clean before the audit. `main`, local HEAD, and
`origin/main` all matched the stated baseline after fetch and fast-forward
pull.

## Methodology

The audit combined the current production source and 215-test suite with the
latest finding-directed reports and a deliberately small final live matrix.
Fresh targeted evidence was not repeated for WebFetch, WebSearch,
NotebookEdit, Task tools, resume/continue, count_tokens, malformed-output
recovery, or the OpenAI/Responses adapters.

The live topology for all six new runs was:

```text
fresh Claude Code process
-> owned loopback observer
-> unchanged production Bridge
-> DeepSeek
```

The observer parsed only an in-memory copy and forwarded the original request
Buffer. Before/after hashes and byte lengths matched for every request. It
retained only bounded tool names, counts, booleans, enums, terminal outcomes,
and physical-check booleans. It did not retain prompts, paths, file contents,
reasoning, arguments, result contents, raw malformed output, headers,
credentials, cookies, session IDs, or call IDs.

Each run used a fresh Claude session and a temporary Claude config. The
Claude version was captured immediately before each invocation. Harness
retries were zero. The Bridge's single shared correction budget remained
available, but no final-matrix request used it. The disposable synthetic
project was outside the repository and contained only harmless project,
TypeScript, and text fixtures. Physical checks were independent of model
claims.

Between runs, each CLI reached a terminal event; pending requests and requests
after terminal were zero. After the matrix, the fixture, temporary configs,
and ignored observer were removed. Both owned ports were free and the owned
Claude child-process count was zero.

## Evidence precedence

Conflicting evidence was resolved in this order:

1. current production source on the final-audit baseline;
2. current 215-test suite;
3. this final bounded live matrix;
4. the newest merged finding-directed report;
5. the newest merged implementation/live report;
6. the compatibility checkpoint;
7. the original full audit; and
8. the original fix plan.

The original audit remains the historical baseline. Its FAIL labels are not
current where later controlled evidence reached a farther boundary or proved
a fix.

## Changes since original audit

The original audit evaluated Bridge
`b49bf745fd6cbc70bb008eb7e90c58edfccd9d14` with Claude Code 2.1.226 and a
185-test suite. Three production changes relevant to its findings later
landed:

| Finding | Production change | Effect |
| --- | --- | --- |
| CC-009 | `e4dfce2`, corrected by `05b5b17` | Added bounded selected-tool and current-result error diagnostics |
| CC-001 | `7d1e57c` | Added one narrow brace-delimited correction class without relaxing the parser |
| CC-010 | `9682cc0` | Removed historical format contamination and added narrow correction-only malformed classifications |

Later evidence also superseded historical failures without production
changes: Write, Agent/subagent, and resume/continue now pass; Bash was narrowed
to a command-form limitation; Task behavior was narrowed to model selection;
WebSearch passed; WebFetch was isolated to upstream formatting; and
NotebookEdit was isolated to the Claude Code runtime. The suite now contains
215 passing tests.

## Final live matrix

### Aggregate

| Measure | Result |
| --- | ---: |
| Fresh foreground invocations | 6 |
| Harness retries | 0 |
| Anthropic message requests | 23 |
| Strict tool calls | 12 |
| Tool results | 12 |
| Tool-result errors | 0 |
| Continuation requests | 12 |
| Maximum completions per request | 1 |
| Correction attempts | 0 |
| Formatting failures | 0 |
| Raw `[Tool Call]` exposures | 0 |
| Raw `tool_call` JSON exposures | 0 |
| Network/upstream errors | 0 |

### Run results

| Run | Model / Claude | Observed lifecycle | Physical / terminal result | Classification |
| --- | --- | --- | --- | --- |
| 1 — ordinary/context | `deepseek-chat` / 2.1.231 | one no-tool request, final text, no unexpected call | expected project-context marker observed; fixture unchanged | `ORDINARY_CHAT=FULL_PASS`; `SYSTEM_CONTEXT=PASS` |
| 2 — core read | `deepseek-chat` / 2.1.231 | strict `Glob -> Read -> Grep`; 3 results, 0 errors, 3 continuations | final text; fixture unchanged | `CORE_READ_FLOW=PASS` |
| 3 — Edit | `deepseek-chat` / 2.1.231 | strict `Read -> Edit`; 2 results, 0 errors, 2 continuations | expected replacement present; old marker absent | `EDIT_PHYSICAL=PASS` |
| 4 — Write | `deepseek-chat` / 2.1.231 | strict `Write`; 1 result, 0 errors, 1 continuation | target exists with exact expected marker | `WRITE_PHYSICAL=PASS` |
| 5 — Bash | `deepseek-chat` / 2.1.231 | strict read-only `Bash`; 1 result, 0 errors, 1 continuation | final text; fixture unchanged | `BASH_READ_ONLY=PASS` |
| 6 — Agent | `deepseek-reasoner` / 2.1.231 | `Agent` advertised/selected; strict aggregate `Agent` x2, `Glob` x1, `Read` x2; 5 results, 0 errors, 5 continuations | Agent result reached parent; terminal parent response; fixture unchanged | `AGENT_SUBAGENT=PASS` |

Run 1's prompt requested the project marker without containing the marker
value. The correct marker was observed in final text without a tool call. This
proves project-context transport behaviorally. The observer did not retain the
exact Anthropic field into which Claude Code packed that context, so the audit
does not claim a specific `system`-field layout.

Run 2 had inbound `tool_choice=NONE`; all three tools were selected naturally.
This is a current end-to-end automatic-selection and sequential-continuation
pass.

Run 3 selected Read before Edit, not a separate verification Read after Edit.
Run 4 selected Write but did not select the requested verification Read. The
audit therefore does not attribute `READ_AFTER_EDIT` or `READ_AFTER_WRITE` to
those individual runs. The independent physical checks prove both mutations,
and Run 2 plus prior targeted evidence independently prove Read and the
requested sequential lifecycle class. Neither run was repeated.

Run 6 used parent and nested inventories of three and two tools respectively.
The aggregate strict sequence and inventory contraction, successful Agent
result, and parent terminal response prove a real bounded subagent lifecycle.
The exact per-request nested model string was not separately retained in this
run; there was no unsupported-model rejection or error result, and the
earlier CC-004 controlled sequence independently retained
`deepseek-reasoner` on every nested request. The run also contained three
non-exposed intermediate Bridge outcomes classified as `safe_failure`, with
no correction, structural recovery class, tool-result error, raw output, or
network error. Claude Code continued to successful tool and terminal
lifecycles. Their internal upstream cause is not inferred and they do not
establish a failing capability or Bridge defect.

## Current capability matrix

`HIGH` means current tests plus direct controlled lifecycle evidence. `MEDIUM`
means the current boundary depends on a smaller observation set or inventory
state. For unavailable or untested rows, confidence describes the boundary,
not feature support.

| Capability | Current status | Confidence | Limiting layer | Bridge fix needed | Strongest evidence |
| --- | --- | --- | --- | --- | --- |
| Ordinary chat | `FULL_PASS` | HIGH | None | NO | Final Run 1 plus current Anthropic tests |
| Anthropic streaming | `FULL_PASS` | HIGH | None | NO | Current text/tool/continuation/stream tests and all final runs |
| System/project context | `PASS` | HIGH | Exact client field placement not retained | NO | Run 1 marker boolean without marker value in prompt |
| Tool inventory | `FULL_PASS` | HIGH | Client inventory varies by run | NO | Final inventories plus all targeted schema reports |
| Glob | `PASS` | HIGH | None | NO | Final Run 2 and CC-004 |
| Read | `PASS` | HIGH | None | NO | Final Runs 2, 3, and 6 plus error-continuation evidence |
| Grep | `PASS` | HIGH | None | NO | Final Run 2 |
| Edit | `PASS` | HIGH | None | NO | Final Run 3 strict result and physical replacement |
| Write | `PASS` | HIGH | None | NO | Final Run 4 strict result and physical creation |
| Bash read-only | `PASS` | HIGH | None for tested command | NO | Final Run 5 and CC-003 controls |
| Bash filesystem mutation | `COMMAND_FORM_LIMITATION` | HIGH | `CLAUDE_CODE_PERMISSION_COMMAND_FORM` | NO | CC-003: redirection denied; Node fs write and touch passed |
| PowerShell | `NOT_AVAILABLE` | MEDIUM | `CLAUDE_CODE_TOOL_INVENTORY` | NO | Latest normal Windows inventories omitted the tool |
| Automatic tool selection | `PASS` | HIGH | Nondeterministic for some specialized tools | NO | Run 2 selected three tools with choice `NONE` |
| Sequential multi-tool flow | `PASS` | HIGH | None | NO | Final `Glob -> Read -> Grep` lifecycle |
| Longer agentic flow | `PASS` | HIGH | Bounded flow only | NO | Final Run 6 plus CC-004 detailed sequence |
| Tool-result continuation | `FULL_PASS` | HIGH | None | NO | 12/12 final-matrix results continued |
| Tool-error continuation | `PASS` | HIGH | None | NO | Current tests, CC-009 missing Read, and CC-008 error results |
| Agent/subagent | `PASS` | HIGH | Bounded read-only scope | NO | Final Run 6 and CC-004 nested lifecycle |
| TaskCreate | `MODEL_SELECTION_LIMITATION` | HIGH | `MODEL_TOOL_SELECTION` | NO | Real selected lifecycle plus CC-005 nondeterminism |
| TaskList | `MODEL_SELECTION_LIMITATION` | HIGH | `MODEL_TOOL_SELECTION` | NO | Real selected lifecycle plus CC-005 nondeterminism |
| TaskGet | `MODEL_SELECTION_LIMITATION` | HIGH | `MODEL_TOOL_SELECTION` | NO | Successful calls around one reproduced not-selected turn |
| TaskUpdate | `MODEL_SELECTION_LIMITATION` | HIGH | `MODEL_TOOL_SELECTION` | NO | Successful in-progress/completion calls; selection not guaranteed |
| TaskOutput | `NOT_TESTED` | HIGH boundary | No applicable background executable task | NOT PROVEN | CC-005 explicit safety boundary |
| TaskStop | `NOT_TESTED` | HIGH boundary | No safely stoppable runtime task | NOT PROVEN | CC-005 explicit safety boundary |
| WebFetch | `FORMAT_LIMITATION` | HIGH | `UPSTREAM_DEEPSEEK_FORMAT_OUTPUT` | NO | CC-006: strict schema path passed; malformed output safely contained |
| WebSearch | `PASS` | HIGH | None | NO | CC-006 real runtime, result, continuation, final |
| NotebookEdit | `RUNTIME_LIMITATION` | HIGH | `CLAUDE_CODE_NOTEBOOK_RUNTIME` | NO | CC-008: two strict calls, two error results, no mutation |
| `count_tokens` | `FULL_PASS` | HIGH | Local estimate by design | NO | Route tests, original probe, CC-007 chain |
| Compact/autocompact | `NOT_TESTED` | HIGH boundary | No controlled context-saturation lifecycle | NOT PROVEN | Explicit bounded-audit exclusion |
| Resume | `PASS` | HIGH | None | NO | CC-007 fresh explicit resume chain |
| Continue | `PASS` | HIGH | None | NO | CC-007 fresh continue identity/context chain |
| Model switching | `PARTIAL` | MEDIUM | `MODEL_BEHAVIOR_AFTER_SWITCH` | NO current defect | Exact model resolution passes; behavioral evidence remains partial |
| MCP | `NOT_CONFIGURED` | HIGH boundary | `CLAUDE_CODE_MCP_CONFIG` | NO | No healthy MCP tool reached Bridge |
| AskUserQuestion | `NOT_AVAILABLE` | HIGH boundary | `CLAUDE_CODE_TOOL_INVENTORY` | NO | Not advertised to Bridge in current evidence |
| OpenAI Chat Completions adapter | `FULL_PASS` | HIGH | None | NO | Current call/result/stream tests and API probe |
| Responses adapter | `FULL_PASS` | HIGH | None | NO | Current call/result/stream tests and API probe |
| Malformed/raw tool output handling | `PASS` | HIGH | Bounded to recognized structural classes | NO | CC-001/CC-010 tests and zero final raw exposures |
| Network diagnostics | `FULL_PASS` | HIGH | External availability remains environmental | NO | Safe staged tests and zero final-matrix errors |
| Session isolation/correlation | `FULL_PASS` | HIGH | None observed | NO | Current resolver tests, CC-007, and isolated fresh runs |

## CC-001 through CC-010 final disposition

| Finding | Original status / boundary | Final status | Production fix landed | Bridge defect remains | Remaining limitation |
| --- | --- | --- | --- | --- | --- |
| CC-001 | Raw brace-delimited tool-like output at Bridge recovery | `FIXED` | YES | NO | Correction is intentionally one-shot and structural |
| CC-002 | Write reached runtime but failed | `REEVALUATED_PASS` | NO | NO | Historical cause remains unknown, not current |
| CC-003 | General shell runtime failure | `DOCUMENTED_LIMITATION` | NO | NO | POSIX redirection command form; PowerShell inventory absence |
| CC-004 | Agent nested unsupported alias | `REEVALUATED_PASS` | NO | NO | Bounded Agent evidence only |
| CC-005 | Inconclusive Task lifecycle | `DOCUMENTED_LIMITATION` | NO | NO | Per-turn model selection is nondeterministic |
| CC-006 | Web tools not proven | `PARTIAL_FORMAT_LIMITATION` | NO | NO | WebFetch upstream formatting; WebSearch passes |
| CC-007 | Resume failed; continue identity unproven | `REEVALUATED_PASS` | NO | NO | Historical client behavior not reproduced |
| CC-008 | NotebookEdit not selected | `RUNTIME_LIMITATION` | NO | NO | Claude Code runtime errors; no physical mutation |
| CC-009 | Safe diagnostic correlation gap | `FIXED` | YES | NO | Diagnostics remain opt-in and bounded by design |
| CC-010 | History/output inconsistency and malformed textual calls | `FIXED` | YES | NO | Model may still format/select badly; one correction maximum |

All ten findings now have an evidence-based disposition. None leaves an open
proven Bridge defect.

## Production fixes that landed

### CC-009 — safe observability

The Bridge now emits only bounded safe selected-tool and current linked-result
error metadata. Historical errors do not contaminate a later request.
Diagnostics remain opt-in and logger failures remain observational.

### CC-001 — brace-delimited recovery

The strict parser still rejects the malformed shape. One narrow predicate may
request one fresh canonical completion. A failed correction returns generic
safe text and never the rejected payload.

### CC-010 — format consistency and recovery

Historical calls use neutral action records instead of output-like
`[Tool Call]` transcripts. Exact textual transcripts, multiple/suffixed
tool-like envelopes, and selected malformed envelope shapes are correction
signals only. They are never directly executed or locally repaired.

## Model limitations

- Core Task tools have working runtimes when selected, but selection on an
  individual turn is not deterministic when Claude sends no forced choice.
- WebFetch produced a recognizable malformed DeepSeek tool intent and then a
  second non-canonical completion. The Bridge safely stopped at two
  completions; the WebFetch runtime was not reached.
- Specialized-tool selection is not guaranteed even though automatic
  selection worked cleanly for the final core read flow.
- A model may still return prose instead of choosing a tool. That is not a
  Bridge defect in the absence of a strict call or a client forcing
  requirement.

## Claude Code runtime limitations

- NotebookEdit was advertised, selected, strictly accepted, and emitted as a
  real Claude tool use twice. Claude Code returned an error result both times,
  and neither notebook cell changed.
- POSIX-style Bash redirection hit a Claude permission/command-form boundary.
  Read-only Bash, Node filesystem mutation, and touch controls passed, so this
  is not a general Bash or Bridge failure.

## Client/inventory limitations

- PowerShell was absent from the latest controlled normal Windows tool
  inventories.
- AskUserQuestion was not advertised to Bridge.
- MCP was not configured successfully, so no MCP tool reached Bridge.
- TaskOutput and TaskStop lacked an applicable safe background/stoppable task.
- No current client request in the targeted evidence forced a tool using
  `ANY` or `TOOL(name)`. The Bridge's lack of a forced-choice implementation
  is therefore not a proven current-client defect and remains separate scope.

## Untested / unavailable boundaries

- Compact/autocompact is `NOT_TESTED`; the audit intentionally did not create
  artificial context saturation.
- TaskOutput and TaskStop are `NOT_TESTED`, not failed.
- MCP is `NOT_CONFIGURED` and AskUserQuestion/PowerShell are currently
  `NOT_AVAILABLE` in the applicable inventories.
- Model-switch behavior remains `PARTIAL`; exact supported model transport is
  tested, but broad behavioral equivalence after switching is not claimed.

## Security and strictness status

The final source review and 215-test suite confirm:

- the executable parser remains a strict whole-response parser;
- arbitrary or embedded JSON is not extracted and executed;
- JSON5, `jsonrepair`, fuzzy regex execution, and local argument repair are
  absent;
- unavailable and unknown tool names are rejected;
- `MAX_COMPLETIONS = 2` remains the hard ceiling;
- all recovery classes share one correction budget;
- recognized malformed payloads are suppressed after failed correction;
- diagnostics are opt-in, bounded, and contain no raw arguments, paths,
  prompts, results, reasoning, credentials, or stable session identifiers;
  and
- Bridge emits tool requests to the calling client and does not execute model
  tool calls itself.

No final live request needed recovery; maximum observed completions was one.

## Raw tool-output containment

Across the six final runs:

- textual `[Tool Call]` exposure: 0;
- raw `tool_call` JSON exposure: 0;
- structural malformed classifications: 0;
- correction attempts: 0;
- generic safe-failure text exposure: 0; and
- maximum completions per request: 1.

Fresh CC-006 and CC-008 evidence covers the important negative path:
recognized malformed output was contained, the shared budget stopped at two
completions, and raw payload was not returned. Nothing in the final matrix
contradicts CC-010.

## Remaining Bridge defects

`OPEN_PROVEN_BRIDGE_DEFECTS = 0`

`BRIDGE_DEFECT = NO`

`PRODUCTION_FIX_REQUIRED = NO`

No observed failure meets the ownership test for a Bridge defect. WebFetch
failed before a strict call at upstream formatting; NotebookEdit failed after
strict Bridge output at Claude runtime; Task nondeterminism failed before any
call; and unavailable/unconfigured features did not reach Bridge.

The three non-exposed intermediate safe outcomes in final Agent Run 6 are
recorded, but they did not fail the lifecycle and have no retained malformed,
network, runtime-error, or Bridge-owned causal boundary. They are not promoted
to a defect without contradictory reproducible evidence.

## Final compatibility verdict

`FINAL_COMPATIBILITY_VERDICT = MOSTLY_COMPATIBLE_WITH_DOCUMENTED_LIMITATIONS`

This verdict is stronger than the original `PARTIALLY_COMPATIBLE` result
because the original Bridge defects are fixed, several historical failures
now pass, and the remaining important failures have been isolated outside
Bridge. It is intentionally not `FULLY_COMPATIBLE`: advertised WebFetch and
NotebookEdit do not currently complete successfully, Task selection is not
deterministic, and several client/runtime boundaries remain unavailable,
unconfigured, or untested.

## Recommended maintenance

- Keep the 215-test strictness and recovery matrix mandatory for parser,
  continuation, streaming, and diagnostics changes.
- Re-evaluate WebFetch or NotebookEdit only after a material DeepSeek or
  Claude Code runtime change, or new reproducible boundary evidence. Do not
  add fuzzy parsing, argument rewriting, or Bridge-side tool execution.
- Treat Task acknowledgements as provisional until a real Task result exists;
  do not infer forcing from natural-language prompts.
- Track Claude Code version at each future compatibility run because inventory
  and runtime behavior can cross update boundaries.
- Scope any future forced `tool_choice`, MCP, compact, WebFetch workaround, or
  NotebookEdit workaround as a separate feature/finding with its own evidence.

The targeted compatibility investigation is complete. No follow-on
production development was started by this audit.
