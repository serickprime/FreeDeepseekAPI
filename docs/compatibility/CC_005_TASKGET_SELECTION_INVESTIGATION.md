# CC-005 TaskGet Selection Investigation

Date: 2026-08-12

Production baseline: `98fc4c01efcee4fbba7c13d01b1bde5a928f5051`

Branch: `audit/cc-005-taskget-selection-investigation`

Claude Code: `2.1.226`

Node.js: `v24.12.0`

OS: Microsoft Windows

Model: `deepseek-reasoner`

## Scope and previous boundary

The previous isolated re-evaluation ended as `CC_005_PARTIAL`. Its first
incomplete boundary was:

`MODEL_TOOL_SELECTION_FAILURE: TaskGet during update verification`

That run proved no Bridge defect. It retained the normal Task tool inventory
but did not retain the inbound Anthropic `tool_choice` field for the failing
turn. This investigation was evidence-only and did not change production code,
the parser, retry behavior, Task schemas, or model selection.

## Offline source investigation

The current `/v1/messages` path reads and parses the Anthropic JSON body,
normalizes `model`, `stream`, `tools`, and `messages`, resolves the local model,
converts the tools into the Bridge prompt, sends that prompt to the DeepSeek
Web completion path, strictly parses one allowed tool call, and adapts it back
to Anthropic `tool_use`.

No production path reads, validates, forwards, or enforces Anthropic
`tool_choice`. The field is not represented in normalized input, the DeepSeek
upstream request, tool parsing, or Anthropic response adaptation.

- Inbound `tool_choice` parsing: absent.
- Validation: absent.
- Forwarding: absent.
- Enforcement: absent.
- Protocol response behavior tied to `tool_choice`: absent.
- `tool_choice: auto` coverage: absent.
- `tool_choice: any` coverage: absent.
- specific `tool_choice: tool` coverage: absent.

`BRIDGE_TOOL_CHOICE_SOURCE_SUPPORT = ABSENT`

`TOOL_CHOICE_TEST_COVERAGE = NO`

This source result alone is not classified as a bug. A current CC-005 defect
would additionally require evidence that Claude Code sent a protocol-level
forced choice that the Bridge failed to honor.

## Observer and pass-through integrity

A temporary loopback observer listened on port 9655 and forwarded to the
unchanged Bridge on port 9656. It parsed a copy of each request body only in
memory and forwarded the original raw body bytes. It retained only bounded
structural fields; it did not retain messages, prompts, tool arguments, tool
results, headers, credentials, raw identifiers, or request/response bodies.

- Observer used: Yes.
- Bridge health before Claude: PASS.
- Observer health before Claude: PASS.
- Request bytes identical for all forwarded requests: Yes.
- Foreground Claude invocations: 1.
- Foreground exit code: 0.
- Sequential user turns reached: 3.
- `/v1/messages` requests: 6.
- Normal Bridge inventory count: 25.
- Model on all six requests: `deepseek-reasoner`.

The single invocation was not repeated.

## Tool inventory

The Bridge inventory advertised all six Task-management tools:

| Tool | Advertised |
| --- | --- |
| `TaskCreate` | Yes |
| `TaskGet` | Yes |
| `TaskList` | Yes |
| `TaskUpdate` | Yes |
| `TaskOutput` | Yes |
| `TaskStop` | Yes |
| `Agent` | Yes |

`Agent` was present in the Bridge inventory but was never selected. The
temporary CLI init summary did not independently mark it, so the Bridge request
inventory is the authoritative advertisement evidence.

## Bounded tool-choice matrix

Each operation below generated an initial request and one tool-result
continuation. `tool_choice` was absent on both requests in every reached turn.

