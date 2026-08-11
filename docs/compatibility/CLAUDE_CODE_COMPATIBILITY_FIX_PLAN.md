# Claude Code ↔ FreeDeepseekAPI Compatibility Fix Plan

Date: 2026-08-11

Source audit: `docs/compatibility/CLAUDE_CODE_FULL_AUDIT.md`

Bridge baseline: `b49bf745fd6cbc70bb008eb7e90c58edfccd9d14`

Audit branch: `audit/claude-code-full-compatibility`

Status: **PLAN ONLY — no implementation has started**

## Objective and constraints

The objective is to close only the compatibility gaps proven by findings
CC-001 through CC-009. This plan does not infer support from tool presence and
does not add speculative capabilities.

The following invariants apply to every implementation phase:

- keep whole-response tool parsing strict;
- do not strip prefixes, extract JSON substrings, use fuzzy/regex JSON
  recovery, or accept malformed output directly;
- use model correction only for a narrowly evidenced structural class;
- share one correction budget across all recovery paths;
- permit at most an initial completion plus one correction completion;
- never copy rejected output, reasoning, arguments, results, prompts, paths,
  URLs, credentials, or identifiers into a correction prompt or diagnostic;
- keep network retry, PoW, WASM, session identity, call-ID binding, streaming,
  and protocol adapters unchanged unless a finding specifically proves that
  layer is responsible;
- do not modify Bridge for a Claude Code client/runtime failure until the
  failing boundary is isolated;
- validate each phase offline before one bounded live check; do not repeat live
  calls until a stochastic malformed response appears.

No P0 issue was found. Core chat and filesystem reads work. The highest
priority is CC-001 because it occurred five times, exposed raw tool-like text,
and blocked multiple core flows.

## Dependency order

1. **Phase 1 — safe observability and deterministic evidence**
   - CC-009 first, then one isolated reproduction each for CC-002 and CC-003.
2. **Phase 2 — parser-adjacent format recovery**
   - CC-001, using the existing shared correction budget.
3. **Phase 3 — core write and shell runtime compatibility**
   - CC-002 and CC-003, but only after Phase 1 identifies their causes.
4. **Phase 4 — agent and client-session compatibility**
   - CC-004, then CC-005; CC-007 remains client-bound unless new Bridge
     evidence appears.
5. **Phase 5 — additional advertised capabilities**
   - CC-006 and CC-008.
6. **Phase 6 — full regression audit**
   - rerun the capability matrix once on the fixed commit and compare counts,
     tool inventory, raw-output events, retries, and network behavior.

Each phase should be a small reviewed change with its own offline evidence.
Production changes must not be bundled merely because the audit found several
symptoms.

## Phase 1 — safe observability and deterministic evidence

### CC-009

**Finding ID:** CC-009

**Priority:** P3, scheduled first because CC-002 and CC-003 have unknown causes

**Affected capability:** safe tool-call and tool-runtime correlation

**Failure layer:** `BRIDGE_NORMALIZATION` diagnostics visibility

**Confirmed evidence:** `tool_response` reports acceptance and outcome but not
the selected tool name. `tool_request` reports total tool results but not the
standard Anthropic `tool_result.is_error` signal. Consequently, the
model-switch tool name and the six main runtime-error causes were not
independently retained.

**Root cause confidence:** high; confirmed directly in
`lib/tool_diagnostics.js` and the audit evidence.

**Required change:**

1. Add an identifier-validated, bounded `selected_tool_name` field only when a
   strict tool call is accepted. Use `invalid` for a non-identifier; never log
   arguments.
2. Add `tool_result_error_count` for Anthropic tool-result blocks by counting
   only the explicit boolean `is_error === true`. Do not parse or classify the
   tool-result text in production.
3. Extend an audit-only harness, not production logging, with fixed error
   categories if more detail is required. It must discard source text and
   emit only an enum such as `permission`, `input_validation`, `runtime`, or
   `unknown`; unknown stays the default.
4. Keep diagnostics opt-in and logger failures observational.

**Files likely affected:**

- `lib/tool_diagnostics.js`
- `server.js`
- `lib/tool_continuation.js` only if the explicit error flag is already parsed
  there; avoid changing continuation semantics
- `tests/unit.test.js`
- an audit script under `scripts/` if needed

**Tests required:**

