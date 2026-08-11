# Final branch review

Date: 2026-08-11.

Base: `main` at `1ca1174ba54eb9853919bd1e0accb7af7849fa3b`.

Reviewed head: `eaebac9f358522cbdbbbf13867a07386de00ffb2`.

Branch: `fix/tool-parser-rejection-diagnostics`.

Ahead / behind `origin/main`: 8 / 0. `origin/main` is an ancestor of the
reviewed head, so there is no main divergence or rebase requirement.

## Scope and commit review

The branch is a coherent diagnostics-and-recovery change. Its eight commits,
in order, add safe parser rejection diagnostics, record the initial live
rejection, add the bounded fenced correction, record three historical live
runs, add the bounded prefixed-tool correction, and record the final post-fix
live run. The five evidence-only commits change documentation only. The later
recovery commits intentionally build on the diagnostics and shared retry
state; no temporary or debug implementation remains in the final diff.

| Commit | Purpose | Production / evidence review |
| --- | --- | --- |
| `0c75ace` | Add parser rejection diagnostics | Parser and diagnostics foundations plus tests; later retry commits consume its inspection result. |
| `e9ecd71` | Record initial parser-rejection live evidence | Documentation only; establishes the pre-fix `CODE_FENCE` shape. |
| `380d37c` | Add one fenced-tool correction | Retry/orchestration/diagnostic changes plus tests; extended later by the prefixed path. |
| `9ca95cb` | Record first fenced-retry live run | Documentation only; explicitly invalid as one-session acceptance. |
| `4e3548f` | Record clean rerun | Documentation only; explicitly stopped before the tool-capable task by the old PID-count guard. |
| `ef4af29` | Record process-tree live run | Documentation only; valid invocation boundary and pre-fix `PREFIXED_TOOL_LIKE` evidence. |
| `54791a4` | Add one prefixed-tool correction | Narrow predicate, shared orchestration/diagnostics, and focused tests; preserves the fenced path. |
| `eaebac9` | Record final post-fix live run | Documentation only; direct strict `Glob -> Read -> Grep` and continuation PASS, retries `NOT_TRIGGERED`. |

Overlaps are intentional layering, not duplicate implementations. Final-state
searches found no temporary instrumentation from any intermediate commit.

Production files:

- `lib/tool_parser.js`;
- `lib/tool_retry.js`;
- `lib/tool_diagnostics.js`;
- `server.js`.

Test file: `tests/unit.test.js`.

Evidence and implementation documentation consists of the eight new files
under `docs/agentic-fix/` in the branch diff. There are no dependency,
package-lock, client, session, continuation, stream, network, PoW, or WASM file
changes.

## Parser verdict

**PASS — acceptance semantics are unchanged.** The final parser still parses
only a complete trimmed strict JSON envelope or the already-supported complete
XML envelope. It does not strip Markdown or prefixes, find JSON substrings,
repair malformed JSON, or use regex extraction. Fenced and prefixed fixtures
remain `invalid_json`.

Allowlist enforcement, identifier validation, plain-object arguments,
dangerous-key rejection, nesting limits, input/argument byte limits, and
content-before-reasoning source priority are preserved. The new inspection
functions share the same acceptance path and add precise rejection reasons and
safe structural metadata only.

## Retry and correction budget verdict

**PASS.** Final priority is: accepted strict call, `CODE_FENCE` correction,
`PREFIXED_TOOL_LIKE` correction, reasoning-only correction, then exact
completed-tool repetition protection.

`shouldRetryFencedToolResponse()` is limited to selected content rejected as
`invalid_json` that starts with a code fence and contains a tool-call marker.
`shouldRetryPrefixedToolResponse()` additionally requires a non-fenced selected
content source that does not start with `{`, ends with `}`, and contains the
marker. It is not a general `invalid_json` retry.

All paths share `correctiveAttempted`. A request can perform at most one
correction completion and therefore at most two upstream completions total:
the initial completion plus one correction. After any correction, the
reasoning and repeated-tool branches cannot request another completion. An
exact repeated call after a format correction is handled by the existing safe
failure without a third completion.

Correction output is passed through the unchanged
`inspectToolCallFromOutput()` path and then through the existing protocol
adapters. No parser bypass or handcrafted protocol tool call exists. If a
fenced or prefixed correction remains malformed, its content and reasoning are
replaced by the generic `TOOL_RETRY_FAILURE_MESSAGE`; diagnostics report
`safe_failure`, and no third completion occurs.

