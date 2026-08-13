# CC-010 Tool Call Stability Fix

Date: 2026-08-13

Finding: `CC-010`

Working title: `TOOL_OUTPUT_FORMAT_CONSISTENCY_AND_RECOVERY`

Baseline main: `94f935527bfa8a2ba91fcabcfd7f3ad0fcd3b677`

Branch: `fix/cc-010-tool-call-stability`

Status: `CC_010_FIXED; CONTROLLED_LIVE_COMPLETE; PR_PENDING`

Baseline validation: `npm.cmd test` 202/202 PASS; the required five
`node --check` commands and `git diff --check` PASS.

## Scope and root-cause policy

CC-010 is a production fix for Claude Code tool-call format consistency and
bounded recovery. It does not start CC-006 or CC-008 and does not change the
documented CC-005 model-selection boundary.

The following facts are confirmed by the current implementation and manual
live evidence:

- the active DeepSeek output protocol requires exactly one strict JSON
  envelope, `{"tool_call":{"name":"tool_name","arguments":{}}}`, and no
  other text;
- historical client tool invocations are currently rendered into the
  upstream prompt with the output-like marker `[Tool Call]`;
- `[Tool Call]` and the canonical `tool_call` envelope are different formats;
- current structural diagnostics and recovery predicates look for the
  `tool_call` marker and do not recognize the exact `[Tool Call]` transcript;
- current recovery predicates do not cover every observed textual shape.

The following remains a hypothesis:

> Showing historical tool invocations as `[Tool Call]` may encourage the model
> to imitate that textual format on later turns.

This hypothesis is plausible but is not `ROOT_CAUSE_CONFIRMED`. It may only be
upgraded after controlled tests compare behavior after removing the format
inconsistency. The confirmed defect is the protocol-format inconsistency and
the missing bounded handling of observed malformed intent classes.

## Observed failures

- A textual transcript instead of a real call:

  ```text
  [Tool Call]
  name: Read
  arguments: {"file_path":"X"}
  ```

- Prose followed by a strict-looking JSON tool envelope.
- Multiple textual tool envelopes in one completion.
- Markdown or ordinary text suffixes after tool envelopes.
- Malformed tool arguments, including string/null arguments and broken JSON.
- An explicit local file path with `Read` available, followed by a claim that
  the file is unavailable instead of a `Read` request.

The first five items can provide structural malformed-output evidence. The
last item is also affected by model selection: prompt guidance can improve the
decision boundary but cannot guarantee that the model selects `Read`.

## Confirmed implementation gaps

### History/output format inconsistency

`server.js` currently serializes OpenAI, Anthropic, and Responses historical
assistant tool invocations as:

```text
[Tool Call]
name: Read
call_id: ...
arguments: {...}
```

At the same time, `toolPrompt()` and all correction prompts require:

```json
{"tool_call":{"name":"tool_name","arguments":{}}}
```

The model therefore sees two incompatible tool-request representations.
Tool-result continuation itself already uses a separate
`[Completed Tool Result]` data block and does not replay the full transcript.

### Missing `[Tool Call]` recognition

The current structural signals contain only a case-insensitive `tool_call`
substring marker. The exact historical marker `[Tool Call]` has a space and is
not recognized by the fenced, prefixed, or brace-delimited predicates.

### Suffix and multiple-envelope gap

The prefixed predicate requires malformed selected content to end with `}`.
It therefore does not cover the observed class containing prose, two or more
standalone strict-looking envelopes, and an arbitrary suffix.

### CC-001 is a different class

CC-001 brace recovery requires selected `content`, parser reason
`invalid_json`, a non-fenced response that starts and ends with braces, and a
`tool_call` marker. It does not cover textual `[Tool Call]`, multiple
standalone envelopes with surrounding text, or valid JSON rejected for a
strict shape reason.

### Valid-JSON malformed envelopes

