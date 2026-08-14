# CC-012 Tool Call Reliability Hardening

Date: 2026-08-14

Finding: `CC-012 TOOL CALL RELIABILITY HARDENING`

`BASELINE_MAIN = 64fcba034b6b306bfb856af3c173c8ec56325988`

`CLAUDE_VERSION = 2.1.231 (Claude Code)`

`MANUAL_GLOB_RAW_EXPOSURE = YES`

`MANUAL_READ_RAW_EXPOSURE = YES`

`MANUAL_BASH_RAW_EXPOSURE = YES`

`MANUAL_INTERNAL_PROMPT_EXPOSURE = YES`

`FALSE_PROJECT_STATE_AFTER_DROPPED_TOOL = YES`

`MANUAL_FAILURE_REPRODUCED = NO; the stochastic manual event did not recur in natural pre-fix Claude runs; a deterministic current-main replay reproduced the equivalent Bridge leak and client-visible shape`

`EXACT_OUTPUT_SHAPE_CLASS = FIRST COMPLETION REASONING-ONLY -> SHARED CORRECTION CONSUMED -> SECOND COMPLETION PROSE + STANDALONE ALLOWED TOOL ENVELOPE -> FINAL CLASSIFIER CORRECTABLE`

`CURRENT_ALLOWLIST_PRESENT_DURING_FAILURE = YES`

`FINAL_CORRECTABLE_ACTION_DROPPED = YES`

`FIRST_FAILING_BOUNDARY = FINAL PROTOCOL DECISION -> CORRECTABLE ACTION NOT RESOLVED -> ORDINARY FINAL TEXT SERIALIZATION`

`ROOT_CAUSE = server.js handled final contain_only but ignored final correctable when no strict tool call remained; the raw latest completion could therefore fall through as assistant text after the one shared correction was consumed or when earlier narrow predicates missed the shape`

`REGRESSION_TEST_ADDED = YES`

`REGRESSION_TEST_FAILS_BEFORE_FIX = YES; 228/230 passed and both new CC-012 tests failed on the baseline implementation`

`REGRESSION_TEST_PASSES_AFTER_FIX = YES`

`STRICT_PARSER_CHANGED = NO`

`HISTORICAL_ALLOWLIST_RESTORED = NO`

`MAX_COMPLETIONS = 2`

`FUZZ_CASES = 50/50 PASS`

`WINDOWS_CASES = 4/4 PASS`

`ANTHROPIC_STREAMING = PASS`

`OPENAI = PASS; streaming and non-streaming`

`RESPONSES = PASS; streaming and non-streaming`

`CC010 = PASS`

`CC011 = PASS`

`LIVE_FRESH_SESSIONS = 10 completed`

`LIVE_MULTI_TURN_SESSIONS = 6 completed`

`LIVE_USER_TURNS = 40`

`LIVE_TOOL_TURNS = 28; 27 non-error results and one error result followed by a successful replacement Read`

`GLOB_INTENTS = 5`

`GLOB_EXECUTIONS = 5`

`GLOB_CORRECTIONS = 1`

`GLOB_RAW_EXPOSURES = 0`

`READ_INTENTS = 16`

`READ_EXECUTIONS = 16; 15 non-error and one error result`

`READ_CORRECTIONS = 3`

`READ_RAW_EXPOSURES = 0`

`GREP_INTENTS = 5; four emitted calls plus one recognized malformed intent whose correction returned final text`

`GREP_EXECUTIONS = 4`

`GREP_CORRECTIONS = 1; correction completed as marker-free final text rather than a tool call`

`GREP_RAW_EXPOSURES = 0`

`BASH_INTENTS = 3`

`BASH_EXECUTIONS = 3`

`BASH_CORRECTIONS = 0`

`BASH_RAW_EXPOSURES = 0`

`STRICT_TOOL_CALLS = 24`

`CORRECTED_TOOL_CALLS = 4`

`SAFE_FAILURES = 38 Bridge request outcomes; all corresponded to empty upstream completions with structural class none, and none exposed raw protocol or a visible generic failure in the completed Claude turns`

