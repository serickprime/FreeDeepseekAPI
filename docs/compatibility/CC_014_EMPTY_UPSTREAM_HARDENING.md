# CC-014 Empty Upstream Response Hardening

## Executive summary

```text
BASELINE_MAIN = a78142a1ce610cd82692ab9b33b09f3b27340c29

CC013_CLASSIFICATION = CC_013_UPSTREAM_EMPTY_RESPONSE_LIMITATION

EMPTY_DETECTION_BOUNDARY = completeOnce(), immediately after parseStream() and before parent state commit
EMPTY_RETRY_USES_EXISTING_CLIENT_LOOP = YES
MAX_UPSTREAM_ATTEMPTS = 3
BRIDGE_MAX_COMPLETIONS = 2

SESSION_RESET_ON_EMPTY = YES
EMPTY_PARENT_COMMITTED = NO

EMPTY_RECOVERY_TEST = PASS
EMPTY_EXHAUSTION_TEST = PASS

ANTHROPIC_STREAMING = PASS
OPENAI = PASS
RESPONSES = PASS

CC010 = PASS
CC011 = PASS
CC012 = PASS

TOTAL_TESTS = 324/324 PASS

CLAUDE_VERSION = 2.1.231
LIVE_SESSIONS = 9 (6 fresh + 3 multi-turn)
LIVE_USER_TURNS = 15
LIVE_BRIDGE_REQUESTS = 81
LIVE_UPSTREAM_ATTEMPTS = 121

UPSTREAM_EMPTY_ATTEMPTS = 60
EMPTY_RETRY_RECOVERIES = 2
EMPTY_RETRY_EXHAUSTED = 19

SILENT_EMPTY_TERMINAL_TURNS = 0
EXPLICIT_UPSTREAM_ERRORS = 21 request outcomes

RAW_PROTOCOL_EXPOSURES = 0
PRIVATE_PROMPT_EXPOSURES = 0
UNAUTHORIZED_EXECUTIONS = 0

CC014_CLASSIFICATION = CC_014_EMPTY_UPSTREAM_HARDENED
```

CC-013 proved that the empty result originates upstream: DeepSeek returns an
HTTP 200 SSE response containing valid metadata and a parent identifier but no
model, reasoning, or search payload. CC-014 prevents that metadata-only result
from becoming a successful empty assistant turn.

The Bridge now treats this exact condition as a retryable upstream failure.
It reuses the pre-existing bounded client retry loop and resets the remote
DeepSeek session before a retry. A recovered attempt continues normally. If
all attempts are empty, the request ends with an explicit upstream error.

## CC-013 evidence carried forward

The CC-013 audit classified the first failing boundary as
`DEEPSEEK_HTTP_200_METADATA_ONLY_SSE`. It found no evidence that
`parseStream()` discarded a model fragment. The current change therefore does
not broadly rewrite SSE parsing; it adds only bounded structural payload
metadata and a decision after parsing.

```text
DeepSeek HTTP 200
-> SSE body present
-> valid metadata events
-> zero model/reasoning/search payload
-> retryable DeepSeekEmptyResponseError
```

## Implementation

`parseStream()` now returns three safe structural fields alongside its current
result:

- whether any reconstructed model payload was seen;
- reconstructed content byte count;
- reconstructed reasoning byte count.

`completeOnce()` checks that signal after the stream has been parsed and
before assigning the returned parent identifier to the local session. A
metadata-only result raises `DeepSeekEmptyResponseError` with safe properties:

```text
status = 502
retryable = true
upstreamStage = empty_response
```

No response body, prompt, identifier, path, or session value is attached to
the error.

## Retry and session invariants

No new retry loop was added. `complete()` retains its existing
`maxRetries = 2`, so one call can make at most three upstream HTTP completion
attempts. Before every permitted retry, the existing `resetRemoteSession()`
path clears both the remote session and parent identifiers.

The metadata-only parent is never committed as a successful continuation
parent. An exhausted final attempt also cannot overwrite the parent that was
present before that attempt.

This upstream reliability retry is independent from the Bridge tool
correction state machine. `MAX_COMPLETIONS` remains 2: an initial Bridge
completion plus at most one tool-format correction.

## Diagnostics

Opt-in diagnostics add only:

```text
stage = empty_response
error_name = DeepSeekEmptyResponseError
error_category = empty_response
upstream_empty_response = true
empty_retry_attempt = bounded attempt number
```

Diagnostics do not retain the upstream body, prompt, model text, parent ID,
session ID, tool arguments, authentication data, or local path.

## Offline verification

The deterministic matrix covers:

- metadata-only SSE detection;
- parent identifier non-commit;
- one empty attempt followed by success;
- two empty attempts followed by third-attempt success;
- three-attempt exhaustion;
- remote session reset before retry;
- ordinary content without retry;
- reasoning-only payload without retry;
- search payload without false empty detection;
- malformed SSE behavior;
- existing network, HTTP 429, and HTTP 5xx retry behavior;
- Anthropic streaming recovery and exhaustion;
- OpenAI streaming and non-streaming recovery;
- Responses streaming and non-streaming recovery;
- explicit non-streaming exhaustion errors for all three adapters;
- unchanged two-completion tool correction budget and current allowlist rule.

The suite increased from 299 to 324 tests. All 324 tests pass. Required Node
syntax checks and `git diff --check` also pass.

## Controlled live methodology

The authorized live matrix used:

```text
Claude Code 2.1.231
model = deepseek-chat
6 fresh sessions
3 independent multi-turn sessions
15 foreground user turns
harness retries = 0
fixture = DISPOSABLE_SYNTHETIC_PROJECT
allowed tools = Glob, Read, Grep
```

The project was a read-only disposable Node fixture. It contained package
metadata, a README, source files, configuration, and a test. No user project
was used.

Claude Code connected through an owned loopback observer to an owned Bridge.
The observer forwarded the original request Buffer without parsing or
reserializing it. All 81 Messages request bodies had identical before/after
hashes:

`REQUEST_BYTES_IDENTICAL = YES`.

Retained evidence contains only version, counters, safe tool names, lifecycle
booleans, and bounded diagnostic classes. It contains no prompt, response
text, tool arguments, path, auth material, or remote identifiers.

## Live results

The matrix completed all nine sessions and all fifteen foreground turns.
Every Claude invocation exited normally and produced a non-empty terminal
result.

```text
BRIDGE_REQUESTS = 81
UPSTREAM_COMPLETION_ATTEMPTS = 121
UPSTREAM_EMPTY_ATTEMPTS = 60

EMPTY_RETRY_RECOVERIES = 2
EMPTY_RETRY_EXHAUSTED = 19
SILENT_EMPTY_TERMINAL_TURNS = 0

EXPLICIT_UPSTREAM_ERRORS = 21 request outcomes
CLAUDE_RESULT_ERRORS = 0
```

The empty-upstream limitation remained frequent and is not claimed fixed at
its source. All sixty empty attempts were handled by the new boundary:

- three empty attempts across two Bridge requests were followed by a
  successful retry;
- fifty-seven empty attempts exhausted nineteen Bridge requests and produced
  explicit upstream errors;
- Claude Code continued its own request lifecycle after those explicit
  errors, so none of the fifteen foreground turns ended silently empty.

Two additional Bridge requests ended with a non-empty-response upstream error
outcome. They are included in the total of twenty-one explicit upstream error
outcomes. The controlled harness did not retry any foreground invocation.

## Tool lifecycle and CC-012 regression

The same matrix completed 45 real tool lifecycles:

| Tool | Executions |
| --- | ---: |
| Glob | 14 |
| Read | 30 |
| Grep | 1 |

All 45 calls produced a matching tool result. Two tool results reported a
runtime error and the agent continued. One Bridge request used the existing
bounded tool-format correction. The maximum observed Bridge completion count
was 2.

```text
RAW_PROTOCOL_EXPOSURES = 0
PRIVATE_PROMPT_EXPOSURES = 0
UNAUTHORIZED_EXECUTIONS = 0
```

CC-012 therefore remained intact during a substantially retry-heavy live
sample.

## Protocol adapter verification

Anthropic streaming hides a metadata-only attempt because no model delta was
emitted. A recovered internal retry then produces the normal SSE lifecycle.
On exhaustion the adapter emits an explicit Anthropic error event and does not
emit a successful `message_stop` for an empty response.

OpenAI Chat Completions and Responses pass both streaming and non-streaming
recovery tests. Non-streaming exhaustion returns HTTP 502 with the existing
generic safe upstream message rather than an HTTP 200 empty assistant.

## Security and compatibility invariants

- The strict tool parser is unchanged.
- CC-010, CC-011, and CC-012 test suites remain passing.
- Tool execution still requires the current request allowlist.
- No historical tool allowlist is restored.
- No model or transport retry was added outside `complete()`.
- The upstream attempt bound was not increased.
- The Bridge tool correction budget remains 2 completions.
- Empty metadata, raw model output, prompts, paths, reasoning, and credentials
  are not logged.

## Final classification

The Bridge cannot prevent DeepSeek from producing a metadata-only HTTP 200,
but it no longer accepts that response as a successful empty assistant turn.
The required live success bar is met:

```text
SILENT_EMPTY_TERMINAL_TURNS = 0
RAW_PROTOCOL_EXPOSURES = 0
PRIVATE_PROMPT_EXPOSURES = 0
UNAUTHORIZED_EXECUTIONS = 0
```

`CC014_CLASSIFICATION = CC_014_EMPTY_UPSTREAM_HARDENED`

The implementation is ready for reviewed PR and merge after the staged
workflow is explicitly continued.