| Operation | Advertised | Inbound choice present | Choice type | Forced name | Selected | Strict | Results/errors | Same task | State | Outcome |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| Create | Yes | No | NONE | N/A | `TaskCreate` | Yes | 1 / 0 | Created | N/A | PASS |
| List | Yes | No | NONE | N/A | `TaskList` | Yes | 1 / 0 | Yes | `pending` | PASS |
| Baseline Get | Yes | No | NONE | N/A | `TaskGet` | Yes | 1 / 0 | Yes | `pending` | PASS |
| Update to in-progress | Not reached | Not observed | N/A | N/A | Not reached | No | 0 / 0 | Not reached | Not reached | BLOCKED |
| Critical verification Get | Not reached | Not observed | N/A | N/A | Not reached | No | 0 / 0 | Not reached | Not reached | BLOCKED |
| Completion Update | Not reached | Not observed | N/A | N/A | Not reached | No | 0 / 0 | Not reached | Not reached | NOT_RUN |
| Completion verification Get | Not reached | Not observed | N/A | N/A | Not reached | No | 0 / 0 | Not reached | Not reached | NOT_RUN |

The List result independently proved that the created task was visible. This
closes the bounded same-task correlation gap from the previous TaskList run.
Baseline TaskGet independently returned the same task in `pending` state.

## Critical-turn limitation

The investigation did not reach the requested critical Turn 5. After the
successful baseline TaskGet, the temporary harness stopped before sending the
TaskUpdate turn because its schema observer looked only for a direct
`input_schema.properties.status.enum`. It retained no enum at that exact
location.

This is an observer/harness limitation, not evidence that the actual current
TaskUpdate contract lacks `in_progress`. The prior isolated run already proved
a real successful TaskUpdate to `in_progress`. The current run did not retain
the raw schema and cannot retrospectively determine its different structural
form without violating the bounded-evidence policy.

Consequently, there is no current Turn 5 `tool_choice` observation and no
basis to decide whether the historical TaskGet selection failure reproduces.
The run was not repeated because the authorization allowed exactly one new
foreground invocation.

## Isolation and diagnostics

- Agent selected: 0.
- Agent/background contamination: No.
- Background requests crossing user turns: 0.
- Quiet boundaries: 3/3.
- Pending requests after exit: 0.
- Orphan requests: 0.
- Network errors: 0.
- Raw tool-like JSON occurrences: 0.
- Brace recovery events: 0.
- Other retry events: 0.
- Direct maximum completions per request: 1.
- Completion counter instrumentation: verified against `completion_start`.

`TaskOutput` and `TaskStop` remained `NOT_APPLICABLE`; no background executable
or safely stoppable disposable runtime task existed, and no Agent was created
for them.

## Security and cleanup

Only safe request references, bounded tool names, counts, booleans, status
enums, and a process-salted task fingerprint were retained temporarily. The
observer did not persist prompts, task text, arguments, result text, raw task
IDs, model output, reasoning, request/response bodies, headers, credentials,
session IDs, call IDs, or private absolute paths.

The owned Claude, observer, and Bridge processes stopped. Ports 9655 and 9656
were free, the disposable fixture was removed, and the temporary ignored
observer and safe summary were removed after this report was prepared.

## Regression

- Pre-live `npm.cmd test`: 202/202 PASS.
- Post-live `npm.cmd test`: 202/202 PASS.
- Required `node --check`: PASS before and after live.
- `git diff --check`: PASS before and after live.
- Production files changed: none.
- Test files changed: none.

## Decision

The reached turns prove that current Claude Code omitted `tool_choice` on the
successful Create, List, and baseline Get lifecycles. They do not prove the
field used on the previous failing boundary, because the critical verification
turn was not reached.

First failing boundary:
`INVESTIGATION_HARNESS: TaskUpdate schema enum observation before Turn 4`

`BRIDGE_DEFECT_EVIDENCE = NO`

`PRODUCTION_FIX_REQUIRED = UNKNOWN`

Classification: `CC_005_BLOCKED`

`NEXT_ACTION = REPEAT_CC005_TASKGET_SELECTION_ONLY_WITH_NEW_AUTHORIZATION`

Historical TaskGet selection failure: `UNRESOLVED`

No production fix, second live invocation, PR, or CC-006/CC-007 work was
started.