- accepted safe name is emitted; malformed/oversized name becomes `invalid`;
- no tool input, result content, path, URL, prompt, session/call ID, or hash is
  present in logs;
- `tool_result_error_count` counts only explicit error booleans;
- OpenAI and Responses requests retain a safe zero/unsupported value without
  inspecting result text;
- diagnostics disabled and throwing logger behavior remain unchanged.

**Live validation required:** one read success, one missing-Read error, one
Write attempt, and one platform-native shell attempt in a disposable fixture.
Retain only the safe fields.

**Risk:** low for identifier/count fields; medium if any implementation tries
to inspect result text. The latter must remain audit-only.

**Dependencies:** none.

**Acceptance criteria:** safe diagnostics independently identify the selected
tool and error-result count, the response is unchanged, security tests pass,
and no payload appears in logs.

## Phase 2 — bounded recovery for the new structural class

### CC-001

**Finding ID:** CC-001

**Priority:** P1

**Affected capability:** Edit, sequential read calls, long agentic flow,
moderate multi-file context, raw tool JSON suppression

**Failure layer:** `BRIDGE_RETRY`, following malformed output from
`UPSTREAM_DEEPSEEK`

**Confirmed evidence:** five requests were selected from `content`, rejected
as `invalid_json`, started and ended with braces, did not start with a code
fence, contained the tool-call marker, had no accepted call or retry, and were
returned as final text. The exact raw syntax is unknown and must remain
unknown.

**Root cause confidence:** high that the current recovery predicates do not
cover the proven shape; unknown as to the exact upstream JSON defect.

**Required change:** add a separate predicate with a structural name such as
`shouldRetryBraceDelimitedToolLikeResponse()`. It may return true only when all
of these are true:

1. tools are present;
2. no strict tool call was accepted;
3. the shared correction budget is unused;
4. selected source is `content`;
5. parse reason is `invalid_json`;
6. content does not start with a code fence;
7. content starts with `{`;
8. content ends with `}`;
9. content contains the tool-call marker.

It must be false for any other source/reason, an accepted call, no tools, an
already-used correction, a code fence, no opening brace, no closing brace, or
no marker. It must not become a general `invalid_json` retry.

Reuse the static strict-tool correction prompt and the existing
`MODELS['deepseek-chat']` correction policy. Do not copy the malformed response.
Pass the second output through the unchanged `inspectToolCallFromOutput()` and
ordinary protocol adapter. If correction fails, return the generic safe
failure with no raw payload and no third completion.

Add a distinct boolean and retry enum only if required for unambiguous
evidence, for example `brace_tool_retry_attempted` and
`tool_retry_reason = brace_tool`; do not overload `prefixed_tool` because the
opening-brace gate is deliberately opposite.

**Files likely affected:**

- `lib/tool_retry.js`
- `lib/tool_diagnostics.js`
- `server.js`
- `tests/unit.test.js`
- implementation documentation under `docs/agentic-fix/`

`lib/tool_parser.js` should receive no acceptance-rule change. Network,
session, stream, and protocol files should remain unchanged unless compilation
requires a nonfunctional import adjustment.

**Tests required:**

- exact true predicate for the five shared safe structural signals;
- false for all individual negative gates;
- parser-level fixture remains `invalid_json`;
- one strict correction becomes a real Anthropic `tool_use`;
- OpenAI and Responses adapters use their normal tool-call path;
- continuation fixture: successful Glob result → brace-delimited intended Read
  → one correction → real Read;
- failed second output returns generic safe failure, hides both outputs and
  reasoning, and performs exactly two completions;
- correction followed by reasoning-only, another format class, or a repeated
  completed call cannot receive another correction;
- strict JSON, ordinary prose, existing CODE_FENCE, existing
  PREFIXED_TOOL_LIKE, explanatory marker prose, and brace-starting content
  without a closing brace/marker retain current behavior;
- synthetic secrets prove prompt/log/response isolation;
- diagnostics disabled and throwing logger behavior.

**Live validation required:** one process-tree-guarded disposable-fixture run
covering an ordered read flow and one Edit task. One run is sufficient even if
the stochastic shape is not re-triggered. Report `NOT_TRIGGERED` honestly; do
not loop until it appears.

**Risk:** medium. The predicate is a new recovery class; broadening it would
mask ordinary malformed JSON. Shared-budget and negative-gate tests are
mandatory.

**Dependencies:** CC-009 is desirable for cleaner evidence but not required
for functional implementation.

