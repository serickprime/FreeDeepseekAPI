# CC-011 Tool Protocol Output Containment

Date: 2026-08-13

Finding: `CC-011 TOOL_PROTOCOL_OUTPUT_CONTAINMENT`

`BASELINE_MAIN = 7f1eb166a437556fb3ff71e7186dde691043516b`

`CLAUDE_VERSION = 2.1.231 (Claude Code)`

`MANUAL_RAW_TOOL_CALL_EXPOSURE = YES`

`MANUAL_INTERNAL_TOOL_PROMPT_EXPOSURE = YES`

`INTERMITTENT_REAL_TOOL_SUCCESS = YES`

`RAW_WITH_TOOLS_PARSE_REASON = invalid_json`

`RAW_WITH_TOOLS_RECOVERY = YES; one bounded correction; corrected strict call required`

`RAW_WITHOUT_TOOLS_PARSE_REASON = invalid_json`

`RAW_WITHOUT_TOOLS_RECOVERY = NO; current response is exposed as final text`

`WINDOWS_PATH_ESCAPE_CLASS = INVALID_SINGLE_BACKSLASH_JSON`

`PROMPT_ECHO_WITH_TOOLS_PARSE_REASON = invalid_json`

`PROMPT_ECHO_WITH_TOOLS_CONTAINED = YES; safe rejection without execution`

`PROMPT_ECHO_WITHOUT_TOOLS_PARSE_REASON = invalid_json`

`PROMPT_ECHO_WITHOUT_TOOLS_CONTAINED = NO`

`LARGE_PROMPT_ECHO_PARSE_REASON = input_too_large`

`INITIAL_TOOLS_PRESENT = YES`

`INITIAL_TOOL_COUNT = 3`

`CONTINUATION_TOOLS_PRESENT = YES`

`CONTINUATION_TOOL_COUNT = 3`

`CONTINUATION_READ_ADVERTISED = YES`

`SAME_REMOTE_SESSION = YES`

`PARENT_CHAIN_CONTINUED = YES`

`STATEFUL_UPSTREAM_TOOL_PROMPT_CONTAMINATION_EVIDENCE = PARTIAL; prompt and continuation share the remote chain, echo not reproduced`

`CONTROLLED_RAW_TOOL_OUTPUT_EXPOSURE = NO`

`CONTROLLED_INTERNAL_PROMPT_EXPOSURE = NO`

`CONTROLLED_REPRODUCTION = NOT_REPRODUCED`

`MANUAL_EVIDENCE = CONFIRMED`

`FIRST_FAILING_BOUNDARY = CURRENT_REQUEST_EMPTY_TOOL_ALLOWLIST -> BUFFER_AND_CONTAINMENT_DISABLED -> TOOL_PROTOCOL_TEXT_EMITTED_AS_FINAL_TEXT`

`CC010_REGRESSION_EVIDENCE = NO`

`BRIDGE_CONTAINMENT_DEFECT_EVIDENCE = YES`

`PRODUCTION_FIX_REQUIRED = YES`

`CC011A_CLASSIFICATION = BRIDGE_CONTAINMENT_GAP`

`CC011B_CLASSIFICATION = PROMPT_ECHO_NOT_CONTAINED`

`CC011_CLASSIFICATION = CC_011_BRIDGE_DEFECT_CONFIRMED`

`NEXT_ACTION = separate CC-011 production fix; contain recognized internal protocol output independently of tool execution eligibility`

## Executive summary

CC-011 confirms a Bridge-owned output-containment gap. Tool execution remains
correctly tied to the current request's allowlist, but containment is tied to
the same `hasTools` boolean. When the current request has no normalized tools,
stream buffering and every CC-010 recovery classifier are disabled. A
recognizable raw tool envelope or an echo of the private tool-system prompt is
then emitted as ordinary assistant text.

The one controlled run did not reproduce either stochastic exposure. It did
prove that the normal Claude Code 2.1.231 continuation kept all three tools,
including `Read`, through three tool-result turns. It also proved that the
initial tool prompt and all continuation prompts used the same remote DeepSeek
session object and continued its parent chain. Therefore tool disappearance is
not a general continuation behavior and is not the cause of this controlled
run. The manual exposure remains confirmed, and deterministic offline Bridge
tests are sufficient to prove the containment defect.

No production or test code was changed during this investigation.

## Manual evidence

The user observed two real Claude Code 2.1.231 failures with
`deepseek-chat`:

- prose plus a visible `tool_call` JSON object after an earlier successful
  tool action;
- `[Error: tool call response]` followed by the private
  `--- TOOL REQUEST SYSTEM ---` instructions and tool inventory.

