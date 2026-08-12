# Claude Code Compatibility Checkpoint

Date: 2026-08-12

## Executive summary

This checkpoint re-evaluates the original nine Claude Code compatibility
findings against the current production code, the current 202-test suite, the
Git history, and every later targeted evidence report. The original full audit
and fix plan remain the historical baseline; they no longer define current
status where newer controlled evidence exists.

Seven of nine findings now have a final evidence-based disposition. Two Bridge
changes actually landed: CC-009 safe runtime observability and CC-001 narrow
brace-delimited recovery. Three historical failures did not reproduce and are
current re-evaluation passes: CC-002 Write, CC-004 Agent/subagent lifecycle,
and CC-007 resume/continue. CC-003 is a documented command-form/client
permission limitation, and CC-005 is a documented per-turn model-selection
limitation. Neither supports a Bridge production fix.

The only finding-directed work still open is CC-006 (`WebFetch`/`WebSearch`)
and CC-008 (`NotebookEdit`). Their original turns never reached real tool
lifecycles, and no later targeted live evidence exists. They require isolated
re-evaluation; they are not current proven Bridge defects.

There are no open proven Bridge defects at this checkpoint. A final full live
matrix should not run yet. First complete CC-006 and CC-008; if either proves a
Bridge defect, land and validate that fix before the final matrix.

`CHECKPOINT_MAIN_SHA = 423bebf38bd9653ca13561ff6b853ccc109752d4`

`ORIGINAL_FINDINGS = 9`

`FINDINGS_FIXED = 2`

`FINDINGS_REEVALUATED_PASS = 3`

`FINDINGS_DOCUMENTED_LIMITATION = 2`

`FINDINGS_REQUIRING_REEVALUATION = 2`

`OPEN_PROVEN_BRIDGE_DEFECTS = 0`

`REMAINING_TARGETED_LIVE_INVESTIGATIONS = 2`

`NEXT_FINDING = CC-006`

`FINAL_FULL_AUDIT_TRIGGER = AFTER_CC006_AND_CC008_AND_ANY_RESULTING_PRODUCTION_FIXES`

`CURRENT_COMPATIBILITY_VERDICT = MOSTLY_COMPATIBLE_REEVALUATION_PENDING`

## Audit methodology

This was a read-only evidence synthesis. It did not start Claude Code, the
Bridge, an observer, a fixture, or any compatibility live test. It did not
change production code, tests, parser, retry, sessions, models, or aliases.

The review covered:

- the complete original full audit and compatibility fix plan;
- every tracked `docs/compatibility/` report and relevant agentic-fix history;
- Git history from the original audit through current `main`;
- current `server.js`, model, parser, retry, continuation, diagnostics, and
  session implementations;
- the relevant portions of the current unit/HTTP test suite; and
- an offline baseline and post-report regression using the normal test suite.

No coverage percentage is claimed because no coverage instrumentation was
run. A commit or a test by itself was not treated as functional live proof.

## Evidence precedence

Conflicting evidence was resolved in this order:

1. current production code on the checkpoint SHA;
2. current tests;
3. the latest merged targeted re-evaluation report;
4. the latest merged implementation/live-validation report;
5. older targeted reports;
6. the original full audit; and
7. the original compatibility fix plan.

Accordingly, later controlled passes supersede historical FAIL labels for
current-status interpretation without deleting or rewriting the old record.

## Changes since original audit

The original audit was merged as PR #5 and evaluated Bridge
`b49bf745fd6cbc70bb008eb7e90c58edfccd9d14`. Current `main` contains the
following subsequent finding work:

| Merge/workflow | Finding | Tracked effect | Current meaning |
| --- | --- | --- | --- |
| PR #6 | CC-009 | Production, tests, evidence | Safe selected-tool/error-result observability landed |
| PR #7 | CC-001 | Production, tests, evidence | Narrow brace-delimited correction landed |
| PR #8 | CC-002/CC-003 | Documentation/evidence only | Write passed; shell remained partial pending isolation |
| PR #9 | CC-003 | Documentation/evidence only | Command-form permission limitation isolated |
| PR #10 | CC-004 | Documentation/evidence only | Current Agent lifecycle passed; no alias added |
| PR #11 | CC-005 | Documentation/evidence only | Isolated core Task evidence recorded |
| PR #12 | CC-005 | Documentation/evidence only | Selection limitation reproduced and documented |
| Direct docs-only `--no-ff` merge | CC-007 | Documentation/evidence only | Resume and continue passed current controlled chain |

