# CC-005 Task Management Re-evaluation

Date: 2026-08-12

Production baseline: `e8df071070345f1ad3afcb5f731d0f6591b72708`

Branch: `audit/cc-005-task-management-reevaluation`

Claude Code: `2.1.226`

Node.js: `v24.12.0`

OS: Microsoft Windows

Model: `deepseek-reasoner`

## Historical boundary

The historical audit advertised all six Task-management tools, but its Task
observations followed Agent/background activity. Read events overlapped the
Task turn, and no isolated Task tool event was proven. That evidence remains
inconclusive: it proves neither a Task lifecycle pass nor a Bridge failure.

This re-evaluation used one new foreground Claude Code invocation in a
disposable fixture. No Agent call occurred before or during the Task turns,
no background request crossed a user-turn boundary, and no previous Claude
session was resumed or continued.

## Invocation and safety boundary

The invocation used the proven direct native Claude executable with
`shell:false`, realtime `stream-json` input, structured `stream-json` output,
verbose mode, `deepseek-reasoner`, and the normal built-in tool inventory. It
did not use `--resume`, `--continue`, or `--bare`.

- Foreground invocations: 1.
- Foreground exit code: 0.
- Sequential user turns sent: 6.
- `/v1/messages` requests: 10.
- Normal inventory count: 25.
- Agent calls before Task lifecycle: 0.
- Agent calls during Task lifecycle: 0.
- Agent selected count: 0.
- Background requests crossing user turns: 0.
- Quiet boundaries before every next turn: 6/6.
- Pending requests after the bounded final quiet interval: 0.
- Orphan requests: 0.
- Network errors: 0.

The fixture contained one synthetic README. Production and test files were
not changed. The harness retained only bounded safe request metadata, tool
names, counts, booleans, status enums, and a temporary one-way task
fingerprint. It did not retain prompts, task title or description text, tool
arguments, tool-result text, raw task IDs, model output, reasoning, request or
response bodies, headers, credentials, session IDs, call IDs, or private
absolute paths.

## Tool inventory

| Tool | Advertised | Selected count |
| --- | --- | ---: |
| `TaskCreate` | Yes | 1 |
| `TaskGet` | Yes | 1 |
| `TaskList` | Yes | 1 |
| `TaskUpdate` | Yes | 1 |
| `TaskOutput` | Yes | 0 |
| `TaskStop` | Yes | 0 |
| `Agent` | Yes | 0 |

The selected counts above cover real accepted calls. The later explicit
update-verification `TaskGet` and completion `TaskUpdate` requests returned
ordinary final text without selecting a tool, so they do not increase these
counts.

## Lifecycle matrix

| Operation | Advertised | Selected | Strict | Results | Errors | Same task | Verified | Status |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| TaskCreate | Yes | Yes | Yes | 1 | 0 | Created correlation captured | Yes | PASS |
| TaskList | Yes | Yes | Yes | 1 | 0 | Not independently retained | No | PARTIAL_EVIDENCE |
| TaskGet | Yes | Yes | Yes | 1 | 0 | Yes | Yes | PASS (`pending`) |
| TaskUpdate | Yes | Yes | Yes | 1 | 0 | Yes | Yes | PASS (`in_progress`) |
| Update verification | Yes | No | No | 0 | 0 | Not reached | No | NOT_SELECTED |
| Completion | Yes | No | No | 0 | 0 | Not reached | No | NOT_SELECTED |
| Completion verification | Yes | No | No | 0 | 0 | Not reached | No | NOT_RUN |
| TaskOutput | Yes | No | No | 0 | 0 | N/A | N/A | NOT_APPLICABLE |
| TaskStop | Yes | No | No | 0 | 0 | N/A | N/A | NOT_APPLICABLE |