Some structurally obvious tool envelopes are valid JSON but fail with parser
reasons other than `invalid_json`, for example `arguments_not_object`,
`invalid_tool_shape`, or `unexpected_envelope_keys`. The current format retry
predicates do not include those reasons. Truncated argument JSON remains an
`invalid_json` case but may not match the current fence/prefix/brace shapes.

## Non-Bridge observations

- language drift;
- stale Claude Code recap.

These observations remain outside CC-010 unless separate evidence identifies
a Bridge-controlled boundary.

## Fix strategy

### A. Remove format contamination without deleting history

The preferred implementation candidate is Option B: translate historical
assistant tool invocations into a neutral, explicitly historical data record
that cannot be mistaken for a new executable output. The record must retain
the tool name, call ID, and arguments, while avoiding both `[Tool Call]` and a
standalone canonical output envelope. A representative shape is:

```text
[Historical Assistant Action Data]
kind: tool_invocation_already_requested
name: Read
call_id: ...
arguments_data: {...}
[/Historical Assistant Action Data]
```

The exact label will be selected by regression tests. Stored
`SessionStore`/`session.toolCalls` semantics should remain unchanged.
Continuation must keep correlating real results by call ID, and exact-repeat
protection must keep using stored name/arguments rather than parsing this
display representation.

Option A, a canonical but explicitly historical representation, remains a
fallback only if tests show the neutral transcript loses required semantics.
It is less preferred because placing an executable-looking canonical envelope
in history can still create imitation pressure.

### B. Add narrow recovery classification around the strict parser

The strict acceptance path in `inspectToolCall()` will not be made
permissive. New classification belongs around the rejected parser result and
may trigger only one model correction.

Planned narrow classes:

- `textual_tool_transcript`: the selected output is the exact standalone
  `[Tool Call]` transcript shape, contains a bounded safe name present in the
  current allowlist, and is not fenced, inline-code, quoted, or documentation
  prose;
- `multi_tool_like`: selected output contains two or more standalone exact
  canonical envelope markers outside fenced/inline/quoted regions, with
  bounded allowed names, but no accepted strict call;
- `malformed_tool_envelope`: a whole-response JSON envelope, or a narrowly
  anchored truncated envelope, makes canonical tool intent structurally
  unambiguous, contains a bounded currently allowed name, and failed only a
  selected set of strict shape/argument reasons.

Classification will not extract executable objects, repair arguments, or
convert text directly into a tool call. The only path is:

```text
rejected malformed intent
-> one static correction prompt
-> strict inspectToolCallFromOutput()
-> one normal protocol tool event or final text
```

If the correction is invalid, the response becomes the existing generic safe
failure. The initial or corrective malformed payload, arguments, paths, and
reasoning must not be returned or logged.

### C. Preserve one-tool lifecycle

One completion may produce at most one executable tool request. A task needing
`Read A`, `Read B`, and `Glob C` must continue through three real client tool
cycles. Multiple malformed textual envelopes are only a correction trigger;
they are never locally expanded or executed.

### D. Add narrow tool-required guidance

`toolPrompt()` will say, in substance: when a task depends on information that
can only be obtained with an available tool, request the appropriate tool
first; do not claim that a file, project, or data is unavailable before trying
an appropriate available tool.

This is guidance, not deterministic forcing. CC-010 will not implement
Anthropic `tool_choice`, global `required`, prompt-derived forcing, or a
synthetic `ExitTool`.

### E. Keep one shared correction budget

All existing and new correction classes must share the current
`correctiveAttempted` budget:

```text
MAX_COMPLETIONS = 2
initial completion + at most one corrective completion
```

No request may chain brace, textual, multi-envelope, malformed-envelope,
reasoning-only, or repeated-tool corrections.

### External design references

The following repositories were reviewed only for architectural reference:

- <https://github.com/musistudio/llms>
- <https://github.com/musistudio/claude-code-router>
- <https://github.com/CJackHwang/ds2api>
- <https://github.com/NIyueeE/ds-free-api>
- <https://github.com/zenyxx-xd/FreeDeepseek-CC>

