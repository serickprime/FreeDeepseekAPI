# CC-013 Empty Upstream Completion Reliability

## Executive summary

```text
BASELINE_MAIN = a78142a1ce610cd82692ab9b33b09f3b27340c29
CLAUDE_VERSION = 2.1.231
CC012_POSTMERGE = PASS

TOTAL_BRIDGE_REQUESTS = 34
EMPTY_COMPLETIONS = 16
USER_VISIBLE_EMPTY_FAILURES = 8
EMPTY_FOLLOWED_BY_CLIENT_RETRY = 8

EMPTY_WITH_TOOLS = 16
EMPTY_WITHOUT_TOOLS = 0
EMPTY_CONTINUATIONS = 1

DEEPSEEK_EMPTY_RESPONSES = 16
PARSESTREAM_EMPTY_WITH_UPSTREAM_DATA = 0

STREAM_PARSER_DEFECT_EVIDENCE = NO
SESSION_STATE_DEFECT_EVIDENCE = NO
BRIDGE_DEFECT_EVIDENCE = NO
CLIENT_BEHAVIOR_EVIDENCE = YES

FIRST_FAILING_BOUNDARY = DEEPSEEK_HTTP_200_METADATA_ONLY_SSE

CC013_CLASSIFICATION = CC_013_UPSTREAM_EMPTY_RESPONSE_LIMITATION
PRODUCTION_FIX_REQUIRED = NO
```

The controlled matrix reproduced the empty-completion condition at useful
scale. Sixteen DeepSeek completion calls returned HTTP 200 with a present SSE
body and valid JSON events, but no response, reasoning, thinking, or search
payload bytes. `parseStream()` returned empty content and reasoning because
the upstream stream carried no such data; it did not discard non-empty model
output.

The behavior was not benign for every user turn. Eight foreground turns ended
with an empty terminal result, although Claude Code showed neither an explicit
result error nor the Bridge generic tool-call failure. Claude automatically
sent another Messages request after eight of the sixteen empty responses; one
of those automatic follow-ups recovered and completed a real tool lifecycle.

The first failing boundary is therefore the successful upstream HTTP response,
not the Bridge stream parser, tool decision pipeline, or Claude tool runtime.
This audit does not change production behavior and does not reopen CC-012.

## Scope and baseline

CC-013 was run after PR #17 merged CC-012. The merged `main` was
`a78142a1ce610cd82692ab9b33b09f3b27340c29`, and the post-merge suite was
`299/299 PASS`. The audit branch made no production or test-code changes.

The investigation addressed the thirty-eight request-level empty outcomes
seen during CC-012 stress. It distinguished an actually empty DeepSeek result
from data present in upstream SSE but lost by `parseStream()`.

## Methodology

The bounded live matrix used:

```text
4 fresh Claude Code sessions
3 independent multi-turn Claude Code sessions
13 foreground invocations
harness retries = 0
model = deepseek-chat
fixture = DISPOSABLE_SYNTHETIC_PROJECT
allowed tools = Glob, Read, Grep
```

An owned loopback observer forwarded the original request Buffer without
reserializing it. The unchanged production Bridge used an untracked wrapper
around its existing DeepSeek client. The wrapper teed only the upstream
completion response body and retained structural metadata:

- HTTP status and response-body presence;
- SSE data-event and JSON-parse counts;
- safe patch-path names;
- fragment types and byte counts;
- whether a parent message identifier was returned;
- reconstructed content and reasoning byte counts.

No fragment text, prompt, raw request body, tool arguments, local path,
authorization material, cookie, session identifier, or parent identifier was
retained. The disposable fixture, isolated Claude configuration, observer, and
Bridge were removed or stopped after the run. Both owned ports were free and
owned Claude process count was zero.

`REQUEST_BYTES_IDENTICAL = YES`. The forwarding path compared the received
Buffer with the forwarded Buffer for every request.

## Observer accounting note

The temporary request metadata recorder compared `req.url` to an exact
`/v1/messages` string. Current Claude Code appended a query component, so the
recorder did not retain its per-request summaries even though the observer
forwarded those exact bytes normally. No live run was repeated to repair this
audit-only counter because the authorized 4 + 3 session budget had already
been consumed.

The request total was reconstructed without prompt or identifier data from
the complete retained lifecycle:

```text
DeepSeek completions = 35
completions starting without a remote session = 21
real Claude tool_use/tool_result lifecycles = 13
second completion from the single bounded correction = 1

Bridge requests = 21 initial/stateless + 13 tool continuations = 34
```

The ordering is unambiguous around the empty burst: the retained Claude event
summaries contain thirteen real tool uses and thirteen matching results, while
the completion records retain only booleans for upstream session and parent
presence. This is sufficient to distinguish the one empty continuation from
the fifteen empty stateless completions. The report does not claim unavailable
per-request fields beyond those relationships.

## Upstream SSE evidence

