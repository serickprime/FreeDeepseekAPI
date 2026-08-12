# CC-005 Claude Task Model-Selection Limitation

## Status

- Finding: `CC-005`
- Classification: `CC_005_MODEL_SELECTION_PARTIAL`
- Compatibility label: `PARTIAL`
- Failure layer: `MODEL_TOOL_SELECTION`
- First failing boundary: `MODEL_TOOL_SELECTION_FAILURE`
- Boundary confidence: `CONFIRMED`
- Bridge defect evidence: `NO`
- Production fix required: `NO`
- Historical TaskGet failure: `REPRODUCED`
- Model-internal root cause: `UNKNOWN`
- Next action after documentation: `CC_005_DOCUMENTED`

## Scope and evidence history

CC-005 covers Claude Code's advertised `TaskCreate`, `TaskList`, `TaskGet`,
`TaskUpdate`, `TaskOutput`, and `TaskStop` capabilities.

The historical audit was inconclusive because Task observations followed
Agent/background activity. The subsequent evidence-only work preserved that
boundary and progressed in four stages:

1. The initial isolated re-evaluation proved real `TaskCreate`, `TaskList`,
   `TaskGet`, and `TaskUpdate` lifecycles, then ended as `CC_005_PARTIAL` when
   an explicit update-verification turn did not select `TaskGet`.
2. Investigation #1 was blocked by an `INVESTIGATION_HARNESS` schema-enum gate
   before the critical verification turn.
3. Replacement #1 passed a real same-task `TaskUpdate`, but a different
   `INVESTIGATION_HARNESS` result-status extraction gate stopped the driver
   before the critical `TaskGet` turn.
4. The final replacement removed all semantic progression gates, sent the
   fixed sequence through the critical turn, and reproduced the original
   model-selection boundary.

The two harness blocks are not product failures and are not part of the final
compatibility classification.

## Confirmed working behavior

The following behavior is proven when the model selects the requested tool:

- `TaskCreate` completes a real strict tool lifecycle with a non-error result.
- `TaskList` completes a real strict lifecycle. A later isolated investigation
  independently confirmed that the created task was visible.
- `TaskGet` completes real strict lifecycles. A baseline Get independently
  observed the same task in `pending` state.
- `TaskUpdate` completes real strict lifecycles. An update request to
  `in_progress` returned one non-error tool result for the same task.
- A completion `TaskUpdate` completed with one non-error same-task result.
- A later completion `TaskGet` independently observed that same task as
  `completed`.
- The foreground session and transport remained usable through the fixed
  sequence, with no background crossing, orphan request, or network error.
- Agent is not required for this core Task lifecycle; Agent selection remained
  zero throughout the isolated evidence runs.

This does not mean that Task management is fully or deterministically
supported. It proves that the core runtime/protocol operations are functional
when selected.

## Confirmed limitation

Claude Code/the model may fail to select an explicitly requested Task tool on
an individual turn even while that same tool remains advertised and works on
surrounding turns.

On the critical update-verification turn:

- `TaskGet` was advertised;
- an explicit TaskGet verification was requested;
- inbound protocol-level `tool_choice` was absent (`NONE`);
- no tool was selected;
- no strict call or tool result existed;
- ordinary final text returned;
- there was no parser, retry, tool-runtime, continuation, network, background,
  or orphan failure;
- an earlier `TaskGet` in the same session succeeded; and
- a later completion-verification `TaskGet` in the same session succeeded.

The supported conclusion is a per-turn model-selection limitation. It is not
evidence that `TaskGet` is broken or that the Bridge loses `TaskGet`.

## Protocol-level tool choice

The observed Claude Code Task requests did not send Anthropic protocol-level
`tool_choice`. On the critical failing turn:

- `tool_choice` present: `NO`
- normalized choice: `NONE`
- forced tool name: none

The Bridge therefore received no explicit protocol requirement forcing
`TaskGet`. Natural-language instructions in message content are not equivalent
to a protocol-level forced choice.

## Bridge source observation

The current Bridge Anthropic `/v1/messages` implementation does not parse,
validate, forward, or enforce Anthropic `tool_choice`, and current tests do not
cover `auto`, `any`, or a specific forced tool choice.

That source gap is not classified as the current CC-005 defect. The failing
Claude Code request did not contain `tool_choice`, so the missing source path
did not discard or ignore a forcing requirement on the reproduced boundary.
Support for a hypothetical future client request carrying forced
`tool_choice` would require its own evidence and scope.

## Why no Bridge production fix is required

Across the isolated evidence, the Bridge:

- received the normal tool inventory with `TaskGet` present;
- successfully handled `TaskGet` before the failing turn;
- successfully handled both `TaskUpdate` lifecycles;
- successfully handled `TaskGet` after the failing turn;
- had no forced `tool_choice` requirement on the failing turn;
- received no malformed Task call to recover; and
- received no Task call at all on that turn.

There is therefore no evidence supporting a parser, retry, continuation, Task
schema, tool-result adapter, or model-resolver change.