The same Claude session later completed real `Read` and search/read
lifecycles. This establishes intermittent output containment failure, not a
permanent adapter or runtime failure.

The report does not retain the raw arguments, absolute manual path, prompt,
tool inventory, authentication material, reasoning, or session identifiers.

## Raw tool-call exposure

The exact safe synthetic shape was prose followed by a canonical-looking
`Read` envelope whose Windows path used literal single backslashes.

With current tools `['Read']`:

- strict inspection returned `invalid_json`;
- the prefixed predicate matched;
- the CC-010 malformed classifier also identified
  `malformed_tool_envelope` with action `correct`;
- an integration-level streaming probe used exactly two completions and
  emitted only the corrected Anthropic `tool_use` event.

With current tools `[]`:

- strict inspection still returned `invalid_json`;
- prefixed retry was false;
- malformed classification was `none`;
- the integration probe used one completion and emitted the raw protocol text
  as an ordinary Anthropic text response.

This is a containment problem, not authorization to restore or execute an old
tool. A future fix must suppress recognized protocol output when no current
allowlist exists, while continuing to reject execution.

## Internal prompt exposure

A bounded synthetic output containing the private start/end marker, one
instruction line, and the placeholder tool envelope was tested without a real
inventory.

With current `Read` available, strict inspection returned `invalid_json` and
the malformed classifier produced a safe reject action because the placeholder
name is not allowed. The response became the generic safe failure without raw
prompt exposure.

With no tools, the malformed classifier did not run and the same internal
prompt was emitted as final text. A version exceeding the parser's 48 KiB
limit returned `input_too_large`; it was likewise contained with tools and
exposed without tools. Parser size rejection alone therefore does not provide
output containment.

## Current Bridge behavior

The relevant current control flow is:

```text
allowedTools = names from input.tools of the current HTTP request
hasTools = allowedTools.length > 0
bufferForTools = hasTools
```

All fenced, prefixed, brace, malformed-envelope, and reasoning-only correction
predicates require `hasTools === true`. `classifyMalformedToolIntent()` exits
immediately when that condition is false. `createProtocolStream()` streams
deltas immediately when `bufferForTools` is false. After strict inspection
rejects the output, the adapters serialize the rejected content as final text.

The Bridge intentionally does not cache or restore an earlier allowlist. That
security property is correct and must be preserved. The defect is that
non-executable containment is not independent from executable eligibility.

## Offline synthetic tests

| Case | Strict reason | Recovery/classification | Client-visible result |
| --- | --- | --- | --- |
| Prose + malformed `Read`, tools present | `invalid_json` | one bounded correction | corrected `tool_use`; raw hidden |
| Prose + malformed `Read`, tools absent | `invalid_json` | none | raw text exposed |
| Private prompt echo, tools present | `invalid_json` | safe reject | generic safe failure |
| Private prompt echo, tools absent | `invalid_json` | none | raw prompt exposed |
| Large private prompt echo, tools present | `input_too_large` | safe reject | generic safe failure |
| Large private prompt echo, tools absent | `input_too_large` | none | raw prompt exposed |

The probes used current unmodified `server.js`, parser, retry logic, streaming
adapter, and synthetic completion outputs. They did not repair JSON, parse
JSON5, execute a tool, or change repository code.

## Controlled live methodology

Exactly one foreground Claude Code invocation was run with zero harness
retries:

```text
fresh Claude Code
-> owned exact-body observer on loopback
-> unchanged Bridge on a second owned loopback port
-> DeepSeek Web
```

The model was `deepseek-chat`. The disposable read-only project path contained
both Cyrillic and a space and is named only as
`WINDOWS_CYRILLIC_FIXTURE_PATH` here. The natural task asked Claude to inspect
and briefly describe the small project. Available tools were `Glob`, `Grep`,
and `Read`; no exact JSON or exact tool sequence was forced.

The observer forwarded the original request Buffer without reserialization.
`REQUEST_BYTES_IDENTICAL = YES`. Retained data was limited to safe tool names,
counts, booleans, parser/recovery enums, and terminal outcomes. It did not
retain prompts, paths, arguments, results, reasoning, headers, credentials,
cookies, or identifiers.

Observed lifecycle:

```text
Glob -> non-error result
Read -> non-error result
Read -> non-error result
final text
```

There were four Anthropic requests, three strict accepted calls, three
non-error tool results, no correction, maximum one completion per request,
no upstream error, and a successful terminal result. Neither raw protocol
output nor the internal prompt was exposed. The run was not repeated.

Owned processes stopped, pending requests were zero, both ports were free,
and the fixture/config were removed after the run.

## Continuation inventory evidence

