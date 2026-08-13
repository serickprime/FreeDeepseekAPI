# CC-006 Web tools re-evaluation

Date: 2026-08-13

## Result summary

This evidence-only re-evaluation tested the current Claude Code `WebFetch` and
`WebSearch` boundaries through the unchanged production Bridge. No production
or test code was changed. Exactly two fresh foreground Claude Code invocations
were used, with zero harness retries.

`BASELINE_MAIN = fff32361aaa0a1f736653f1e2fb8136bad045000`

`WEBFETCH_SCHEMA_TRANSPORT = PASS`

`WEBSEARCH_SCHEMA_TRANSPORT = PASS`

`WEBFETCH_SYNTHETIC_STRICT_PARSE = PASS`

`WEBSEARCH_SYNTHETIC_STRICT_PARSE = PASS`

`WEBFETCH_CLAUDE_VERSION = 2.1.231`

`WEBFETCH_ADVERTISED = YES`

`WEBFETCH_TOOL_CHOICE = NOT_RETAINED`

`WEBFETCH_SELECTED = NO_EXECUTABLE_SELECTION`

`WEBFETCH_STRICT = NO`

`WEBFETCH_RESULT_COUNT = 0`

`WEBFETCH_RESULT_ERRORS = 0`

`WEBFETCH_CONTINUATION = NO`

`WEBFETCH_COMPLETION_MAX = 2`

`WEBFETCH_FORMAT_FAILURE = YES`

`WEBFETCH_CLASSIFICATION = FORMAT_FAILURE`

`WEBSEARCH_CLAUDE_VERSION = 2.1.231`

`WEBSEARCH_ADVERTISED = YES`

`WEBSEARCH_TOOL_CHOICE = NONE`

`WEBSEARCH_SELECTED = YES`

`WEBSEARCH_STRICT = YES`

`WEBSEARCH_RESULT_COUNT = 1`

`WEBSEARCH_RESULT_ERRORS = 0`

`WEBSEARCH_CONTINUATION = YES`

`WEBSEARCH_COMPLETION_MAX = 1`

`WEBSEARCH_FORMAT_FAILURE = NO`

`WEBSEARCH_CLASSIFICATION = PASS`

`REQUEST_BYTES_IDENTICAL = YES`

`RAW_TOOL_OUTPUT_EXPOSURE = NO`

`CC010_REGRESSION_EVIDENCE = NO`

`BRIDGE_DEFECT_EVIDENCE = NO`

`PRODUCTION_FIX_REQUIRED = NO`

`CC006_CLASSIFICATION = CC_006_PARTIAL_FORMAT_LIMITATION`

`NEXT_ACTION = NO_CC006_BRIDGE_FIX; PROCEED_TO_SEPARATELY_AUTHORIZED_CC008`

## Method and safety boundary

The controlled topology was:

```text
Claude Code
-> owned exact-byte loopback observer
-> unchanged production Bridge
-> DeepSeek
```

- Observer: `127.0.0.1:19656`.
- Bridge: `127.0.0.1:19657`.
- Existing user listeners were not used or changed.
- The observer parsed only an in-memory copy and forwarded the original body
  `Buffer`. Its before/after hashes matched for every forwarded request.
- Only bounded names, counts, booleans, enums, and terminal states were
  retained.
- Prompts, URL/query arguments, fetched/search content, raw arguments,
  reasoning, headers, cookies, authorization, session IDs, raw malformed
  output, and tool results were not logged or retained.
- The public target class was `PUBLIC_IANA_INFORMATION`.
- Foreground Claude invocations: exactly `2`.
- Harness retries: `0`.
- Bridge correction limit: initial completion plus at most one correction.

The Claude version was obtained immediately before each foreground invocation,
not once for the batch. Both invocations reported `2.1.231`.

## Offline source and schema review

The current Anthropic path remains generic and does not special-case either
web tool:

```text
incoming body.tools[].name / description / input_schema
-> normalize(..., "anthropic")
-> function.name / description / parameters
-> toolPrompt()
-> DeepSeek completion
-> inspectToolCallFromOutput() with exact current allowed names
-> toAnthropic() tool_use with the accepted name and parsed input
-> Claude Code runtime
-> tool_result extraction and call-ID continuation
```

`normalize()` does not filter or rename `WebFetch` or `WebSearch`. It assigns
the original `input_schema` object directly to `function.parameters`; the
offline identity and structural-equality checks passed. `toolPrompt()` exposes
the same name and schema. CC-010 neutral historical records change only the
representation of already-requested actions and do not remove current tools.

The installed Claude Code `2.1.231` package contract defines:

- `WebFetch`: required string fields `url` and `prompt`;
- `WebSearch`: required string field `query`, plus optional string-array
  fields `allowed_domains` and `blocked_domains`.

The offline checks preserved the names, descriptions, object type, property
types, required fields, optional fields, and array item types. No enum/type or
required/optional field was rewritten.