The first four selected operations each completed a real protocol lifecycle:
the Bridge accepted a strict Task call, Claude Code returned one real tool
result with `is_error = false`, and a continuation reached ordinary final
text. `TaskGet` and `TaskUpdate` used the same bounded task correlation as the
created task. The update call requested and reported the supported
`in_progress` state.

The TaskList result succeeded and exposed a `pending` status, but the bounded
summary did not independently retain `SAME_TASK = YES` for that result. It is
therefore not promoted to a full same-task verification claim.

## First incomplete boundary

The next explicit update-verification turn kept the full 25-tool inventory,
including `TaskGet`, but selected no tool. It completed as ordinary final text
with no tool result, network error, raw tool-like JSON, or retry. The following
explicit completion turn likewise kept `TaskUpdate` advertised but selected
no tool and returned ordinary final text.

The first operationally failing boundary is therefore:

`MODEL_TOOL_SELECTION_FAILURE: TaskGet during update verification`

This is not evidence that Bridge corrupted a call. No Task tool call existed
for Bridge to adapt on that turn. The earlier accepted Create/List/Get/Update
calls also prove that Bridge emitted Task tool use and preserved their real
result continuations on the unchanged production baseline.

## TaskOutput and TaskStop policy

`TaskOutput` and `TaskStop` were not invoked. The created TaskCreate record was
not a background executable runtime task, and no active disposable stoppable
process existed. Creating an Agent/background process solely to exercise
these tools was explicitly out of scope.

- `TASK_OUTPUT = NOT_APPLICABLE`
- `TASK_STOP = NOT_APPLICABLE`

Neither status is counted as a failure of the isolated core lifecycle.

## Isolation and completion

All six completed user-turn boundaries reached a quiet state before the next
turn. Agent selection, background crossing, pending requests, orphan requests,
and network errors were all zero. The conversation continued from Create
through List, Get, Update, verification request, and completion request.

The required completed-task state was not independently reached or verified,
so the dedicated post-completion no-tool conversation turn was not sent.
`FINAL_CONVERSATION_CONTINUATION` is therefore `NOT_REACHED`, not PASS.

## Retry and parser observations

- Raw tool-like JSON occurrences: 0.
- Brace recovery events: 0.
- Other correction/retry events: 0.
- Network errors: 0.
- Retry budget remained unused.

The temporary completion-stage counter used the label `completion_request`,
while production diagnostics emit `completion_start`. It therefore retained
zero as an instrumentation artifact and is not used as a factual completion
count. With no correction flag, upstream error, or network retry, the code
path is consistent with one completion per request, but the report does not
present the broken direct counter as evidence. The single authorized live run
was not repeated to improve instrumentation.

## Cleanup and regression

The owned Claude process and Bridge stopped, Claude process count returned to
zero, and port 9655 was free. The harness path-equality guard did not remove
the fixture automatically because the resolved Windows path string differed
from its literal comparison. The exact target was then resolved and verified
before one manual recursive removal; the fixture is absent.

- Post-live `npm.cmd test`: 202/202 PASS.
- Required `node --check`: PASS.
- `git diff --check`: PASS.
- Production files changed: none.
- Test files changed: none.
- Temporary ignored safe summary: removed after bounded facts were transferred.

## Decision

The isolated run materially improves CC-005 evidence: TaskCreate, TaskList,
TaskGet, and TaskUpdate all reached real Claude Code Task runtime results with
zero explicit errors, and no Agent/background contamination occurred.
However, update verification, completion, completion verification, and the
post-completion final turn did not complete. A full pass would overstate the
evidence.

Classification: `CC_005_PARTIAL`

First failing boundary:
`MODEL_TOOL_SELECTION_FAILURE: TaskGet during update verification`

`BRIDGE_DEFECT_EVIDENCE = NO`

`PRODUCTION_FIX_REQUIRED = NO`

`NEXT_ACTION = INVESTIGATE_CC005_TASKGET_SELECTION`

No production fix, parser change, retry heuristic, second live invocation, or
follow-up investigation was performed in this branch.