`FINAL_TEXT_RESPONSES = 21 Bridge request outcomes`

`RAW_PROTOCOL_EXPOSURES = 0`

`PRIVATE_PROMPT_EXPOSURES = 0`

`UNAUTHORIZED_EXECUTIONS = 0`

`UNSUPPORTED_PROJECT_STATE_CLAIMS = 0`

`MODEL_SELECTION_FAILURES = 2 ordinary final-text turns without a tool; 16 additional no-tool turns ended after empty upstream completions and are tracked separately`

`UPSTREAM_ERRORS = 2 transient connection timeouts during one otherwise successful multi-turn chain`

`NETWORK_ERRORS = 2`

`RATE_LIMIT_ERRORS = 0`

`FRESH_SESSION_TOOL_INTENTS = 9; eight emitted tool calls plus one corrected-to-final-text intent`

`FRESH_SESSION_MALFORMED = 3`

`FRESH_SESSION_MALFORMED_RATE = 33.3%`

`LONG_SESSION_TOOL_INTENTS = 20`

`LONG_SESSION_MALFORMED = 2`

`LONG_SESSION_MALFORMED_RATE = 10.0%`

`PROMPT_AB_RESULT = CURRENT A: STRICT 8/8, MALFORMED 0/8, EMPTY 0/8; CANDIDATE B: STRICT 3/8, MALFORMED 0/8, EMPTY 5/8; candidate rejected and production prompt unchanged`

`REQUEST_BYTES_IDENTICAL = YES`

`HARNESS_RETRIES = 0`

`CC012_CLASSIFICATION = CC_012_FIXED_WITH_STRESS_PASS`

## Executive summary

CC-012 confirmed a Bridge-owned control-flow defect beyond CC-010 and
CC-011. The current allowlist could contain the requested tool, the final
protocol classifier could identify the output as `correctable`, and the
strict parser could correctly reject the non-canonical response, yet the
server only acted on the classifier's `contain_only` result. A final
`correctable` result with no accepted tool call could therefore be serialized
as ordinary assistant text.

The deterministic baseline reproduction used the same user-visible class as
the manual `Glob` failure: prose followed by a standalone canonical-looking
tool envelope. A hidden reasoning-only first completion consumed the single
correction budget; the second completion remained `correctable`; the baseline
server returned it raw. A second case demonstrated that a zero-width suffix
could reach the final classifier without any earlier CC-010 predicate. Both
tests failed before the production fix and pass afterward.

The fix centralizes the final decision into exactly three terminal outcomes:

```text
strict accepted call -> real protocol tool call
correctable intent -> one correction when budget remains, otherwise containment
contain-only/private intent -> generic safe containment
ordinary response -> final text
```

There is no raw-protocol fallthrough. Tool execution remains authorized only
by the current HTTP request's allowlist and by a fresh strict parse. The strict
parser, correction budget, tool prompt, continuation correlation, and
client-owned execution model were not relaxed.

The post-fix live matrix completed ten fresh Claude sessions, six independent
multi-turn sessions, forty user turns, and twenty-eight real tool lifecycles.
No raw protocol, private prompt, unauthorized execution, or unsupported claim
that the non-empty fixture was empty appeared. Five malformed intents were
recognized; four became real tool calls after one correction and one became
safe marker-free final text. The live success bar was met.

## Manual user evidence

The user confirmed intermittent raw protocol exposure for `Glob`, `Read`, and
`Bash`, plus an earlier echo of the private `TOOL REQUEST SYSTEM` text. In the
new `Glob` case the requested filesystem action did not run. A later turn then
claimed that a real non-empty project was empty. The same pattern recurred for
`Bash`: prose and a visible envelope appeared, but no Claude tool runtime event
followed.

These observations establish an agent-state failure, not a cosmetic rendering
issue. When the Bridge emits tool intent as text, Claude receives neither a
tool request nor a real result, while the upstream conversation may continue
as if useful project state had been established.

