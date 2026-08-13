# CC-008 NotebookEdit Re-evaluation

Date: 2026-08-13

## Executive summary

This evidence-only re-evaluation tested the current `NotebookEdit` boundary
through the unchanged production Bridge. No production or test code was
changed. Exactly two fresh foreground Claude Code invocations were used, with
zero harness retries.

Both runs progressed farther than the historical finding: Claude Code
advertised `NotebookEdit`, DeepSeek selected it, the Bridge strict parser
accepted it, and Claude Code returned a real `tool_result`. The result was an
error in both runs, so neither synthetic notebook cell changed. The first
failing boundary is therefore the Claude Code notebook runtime, after the
Bridge boundary.

`BASELINE_MAIN = e5df275e1f1904fdd16bc0e54330461b54dd47db`

`NOTEBOOKEDIT_SCHEMA_TRANSPORT = PASS`

`NOTEBOOKEDIT_SYNTHETIC_STRICT_PARSE = PASS`

`REQUEST_BYTES_IDENTICAL = YES`

`RUN_A_CLAUDE_VERSION = 2.1.231`

`RUN_A_ADVERTISED = YES`

`RUN_A_TOOL_CHOICE = NONE`

`RUN_A_SELECTED = YES`

`RUN_A_STRICT = YES`

`RUN_A_TOOL_RESULT_COUNT = 1`

`RUN_A_TOOL_RESULT_ERRORS = 1`

`RUN_A_CONTINUATION = YES`

`RUN_A_COMPLETION_MAX = 1`

`RUN_A_CORRECTION = NO`

`RUN_A_PHYSICAL_MUTATION = NO`

`RUN_A_EXPECTED_MARKER_PRESENT = NO`

`RUN_A_OLD_MARKER_ABSENT = NO`

`RUN_A_CLASSIFICATION = CLAUDE_CODE_NOTEBOOK_RUNTIME`

`RUN_B_CLAUDE_VERSION = 2.1.231`

`RUN_B_ADVERTISED = YES`

`RUN_B_TOOL_CHOICE = NONE`

`RUN_B_SELECTED = YES`

`RUN_B_STRICT = YES`

`RUN_B_TOOL_RESULT_COUNT = 1`

`RUN_B_TOOL_RESULT_ERRORS = 1`

`RUN_B_CONTINUATION = YES`

`RUN_B_COMPLETION_MAX = 1`

`RUN_B_CORRECTION = NO`

`RUN_B_PHYSICAL_MUTATION = NO`

`RUN_B_EXPECTED_MARKER_PRESENT = NO`

`RUN_B_CLASSIFICATION = CLAUDE_CODE_NOTEBOOK_RUNTIME`

`FALLBACK_TOOL_USED = NO`

`RAW_TOOL_OUTPUT_EXPOSURE = NO`

`CC010_REGRESSION_EVIDENCE = NO`

`FIRST_FAILING_BOUNDARY = CLAUDE_CODE_NOTEBOOK_RUNTIME`

`BRIDGE_DEFECT_EVIDENCE = NO`

`PRODUCTION_FIX_REQUIRED = NO`

`CC008_CLASSIFICATION = CC_008_RUNTIME_LIMITATION`

`FINAL_FULL_AUDIT_READY = YES`

`NEXT_ACTION = FINAL_FULL_LIVE_AUDIT_REQUIRES_SEPARATE_AUTHORIZATION`

## Historical finding

The original CC-008 evidence established that `NotebookEdit` was advertised,
but the model did not select it and the physical notebook remained unchanged.
Consequently, strict Bridge acceptance, Claude Code runtime execution, and a
real tool result were not reached. The earlier evidence did not establish a
Bridge defect.

This re-evaluation separates the path into inventory, schema transport, model
selection, strict parsing, Claude runtime, physical mutation, result delivery,
and continuation. Both controlled runs reached the runtime/result boundary.

## Current schema transport