Useful ideas are canonical structured history, protocol-specific adapters,
tool-output anti-leak behavior, malformed fixtures, and bounded streaming
argument accumulation. Their permissive extraction/repair behavior is not a
design precedent for this Bridge.

## Safety invariants

- The Bridge never executes model tool calls; it only returns validated
  protocol tool events to the calling client.
- `inspectToolCall()` accepts only the existing canonical whole-response
  structure. Parser acceptance is not relaxed for CC-010.
- Textual `[Tool Call]`, multiple envelopes, and malformed envelopes are never
  converted directly into executable calls.
- No arbitrary JSON substring extraction, fuzzy extraction, regex-based
  execution, JSON5, `jsonrepair`, or local argument repair is added.
- Every name used by a correction classification is a bounded identifier and
  an exact member of the current request's allowed tool names.
- Unknown/unavailable names never become executable calls. Any safe rejection
  or correction must expose only the current safe allowlist.
- Code fences, inline-code examples, Markdown quotations, README/tutorial
  content, user quotations, ordinary prose, arbitrary JSON, and discussions
  of `[Tool Call]` must not trigger recovery.
- Historical tool semantics are retained: name, arguments, call/result
  correlation, continuation, and repeated-tool protection remain available.
- A completion yields at most one executable tool call; malformed multi-call
  text cannot bypass the client-owned tool lifecycle.
- All correction classes share one budget; maximum completions per Bridge
  request remains two.
- After an attempted malformed-intent correction fails, raw content,
  reasoning, arguments, paths, prompts, and results are suppressed in favor
  of the generic safe failure.
- Diagnostics remain opt-in and bounded. They may record a safe class/reason,
  correction-attempt boolean, safe allowed name, and completion count, but not
  raw model output, raw arguments, paths, prompts, reasoning, results, tokens,
  cookies, or authorization data.
- Existing OpenAI, Anthropic, Responses, streaming, session, call-ID,
  continuation, and exact-repeat semantics remain intact.
- CC-010 does not add `tool_choice`, `ExitTool`, DSML, direct parallel/multi
  tool execution, account rotation, or any CAPTCHA/2FA/limit bypass.

## Verification plan

### Unit tests

- Prove strict parser rejection for textual, multiple, suffixed, malformed,
  truncated, wrong-field, spilled-field, merged-field, and unknown-name
  fixtures.
- Prove the exact positive gates for each new recovery class.
- Prove negative controls for fenced examples, inline code, Markdown quotes,
  README/tutorial text, discussions, user quotations, arbitrary JSON, normal
  prose, unavailable names, and valid strict calls.
- Prove safe allowlist/name bounds, no local argument repair, generic failure,
  payload isolation, diagnostics-off behavior, and logger failure safety.
- Prove all correction orderings consume one shared budget and never exceed
  two completions.

### Integration tests

- Prove historical OpenAI, Anthropic, and Responses tool calls no longer use
  `[Tool Call]` while preserving names, arguments, IDs, and results.
- Prove continuation and exact-repeat protection after the representation
  change.
- Prove successful and failed recovery through all three adapters and buffered
  streaming without raw textual leakage.
- Prove an explicit synthetic local file path plus an advertised `Read`
  receives the new guidance, without claiming deterministic selection.
- Preserve all CC-001 regressions and CC-005 no-forcing semantics.

### Offline validation

Run `npm.cmd test`, the five required `node --check` commands, and
`git diff --check`. The test count must exceed the 202-test baseline.

### Controlled Claude live verification

Only after offline PASS and separate explicit user approval, run at most three
foreground Claude Code invocations against a disposable synthetic fixture:

1. `deepseek-chat` basic project read;
2. `deepseek-chat` explicit file read;
3. `deepseek-reasoner` Glob then Read.

Record the actual Claude Code and Node versions, strict tool lifecycle,
correction class/attempt, maximum completions, raw malformed exposure, and
model-selection failures separately from formatting failures. Do not repeat a
run for a better result.

## Implemented changes

