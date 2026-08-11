# CC-001 Brace-Delimited Tool Recovery

Date: 2026-08-11

Finding: `CC-001`

Baseline main: `52f7f7039a47a0736c3e3319c27b052211e5c0e5`

Status: `CC_001_OFFLINE_READY`; live validation has not yet been performed.

## Proven rejected class

The compatibility audit recorded five malformed tool-like outputs with the
same safe structural profile:

- selected source: `content`;
- parser reason: `invalid_json`;
- no accepted strict tool call;
- does not start with a code fence;
- starts with `{`;
- ends with `}`;
- contains the `tool_call` marker.

The implementation adds
`shouldRetryBraceDelimitedToolLikeResponse()` for exactly that conjunction.
It returns false when tools are absent, a call was accepted, the shared
correction budget was used, the selected source or parse reason differs, or
any structural signal differs. It is not a general `invalid_json` retry.

## Recovery semantics

The strict parser is unchanged. A matching response is rejected first, then
receives one model correction through the existing static strict-tool prompt.
The correction uses `MODELS['deepseek-chat']`, the same upstream session, and
the existing safe allowlist of tool names. Rejected content, reasoning, tool
arguments, tool results, user prompts, paths, URLs, commands, session IDs, and
call IDs are not copied into the correction prompt.

The corrected output is processed again by `inspectToolCallFromOutput()`. A
valid strict call continues through the existing Anthropic, OpenAI, or
Responses adapter. A second malformed output produces the existing generic
safe failure; neither malformed response nor retry reasoning is returned.

The new path uses the same `correctiveAttempted` state as CODE_FENCE,
PREFIXED_TOOL_LIKE, reasoning-only, and repeated-tool protection. Therefore a
request has at most one correction completion and at most two upstream
completions in total. There is no third completion and no independent brace
retry counter.

## Diagnostics

Opt-in tool diagnostics add:

- `brace_tool_retry_attempted`: bounded boolean;
- `tool_retry_reason = brace_tool`: bounded enum value.

On a malformed initial response `selected_tool_name` remains `none`. After a
successful correction it contains only the safely validated name of the
accepted strict call. `tool_result_error_count` and its current linked-result
scope are unchanged. Diagnostics retain no raw payload.

## Compatibility and security

Focused offline coverage verifies:

- the exact positive predicate and each required negative gate;
- parser rejection of a representative synthetic malformed response;
- mutual exclusion and regressions for CODE_FENCE and PREFIXED_TOOL_LIKE;
- direct strict calls, ordinary final text, and explanatory marker text;
- successful Anthropic `Edit` recovery to a real `tool_use`;
- generic safe failure after one failed correction;
- the shared budget in both recovery orders, including repeated-tool
  protection;
- Anthropic continuation through recovered `Read` and its following result;
- existing OpenAI and Responses adapter paths;
- buffered streaming for successful and failed correction;
- isolation of synthetic rejected-output, correction-output, prompt, result,
  and reasoning markers;
- diagnostics-disabled and throwing-logger behavior.

No functional changes were made to the parser, SessionStore, SessionResolver,
tool-result continuation, stream protocol, network retry, timeouts, PoW, WASM,
or model aliases. Live validation remains a separate bounded step.