The current Anthropic path is generic and does not special-case
`NotebookEdit`:

```text
incoming body.tools[].name / description / input_schema
-> normalize(..., "anthropic")
-> function.name / description / parameters
-> toolPrompt()
-> DeepSeek completion
-> inspectToolCallFromOutput() with exact allowed names
-> toAnthropic() tool_use
-> Claude Code runtime
-> tool_result extraction and continuation
```

`normalize()` does not filter or rename `NotebookEdit`. It assigns the
original `input_schema` object to `function.parameters`; `toolPrompt()` exposes
the same name and schema. The strict parser checks exact membership in the
current allowed tool names and does not special-case the tool. Result
correlation and continuation use the call ID and stored name generically.

The observer confirmed that Claude Code `2.1.231` actually advertised an
object schema with these bounded contract details:

- required string `notebook_path`;
- optional string `cell_id`;
- required string `new_source`;
- optional string `cell_type`, enum `code | markdown`;
- optional string `edit_mode`, enum `replace | insert | delete`.

The actual name, property order, required fields, JSON types, and enum values
matched the installed package contract. Identity and structural checks showed
that the Bridge did not rewrite the schema. CC-010 history/recovery changes do
not remove the current tool or alter a valid accepted call.

## Synthetic parser result

A canonical whole-response tool envelope was constructed from the observed
contract with the exact allowed name `NotebookEdit`, an object argument value,
the disposable notebook class, a stable synthetic cell ID, a new marker,
`cell_type=code`, and `edit_mode=replace`.

The unchanged `inspectToolCallFromOutput()` path returned `accepted` and
preserved the exact tool name and argument fields. No malformed, fuzzy,
substring, JSON5, repair, or extraction path was used.

## Controlled live methodology

The topology was:

```text
Claude Code
-> owned exact-byte loopback observer
-> unchanged production Bridge
-> DeepSeek
```

- Observer: `127.0.0.1:19658`.
- Bridge: `127.0.0.1:19659`.
- Existing user listeners were not used or changed.
- The observer parsed only an in-memory copy and forwarded the original body
  `Buffer`; before/after hashes matched for every request.
- Only bounded names, schema field/type/enum metadata, counts, booleans, and
  terminal states were retained.
- Prompts, absolute fixture paths, raw notebook contents, raw tool arguments,
  reasoning, headers, authorization, cookies, session IDs, and raw tool-like
  payloads were not logged or retained.
- The target was recorded only as `DISPOSABLE_SYNTHETIC_NOTEBOOK`.
- Claude inventory was restricted to `NotebookEdit`; filesystem and fallback
  tools were not available.
- Foreground Claude invocations: exactly `2`.
- Harness retries: `0`.
- Each run used a new Claude config directory and a fresh process/session.
- The native installed Claude executable was used because the PowerShell shim
  was blocked by local execution policy.
- The version was obtained directly from that executable immediately before
  each run.
- The Bridge retained its shared limit of initial completion plus at most one
  correction; the observed maximum was one completion per request.

The disposable notebook was valid notebook format 4 with two code cells,
stable synthetic IDs, and independent original markers. Run A targeted only
cell A; Run B targeted only cell B. The fixture was inspected physically after
each process completed.

## Run A

Run A reached this lifecycle:

```text
NotebookEdit advertised with tool_choice NONE
-> strict NotebookEdit selected
-> Claude Code NotebookEdit runtime
-> one error tool_result
-> continuation reaches Bridge
-> safe final response
```

- advertised: yes, in an inventory of one tool;
- forced tool: none;
- strict Bridge selection: `NotebookEdit`;
- Claude tool-use count: one;
- tool result count: one;
- current result error count: one;
- continuation: yes;
- maximum completions per Bridge request: one;
- correction attempted: no;
- fallback tool: none;
- process exit: zero;
- physical mutation: no;
- updated A marker present: no;
- original A marker absent: no.