### Neutral historical action records

OpenAI `tool_calls`, Anthropic `tool_use`, and Responses `function_call`
history now use one neutral non-output transcript:

```text
[Historical Action Record: already requested by the assistant]
tool_name_data: "Read"
correlation_id_data: "call_..."
arguments_data: {"file_path":"X"}
[End Historical Action Record]
```

The historical representation contains neither `[Tool Call]` nor a canonical
`"tool_call"` output envelope. Valid string arguments are parsed only for
safe historical serialization; they are not parsed into an executable call.
Tool name, arguments, correlation ID, and adjacent tool-result data remain in
the normalized prompt. Stored `session.toolCalls`, call-ID binding,
continuation, and exact-repeat protection are unchanged.

### Narrow rejected-output classification

`lib/tool_retry.js` now classifies only selected model `content` rejected by
the existing strict parser:

- `textual_tool_transcript` recognizes the exact standalone `[Tool Call]`,
  bounded `name:`, optional bounded `call_id:`, and single-line
  `arguments:` transcript;
- `multi_tool_like` recognizes at least two standalone exact canonical
  envelope lines with allowed bounded names, including the observed prose and
  suffix fixture;
- `malformed_tool_envelope` recognizes one standalone envelope with
  surrounding non-documentation text, an exact whole-response `tool_call`
  envelope rejected for a narrow strict-shape reason, or a narrowly anchored
  truncated canonical prefix.

These classifiers return only a structural class, an action, and at most one
safe allowed tool name. They do not return arguments and do not create a tool
call. Allowed classes receive one static correction prompt. A corrective tool
request must pass the unchanged `inspectToolCallFromOutput()` path; a
marker-free ordinary final text answer is also allowed. A second malformed or
tool-like response is replaced with the generic safe failure. Unknown names
and recognized unsafe/non-correctable envelope failures receive the generic
safe failure without execution.

The pre-existing CC-001 prefixed predicate was narrowed just enough to exclude
code/quote/documentation/example contexts and unavailable names while
preserving the confirmed arbitrary-prefix and `[调用 Name]` fixtures.

### Shared completion budget and anti-leak behavior

`server.js` now enforces `MAX_COMPLETIONS = 2` around every upstream
completion. Existing fenced, prefixed, brace, reasoning-only, repeated-tool,
and all CC-010 classes share the same `correctionAttempted` state. A failed
CC-010 correction is replaced with the existing generic safe failure; neither
the first nor second malformed output is returned. Buffered streaming emits
only the corrected protocol event or safe final failure.

### Guidance and diagnostics

`toolPrompt()` now tells the model to request an appropriate available tool
when the task depends on tool-only information and not to claim that a file,
project, or data is unavailable before attempting that tool. This remains
guidance and does not force tool selection.

Opt-in bounded response diagnostics now add:

- `tool_correction_attempted`;
- `tool_structural_class`;
- `mentioned_tool_name` (only a safe allowed name or `none` from the server);
- `completion_count`, capped at two.

The safe retry reasons include `textual_tool_transcript`, `multi_tool_like`,
and `malformed_tool_envelope`. Raw output, arguments, paths, prompts, and
reasoning are not added to diagnostics.

## Rejected alternatives

Rejected for this implementation:

- arbitrary JSON extraction;
- JSON5 or `jsonrepair`;
- global `tool_choice = required`;
- synthetic `ExitTool`;
- DSML migration;
- direct execution of multiple textual tool calls.

Canonical executable-looking history was also rejected in favor of the
neutral record because it would retain imitation pressure. Arbitrary regular
expression extraction and permissive alias parsing were rejected because they
could turn documentation or unrelated JSON into executable intent. Direct
conversion of `[Tool Call]` was rejected because only a fresh strict model
completion may create a Claude tool event.

## Regression coverage

The offline suite increased from 202 to 215 top-level tests. Added coverage
proves:

- neutral historical serialization with preserved name, arguments, ID, and
  result semantics for OpenAI, Anthropic, and Responses;
