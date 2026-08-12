# CC-005 TaskGet selection final replacement

Date: 2026-08-12

## Runtime

- Main baseline: `98fc4c01efcee4fbba7c13d01b1bde5a928f5051`
- Branch: `audit/cc-005-taskget-selection-investigation`
- Starting branch HEAD: `947ab94ab3f2681f165e06bc87f250968061463f`
- Claude Code: `2.1.226`
- Node.js: `v24.12.0`
- OS: Windows
- Top-level model: `deepseek-reasoner`
- Final replacement authorized: `YES`
- Foreground Claude invocations: `1`
- Fixed user turns sent: `7`
- Terminal assistant responses: `7/7`
- `/v1/messages` requests: `13`

## Investigation history

The original CC-005 selection investigation was blocked before `TaskUpdate`
because its temporary harness required a schema-enum observation. The first
replacement reached a successful strict `TaskUpdate` lifecycle but was then
blocked by a post-result status extractor before the critical `TaskGet` turn.
Both earlier reports remain unchanged.

For this separately authorized final replacement, all semantic harness gates
were removed. The driver used a fixed seven-turn sequence and advanced solely
after the preceding turn reached a terminal assistant response and transport
was quiet. Tool selection, result contents, status extraction, same-task
correlation, and `tool_choice` observations did not control progression.

The fixed sequence completed. In particular, the critical `TaskGet` turn was
sent after the successful `TaskUpdate` request regardless of the extracted
status value.

## Observer integrity

- Observer used: `YES`
- Topology: Claude Code -> local observer -> unchanged Bridge
- Observer endpoint: bounded loopback test endpoint
- Bridge endpoint: bounded loopback test endpoint
- Original request bytes forwarded: `YES`
- `REQUEST_BYTES_IDENTICAL = YES`
- Observer JSON mutation: `NO`
- Production source changed: `NO`
- Test source changed: `NO`

The observer parsed only an in-memory copy and retained bounded structural
metadata. It did not retain request or response bodies, prompts, messages,
arguments, results, model output, reasoning, credentials, session identifiers,
call identifiers, or private paths.

## Turn matrix

| Turn | Operation | Advertised | Inbound `tool_choice` | Forced name | Selected | Strict | Results / errors | Same task | State | Outcome |
| ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Create | `TaskCreate`: YES | `NONE` | none | `TaskCreate` | YES | 1 / 0 | YES | UNKNOWN | strict lifecycle PASS |
| 2 | Baseline Get | `TaskGet`: YES | `NONE` | none | `TaskGet` | YES | 1 / 0 | YES | `pending` | PASS |
| 3 | Update to `in_progress` | `TaskUpdate`: YES | `NONE` | none | `TaskUpdate` | YES | 1 / 0 | YES | UNKNOWN | strict lifecycle PASS; result enum not extracted |
| 4 | Critical verification Get | `TaskGet`: YES | `NONE` | none | none | NO | 0 / 0 | UNKNOWN | UNKNOWN | ordinary final text; NOT_SELECTED |
| 5 | Completion Update | `TaskUpdate`: YES | `NONE` | none | `TaskUpdate` | YES | 1 / 0 | YES | UNKNOWN | strict lifecycle PASS |
| 6 | Completion Get | `TaskGet`: YES | `NONE` | none | `TaskGet` | YES | 1 / 0 | YES | `completed` | independent completion verification PASS |
| 7 | Final conversation | normal inventory present | `NONE` | none | none | NO | 0 / 0 | UNKNOWN | UNKNOWN | terminal no-tool response; safe-failure outcome |

Every turn advertised the normal 25-tool inventory, including `TaskCreate`,
`TaskList`, `TaskGet`, `TaskUpdate`, and `Agent`. No turn contained inbound
`tool_choice`; the normalized value was `NONE` throughout.

## Critical TaskGet turn

