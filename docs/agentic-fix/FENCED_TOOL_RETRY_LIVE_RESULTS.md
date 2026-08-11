# Bounded fenced tool retry: live results

Date: 2026-08-11.

Node.js: `v24.12.0`.

Claude Code: `2.1.226`.

Branch: `fix/tool-parser-rejection-diagnostics`.

Starting commit: `380d37cf8522e5ed576de897cc3eb19a0d1eccad`.

## Test boundary and deviation

- Intended boundary: one Claude session, one user prompt, no follow-up, at most
  twelve `/v1/messages`, and at most ten minutes.
- Actual Claude sessions: **2**.
- Actual user prompts: **2**.
- `/v1/messages` requests: 8.
- Tool-capable requests: 6.
- Requests with `tools = 0`: 2.
- Both sessions used the same single read-only prompt intent; no follow-up was
  sent in either session.
- The elapsed time and twelve-request limits were not reached.

The first background wrapper appeared to have exited before Claude started:
the process was absent, its redirected files were empty, and Bridge diagnostics
still contained zero requests at the intervening check. It subsequently
started Claude late. A synchronous launch was then made under the mistaken
assumption that no Claude session had started. Correlation later showed two
distinct process-scoped `client_session_ref` values. This is a test-procedure
violation, so the combined run is **not a valid one-session acceptance test**.
No further session or prompt was started after the deviation was discovered.

## Request and tool summary

Both tool-capable initial requests carried three raw and three normalized tools:
`Glob`, `Read`, and `Grep`. All tool-capable continuation requests carried five
raw and five normalized tools; `Glob`, `Read`, and `Grep` remained present, and
two inherited Context7 MCP tools also appeared. No settings, MCP configuration,
or agents were changed during the test.

- `Glob` in the allowlist: yes.
- `Read` in the allowlist: yes.
- `Grep` in the allowlist: yes.
- Proven actual tool execution: `Glob` in the first session.
- Proven tool executions by protocol lifecycle: four total tool calls received
  corresponding `tool_result` continuations (one in the first session and
  three in the second).
- Exact names of the three second-session tool executions were not retained by
  the safe CLI summarizer. Their ordered lifecycle is consistent with the
  requested `Glob` -> `Read` -> `Grep` flow, but diagnostics alone do not record
  response tool names. The exact three-name chain is therefore not claimed as
  independently proven.
- `Glob` -> `Read` -> `Grep` chain: **PARTIAL / not independently name-verified**.

The first session's safe CLI event summary contained one `Glob` tool use and
one tool result. Its final ordinary text was a brace-delimited tool-like object,
so raw tool JSON was visible in that session. The second session had three
accepted tool calls and three corresponding continuations; its final selected
content had no brace, code-fence, or tool-call-marker signals.

- `raw_tool_json_visible_in_claude`: **yes overall** (first session).
- Raw tool JSON evidence in the second session: no.

## Correlated tool-capable requests

The following safe process-scoped client refs are included only to separate the
two sessions. No full session ID or call ID is recorded.

| client ref | request_ref | raw / normalized | Glob / Read / Grep | continuation | tool results | parse source | parse reason | strict | reasoning nonempty | content nonempty | reasoning retry | fenced retry | repeated retry | retry reason | outcome |
| --- | --- | ---: | --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `228d4a883260` | `85960273f288ba4a` | 3 / 3 | yes / yes / yes | no | 0 | content | accepted | yes | yes | yes | no | no | no | none | tool_call |
| `228d4a883260` | `eb7068a2727ade5f` | 5 / 5 | yes / yes / yes | yes | 1 | content | invalid_json | no | no | yes | no | no | no | none | final_text |
| `cc162bfc2b92` | `36fc8218f4ea3a2d` | 3 / 3 | yes / yes / yes | no | 0 | content | accepted | yes | yes | yes | no | no | no | none | tool_call |
| `cc162bfc2b92` | `ff80911bd5fcf7fe` | 5 / 5 | yes / yes / yes | yes | 1 | content | accepted | yes | yes | yes | no | no | no | none | tool_call |
| `cc162bfc2b92` | `cfbec0fb6b0771b6` | 5 / 5 | yes / yes / yes | yes | 1 | content | accepted | yes | yes | yes | no | no | no | none | tool_call |
| `cc162bfc2b92` | `f5751fd23f510bdc` | 5 / 5 | yes / yes / yes | yes | 1 | content | invalid_json | no | no | yes | no | no | no | none | final_text |