The continuation after the error result produced malformed-envelope intent and
ended through the existing safe-failure path. It did not cause a second
completion, expose raw malformed output, or alter the notebook. This is a
post-runtime formatting limitation, not the first failing boundary.

## Run B

Run B was a new process/session against the independent second code cell. It
reached the same lifecycle:

```text
NotebookEdit advertised with tool_choice NONE
-> strict NotebookEdit selected
-> Claude Code NotebookEdit runtime
-> one error tool_result
-> continuation reaches Bridge
-> safe final response
```

- advertised: yes, in an inventory of one tool;
- forced tool: none;
- strict Bridge selection: `NotebookEdit`;
- Claude tool-use count: one;
- tool result count: one;
- current result error count: one;
- continuation: yes;
- maximum completions per Bridge request: one;
- correction attempted: no;
- fallback tool: none;
- process exit: zero;
- physical mutation: no;
- updated B marker present: no;
- original B marker absent: no.

Its post-result completion also ended safely after malformed-envelope intent.
No raw tool-like output reached the Claude interface.

## Physical verification

Model text was not used as proof of mutation. The notebook was parsed from disk
after each run and the specifically targeted cell was checked independently.

- Run A: file hash unchanged; expected A marker absent; old A marker present.
- Run B: file hash unchanged; expected B marker absent; old B marker present.
- No fallback tool was selected or available in either run.

After both fixed runs, the owned observer and Bridge were stopped, pending
requests were zero, the owned ports were free, owned Claude child processes
were zero, and the disposable fixture and temporary Claude configs were
deleted. The temporary ignored harness was also removed. No raw live capture
or temporary diagnostic log was retained.

## Failure-boundary analysis

The historical model-selection boundary did not reproduce. Both runs prove:

1. current Claude inventory includes `NotebookEdit`;
2. the actual schema reaches the Bridge unchanged;
3. DeepSeek selects the exact tool name;
4. the strict Bridge parser accepts the canonical call;
5. Claude Code receives and executes its NotebookEdit runtime path;
6. Claude Code returns a real error `tool_result`;
7. the result continuation reaches the Bridge;
8. no physical mutation occurs.

The first failing boundary is therefore `CLAUDE_CODE_NOTEBOOK_RUNTIME`, not
schema transport, model selection, strict Bridge parsing, or result
continuation. Raw tool arguments and raw runtime errors were intentionally not
retained, so this investigation does not claim a narrower runtime cause.

No inbound `ANY` or forced `TOOL(NotebookEdit)` choice was observed. Both runs
used `tool_choice=NONE`; therefore this evidence neither identifies nor
requires a Bridge tool-choice implementation.

## Bridge decision

`BRIDGE_DEFECT_EVIDENCE = NO` because the Bridge preserved the actual tool name
and schema, accepted the canonical calls, emitted real Anthropic tool-use
events, received the error results on continuation, stayed within one
completion per request, and suppressed the later malformed output safely.

`PRODUCTION_FIX_REQUIRED = NO`. A NotebookEdit-specific fuzzy parser, argument
rewriter, forced tool choice, Bridge-side notebook mutation, or broader retry
would not address the proven first failing boundary and was not introduced.

## Current compatibility classification

`CC008_CLASSIFICATION = CC_008_RUNTIME_LIMITATION`

The Bridge-side compatibility path is demonstrated through strict selection,
tool-use emission, error-result correlation, and continuation. Successful
physical mutation remains unavailable in this controlled environment because
both Claude Code NotebookEdit runtime executions failed.

The post-result malformed-envelope responses in both runs were contained by
the existing CC-010 safe handling. There was no raw `[Tool Call]`, raw
`tool_call` JSON, other tool-like exposure, or correction-budget regression.

## Next action

No CC-008 production fix is justified by this evidence. CC-006 and CC-008
targeted investigations are now complete, so the final full audit is ready,
but it was not started and still requires separate explicit authorization.