Only CC-009 and CC-001 changed production behavior after the original audit.
The remaining merged work correctly preserved unchanged production code.

The original audit baseline already contained strict whole-response parsing,
reasoning-only/fenced/prefixed bounded corrections, repeated-tool protection,
tool-result continuation, session isolation, local token counting, and safe
upstream/tool diagnostics. This checkpoint confirms those foundations remain
present; it does not relabel them as new post-audit fixes.

## Current capability matrix

Confidence is based on the strongest current evidence: `HIGH` for current
code/tests plus controlled lifecycle evidence, `MEDIUM` for a bounded single
live observation or client-dependent inventory, and `LOW` where a lifecycle
has not been reached.

| Capability | Original audit | Current status | Confidence | Failure layer / limitation | Bridge fix needed | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Ordinary chat | `FULL_PASS` | `FULL_PASS` | HIGH | None observed | NO | Original live stream plus unchanged protocol path and regressions |
| Anthropic streaming | `FULL_PASS` | `FULL_PASS` | HIGH | None observed | NO | Text, tool, continuation, error, and buffered correction coverage |
| System/project context | `PARTIAL` | `PARTIAL` | MEDIUM | Original exact marker boolean was not retained | NO evidence | No newer targeted context probe |
| Tool inventory transport | `FULL_PASS` | `FULL_PASS` | HIGH | Client inventory varies by invocation, but arrays/schemas reach Bridge | NO | Original and all targeted inventories |
| Glob | `FULL_PASS` | `FULL_PASS` | HIGH | None observed | NO | Original plus CC-001 and CC-004 lifecycles |
| Read | `FULL_PASS` | `FULL_PASS` | HIGH | None observed | NO | Success/error continuation and multiple later lifecycles |
| Grep | `FULL_PASS` | `FULL_PASS` | HIGH | None observed | NO | Original and CC-001 ordered flow |
| Edit | `FAIL` | `PASS` | HIGH | Original CC-001 malformed output is now narrowly recoverable; current direct Edit passed | NO remaining | CC-001 deterministic recovery tests plus physical live Edit/Read |
| Write | `FAIL` | `PASS` | HIGH | Historical runtime failure cause remains unknown | NO | CC-009 physical Write and two CC-002 Write/Read lifecycles |
| Bash read-only command | `FAIL` | `PASS` | HIGH | None for tested Node-version command | NO | CC-002/003 and CC-003 controls |
| Bash filesystem mutation | `FAIL` | `COMMAND_FORM_LIMITATION` | HIGH | POSIX redirection permission denial; Node fs write and touch pass | NO | CC-003 isolated runtime investigation |
| PowerShell tool | `FAIL` | `NOT_AVAILABLE` | MEDIUM | Not advertised in latest controlled normal Windows inventories | NO | CC-002/003 and CC-003 inventories; historical fallback remains historical |
| Automatic tool selection | `FULL_PASS` | `FULL_PASS` | HIGH | Selection is not deterministic for every capability | NO | Natural Grep plus many targeted selected lifecycles |
| Sequential multi-tool flow | `FAIL` | `PASS` | HIGH | Original flow was blocked by CC-001 | NO remaining | Current `Glob -> Read -> Grep` live flow |
| Longer agentic read flow | `FAIL` | `PASS` | HIGH | Current bounded Agent flow, not an unlimited autonomy claim | NO | CC-004 nested Glob/Read/final/parent lifecycle |
| Tool-result continuation | `FULL_PASS` | `FULL_PASS` | HIGH | None observed | NO | Current cross-protocol tests and later live flows |
| Tool-error continuation | `FULL_PASS` | `FULL_PASS` | HIGH | None observed | NO | Read errors and Bash errors continued without route loss |
| Agent/subagent | `PARTIAL` | `PASS` | HIGH | Historical `claude-opus-5` alias was not sent by current client | NO | CC-004 full nested and parent lifecycle |
| TaskCreate/List/Get/Update | `PARTIAL` | `MODEL_SELECTION_LIMITATION` | HIGH | Runtime works when selected; per-turn selection is nondeterministic | NO | CC-005 isolated lifecycle and critical `tool_choice=NONE` turn |
| TaskOutput/TaskStop | `PARTIAL` | `NOT_TESTED` | HIGH boundary | Not applicable without a real background/stoppable task | NO evidence | Explicit CC-005 safety boundary |
| WebFetch | `FAIL` | `REQUIRES_REEVALUATION` | LOW current | Historical model did not select the tool; runtime never reached | UNKNOWN pending evidence | CC-006 original single turn only |
| WebSearch | `NOT_TESTED_COST` | `REQUIRES_REEVALUATION` | LOW | Advertised historically but no real tool lifecycle | UNKNOWN pending evidence | No post-audit targeted evidence |
| NotebookEdit | `FAIL` | `REQUIRES_REEVALUATION` | LOW current | Historical model did not select the tool; runtime never reached | UNKNOWN pending evidence | CC-008 original single turn only |
| `count_tokens` | `FULL_PASS` | `FULL_PASS` | HIGH | Local estimate by design | NO | Route tests, original probe, and CC-007 client chain |
| Compact/autocompact | `NOT_TESTED_COST` | `NOT_TESTED` | HIGH boundary | No controlled context saturation/compact lifecycle | UNKNOWN, no defect evidence | Historical compaction attempts never reached compaction |
| `--resume` | `FAIL` | `PASS` | HIGH | Historical pre-Bridge cause remains unknown | NO | CC-007 explicit resume reached Bridge and matched context |
| `--continue` | `PARTIAL` | `PASS` | HIGH | Historical identity difference remains unexplained | NO | CC-007 identity and context continuity passed |
| Model switching | `PARTIAL` | `PARTIAL` | MEDIUM | Exact advertised model resolution works; behavioral compliance after switch was only partially evidenced | NO current defect | Original `deepseek-chat` transport/tool cycle plus current exact model table/tests |
| MCP | `NOT_CONFIGURED` | `NOT_CONFIGURED` | HIGH boundary | Client server failed; no MCP tool reached Bridge | NO | Original client inventory; no later configured MCP evidence |
| AskUserQuestion | `NOT_AVAILABLE` | `NOT_AVAILABLE` | HIGH boundary | Not advertised to Bridge | NO | Current client inventory evidence |
| OpenAI Chat Completions adapter | `FULL_PASS` | `FULL_PASS` | HIGH | None observed | NO | Tool/continuation/stream tests and original API probe |
| Responses adapter | `FULL_PASS` | `FULL_PASS` | HIGH | None observed | NO | Tool/continuation/stream tests and original API probe |
| Raw tool-like output handling | `FAIL` | `PASS` | HIGH | Pass is bounded to the proven recovery classes; stochastic CC-001 did not re-trigger live | NO remaining proven defect | Narrow deterministic tests; later live runs had zero raw events |
| Network stability/diagnostics | `FULL_PASS` | `FULL_PASS` | HIGH | Live upstream availability remains environment-dependent | NO | Safe staged diagnostics, retry separation, and zero-error targeted runs |