Canonical whole-response synthetic calls for each exact allowed name and
object arguments were passed through the unchanged
`inspectToolCallFromOutput()` path. Both returned `accepted`. No malformed,
fuzzy, substring, JSON5, repair, or extraction path was used.

## Live run 1 — WebFetch

The invocation exposed only `WebFetch` through the Claude CLI tool flags, and
the Bridge entered its tool-capable brace-delimited recovery path. This proves
that a tool was present on the request; because `WebFetch` was the only allowed
CLI tool, the advertised capability is recorded as `YES`.

The initial DeepSeek completion was not a strict executable call. It matched
the existing narrow `brace_tool` malformed class. The Bridge used exactly one
bounded corrective completion. The correction did not produce a strict call,
so the request ended as the existing generic safe failure.

- executable `WebFetch` selection: no;
- strict parser acceptance: no;
- Claude WebFetch runtime reached: no;
- tool result: none;
- continuation: no;
- completion maximum: two;
- correction attempted: yes;
- recovery class: `brace_tool`;
- terminal Bridge outcome: `safe_failure`;
- raw textual `[Tool Call]` exposure: no;
- raw `tool_call` JSON exposure: no;
- other raw tool-like exposure: no;
- upstream/network error: none;
- Claude process exit: zero.

The observer forwarded the original bytes, but its first-run safe row selector
did not recognize the Messages pathname when the request carried a query
suffix. Consequently, the inbound `tool_choice` value for this run was not
retained. The run was not repeated, as required. This observation gap is not
evidence for either presence or absence of forced `tool_choice`, and no
tool-choice implementation change is inferred from it.

`WEBFETCH_FIRST_FAILING_BOUNDARY = UPSTREAM_DEEPSEEK_FORMAT_OUTPUT`

The first proven functional boundary is before strict Bridge acceptance and
before Claude web runtime. The Bridge safely handled the malformed class under
the existing shared budget, so this is not raw-output leakage or a CC-010
regression. It is also not evidence of schema transport corruption or parser
rejection of a canonical call.

## Quiet boundary

After WebFetch and before WebSearch:

- pending requests: `0`;
- orphan tool results: `0`;
- owned Claude processes: `0`;
- unexpected background calls: `0`;
- observer and Bridge ports free: yes.

Only the temporary observer pathname matcher was corrected before the second
run. WebFetch was not repeated.

## Live run 2 — WebSearch

The fresh WebSearch session completed the full requested lifecycle:

```text
WebSearch advertised with tool_choice NONE
-> strict WebSearch tool_use
-> real Claude Code WebSearch runtime
-> one non-error tool_result
-> continuation reaches Bridge
-> final text
```

- advertised: yes;
- initial `tool_choice`: `NONE`;
- forced safe tool name: none;
- strict WebSearch selected: yes;
- Bridge selected count: one;
- Claude WebSearch tool-use count: one;
- tool result count: one;
- current result error count: zero;
- continuation: yes;
- final answer: yes;
- maximum completions per Bridge request: one;
- correction attempted: no;
- formatting failure: no;
- raw textual `[Tool Call]` exposure: no;
- raw `tool_call` JSON exposure: no;
- other raw tool-like exposure: no;
- upstream/network errors: none;
- Claude process exit: zero.

Claude Code also issued one separate tool-capable internal request with
`tool_choice=AUTO` before the final WebSearch continuation. It did not force
`WebSearch` and does not change the classification of the main lifecycle.
No `ANY` or `TOOL(WebSearch)` requirement was observed.

`WEBSEARCH_FIRST_FAILING_BOUNDARY = NONE`

`WEBSEARCH_RUNTIME = PASS`

## Classification

WebSearch is compatible end to end in the current controlled environment.
WebFetch did not reach its runtime because DeepSeek produced a malformed
brace-delimited tool intent and the one permitted correction did not yield a
strict call. The Bridge did not execute the malformed text, did not exceed two
completions, and did not expose the rejected payload.

This is therefore a partial result, but not a confirmed Bridge defect:

- schema transport: pass for both tools;
- canonical strict parser path: pass for both tools;
- WebSearch runtime and continuation: pass;
- WebFetch model formatting: failed safely before runtime;
- tool-choice gap: not proven;
- CC-010 regression: no evidence;
- production fix justified by this evidence: no.

The exact WebFetch runtime remains unproven. A nondeterministic repeat is not
authorized or recommended from this run. A future investigation should occur
only if new evidence identifies a stable Bridge-controlled boundary; it must
not add global forcing, broad retries, schema rewriting, or permissive parsing.

## Cleanup

- Both owned Claude processes exited.
- Owned observer and Bridge stopped.
- Ports `19656` and `19657` were free after both runs.
- Temporary Claude configs and workspaces were removed.
- The temporary ignored observer/harness was removed.
- No temporary live logs or raw payload captures were retained.
- The repository was clean before this report was created.
- CC-008 and the final full audit were not started.