The report retains only the aliases `WINDOWS_REAL_PROJECT_PATH` and
`WINDOWS_CYRILLIC_FIXTURE_PATH`. It does not retain the user's path, raw tool
arguments, prompt, reasoning, inventory, session identifiers, credentials,
cookies, or forensic completion payloads.

## Reproduction methodology

Pre-fix investigation used two complementary paths.

First, six fresh controlled Claude Code sessions ran against a disposable
read-only Node.js fixture whose path contained Cyrillic and a space. An owned
loopback observer forwarded the original request Buffer to an unchanged
Bridge, and a local untracked wrapper captured the reconstructed completion
shape after `parseStream()`. Those natural runs produced eleven real tool
results and did not stochastically reproduce the raw exposure. They did prove
that the allowlist remained present through continuations and that strict tool
markers were often split across DeepSeek fragments while the existing tool
buffer kept them hidden.

Second, a deterministic current-main HTTP reproduction replayed the exact
observable class with a current `Glob` allowlist. Completion one contained
reasoning only and consumed the shared correction. Completion two contained
prose plus the standalone allowed envelope. The baseline response contained
the raw protocol, no `tool_use`, and no safe failure. This supplied a stable
failing boundary even though the stochastic remote output did not recur in
the small pre-fix sample.

`REQUEST_BYTES_IDENTICAL = YES` for the controlled observer topology. Harness
retries were always zero.

## Exact output structural shape

The deterministic failing sequence was:

```text
request tools: current Glob allowlist present

completion 1:
  content = empty
  reasoning = planning without a strict call
  result = one existing reasoning-only correction

completion 2:
  content = prose + newline + standalone allowed Glob envelope
  reasoning = empty
  strict parser = rejected because the envelope is not the whole response
  final protocol action = correctable
  correction budget = already used
```

The baseline final fallback handled only `contain_only`. It did not turn this
remaining `correctable` action into containment, so the rejected content
became assistant text. The same gap was independently reached with a
prose/envelope response containing an invisible trailing character: earlier
narrow predicates did not match, the final classifier returned `correctable`,
and the baseline did not start the available correction.

Natural pre-fix Claude runs did not capture the stochastic manual payload, so
the report does not claim a verbatim DeepSeek replay. It records a
deterministic reproduction of the exact Bridge fallthrough and client-visible
shape.

## First failing boundary

The failing order on the baseline was:

```text
inspectToolCallFromOutput() -> no strict call
CC-010 recovery path -> skipped or budget already consumed
classifyToolProtocolOutput() -> action=correctable
server final fallback -> checks only action=contain_only
adapter serialization -> raw protocol emitted as ordinary text
```

`classifyToolProtocolOutput()` was therefore correctly signaling tool intent.
The first wrong boundary was its caller's incomplete handling of the decision,
not the strict parser, the Claude adapter, or the runtime.

## Current control-flow defect

Before the fix, `hasExecutableTools` correctly controlled execution and full
tool buffering. CC-011 had also added allowlist-independent containment.
However, the final server block reduced the protocol classifier to one
question: whether its action was `contain_only`. It did not resolve
`correctable` at all.

This created a forbidden fourth state:

```text
recognized protocol
AND no final strict tool call
AND no final safe failure
AND final text still contains protocol
```

The defect was intermittent because earlier CC-010 predicates caught common
fenced, prefixed, brace, malformed-envelope, transcript, and reasoning-only
forms. It appeared only when the final classifier recognized a shape those
paths missed, or when a previous correction had already consumed the shared
budget.

## Regression test

The first CC-012 commit was deliberately test-only:

`fdece62e6bde4d4951af2ebc351f2991930e9b19` —
`test: reproduce CC-012 tool protocol leak`

It added two integration regressions:

- an allowed protocol intent after the shared correction budget is spent may
  become only a real tool call or a generic safe failure, never raw text;
- a final allowed `correctable` intent with unused budget must receive exactly
  one strict correction, not become ordinary text.

On the baseline implementation the suite reported 228/230 passing and these
two tests failed. No production code was changed in that commit.

After the production change, both pass and are part of the 299/299 suite.

## Root cause