The matrix does not treat DeepSeek's built-in `*-search` model modes as proof
of Claude Code `WebFetch` or `WebSearch`; those are distinct capabilities.

## CC-001 through CC-009 disposition

| Finding | Original priority | Original status/root boundary | Current status | Production fix landed | Reproduced? | Bridge defect remains? | Next action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CC-001 | P1 | Unhandled brace-delimited tool-like output at `BRIDGE_RETRY` | `FIXED` | YES | Original shape: yes; post-fix live: not triggered | NO | Preserve narrow tests; no repeat run |
| CC-002 | P1 | Write runtime error, cause unknown | `REEVALUATED_PASS` | NO | Historical failure: NOT_REPRODUCED | NO | `NO_CC002_FIX` |
| CC-003 | P1 | General shell runtime errors | `DOCUMENTED_LIMITATION` | NO | Broad failure disproven; redirection permission failure reproduced narrowly | NO | Keep command-form/client limitation documented |
| CC-004 | P1 | Nested unsupported `claude-opus-5` model | `REEVALUATED_PASS` | NO | Historical alias: NOT_REPRODUCED | NO | `NO_CC004_FIX` |
| CC-005 | P2 | Inconclusive Task lifecycle | `DOCUMENTED_LIMITATION` | NO | Critical TaskGet selection failure: REPRODUCED | NO | `CC_005_DOCUMENTED` |
| CC-006 | P2 | WebFetch not selected; runtime not reached | `REQUIRES_REEVALUATION` | NO | No post-audit reproduction | NOT PROVEN | One isolated WebFetch/WebSearch investigation |
| CC-007 | P2 | Resume pre-Bridge failure; continue identity mismatch | `REEVALUATED_PASS` | NO | Historical behavior: NOT_REPRODUCED | NO | `NO_CC007_FIX` |
| CC-008 | P2 | NotebookEdit not selected; runtime not reached | `REQUIRES_REEVALUATION` | NO | No post-audit reproduction | NOT PROVEN | One isolated disposable NotebookEdit investigation |
| CC-009 | P3 | Safe runtime observability gap | `FIXED` | YES | Fixed fields validated live and offline | NO | Maintain bounded/opt-in semantics |