The two tools=0 model-discovery requests were `6c2815af1fe86507` and
`30c338e9b660c263`. They correlated respectively with the two client refs above
and are excluded from the tool-capable table.

## Safe rejected-output metadata

Request `eb7068a2727ade5f` ended the first session after its proven `Glob`
continuation:

- `content_bytes = 274`;
- `content_trimmed_bytes = 274`;
- `reasoning_bytes = 1716`;
- `reasoning_trimmed_bytes = 1715`;
- `content_starts_with_brace = true`;
- `content_ends_with_brace = true`;
- `content_starts_with_code_fence = false`;
- `content_contains_tool_call_marker = true`;
- `reasoning_starts_with_brace = false`;
- `reasoning_ends_with_brace = false`;
- `reasoning_starts_with_code_fence = false`;
- `reasoning_contains_tool_call_marker = false`.

This was tool-like malformed JSON without a code fence. It did not satisfy the
bounded `CODE_FENCE` correction predicate, so `fenced_tool_retry_attempted` was
correctly false and the request used one upstream completion.

Request `f5751fd23f510bdc` ended the second session after three accepted tool
calls and three tool-result continuations:

- `content_bytes = 1512`;
- `content_trimmed_bytes = 1512`;
- `reasoning_bytes = 3564`;
- `reasoning_trimmed_bytes = 3563`;
- `content_starts_with_brace = false`;
- `content_ends_with_brace = false`;
- `content_starts_with_code_fence = false`;
- `content_contains_tool_call_marker = false`;
- `reasoning_starts_with_brace = false`;
- `reasoning_ends_with_brace = false`;
- `reasoning_starts_with_code_fence = false`;
- `reasoning_contains_tool_call_marker = true`.

The selected content had no code-fence or tool-call-marker evidence. The
reasoning signal did not override nonempty content under existing parser
semantics. No correction retry was attempted.

No raw content, reasoning, prompt, tool arguments, tool results, local file
contents, credential, token, cookie, authorization value, full session ID, or
full call ID is recorded in this report.

## Upstream, retry, and call-count evidence

All eight requests reached:

`challenge_start` -> `challenge_received` -> `wasm_cache_hit` (or the initial
WASM download and compile path) -> `pow_solve_start` -> `pow_solved` ->
`completion_start` -> `completion_completed` -> `stream_received` ->
`stream_read` -> `stream_parsed`.

New upstream sessions additionally recorded `remote_session_start` and
`remote_session_created`. The first request downloaded and compiled WASM; all
later requests used `wasm_cache_hit`.

- Network error: no.
- `upstream_error` records: 0.
- Upstream completions per HTTP request: 1 for every request.
- Maximum upstream completions in any request: 1.
- CODE_FENCE observed: no.
- Fenced retry attempted: no.
- `tool_retry_reason`: `none` for every response.
- Reasoning retry attempted: no.
- Repeated-tool retry attempted: no.
- Third correction completion: no.

Because no CODE_FENCE occurred, there was no corrected request and no
initial-plus-correction pair to count. The live run therefore did not directly
exercise the new bounded fenced retry.

## Classification and conclusion

Taxonomy classification for the second session's direct tool lifecycle:
**NO_FENCE_DIRECT_SUCCESS**.

Overall controlled-test validity: **FAIL due to the 2-session / 2-prompt
procedure violation**. This qualifier is outside the requested response
taxonomy but is necessary to avoid treating the combined evidence as a valid
one-session PASS.

The live evidence proves that strict direct tool JSON can become real Anthropic
`tool_use`, that Claude Code returns `tool_result` continuations, and that one
session completed three consecutive direct tool cycles without a network or
retry failure. It does not prove the bounded CODE_FENCE recovery path, because
no code fence occurred. It also does not independently prove the exact names of
all three tools in the second session because the safe CLI summary for that
session failed before retaining those names.

Parser semantics changed: **NO**.

Production files changed after live: **NO**.

Post-live validation before this report:

- required `node --check`: PASS;
- `git diff --check`: PASS;
- `npm.cmd test`: 174/174 PASS;
- port 9655: free.