The root cause was not permissive parsing, Windows path repair, loss of the
current allowlist, or the Claude serialization adapter. It was an incomplete
final decision state machine in `server.js`:

```text
contain_only -> handled
correctable -> ignored
```

In addition, the final decision could inspect an already substituted safe
failure rather than the latest raw completion. That could hide the structural
reason the request reached the final fallback. The implementation now retains
the latest completion only for final structural classification; it does not
log or expose that payload.

The containment classifier also had narrow stream-marker blind spots around
zero-width characters and partial private markers. Those did not authorize a
tool but could make streaming containment inconsistent with final
classification. The fix normalizes only the bounded invisible characters for
protocol recognition and maps marker positions back to the original stream.

## Implementation

Production commit:

`a05568681565acaf57365888702bd3e048bf0225` —
`fix: harden tool-call decision pipeline`

The implementation adds a unified `decideToolProtocolOutput()` result:

- `tool_use`: keep the strict accepted call;
- `correct`: use the existing one shared correction when the current allowed
  name is safe and budget remains;
- `contain`: suppress the protocol and return the existing generic failure;
- `final_text`: preserve ordinary text.

After a correction, the result is strictly inspected again and passed through
the same final decision. A remaining `correctable` intent is contained because
the correction budget is already spent. An unknown or unavailable name is
always contained. A private prompt marker always has containment priority,
even when content would otherwise be a valid current tool call.

No arguments are extracted into an executable call by the containment layer.
A real tool call is created only by `inspectToolCallFromOutput()` after a
fresh canonical whole-response output and exact current-allowlist membership.

Diagnostics add only bounded enums and a safe allowed tool name. They retain
no output, arguments, path, prompt, reasoning, or inventory.

## Security invariants

All existing security boundaries remain true:

- execution membership uses only the current request allowlist;
- no historical or session tool inventory is restored;
- the strict whole-response parser is unchanged;
- no JSON5, `jsonrepair`, fuzzy JSON extraction, local slash repair, or regex
  argument execution was added;
- private `TOOL REQUEST SYSTEM` output is never executable;
- unknown and wrong-case names never execute;
- correction prompts contain only safe current tool names, never rejected
  arguments;
- one request performs at most two upstream completions;
- the Bridge continues to return tool requests to Claude and never executes
  tools itself.

## Deterministic fuzz matrix

The nested CC-012 matrix covers fifty structural cases and passes 50/50. It
includes:

- strict JSON and strict XML;
- prose separated by newline, space, no separator, CRLF, tabs, NBSP, and
  multiple newlines;
- leading/trailing whitespace, prose suffixes, and prose on both sides;
- zero-width characters before and inside the marker;
- fenced, inline-code, documentation, README, quote, and previous-error
  negatives;
- `[Tool Call]`, two envelopes, truncated envelopes, XML, argument string,
  argument array, and empty arguments;
- allowed, unknown, wrong-case, and cross-channel tool names;
- content-only, reasoning-only, and content-priority combinations;
- marker, name, and opening-brace fragment reconstruction;
- prefixes and suffixes above the strict parser byte limit;
- full and partial private prompt markers;
- ordinary non-tool JSON;
- malformed Windows paths and budget-exhausted final decisions.

For every recognized non-strict intent the decision is either `correct` or
`contain`. Re-evaluating a correctable case with the correction budget already
used always produces `contain`.

## Windows path matrix

Four Windows-path cases pass:

1. a correctly escaped Cyrillic path with a space is accepted only as part of
   a strict current `Read` call;
2. a literal single-backslash Cyrillic path is recognized as correctable but
   never repaired locally;
3. a literal single-backslash Latin path follows the same rule;
4. the integration correction replaces rejected path-bearing output with a
   fresh strict model response without copying the rejected path.

With no current `Read`, the same protocol form is containment-only. Windows
backslashes never grant execution rights.

## Streaming verification

Requests with executable tools retain full buffering until the final tool
decision. Split tests cover the marker across fragments, the `tool_call` name
across fragments, and the opening brace separately. No text delta containing
the real protocol is emitted.