Disposition totals are mutually exclusive and sum to nine: two `FIXED`, three
`REEVALUATED_PASS`, two `DOCUMENTED_LIMITATION`, and two
`REQUIRES_REEVALUATION`.

### Progress accounting

- Finding-resolution progress: `7/9` findings have a final evidence-based
  disposition; CC-006 and CC-008 remain open for evidence.
- Compatibility-completion progress: three advertised tool capabilities
  (`WebFetch`, `WebSearch`, and `NotebookEdit`) remain in the two required
  targeted investigations.
- Additional non-finding boundaries remain intentionally outside that count:
  compaction is untested, MCP is not configured, AskUserQuestion is not
  available, and TaskOutput/TaskStop had no applicable safe runtime task.

No percentage is reported because the capability rows have different scope
and risk and cannot be meaningfully weighted as equal units.

## Production fixes landed

### CC-009 safe observability

- `e4dfce25690f530f443a5104d5ce819c37c161f8` added bounded
  `selected_tool_name` and `tool_result_error_count` diagnostics.
- `05b5b179dd59937f5459bc94e09d83b797b8b2cf` corrected the error count to
  current known call-ID-linked results, excluding historical transcript
  errors.
- Diagnostics remain opt-in, identifier/count-only, and observational when a
  logger fails.
- Live evidence confirmed Read success/error and physical Write success; the
  current 202-test suite covers accepted/none/invalid names, boolean-only
  errors, stale-error exclusion, disabled diagnostics, and throwing loggers.

`CC_009_BRIDGE_DEFECT_FIXED = YES`

`CC_009_REMAINING_WORK = NONE`

### CC-001 brace-delimited recovery

- `7d1e57c78e5ca5a5e5e0d12f7b6faa9e77853dbd` added one narrow structural
  predicate and correction path for the exact observed brace-delimited class.
- The strict parser was not relaxed. The correction uses the existing static
  prompt, same shared `correctiveAttempted` budget, maximum one correction,
  and generic safe failure after an unsuccessful correction.
- Rejected content/reasoning is not copied into the prompt, diagnostics, or
  failed response.
- Deterministic tests directly prove the matching recovery and all negative
  gates. The bounded post-fix live run passed `Glob -> Read -> Grep` and
  `Edit -> Read` physically, but honestly recorded the stochastic brace path
  as `NOT_TRIGGERED`.

`CC_001_BRIDGE_DEFECT_FIXED = YES`

`CC_001_REMAINING_WORK = NONE`

No other CC-001 through CC-009 production fix landed after the original audit.

## Documentation/client/model limitations

The correct outcome for five re-evaluated findings was no production fix:

- **CC-002:** two independent strict `Write -> Read` lifecycles and physical
  checks passed. The historical failure cause remains unknown.
- **CC-003:** Bash itself and filesystem mutation work. Only the tested POSIX
  redirection form returned `PERMISSION_DENIED` despite a temporary rule;
  PowerShell was absent from current inventories. Bridge received the expected
  strict command and must not rewrite or execute it.
- **CC-004:** current Claude Code used `deepseek-reasoner` for all nested
  requests; nested Glob/Read, nested final, Agent result, and parent final
  completed. No exact or wildcard Claude alias was added.
- **CC-005:** core Task runtime operations work when selected. The reproduced
  missing TaskGet selection had inbound `tool_choice = NONE`; no call existed
  for Bridge to corrupt or continue. Prompt-derived forcing or broad prose
  retry would change semantics and is not justified.