- strict rejection plus narrow classification of exact textual `[Tool Call]`;
- prose, multiple envelopes, one-envelope suffixes, and arbitrary suffixes;
- string/null arguments, unexpected envelope keys, `args`, spilled
  parameters, merged fields, truncated JSON, and unknown names;
- one corrective completion through the strict parser, generic failure after
  a failed correction, safe marker-free final text, and no local repair or
  multi-call extraction;
- negative controls for fences, inline code, documentation, README content,
  Markdown quotations, `[Tool Call]` discussion, quoted failures, normal
  prose, arbitrary JSON, tutorials, wrong top-level aliases, unavailable
  tools, and already-valid canonical calls;
- safe diagnostics, payload/path/reasoning suppression, and a hard maximum of
  two completions;
- buffered streaming suppression for textual malformed output;
- recovery through Anthropic, OpenAI, and Responses adapters;
- explicit-file guidance without forcing tool selection.

All pre-existing CC-001 fenced/prefixed/brace, correction-order, raw-payload
suppression, continuation, exact-repeat, adapter, and streaming regressions
remain passing. Existing CC-005 semantics remain unchanged: ordinary model
final text is not converted into a forced tool call.

## Controlled live results

The separately authorized controlled verification ran on 2026-08-13 against
implementation commit `9682cc0c2f08f7f93951d8c455927a950c14e0e7`.

### Environment and invocation boundary

- Node.js: `v24.12.0`.
- Claude Code immediately before the run: `2.1.228`.
- Claude Code immediately after the run: `2.1.231`.
- Exact version for each child process: not retained; the installed CLI
  changed across the test boundary, so both observed versions are recorded.
- Foreground Claude model invocations: 3.
- Harness retries: 0.
- Fresh session/config state: yes, independently for every invocation.
- Bridge diagnostics: enabled and reduced to bounded structural fields.
- Controlled Bridge: owned loopback listener on port 19655.
- Existing unrelated loopback listener on port 9655: left untouched.
- Fixture: `FreeDeepseekAPI-cc010-fix-fixture`, outside the production
  repository, containing synthetic data only.

The Claude stream was reduced in memory to tool-use names, tool-result count,
marker-presence booleans, result/error flags, and malformed-text flags. Raw
assistant text, prompts, arguments, tool results, and marker values were not
written to a log or retained in this report.

### Aggregate Bridge evidence

- `/v1/messages` requests: 6.
- Tool-capable requests: 6.
- Tool-result continuation requests: 3.
- Strict executable tool calls: 3, all `Read`.
- Claude tool-result events: 3.
- Requests reaching both `completion_completed` and `stream_parsed`: 6/6.
- Maximum upstream completions per Bridge request: 1.
- Corrections attempted: 0.
- CC-010 structural classes observed: 0.
- Safe failures: 0.
- Upstream/network errors: 0.
- Raw textual `[Tool Call]` visible: no.
- Raw `tool_call` JSON or other detected tool-like text visible: no.
- Neutral historical action record visible in the UI: no.

No malformed class occurred naturally, so live correction status is
`NOT_TRIGGERED`. The deterministic evidence for successful correction and
failed-correction suppression remains the 215-test offline suite. The live
run proves no raw exposure in these three outputs and no regression of direct
strict `Read -> tool_result` lifecycle.

### Run A — deepseek-chat basic project read

Requested lifecycle: `Read package.json -> Read README.md -> final text`.

Observed Bridge lifecycle:

```text
Read (content/accepted, strict, completion_count=1)
-> one real tool_result continuation
-> ordinary final text (content/invalid_json, no marker, completion_count=1)
```

- Claude exit: 0, terminal result non-error.
- Real `Read -> tool_result`: yes, once.
- Second requested `Read`: not selected.
- Requested marker values visible in final answer: no.
- Claim of file unavailability before a tool attempt: no.
- Formatting failure: no.
- Raw malformed exposure: no.
- Classification: `MODEL_SELECTION_PARTIAL`, not a formatting failure.