## Session, protocol, and streaming verdicts

**Session and continuation: PASS.** `SessionStore`, `SessionResolver`, identity
priority, anonymous isolation, call-ID binding, and tool-result continuation
files are unchanged. Corrections receive the same upstream session object.
Focused integration tests cover fenced and prefixed `Read` calls after a real
tool result and verify linked-session continuity.

**Protocols: PASS.** The public OpenAI Chat Completions, Responses, Anthropic
Messages, and Anthropic token-count endpoints are unchanged. Accepted calls
use the existing OpenAI, Anthropic, or Responses adapter path. Protocol and
streaming integration tests exercise normal tool events after correction.

**Streaming: PASS.** `lib/api_stream.js` is unchanged. Tool-capable streams use
`bufferForTools`, which suppresses upstream deltas until parsing and retry
classification are complete. A successful correction therefore emits only the
validated protocol tool sequence; a safe failure emits only the generic final
text. Initial malformed output cannot be streamed before the correction
decision, and `stream.finish()` is invoked once.

## Diagnostics and security verdict

**PASS.** Structured logs use fixed allowlists for parser source/reason,
retry reason, outcome, upstream stages, routes, protocols, model and tool-name
syntax. Permitted retry reasons are `none`, `reasoning_only`, `code_fence`,
`prefixed_tool`, and `repeated_tool`.

Rejected-output diagnostics contain only byte counts and structural booleans.
They do not contain raw content, reasoning, prompts, tool arguments/results,
paths, URLs, credentials, authorization/cookie values, full session/call IDs,
or content hashes. Correction prompts contain static instructions plus bounded
identifier-only allowed tool names and never copy the rejected payload.

`request_ref` is a random 16-character lowercase hexadecimal value. It is used
only for local diagnostic correlation, is not passed to the upstream
completion, and is not returned to API clients. Session correlation values are
process-salted, bounded local references. Logger failures remain observational,
and diagnostics remain opt-in.

Targeted searches found no added production `TODO`, `FIXME`, `HACK`, `DEBUG`,
`debugger`, `console.log`, `console.error`, or payload-logging pattern.

## Network and compatibility verdict

**PASS.** Network retry policy, timeouts, 429/5xx behavior, remote-session
creation, PoW, WASM loading/cache, and stream reading are unchanged. No runtime
dependency was added. Public endpoint names and protocol adapters remain
compatible; no breaking API change was found.

## Test verdict

**PASS.** The added tests inspect real parser results and HTTP/protocol output,
mock upstream completion counts, session object continuity, diagnostics and
client responses. They are not limited to self-referential predicate tests.
Coverage includes strict acceptance and rejection reasons, exact negative
predicate gates, fenced and prefixed success/failure, shared correction budget,
reasoning and repeated-tool regressions, continuation, all protocol adapters,
stream buffering, diagnostics disabled, throwing loggers, payload isolation,
ordinary final text, and malformed shapes outside the narrow predicates.

Final validation:

- `npm.cmd test`: 185/185 PASS;
- required `node --check` commands: PASS;
- `git diff --check`: PASS.

## Live evidence summary

The historical reports are evidence with different boundaries and are not all
acceptance runs:

1. The initial pre-fix live run observed the `CODE_FENCE` structural shape.
2. The first fenced-retry run started two sessions and two prompts, so it is
   not one-session acceptance evidence.
3. The next run was stopped by the incorrect PID-count guard after a tools=0
   discovery request, so it did not reach the task path.
4. The valid process-tree run reached the tool task and observed the pre-fix
   `PREFIXED_TOOL_LIKE` structural shape, but no real tool executed.
5. The final post-fix process-tree run passed the direct strict tool flow:
   `Glob -> tool_result -> Read -> tool_result -> Grep -> tool_result -> final
   response`, with one foreground invocation, one prompt, one Bridge client
   reference, no network error, and no raw tool JSON shown to the client.

Both observed malformed formats have focused offline recovery coverage. The
final post-fix live run returned valid strict calls, so neither format retry was
re-triggered. This is a known limitation of nondeterministic live evidence, not
a failure and not a reason to repeat live tests until a malformed shape appears.

## PR scope and readiness

The proposed PR meaning is coherent: improve strict tool-call diagnostics and
recover two observed malformed DeepSeek tool-call formats without weakening
the parser. Diagnostics establish the narrow recovery evidence, both recovery
paths share one safety budget, and the evidence commits document why the
predicates exist and what was and was not validated live.

Final readiness: **READY_FOR_PR**.