**Acceptance criteria:** strict parser remains unchanged; a matching synthetic
output gets at most one correction; success emits a real protocol tool call;
failure emits generic safe text; raw rejected output is never visible; maximum
total completions is 2.

## Phase 3 — core write and shell runtime compatibility

### CC-002

**Finding ID:** CC-002

**Priority:** P1

**Affected capability:** `Write` and write-to-read continuation

**Failure layer:** confirmed `TOOL_RUNTIME`; deeper cause unknown

**Confirmed evidence:** one strict Write call produced one explicit tool error,
continued to final text, and did not create the file.

**Root cause confidence:** low beyond the first failing boundary. The audit did
not retain raw arguments or tool-result text.

**Required change:** first rerun one Write fixture after CC-009 and classify the
error without payload retention. Then choose exactly one branch:

- if Claude Code permission/configuration denied it, update audit/user setup
  documentation only;
- if the accepted argument object fails the advertised Write schema, add a
  safe schema-validation signal and a narrowly bounded model correction before
  returning `tool_use`; do not repair arguments locally;
- if protocol conversion changes arguments, fix only the responsible adapter
  and add cross-protocol regression tests;
- if the Claude Code runtime itself fails despite valid input and permission,
  document the client limitation and do not modify Bridge.

**Files likely affected:** unknown until reproduction. Possible scope is
`server.js`, tool orchestration/tests, or documentation only. Do not preselect
`lib/tool_parser.js`.

**Tests required:** based on the confirmed branch; at minimum a valid Write
schema fixture, missing/invalid required fields, security isolation, one
correction budget if correction is used, and unchanged Read/Edit parsing.

**Live validation required:** disposable `Write → tool_result → Read`, physical
file check, no raw JSON, no network error, and no more than two completions for
any corrected request.

**Risk:** high if fixed before cause isolation; low if the result is a client
configuration/documentation change.

**Dependencies:** CC-009; CC-001 should land first if the reproduced call is
again blocked by the brace-delimited shape.

**Acceptance criteria:** a file is physically created with the requested
synthetic content, Read verifies it, tool-result continuation completes, and
the repository outside the disposable fixture is unchanged.

### CC-003

**Finding ID:** CC-003

**Priority:** P1

**Affected capability:** `Bash`, `PowerShell`, and shell-result continuation

**Failure layer:** confirmed `TOOL_RUNTIME`; client permission/platform cause
unknown

**Confirmed evidence:** read-only Bash failed; the write task produced Bash,
PowerShell, Bash and all three results were errors. No file was created.

**Root cause confidence:** low. PowerShell was not in the initial pre-approved
list, while Bash was; the two tools must be isolated.

**Required change:** after CC-009, run two separate single-tool fixture tests
with explicit safe permission:

1. PowerShell `node --version` on Windows;
2. Bash `node --version` only if Claude Code reports a usable Bash runtime.

If PowerShell works, document it as the Windows-supported shell and classify
Bash as a Claude Code/platform limitation. If accepted inputs violate a schema,
apply the same narrow correction decision tree as CC-002. Do not rewrite shell
commands or execute them in Bridge.

**Files likely affected:** documentation or audit scripts first; production
scope only after evidence. Possible tool orchestration/tests if an input-schema
problem is proven.

**Tests required:** explicit permission matrix, correct tool schema, nonzero
runtime failure, successful output, result continuation, and command-safety
allowlist in the live harness.

**Live validation required:** one platform-native read-only command, then one
disposable file creation and Read. No network/system/configuration commands.

**Risk:** high if Bridge starts translating/executing shell commands; that is
out of scope and forbidden. Documentation/client configuration is preferred
when supported by evidence.

**Dependencies:** CC-009; CC-002 schema findings may be reusable.

**Acceptance criteria:** at least the platform-native shell tool completes a
real tool-result cycle; any unsupported shell is explicitly documented rather
than advertised as Bridge-compatible.

## Phase 4 — agents, task management, and client sessions

### CC-004

**Finding ID:** CC-004

**Priority:** P1

**Affected capability:** Agent/Task subagents

**Failure layer:** `BRIDGE_NORMALIZATION` model resolution

**Confirmed evidence:** two nested requests used `claude-opus-5` and were
rejected locally before upstream work; parent Agent execution alone did not
prove a completed subagent task.