All sixteen empty completions had the same strong structural properties:

| Property | Result |
| --- | --- |
| DeepSeek HTTP status | 200 |
| Response body | present |
| Body size | 306 or 308 bytes |
| SSE data events | 3 or 4 |
| JSON parse failures | 0 |
| Parent identifier returned | YES |
| Response payload bytes | 0 |
| Reasoning/thinking payload bytes | 0 |
| Search payload bytes | 0 |
| Parsed content bytes | 0 |
| Parsed reasoning bytes | 0 |

For comparison, all nineteen non-empty completion calls showed upstream
content byte counts equal to their reconstructed content byte counts. The
same parser therefore retained data when the upstream stream supplied it.

```text
UPSTREAM_HAD_NONEMPTY_DATA_ON_EMPTY_PARSE = NO
PARSESTREAM_EMPTY_WITH_UPSTREAM_DATA = 0
```

This rejects the `STREAM_PARSER_LOSS` hypothesis for the observed sample.

## Correlation

### Tool inventory and continuation

Every foreground invocation ran with the current three-tool read-only
allowlist. The empty set included:

```text
15 stateless/current-request completions
1 real tool-result continuation
```

The continuation had an existing remote session and parent. The other fifteen
empty calls began without either. Therefore empty output is not limited to a
tool-result continuation or a stateful parent chain.

### Fresh and long sessions

```text
FRESH_SESSIONS_AFFECTED = 2 / 4
LONG_SESSIONS_AFFECTED = 3 / 3
```

The affected long sessions do not establish length as the cause because the
same empty shape appeared in fresh sessions and in requests without an
existing upstream session. The events formed one intermittent burst and then
normal non-empty completions resumed.

### Claude client behavior

Eight empty responses were followed immediately by another Messages request
inside the same foreground invocation. Seven of those retry chains still
ended empty; one recovered and proceeded through a real `Glob` lifecycle.
One empty tool continuation and seven terminal requests were not followed by
another client request.

```text
EMPTY_FOLLOWED_BY_CLIENT_RETRY = 8
AUTOMATIC_RETRY_RECOVERIES = 1
TERMINAL_EMPTY_TURNS = 8
EXPLICIT_RESULT_ERRORS = 0
VISIBLE_GENERIC_TOOL_FAILURES = 0
```

This is evidence that Claude Code sometimes retries an empty assistant turn,
but the client behavior does not make the upstream result benign or reliably
hide it from the user.

## Hypothesis decisions

### Benign internal request

Rejected as the overall classification. Although automatic client requests
exist, eight foreground invocations still ended without a terminal answer.

### Upstream model empty response

Supported. DeepSeek returned HTTP 200, a structurally readable metadata-only
SSE body, a parent identifier, and zero model payload bytes sixteen times.

### Streaming parser loss

Rejected for this sample. No empty parsed result had upstream content or
reasoning data, and every SSE data item was valid JSON.

### Stateful session problem

Not supported. Fifteen empty calls started without a remote session or parent;
only one was a stateful continuation. Normal output later resumed.

### Bridge defect

Not proven. The Bridge accurately represented the absence of upstream model
payload, did not expose tool protocol, did not perform unauthorized execution,
and did not lose SSE fragment data. Returning an explicit retryable upstream
error for metadata-only HTTP 200 responses could be considered future
reliability hardening, but the present evidence assigns the original empty
completion to DeepSeek and does not authorize a production change in this
audit stage.

## First failing boundary

```text
Claude Messages request
-> Bridge request normalization PASS
-> DeepSeek HTTP completion status 200
-> SSE body present
-> SSE JSON parsing PASS
-> metadata / parent identifier present
-> model content/reasoning payload absent   <-- first failing boundary
-> parseStream correctly reconstructs empty output
-> Bridge returns an empty assistant outcome
```

`FIRST_FAILING_BOUNDARY = DEEPSEEK_HTTP_200_METADATA_ONLY_SSE`.

## CC-012 relationship

No raw tool JSON, private tool prompt, or unauthorized tool execution was
observed. CC-012 remained merged and its post-merge 299-test regression suite
passed. Empty upstream output is independent of CC-012 protocol containment.

```text
CC012_POSTMERGE = PASS
RAW_PROTOCOL_EXPOSURE = 0
PRIVATE_PROMPT_EXPOSURE = 0
UNAUTHORIZED_EXECUTION = 0
```

## Classification and next action

```text
CC013_CLASSIFICATION = CC_013_UPSTREAM_EMPTY_RESPONSE_LIMITATION
BRIDGE_DEFECT_EVIDENCE = NO
PRODUCTION_FIX_REQUIRED = NO
NEXT_ACTION = REVIEW_CC013_EVIDENCE_BEFORE_ANY_OPTIONAL_EMPTY_RESPONSE_HARDENING
```

The audit report should remain on its investigation branch for review. No
release, UI change, CI work, or production retry policy change follows from
this stage automatically.