- **CC-007:** START, explicit RESUME, and CONTINUE all reached Bridge and
  preserved native client equality and context. The historical persistence
  cause remains unknown but is not a current Bridge issue.

These findings must not be reopened as speculative parser, retry, alias,
session, schema, or model-forcing changes without new contradictory evidence.

## Remaining unresolved work

### CC-006 — WebFetch/WebSearch

The original request advertised both tools, but the representative WebFetch
turn returned prose without a tool call. The runtime and continuation were
never reached. Since then, CC-001 recovery and CC-009 observability landed,
but neither is evidence that WebFetch or WebSearch now executes.

Current decision: `REQUIRES_REEVALUATION`. Run one isolated, read-only,
current-client lifecycle with a normal inventory and bounded diagnostics.
Require a real tool event/result before PASS. Do not prepare a production fix
unless that run proves a Bridge-controlled boundary.

### CC-008 — NotebookEdit

The original NotebookEdit turn also returned prose with no tool event and no
physical mutation. Current generic normalization/parser code can transport an
allowed identifier and schema, but generic synthetic support is not a real
NotebookEdit lifecycle.

Current decision: `REQUIRES_REEVALUATION`. Use one disposable notebook, a real
NotebookEdit result, independent physical verification, and no mutation
outside the fixture. Production-fix need remains unknown until the first
failing layer is proven.

### Other matrix boundaries

- Compact/autocompact remains intentionally `NOT_TESTED` and is not an open
  proven defect.
- MCP remains `NOT_CONFIGURED`; it can only be assessed after the client
  supplies a healthy read-only MCP tool.
- AskUserQuestion remains `NOT_AVAILABLE` in the observed API inventory.
- TaskOutput/TaskStop remain outside the safe core Task lifecycle because no
  applicable background/stoppable task was created.
- Model switching remains behaviorally `PARTIAL`, although exact advertised
  model resolution and transport work.
- Anthropic `tool_choice` is not currently parsed or enforced by Bridge. This
  is a protocol watch item, not current CC-005 defect evidence: the reproduced
  failing client request contained no such field.

## Open proven Bridge defects

`OPEN_PROVEN_BRIDGE_DEFECTS = 0`

None. CC-006 and CC-008 are evidence gaps, not proven Bridge bugs. CC-003 is a
client/runtime command-form limitation; CC-005 is a model-selection
limitation; CC-002, CC-004, and CC-007 are current passes; CC-001 and CC-009
have landed fixes.

## Test and regression health

Checkpoint baseline on current `main`:

- `npm.cmd test`: `202/202 PASS`;
- required `node --check`: `PASS` for `server.js`, diagnostics,
  continuation, retry, parser, and models;
- `git diff --check`: `PASS`.

Post-report offline validation produced the same results: `202/202 PASS`, all
six required `node --check` commands PASS, and `git diff --check` PASS.
Production files changed: `0`. Test files changed: `0`.

Coverage relevant to this checkpoint includes:

- CC-001 exact predicate, every negative gate, success/failure, shared budget,
  continuation, all three adapters, streaming, payload isolation,
  diagnostics-disabled, and throwing-logger behavior;
- CC-009 bounded selected names, current boolean error counts, historical
  error exclusion, protocol defaults, opt-in behavior, and logger failures;
- strict parser whole-content acceptance, size/depth/dangerous-key rejection;
- current-result continuation, call-ID linkage, exact-repeat protection, and
  OpenAI/Anthropic/Responses adapters; and
- client/upstream identity separation, anonymous isolation, explicit upstream
  identity, link expiry, and bounded diagnostic fingerprints.

Native Claude `--resume`/`--continue` is external-client behavior and is
supported by the targeted CC-007 live chain rather than unit coverage.
WebFetch/WebSearch and NotebookEdit still lack post-audit real lifecycle
proof. No coverage percentage is inferred.

## Code-quality/security observations

- Retry orchestration has separate class-specific blocks, but all consume the
  single `correctiveAttempted` budget. Tests cover both correction orders and
  prevent a third completion. The repetition is a maintainability cost, not a
  current semantic defect.
- The parser remains strict: it accepts only a whole JSON/XML envelope,
  validates the allowed name and plain-object arguments, rejects dangerous
  keys, and enforces input/argument/depth limits. No substring extraction,
  prefix stripping, fuzzy repair, or wildcard execution path was added.
