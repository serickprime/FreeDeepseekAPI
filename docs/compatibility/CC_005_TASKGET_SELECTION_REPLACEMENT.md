# CC-005 TaskGet Selection Replacement

Date: 2026-08-12

Main baseline: `98fc4c01efcee4fbba7c13d01b1bde5a928f5051`

Branch: `audit/cc-005-taskget-selection-investigation`

Starting branch HEAD: `3948d57d7b2b772ea7cfa8f98fe1ac312e5ae6ba`

Claude Code: `2.1.226`

Node.js: `v24.12.0`

OS: Microsoft Windows

Model: `deepseek-reasoner`

`REPLACEMENT_AUTHORIZED = YES`

## Previous investigation boundary

The preserved first investigation report classified its run as
`CC_005_TASKGET_INVESTIGATION_BLOCKED`. Its boundary was an
`INVESTIGATION_HARNESS` gate before Turn 4: the temporary harness required a
TaskUpdate status enum at one particular schema path.

That result was not a production failure and did not prove a Bridge defect.
The previous report remains unchanged.

## Replacement harness change

The previous schema-enum gate was removed. The replacement did not inspect or
require any TaskUpdate schema enum before Turn 4. It sent the already proven
`in_progress` value directly and allowed Claude Code to construct the actual
TaskUpdate call.

- Schema enum gate removed: Yes.
- Schema discovery required before TaskUpdate: No.
- Production code changed: No.
- Parser, retry, Task schemas, and model selection changed: No.

The replacement harness nevertheless retained a different post-result gate:
after a successful TaskUpdate lifecycle, it required the bounded status
extractor to independently find `in_progress` in the tool-result
representation. That extractor returned no status enum, so the harness ended
the invocation before sending critical Turn 5. This was an investigation
harness limitation, not a TaskUpdate runtime error.

## Observer and invocation

A temporary loopback observer accepted Claude Code traffic on port 9655 and
forwarded it to the unchanged Bridge on port 9656. It parsed a copy of each
body only in memory and forwarded the original raw request bytes.

- Observer used: Yes.
- Bridge and observer health checks: PASS.
- Request bytes identical: Yes, all forwarded requests.
- Foreground invocations: 1.
- Foreground exit code: 0.
- Sequential user turns: 4.
- `/v1/messages` requests: 8.
- Normal tool inventory: 25 on every request.
- Model: `deepseek-reasoner` on every request.

The replacement invocation was not repeated.

## Tool inventory

All six Task-management tools and Agent were advertised on every reached
Messages request.

| Tool | Advertised |
| --- | --- |
| `TaskCreate` | Yes |
| `TaskGet` | Yes |
| `TaskList` | Yes |
| `TaskUpdate` | Yes |
| `TaskOutput` | Yes |
| `TaskStop` | Yes |
| `Agent` | Yes |

Agent selected count was zero. TaskOutput and TaskStop remained
`NOT_APPLICABLE`; no background runtime task was created.

## Tool-choice matrix

Each reached operation generated one initial request and one tool-result
continuation. The inbound `tool_choice` field was absent from all eight
requests. No forced name or `disable_parallel_tool_use` value was present.

| Turn | Operation | Advertised | Choice present | Choice | Forced name | Selected | Strict | Results/errors | Same task | State | Outcome |
| ---: | --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| 1 | Create | Yes | No | NONE | N/A | `TaskCreate` | Yes | 1 / 0 | Created | N/A | PASS |
| 2 | List | Yes | No | NONE | N/A | `TaskList` | Yes | 1 / 0 | Yes | `pending` | PASS |
| 3 | Baseline Get | Yes | No | NONE | N/A | `TaskGet` | Yes | 1 / 0 | Yes | `pending` | PASS |
| 4 | Update to in-progress | Yes | No | NONE | N/A | `TaskUpdate` | Yes | 1 / 0 | Yes | requested `in_progress`; result enum not retained | strict lifecycle PASS; harness stopped |
| 5 | Critical verification Get | Not reached | Not observed | N/A | N/A | Not reached | No | 0 / 0 | Not reached | Not reached | BLOCKED |
| 6 | Completion Update | Not reached | Not observed | N/A | N/A | Not reached | No | 0 / 0 | Not reached | Not reached | NOT_RUN |
| 7 | Completion verification Get | Not reached | Not observed | N/A | N/A | Not reached | No | 0 / 0 | Not reached | Not reached | NOT_RUN |

TaskList independently proved that the created task was visible, preserving
the closure of the earlier same-task evidence gap. Baseline TaskGet returned
the same task in `pending` state.

Turn 4 proved a real accepted TaskUpdate call for the same task with the safe
requested status enum `in_progress`. Claude Code returned one real non-error
tool result and continued to ordinary final text. No TaskUpdate runtime error
occurred. Only the temporary result-status extractor failed to retain the
status a second time.

## Critical TaskGet turn

The critical TaskGet turn was not sent because the replacement harness stopped
after Turn 4. Therefore the following fields have no current evidence:

- TaskGet advertised on critical turn: not observed.
- Inbound critical `tool_choice`: not observed.
- Forced tool name: not observed.
- Actual selected tool: not reached.
- Strict call: not reached.
- Tool result/errors: 0 / 0 because the turn was not sent.
- Same task and verified state: not reached.

Critical classification: `NOT_REACHED_DUE_TO_REPLACEMENT_HARNESS`

The historical TaskGet selection failure is still `UNRESOLVED`. The absence
of `tool_choice` on Create, List, baseline Get, and Update cannot be substituted
for direct evidence from the missing critical request.

## Isolation and diagnostics

- Agent selected: 0.
- Agent/background contamination: No.
- Background request crossings: 0.
- Quiet boundaries: 4/4.
- Pending requests after terminal state: 0.
- Orphan requests: 0.
- Network errors: 0.
- Raw tool-like JSON occurrences: 0.
- Brace recovery events: 0.
- Other retries: 0.
- Direct maximum completions per request: 1.
- Completion counter stage: verified `completion_start`.

## Security and cleanup

The temporary observer retained only bounded structural metadata, safe tool
names and status enums, counts, booleans, safe request references, and a
process-salted task fingerprint. It did not retain prompts, messages, task
text, raw arguments or results, raw task IDs, raw bodies, model output,
reasoning, headers, credentials, session IDs, call IDs, or private absolute
paths.

The owned Claude, observer, and Bridge processes stopped. Ports 9655 and 9656
were free and the disposable fixture was removed. The ignored observer,
snapshot, and append-only safe journal were removed after bounded evidence was
transferred to this report.

## Validation

- Pre-live `npm.cmd test`: 202/202 PASS.
- Post-live `npm.cmd test`: 202/202 PASS.
- Required `node --check`: PASS before and after live.
- `git diff --check`: PASS before and after live.
- Production files changed: none.
- Test files changed: none.

## Root decision

First failing boundary:
`INVESTIGATION_HARNESS: post-TaskUpdate result-status extraction before critical Turn 5`

`BRIDGE_DEFECT_EVIDENCE = NO`

`PRODUCTION_FIX_REQUIRED = UNKNOWN`

Classification: `CC_005_REPLACEMENT_BLOCKED`

Historical TaskGet selection failure: `UNRESOLVED`

`NEXT_ACTION = REPEAT_CC005_TASKGET_SELECTION_ONLY_WITH_NEW_AUTHORIZATION`

No production fix, second replacement invocation, PR, or CC-006/CC-007 work
was started.
