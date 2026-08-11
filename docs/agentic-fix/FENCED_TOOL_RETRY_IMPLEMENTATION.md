# Bounded fenced tool correction retry

Date: 2026-08-10.

Branch: `fix/tool-parser-rejection-diagnostics`.

Starting commit: `e9ecd71abee1f1bd2f89973f1a94526b9aca0229`.

## Confirmed cause

The controlled Claude Code 2.1.226 run classified request
`435017840edd2d00` as **CODE_FENCE**. The request carried 39 raw and 39
normalized tools, including `Glob`, `Read`, and `Grep`. Its network path
completed through `stream_parsed` without an upstream error or retry, but no
tool executed.

Safe parser diagnostics proved that selected `content` began with a Markdown
code fence, contained a tool-call marker, and was rejected as `invalid_json`.
The strict parser therefore behaved correctly. It has not been changed to
strip fences, find embedded JSON, or accept Markdown-wrapped tool calls.

## Why a bounded correction was selected

Accepting fenced JSON locally would weaken the whole-response parser contract.
Instead, Bridge asks the model once to restate its intended call as one strict
JSON object. The corrected response goes through the unchanged
`inspectToolCallFromOutput()` path and all existing allowlist, name, argument,
nesting, dangerous-key, and byte-limit checks.

The new retry predicate is true only when all of these conditions hold:

- tools are present;
- no tool call was accepted;
- the shared correction count is zero;
- selected source is `content`;
- parse reason is `invalid_json`;
- selected content starts with a code fence;
- selected content contains the tool-call marker.

Ordinary prose, extra text without a fence, Chinese-style markers, a fence
without the marker, a fenced reasoning channel shadowed by ordinary content,
and every other parser reason remain outside this retry.

## One shared correction budget

Fenced, reasoning-only, and repeated-completed-tool corrections share the
existing `correctiveAttempted` budget. One HTTP request can perform at most an
initial completion plus one corrective completion. A fenced correction cannot
then trigger reasoning-only or repeated-tool correction, and the other paths
retain their previous one-correction limit.

The correction uses the existing `MODELS['deepseek-chat']` policy and the same
upstream session object. No network retry policy or model-selection
architecture was introduced.

## Correction prompt and payload boundary

The fenced correction prompt is static except for the bounded, identifier-only
allowed tool names. It requires exactly one strict JSON object and forbids
Markdown, code fences, reasoning, prose, explanations, comments, and text
before or after JSON.

Rejected content, reasoning, tool arguments, tool results, the user prompt,
paths, and URLs are never copied into the correction prompt. The model already
has the current upstream context, so replaying rejected payload data is neither
necessary nor allowed.

## Outcomes

On a successful correction, the second output is accepted by the unchanged
strict parser and proceeds through the existing protocol adapters. Anthropic
therefore emits its normal `tool_use`; no retry-specific response is built.

If the second output is not a valid tool call, no third completion is made.
Bridge removes correction reasoning and returns the existing generic
`TOOL_RETRY_FAILURE_MESSAGE`. The malformed fenced output is not returned to
the client. If a corrected call repeats an already completed exact tool call,
the shared budget prevents another correction and the existing repeated-tool
safe failure is used.

## Diagnostics

Opt-in `tool_response` records add:

- `fenced_tool_retry_attempted`, a boolean that is true only when this new
  correction actually ran;
- `tool_retry_reason`, one of `none`, `reasoning_only`, `code_fence`, or
  `repeated_tool`.

The separate `reasoning_retry_attempted` and
`repeated_tool_retry_attempted` fields remain intact. A successful fenced
correction reports final parse reason `accepted` together with
`tool_retry_reason = code_fence`, preserving why the correction occurred.

No diagnostic or static retry log contains content, reasoning, raw JSON, tool
arguments/results, prompts, paths, URLs, credentials, authorization values,
session/call IDs, or content hashes. Logger exceptions remain observational.
When `BRIDGE_TOOL_DIAGNOSTICS` is disabled, the functional correction still
works and no structured diagnostics are written.

## Scope and offline evidence

Parser acceptance and content/reasoning priority are unchanged. Streaming and
session semantics, call-ID continuation, tool continuation architecture,
network/PoW/WASM behavior, and network retry policy are unchanged.

Offline tests cover the exact predicate, all required negative gates, strict
parser regression, successful Anthropic conversion, failed correction, shared
budget, reasoning and repeated-tool regressions, linked continuation, prompt
and diagnostic security, diagnostics disabled, and throwing loggers.

No doctor, Claude Code, DeepSeek, Chrome, OpenCode, or external network test was
run after this fix. Any live validation requires separate explicit approval.