| Request | Current tool count | `Read` advertised | Current tool results | Outcome |
| --- | ---: | --- | ---: | --- |
| Initial | 3 | YES | 0 | strict `Glob` |
| First continuation | 3 | YES | 1 | strict `Read` |
| Second continuation | 3 | YES | 1 | strict `Read` |
| Third continuation | 3 | YES | 1 | final text |

Claude Code therefore did not remove or change the controlled inventory after
the first result. The strong hypothesis that tools always disappear on a
continuation is rejected. A client inventory change remains a possible trigger
for the manual event, but the manual request body was not retained and this
single controlled run cannot prove that historical condition.

## DeepSeek remote-session evidence

The completion wrapper retained only object-identity booleans, never remote
IDs. The initial completion created one remote session and parent. Each of the
three continuation completions received the same session object with an
existing remote session and parent, then advanced the chain.

The initial upstream prompt in that chain contained `toolPrompt()`. The later
continuation prompts used `--- TOOL RESULT CONTINUATION ---` on the same
remote chain. This confirms the architectural precondition for stateful
prompt contamination: private protocol instructions enter a stateful upstream
conversation that continues after results.

No prompt echo occurred in the one bounded run, so actual model regurgitation
in the controlled chain is not confirmed. The finding records
`STATEFUL_UPSTREAM_TOOL_PROMPT_CONTAMINATION_EVIDENCE = PARTIAL`, not a
confirmed root cause. The manual internal-prompt exposure plus deterministic
non-containment is sufficient for Bridge ownership without claiming why the
model emitted the prompt.

## Windows path analysis

Literal Windows backslashes are not valid in JSON unless each backslash is
escaped. In the observed-style value, sequences such as `\Т`, `\М`, and
`\p` are invalid JSON escapes. The strict parser correctly reports
`invalid_json`.

This is not a reason to repair or execute the arguments locally. With a current
allowed `Read`, the output may only trigger one fresh correction. Without a
current allowlist it must be contained and rejected, never executed.

## Failure boundary

The first deterministic failing boundary is after strict rejection and before
protocol serialization:

```text
current request has no normalized tools
-> hasTools = false
-> streaming buffer disabled
-> CC-010 classifiers disabled
-> rejected internal/tool-protocol text serialized as final assistant text
```

The controlled run did not cross this boundary because every request retained
all three tools. The Bridge behavior is nevertheless directly proven offline
with current production components.

## Security decision

The invariant is:

```text
INTERNAL TOOL PROTOCOL NEVER USER VISIBLE
```

Containment must not imply execution. If the current allowlist is empty or the
mentioned tool is absent, a future Bridge fix must not restore historical tool
inventory, create a `tool_use`, repair arguments, or perform a correction that
could authorize a tool. It should recognize only narrow private/protocol
markers, suppress the raw content, and return a generic safe failure.

Streaming containment must be decided before any matching raw delta becomes
client-visible. Large rejected outputs must follow the same safe path. Negative
controls for ordinary JSON, documentation, quoted examples, and user-provided
text remain required for the separate production-fix stage.

## Bridge ownership

The upstream model owns producing malformed or echoed content. The Bridge owns
whether private protocol material is released to the client. Current code can
safely recognize and contain these classes when tools are present, but exposes
them when the current allowlist is empty. That makes containment Bridge-owned.

This does not prove that Claude Code omitted tools in the manual request, and
it does not invalidate CC-010's strict correction behavior with a current
allowlist. CC-011 is a newly isolated non-executable containment boundary.

## Classification

- `CC011A_CLASSIFICATION = BRIDGE_CONTAINMENT_GAP`: raw protocol text can be
  exposed when current tools are absent; with tools it is safely corrected or
  rejected.
- `CC011B_CLASSIFICATION = PROMPT_ECHO_NOT_CONTAINED`: the private prompt can
  be exposed when current tools are absent, including an over-limit echo.
- `CC010_REGRESSION_EVIDENCE = NO`: the controlled current-allowlist path and
  CC-010 correction path remain correct; the uncovered boundary is
  allowlist-independent containment.
- `BRIDGE_CONTAINMENT_DEFECT_EVIDENCE = YES`.
- `PRODUCTION_FIX_REQUIRED = YES`.
- `CC011_CLASSIFICATION = CC_011_BRIDGE_DEFECT_CONFIRMED`.

## Next action

Open a separate CC-011 production-fix stage. Preserve the strict parser,
current-request allowlist, one shared correction budget, and client-owned tool
execution. Add narrowly tested protocol/prompt containment that remains active
when execution eligibility is absent. Do not merge this audit branch and do
not implement the fix in this investigation.