This run confirms one normal strict tool lifecycle but does not claim full
task completion because the model stopped before the second requested Read.

### Run B — deepseek-chat explicit file Read

The prompt contained the exact disposable fixture file path and advertised
`Read`.

Observed Bridge lifecycle:

```text
Read (content/accepted, strict, completion_count=1)
-> tool_result continuation
-> Read (content/accepted, strict, completion_count=1)
-> tool_result continuation
-> ordinary final text (content/invalid_json, no marker, completion_count=1)
```

- Claude exit: 0, terminal result non-error.
- `Read` selected: yes.
- Real tool-use/tool-result cycles: 2.
- False file-unavailable claim before attempting Read: no.
- Exact synthetic marker visible in the final answer: no.
- Formatting failure: no.
- Raw malformed exposure: no.
- Classification: `READ_SELECTED; FINAL_MARKER_NOT_OBSERVED`.

The exact-file selection improvement succeeded at the selection/protocol
boundary. Because the safe harness retained neither arguments nor result
payloads and the marker did not appear in final text, it does not claim that
the requested marker answer was semantically correct.

### Run C — deepseek-reasoner Glob then Read

Requested lifecycle: `Glob -> tool_result -> Read -> tool_result -> final`.

Observed Bridge lifecycle:

```text
ordinary final text (content/invalid_json, no tool-call marker,
completion_count=1)
```

- Claude exit: 0, terminal result non-error.
- `Glob` selected: no.
- `Read` selected: no.
- Tool result: none.
- Synthetic marker visible: no.
- Formatting failure: no.
- Raw textual or JSON tool output: no.
- Correction attempted: no, because no structural malformed intent existed.
- Classification: `MODEL_SELECTION_FAILURE`, not a formatting failure.

This is consistent with the documented CC-005/model-selection limitation and
does not establish a CC-010 recovery regression. The test was not repeated for
a better stochastic result.

### Live safety and cleanup

- Fixture source hashes unchanged after all invocations: yes.
- Fixture removed: yes.
- Temporary Claude config directories removed: yes.
- Owned Claude process roots closed: yes.
- Owned controlled Bridge stopped: yes.
- Controlled port 19655 free after cleanup: yes.
- Claude processes remaining after cleanup: 0.
- Production repository accessed by model tools: no.
- Foreground invocation count remained exactly 3: yes.

## Remaining limitations

- The model may still choose no tool.
- `deepseek-reasoner` may still produce malformed output after the single
  correction.
- The Bridge corrects at most once and then fails safely.
- Prompt guidance cannot guarantee explicit-file `Read` selection.
- Language drift is unrelated to this fix.
- Stale Claude Code recap is unrelated to this fix.
- The live run did not naturally produce a recognized malformed class, so
  bounded correction remains directly demonstrated offline rather than by a
  stochastic live trigger.
- The basic chat run stopped after one of two requested Reads; the reasoner
  run selected no tool; and the explicit-file run did not surface the expected
  marker in final text. These are recorded separately from formatting and raw
  exposure evidence.

## Final status

Implementation and offline verification: PASS. Post-live `npm.cmd test` is
215/215 PASS; all five required `node --check` commands and
`git diff --check` PASS.

Controlled live success bar: PASS for CC-010. No raw textual malformed output
was exposed; all observed valid tool requests used the strict Claude
tool-use/tool-result lifecycle; all Bridge requests used one completion; and
there was no formatting failure. A recognized malformed class did not occur
naturally, so neither a live correction nor live generic failure was needed.

`BRIDGE_DEFECT_FIXED = YES`

`CC010_CLASSIFICATION = CC_010_FIXED`

Further CC-010 production change required before PR: NO.

The hypothesis that historical `[Tool Call]` representation caused imitation
pressure remains unconfirmed because this was not an A/B model experiment and
no malformed class recurred. Model-selection failures remain a separate
limitation. PR review and merge decision are pending. No CC-006 or CC-008 work
has started.