**Root cause confidence:** high for the unsupported alias.

**Required change:** define an explicit, minimal Claude Code compatibility
alias policy for the single observed nested alias. Prefer mapping
`claude-opus-5` to the supported reasoning policy used for agents, while
preserving the requested alias in protocol metadata only where required for
client compatibility. Do not add wildcard acceptance for arbitrary Claude
model names. Alternatively, if Claude Code's Agent arguments can reliably
request `deepseek-reasoner`, document and test that configuration instead of
adding a server alias.

**Files likely affected:**

- `lib/models.js`
- model resolution in `server.js` or a new narrowly scoped resolver
- `tests/unit.test.js`
- README compatibility documentation

**Tests required:** exact alias accepted/mapped; unrelated unknown aliases
remain rejected; top-level supported aliases unchanged; nested tool and result
continue on the same client correlation; no session/call-ID regression;
stream/nonstream response model fields remain contract-compatible.

**Live validation required:** one foreground parent prompt, one Agent call,
nested Glob/Read, nested result, and parent final. Wait for background work to
finish before another prompt.

**Risk:** medium. Overbroad aliases could conceal invalid client configuration
or change requested-model semantics.

**Dependencies:** preferably CC-009 for selected-tool evidence.

**Acceptance criteria:** no unsupported-model safe failure; the subagent's
real read result reaches the parent; no orphan/incomplete background request;
one stable parent client ref; zero network errors.

### CC-005

**Finding ID:** CC-005

**Priority:** P2

**Affected capability:** TaskCreate/Get/List/Output/Stop/Update

**Failure layer:** `UNKNOWN` due audit interleaving

**Confirmed evidence:** all six tools were advertised, but no isolated Task
tool event was proven after the preceding Agent launched background activity.

**Root cause confidence:** low.

**Required change:** no production change initially. After CC-004, run an
isolated task-management session with no Agent call before it. Test create,
list/get, update, and completion as separate safe lifecycle steps. Stop is not
required unless a disposable task is demonstrably active.

**Files likely affected:** audit documentation/scripts first. Production files
only if an isolated request reaches Bridge and fails at a proven Bridge layer.

**Tests required:** client tool event names, result flags, Bridge request
correlation, and no overlap from background Agent requests.

**Live validation required:** yes, one isolated task lifecycle.

**Risk:** low if kept evidence-only; high if inferred from the contaminated
run.

**Dependencies:** CC-004.

**Acceptance criteria:** each tested task operation has a real tool event and
result; parent conversation continues; no background request crosses the next
user turn.

### CC-007

**Finding ID:** CC-007

**Priority:** P2

**Affected capability:** Claude Code `--resume` and `--continue`

**Failure layer:** `CLAUDE_CODE_CLIENT` before Bridge for resume; unknown
client session selection for continue

**Confirmed evidence:** explicit resume exited with no Bridge request; continue
used a different client ref from the controlled start.

**Root cause confidence:** high that Bridge cannot fix the zero-request resume
failure; low for the underlying Claude persistence reason.

**Required change:** first reproduce with a minimal local mock/identity probe
and retain only result subtype, exit code, and identifier fingerprints. Verify
Claude Code 2.1.226 persistence requirements for print sessions. If the native
client emits a stable session header after a valid resume, existing Bridge
correlation should be tested without changing SessionResolver. If no request is
emitted, document the client limitation.

**Files likely affected:** `scripts/claude_session_identity_probe.mjs`, tests,
and documentation. `lib/session.js` and `lib/session_resolver.js` should remain
unchanged unless a request with stable native identity reaches Bridge and is
misrouted.

**Tests required:** first process, exactly one explicit resume, exactly one
continue, fingerprint equality, request counts, and no full identifiers.

**Live validation required:** one minimal start/resume/continue chain; no loops.

**Risk:** medium if client and upstream session identities are conflated.

**Dependencies:** none; schedule after Agent work to avoid background overlap.

**Acceptance criteria:** either resume/continue preserve the intended client
fingerprint and Bridge upstream linkage, or the unsupported client behavior is
documented with zero production change.

## Phase 5 — additional advertised capabilities

### CC-006

**Finding ID:** CC-006

**Priority:** P2

**Affected capability:** WebFetch/WebSearch

**Failure layer:** `UPSTREAM_DEEPSEEK` tool selection; runtime not reached