- Critical turn sent: `YES`
- Terminal response reached: `YES`
- `TaskGet` advertised: `YES`
- Tool inventory count: `25`
- Inbound `tool_choice` present: `NO`
- Inbound `tool_choice` type: `NONE`
- Forced tool name: none
- Actual selected tool: none
- Strict call: `NO`
- Tool results: `0`
- Tool result errors: `0`
- Same task: `UNKNOWN`
- State: `UNKNOWN`
- Response class: ordinary final text
- Completion count: `1`
- Retry: none
- Network error: `NO`

The historical operational boundary reproduced: the explicit verification
turn still advertised `TaskGet`, but no Task tool call was produced. Claude
Code did not send a forced protocol-level `tool_choice`, so there was no forced
selection requirement for the Bridge to violate.

Critical-turn classification:

`MODEL_TOOL_SELECTION_FAILURE: TaskGet during critical update verification`

## Completion lifecycle

- Completion Update turn reached: `YES`
- Completion Update `tool_choice`: `NONE`
- `TaskUpdate` selected: `YES`
- Strict call: `YES`
- Results / errors: `1 / 0`
- Same task: `YES`
- Extracted update-result status: `UNKNOWN`
- Completion verification Get reached: `YES`
- Completion verification `tool_choice`: `NONE`
- `TaskGet` selected: `YES`
- Strict call: `YES`
- Results / errors: `1 / 0`
- Same task: `YES`
- Independently observed status: `completed`
- Completion lifecycle: `PASS`

`TaskOutput` and `TaskStop` remain `NOT_APPLICABLE`: this isolated core
lifecycle created no background executable or stoppable runtime task, and no
Agent was started for that purpose.

## Isolation and diagnostics

- Agent advertised: `YES`
- Agent selected: `0`
- Background request crossings: `0`
- Quiet turn boundaries: `7/7`
- Pending requests after final: `0`
- Orphan requests: `0`
- Network errors: `0`
- Raw tool-like JSON occurrences: `0`
- Brace recovery events: `0`
- Other retries: `0`
- Direct maximum completions per request: `1`
- Transport abort: `NO`
- Claude exit code: `0`

The final no-tool turn reached a terminal response, proving that the foreground
session and transport remained usable through the fixed sequence. Its bounded
outcome was `safe_failure`; no tool or background request followed it.

## Decision

The critical `TaskGet` selection failure reproduced under an inbound
`tool_choice` value of `NONE`. Earlier and later strict `TaskGet` lifecycles in
the same session succeeded, as did both `TaskUpdate` lifecycles. This evidence
does not show request corruption, continuation loss, parser failure, retry
failure, tool runtime failure, or an ignored forced-tool requirement.

`CC_005_MODEL_SELECTION_PARTIAL`

`FIRST_FAILING_BOUNDARY = MODEL_TOOL_SELECTION_FAILURE: TaskGet during critical update verification`

`BRIDGE_DEFECT_EVIDENCE = NO`

`PRODUCTION_FIX_REQUIRED = NO`

`HISTORICAL_TASKGET_FAILURE = REPRODUCED`

`NEXT_ACTION = DOCUMENT_CC005_MODEL_SELECTION_LIMITATION`

No parser, retry, Task schema, model-selection forcing, or production change is
supported by this result.

## Cleanup and validation

- Foreground invocation budget: `1/1`
- Second replacement invocation: `NO`
- Test-owned Claude processes after cleanup: `0`
- Test-owned Bridge processes after cleanup: `0`
- Test-owned observer processes after cleanup: `0`
- Observer and temporary harness removed: `YES`
- Safe journal removed: `YES`
- Disposable fixture removed: `YES`
- Observer port free: `YES`
- Bridge port free: `YES`
- Production files changed: `NO`
- Test files changed: `NO`
- Post-live tests: `202/202 PASS`
- Required `node --check`: `PASS`
- `git diff --check`: `PASS`
- PR created: `NO`
- CC-006 / CC-007 started: `NO`