Fresh no-tool streams remain incremental. The bounded quarantine now detects
zero-width-separated and split protocol markers through shared containment
helpers. Ordinary no-tool text still streams; once a strong marker completes,
the marker and following raw protocol are held for final containment.

Anthropic streaming emits the normal `tool_use` block lifecycle after strict
acceptance or successful correction. No Anthropic `text_delta` contains a
recognized live tool envelope. The same core decision is exercised by OpenAI
Chat Completions and Responses streaming.

## Anthropic verification

Anthropic `/v1/messages` passes both streaming and non-streaming correction
and containment tests. The agentic integration test performs:

```text
malformed allowed Glob
-> one correction
-> Anthropic tool_use
-> synthetic real result
-> strict Read tool_use
-> synthetic real result
-> final answer
```

There is no dropped intent, fake result, raw protocol, or third completion.

## OpenAI verification

OpenAI `/v1/chat/completions` passes streaming and non-streaming cases through
the shared final decision. Corrected calls are emitted as `tool_calls`; raw
rejected content and invisible marker characters are absent. Existing OpenAI
continuation and repeated-tool coverage remains passing.

## Responses verification

Responses `/v1/responses` passes streaming and non-streaming cases through the
same core decision and emits `function_call` protocol events only after strict
acceptance. Existing Responses continuation behavior remains passing.

## CC-010 regression

`CC010 = PASS`. Existing fenced, prefixed, brace, textual transcript,
multi-envelope, malformed envelope, reasoning-only, repeated-tool,
continuation, diagnostics, streaming, and shared-budget tests all pass. An
unknown name retains the original CC-010 `malformed_tool_envelope` diagnostic
instead of being overwritten by the new final classifier.

The strict parser and CC-010 correction prompts were not relaxed. Raw rejected
arguments remain absent from prompts, responses, and diagnostics.

## CC-011 regression

`CC011 = PASS`. No-tool protocol containment, private prompt containment,
large prompt echo handling, current-request-only authorization,
`protocolContextSeen`, and normal incremental no-tool streaming all remain
covered. A private marker overrides an otherwise strict allowed tool call and
can only produce safe containment.

## Live stress methodology

The post-fix stress topology was:

```text
Claude Code 2.1.231
-> owned exact-byte loopback observer
-> fixed local Bridge
-> DeepSeek Web
```

Every session used `deepseek-chat`, a fresh isolated Claude configuration, and
a disposable synthetic Node.js fixture under
`WINDOWS_CYRILLIC_FIXTURE_PATH`. The fixture contained a README, package
metadata, two source files, configuration, and a test, so a claim that it was
empty could be rejected independently. Mutation and web tools were disabled.

Claude Code version was recorded immediately before each session. The ten
fresh sessions used natural project-discovery, read, search, and recheck
tasks. Six independent five-turn sessions exercised both natural continuation
and explicit read-only `Glob`, `Read`, `Grep`, and harmless `Bash` selection.
No prompt requested or supplied JSON.

Harness retries were zero. One initial attempt was aborted by a harness process
timeout before the final runner was switched from a shell wrapper to the
direct Claude executable. A second initial attempt was invalid because the
sandbox denied network access before any DeepSeek completion. Neither is
included in the ten completed fresh sessions. Both owned fixtures and process
trees were cleaned before the valid matrix.

During one completed multi-turn chain, two transient DeepSeek connection
timeouts occurred before the chain completed five strict tool lifecycles.
They are retained as `UPSTREAM_ERRORS = 2` and `NETWORK_ERRORS = 2`; there were
no rate-limit errors. The remaining completed sessions had no upstream error.

Raw completion capture was untracked and limited to the synthetic fixture.
Tracked evidence contains only structural classes, safe tool names, counts,
booleans, versions, and terminal outcomes.

## Fresh-session results

Ten fresh sessions completed ten user turns. They produced nine recognized
tool intents and eight real tool lifecycles. Five sessions selected tools;
two produced ordinary final text without tool selection; three were affected
by empty upstream completions rather than a protocol decision.