- The recovery predicates are structural and bounded. Matching failed
  corrections emit a generic safe failure; correction prompts are static and
  contain only validated allowed names.
- Network retry remains inside the upstream completion client and is separate
  from model-format correction. A network/authorization/timeout error does not
  trigger a tool correction.
- Diagnostics remain off by default. Enabled records contain bounded tool
  names, counts, enums, structural booleans, random request refs, and
  process-salted identity refs—not prompts, reasoning, arguments, results,
  credentials, raw IDs, or response bodies.
- Logger failures remain observational. Ordinary upstream error logging
  redacts credentials, URLs, and absolute paths; tests also cover stream
  reader errors and API-response isolation.
- Tool results and arguments are sent to the upstream model only as required
  for functional continuation; they are not copied into structured
  diagnostics or correction prompts.
- Current model resolution uses exact `MODELS` keys. There is no wildcard
  Claude alias and no `claude-opus-5` public model entry.
- No obvious dead compatibility path or new critical security concern was
  found. The unimplemented Anthropic `tool_choice` surface and the untested
  web/notebook lifecycles remain explicit scope boundaries rather than hidden
  claims of support.

## Stale historical documents

The following files remain valuable audit trail but are `HISTORICAL_ONLY` for
current-status interpretation:

- `CLAUDE_CODE_FULL_AUDIT.md`: its overall `PARTIALLY_COMPATIBLE` verdict and
  CC-001/002/003/004/005/007/009 statuses are superseded by later evidence.
  Its CC-006 and CC-008 observations remain the latest live baseline, not a
  current FAIL verdict.
- `CLAUDE_CODE_COMPATIBILITY_FIX_PLAN.md`: its dependency order is historical.
  CC-009 and CC-001 landed; CC-002, CC-004, and CC-007 need no fix; CC-003 and
  CC-005 are documented limitations. Only the targeted CC-006/CC-008 phase
  remains active.
- Early CC-002/003 blocked-at-launch sections and the two blocked CC-005
  harness reports remain truthful run records but are superseded for current
  classification by their later successful/critical-boundary evidence.

The historical files should not be edited to erase old failures. This
checkpoint supersedes only their interpretation as current project status.

## Recommended next sequence

1. **CC-006 evidence-only re-evaluation:** isolate WebFetch and WebSearch,
   requiring real tool events/results and distinguishing model selection from
   client runtime and Bridge adaptation.
2. **CC-008 evidence-only re-evaluation:** isolate NotebookEdit in a disposable
   notebook with physical verification.
3. If either run proves a Bridge defect, isolate the narrow production fix in
   a separate reviewed branch, validate it offline and with one targeted live
   lifecycle, then merge it.
4. Only after both targeted tracks are dispositioned and any resulting fixes
   are merged, run one final full live regression matrix.

`NEXT_FINDING = CC-006`

No production fix is presently authorized for CC-006 or CC-008. Their
production-fix decision is `UNKNOWN_PENDING_REEVALUATION`, not YES.

## Final full-audit trigger

Do not run the final full live audit now. The exact trigger is:

`WHEN_TO_RUN_FINAL_FULL_LIVE_AUDIT = AFTER_CC006_AND_CC008_AND_ANY_RESULTING_PRODUCTION_FIXES`

If both targeted investigations find no Bridge defect, run the final matrix
immediately after their docs/evidence merge. If either finds a Bridge defect,
run it only after that production fix and its targeted validation are merged.
This combines option D (after CC-006 and CC-008) with option E when a new fix
is actually required.

## Current compatibility verdict

`CURRENT_COMPATIBILITY_VERDICT = MOSTLY_COMPATIBLE_REEVALUATION_PENDING`

The core Claude Code integration now works for chat, streaming, read tools,
Edit, Write, multi-tool continuation, Agent/subagent, Task runtime operations
when selected, token counting, and current resume/continue. Known limitations
are bounded and documented: Bash redirection permission semantics, per-turn
Task model selection, current PowerShell inventory absence, unconfigured MCP,
and intentionally untested capabilities.

The project is not yet at a final compatibility declaration because CC-006
and CC-008 still lack current targeted tool lifecycles. That remaining
uncertainty does not constitute an open proven Bridge defect.