### Do not infer tool forcing from prompts

The Bridge should not automatically force a tool merely because
natural-language text appears to request one. Doing so would require brittle
prompt interpretation, could select the wrong tool, could disrupt ordinary
multi-tool reasoning, and would change request semantics when the client did
not send protocol-level forcing.

### Do not add a broad retry heuristic

The Bridge should not retry merely because tools were advertised, a prompt
appeared tool-oriented, and the completion returned prose. That would be a
broad model-selection heuristic rather than recovery from a proven structural
failure.

Existing correction retries should remain limited to their proven structural
malformed, reasoning-only, and repeated-tool classes.

## Compatibility labels

| Capability | User-facing label | Meaning |
| --- | --- | --- |
| `TaskCreate` | `PARTIAL` | Real lifecycle works when selected; deterministic per-turn selection is not guaranteed. |
| `TaskList` | `PARTIAL` | Real lifecycle and same-task visibility work when selected; deterministic per-turn selection is not guaranteed. |
| `TaskGet` | `PARTIAL` | Baseline and completion Get calls work, but one explicit verification turn reproduced NOT_SELECTED. |
| `TaskUpdate` | `PARTIAL` | In-progress and completion lifecycles work when selected; deterministic per-turn selection is not guaranteed. |
| `TaskOutput` | `NOT_APPLICABLE_TO_TESTED_CORE_LIFECYCLE` | No background executable task existed in the isolated lifecycle. |
| `TaskStop` | `NOT_APPLICABLE_TO_TESTED_CORE_LIFECYCLE` | No safely stoppable runtime task existed in the isolated lifecycle. |

## Evidence matrix

| Capability | Evidence | Result |
| --- | --- | --- |
| TaskCreate | Strict call plus one non-error result | `PASS` |
| TaskList | Strict call plus later independent same-task confirmation | `PASS` |
| Baseline TaskGet | Strict same-task call; `pending` independently observed | `PASS` |
| TaskUpdate to `in_progress` | Strict same-task non-error lifecycle | `PASS` |
| Critical TaskGet | Advertised; choice `NONE`; not selected; ordinary final text | `PARTIAL` |
| Completion TaskUpdate | Strict same-task non-error lifecycle | `PASS` |
| Completion TaskGet | Strict same-task call; `completed` independently verified | `PASS` |
| TaskOutput | No applicable background executable task | `NOT_TESTED` |
| TaskStop | No applicable safely stoppable runtime task | `NOT_TESTED` |

## Client guidance

- Treat the Task tools as partially compatible: their real lifecycles work,
  but per-turn model selection is not deterministic.
- A new explicit Task request may be necessary in practice after a prose-only
  response, but repetition is not guaranteed to select the tool.
- Independently verify important state transitions with a real `TaskGet` or
  `TaskList` lifecycle.
- Do not treat natural-language acknowledgement as proof of Task state.
- Count an operation as successful only after a real Task tool result without
  an error.
- For critical automation, do not assume deterministic tool selection when
  the client does not send a protocol-level forced choice.

## TaskOutput and TaskStop boundary

`TaskOutput` and `TaskStop` were advertised but were intentionally not tested
as part of the core lifecycle. No background executable task or safely
stoppable runtime task existed, and Agent was intentionally not created merely
to exercise them. Their status is not a failure.

## Final conversation observation

The final replacement's no-tool conversation turn reached a terminal response
with the bounded outcome `safe_failure`. The session and transport remained
usable, and there was no network, background, pending, or orphan issue. This
outcome is not used as root evidence for the CC-005 model-selection finding,
and its cause is not inferred here.

## Root-cause boundary

`FIRST_FAILING_BOUNDARY = MODEL_TOOL_SELECTION_FAILURE`

`BOUNDARY_CONFIDENCE = CONFIRMED`

`MODEL_INTERNAL_ROOT_CAUSE = UNKNOWN`

The evidence does not attribute the internal cause to DeepSeek, Claude Code,
prompt construction, temperature, or randomness.

## Final decision

`CC_005_MODEL_SELECTION_PARTIAL`

`BRIDGE_DEFECT_EVIDENCE = NO`

`PRODUCTION_FIX_REQUIRED = NO`

`HISTORICAL_TASKGET_FAILURE = REPRODUCED`

`MODEL_INTERNAL_ROOT_CAUSE = UNKNOWN`

`NEXT_ACTION = CC_005_DOCUMENTED`

No new live test, Bridge start, observer start, fixture, production change, or
follow-up investigation was used to produce this synthesis.

## Evidence sources

- `CC_005_TASK_MANAGEMENT_REEVALUATION.md`
- `CC_005_TASKGET_SELECTION_INVESTIGATION.md`
- `CC_005_TASKGET_SELECTION_REPLACEMENT.md`
- `CC_005_TASKGET_SELECTION_FINAL_REPLACEMENT.md`
- CC-005 section of `CLAUDE_CODE_COMPATIBILITY_FIX_PLAN.md`