**Confirmed evidence:** both tools were advertised; one explicit WebFetch task
returned final text with no marker, no tool call, and no network error.

**Root cause confidence:** low beyond the selection boundary.

**Required change:** no parser/retry change. Recheck one deterministic
read-only WebFetch prompt after CC-001/CC-004 so unrelated flow problems are
absent. Compare the advertised schema with Claude Code's current schema and the
safe tool-name list sent upstream. If the model consistently refuses an
otherwise valid schema, consider a narrowly scoped tool-instruction change for
web-capable requests; do not infer user intent by inspecting/logging prompts.

**Files likely affected:** tests/documentation first; possibly tool prompt
construction in `server.js` only with repeated evidence.

**Tests required:** WebFetch schema preservation, strict accepted synthetic
call, adapter output, result continuation, and no access to mutating web/MCP
tools.

**Live validation required:** one official public read-only page.

**Risk:** medium. A global prompt change could regress core tools.

**Dependencies:** CC-001; optionally CC-009.

**Acceptance criteria:** real WebFetch tool event, successful result, final
response, no raw JSON, no network error, and no prompt/schema broadening.

### CC-008

**Finding ID:** CC-008

**Priority:** P2

**Affected capability:** NotebookEdit

**Failure layer:** `UPSTREAM_DEEPSEEK` tool selection/output

**Confirmed evidence:** NotebookEdit was advertised, but the explicit fixture
task produced no tool event and no file change. The final text did not contain
the tool-call marker.

**Root cause confidence:** low.

**Required change:** first run an isolated notebook task after CC-001 with the
current tool schema and an explicitly permitted disposable notebook. If the
model produces a new tool-like structural class, record safe metadata and plan
another narrow recovery only after evidence. If it returns prose again, test
schema/prompt compatibility without changing the parser.

**Files likely affected:** audit tests/docs first; production scope only after
a proven boundary.

**Tests required:** valid NotebookEdit schema, real file mutation, Read
verification, no raw output, and unchanged Edit/Write behavior.

**Live validation required:** one disposable notebook edit and physical check.

**Risk:** medium; notebook input schemas are richer and must not be guessed.

**Dependencies:** CC-001 and CC-009.

**Acceptance criteria:** NotebookEdit tool event and successful result, physical
cell update, Read verification, and no mutation outside the fixture.

## Phase 6 — regression audit

After the individually approved fixes, rerun one compatibility audit against a
fresh disposable fixture. Do not repeat stochastic prompts merely to trigger a
format class.

The regression audit must include:

- plain chat and system/project context marker;
- Glob, Read, Grep individually;
- Glob → Read → Grep and a longer multi-file flow;
- Edit, Write, platform-native shell, and NotebookEdit with physical checks;
- missing-file error continuation;
- automatic selection;
- Agent only after supported nested-model policy, followed by an isolated Task
  lifecycle;
- one representative web read;
- MCP only if the client reports a connected read-only tool;
- count_tokens;
- Anthropic, OpenAI, and Responses adapters;
- one start/resume/continue chain;
- safe tool inventory and slash-command inventory;
- all retry flags, raw-output flags, network stages, safe failures, and maximum
  completion count.

Final acceptance targets:

- no raw tool JSON/tool-like text in a successful or safely failed flow;
- strict parser semantics unchanged;
- maximum correction completions = 1;
- maximum total completions for a corrected request = 2;
- individual Glob/Read/Grep, multi-step continuation, Edit, Write, and the
  supported Windows shell path all pass;
- subagent completes through a supported model policy;
- every tool error has a safe selected-name/error-count correlation;
- no network/session/protocol regression;
- fixture removed, port free, no leftover Claude process, production worktree
  clean.

## Planned deliverables by phase

| Phase | Deliverable | Production change allowed? |
| --- | --- | --- |
| 1 | safe diagnostics and isolated evidence | Only bounded diagnostic fields |
| 2 | CC-001 narrow bounded recovery | Yes, parser acceptance unchanged |
| 3 | Write/shell fix or client documentation | Only after confirmed cause |
| 4 | exact Agent alias policy; task/session evidence | Exact alias only; session code only with Bridge evidence |
| 5 | web/notebook evidence and narrow fixes | Only after confirmed Bridge boundary |
| 6 | final audit report | No implementation during audit |

Every implementation phase requires a separate user approval. This plan does
not authorize code changes, live retries, a pull request, or merge.