Three of the nine tool intents were initially malformed (33.3%). Two were
successfully corrected into real calls. The third received one correction and
then a marker-free final answer. None exposed raw protocol or a private prompt.

## Multi-turn results

Six independent five-turn sessions completed thirty user turns and twenty
real tool lifecycles. Two of the twenty intents were initially malformed
(10.0%); both were corrected into real `Read` calls.

One `Read` runtime result reported an error and was followed by a successful
replacement `Read` within the same turn. This is counted as one errored tool
result and does not indicate a dropped intent. All session invocations reached
a successful terminal Claude result.

The long-session malformed rate was lower than the fresh-session rate in this
sample. There is no evidence here that stateful session length made tool
formatting worse.

## Tool-specific statistics

| Tool | Intents / tool uses | Runtime results | Corrections | Raw exposure |
| --- | ---: | ---: | ---: | ---: |
| Glob | 5 | 5 non-error | 1 | 0 |
| Read | 16 | 15 non-error, 1 error | 3 | 0 |
| Grep | 5 | 4 non-error | 1 | 0 |
| Bash | 3 | 3 non-error | 0 | 0 |

The safe `Bash` commands were read-only. No destructive command or filesystem
mutation was requested.

## Malformed-rate statistics

Across the completed matrix:

```text
recognized tool intents = 29
emitted tool uses = 28
strict tool calls = 24
corrected tool calls = 4
recognized malformed intents = 5
fresh malformed rate = 3 / 9 = 33.3%
long-session malformed rate = 2 / 20 = 10.0%
```

Four malformed intents became strict tool calls after one correction. One
became a safe marker-free final answer. There were no visible generic protocol
failures in the forty completed Claude turns.

The Bridge also recorded thirty-eight request-level `safe_failure` outcomes.
Every one had zero content bytes, zero reasoning bytes, zero fragments,
`structural_class=none`, and `completion_count=1`. These were empty upstream
outputs, not recognized tool intents and not consequences of the new final
containment decision. Sixteen Claude turns ended empty after those outputs.
This remains an upstream reliability limitation worth monitoring, but it is
separate from CC-012 protocol leakage.

## Prompt A/B

Because the live malformed rate was non-zero, a bounded direct DeepSeek A/B
compared eight fresh completions per arm. It executed no tool and used zero
harness retries.

| Prompt | Strict | Malformed | Final text | Empty |
| --- | ---: | ---: | ---: | ---: |
| A: current `toolPrompt()` | 8 | 0 | 0 | 0 |
| B: extra repeated JSON-only prohibition | 3 | 0 | 0 | 5 |

The candidate made output substantially less reliable by producing five empty
completions. It was rejected. The production tool prompt was not changed;
the root fix remains control-flow hardening rather than prompt accumulation.

## Remaining limitations

- DeepSeek can still produce malformed tool intent; the Bridge corrects at
  most once and never promises deterministic model formatting.
- A malformed completion may become marker-free final text after correction;
  it is safe but may represent model-selection loss.
- Empty DeepSeek completions occurred frequently in part of the stress run and
  produced empty terminal Claude turns. This is not raw-protocol exposure, but
  it remains an upstream reliability limitation outside the proven CC-012
  root cause.
- Two transient connection timeouts occurred. They were not Bridge parser or
  containment failures.
- A real tool runtime may return an error; continuation can recover, as the
  observed replacement `Read` did.

## Final classification

The required post-fix bar is satisfied:

```text
completed fresh sessions >= 10: YES (10)
completed multi-turn sessions: 6
real tool turns >= 25: YES (28)
deterministic fuzz cases: 50/50 PASS
raw protocol exposures: 0
private prompt exposures: 0
unauthorized executions: 0
unsupported project-state claims: 0
max completions per request: 2
CC-010 regression: NO
CC-011 regression: NO
```

`CC012_CLASSIFICATION = CC_012_FIXED_WITH_STRESS_PASS`

`PRODUCTION_FIX_REQUIRED = NO; fixed implementation is ready for reviewed PR and merge`
