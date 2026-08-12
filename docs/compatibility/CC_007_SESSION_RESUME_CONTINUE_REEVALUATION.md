# CC-007 Claude Session Resume/Continue Re-evaluation

Date: 2026-08-12

## Runtime

- Main baseline: `7d3a868ec9d6399bb8814233aad33f54626e4570`
- Branch: `audit/cc-007-session-resume-continue`
- Claude Code: `2.1.226`
- Node.js: `v24.12.0`
- OS: Microsoft Windows
- Model: `deepseek-reasoner`
- Authorized chain: one `START`, one explicit `RESUME`, one `CONTINUE`
- Foreground Claude processes: `3`
- Repeated stages or retries: `0`
- Production code changed before testing: `NO`

## Historical finding

The historical controlled chain reported two distinct observations:

- explicit `--resume` exited before any Bridge request; and
- `--continue` reached the Bridge with a different client fingerprint from the
  controlled start.

The historical resume boundary was `CLAUDE_CODE_CLIENT` before Bridge. The
underlying persistence reason was unknown, and no Bridge production defect was
proven.

## Current CLI contract

The installed Claude Code `2.1.226` help documents:

- `--resume [value]`: resume by session ID or open the session picker;
- `--continue`: continue the most recent conversation in the current
  directory;
- print-mode session persistence unless `--no-session-persistence` is used;
  and
- structured `stream-json` output in print mode.

The test used direct native executable launches, structured stream output,
normal session persistence, the same disposable working directory for all
three processes, and no tool calls.

## Offline source boundary

The current identity path is:

Claude native session identity
-> inbound `x-claude-code-session-id`
-> `SessionResolver.clientSession`
-> hashed client key and process-scoped diagnostic client reference
-> request handling.

`SESSION_IDENTITY_SOURCE = x-claude-code-session-id`

`SESSION_RESOLVER_INPUT = inbound request headers`

The native Claude client identity is diagnostic correlation; it does not make
ordinary no-tool turns use one stateful Bridge upstream route. Without an
explicit `x-agent-session`, metadata/user identity, or tool-result linkage,
`SessionResolver` creates an anonymous upstream route for each request.

`UPSTREAM_LINKAGE_OBSERVABLE = SOURCE_AND_BOUNDED_REFERENCE_ONLY`

The existing diagnostics safely exposed equality of the resolver-derived
client reference. They did not expose raw keys or identifiers.

## Isolation and observer

A temporary loopback observer forwarded original request bytes to the
unchanged Bridge. It parsed an in-memory copy only to retain bounded structure
and process-salted identity equality.

- Observer health: `PASS`
- Bridge health: `PASS`
- Request bytes identical: `YES`
- Observer errors: `0`
- Agent/tool contamination: `NO`
- Tool-use events: `0`
- Network errors: `0`

## Invocation matrix

| Invocation | Exit | Result subtype | Bridge requests | `/v1/messages` | Same client fingerprint as START | Prior context present | Context match | Outcome |
| --- | ---: | --- | ---: | ---: | --- | --- | --- | --- |
| START | 0 | `success` | 2 | 1 | BASELINE | NO | YES | PASS |
| RESUME | 0 | `success` | 2 | 1 | YES | YES | YES | PASS |
| CONTINUE | 0 | `success` | 2 | 1 | YES | YES | YES | PASS |

The Bridge request count includes one local count-token request and one
`/v1/messages` request for each foreground process.

## Required safe fields

`START_SESSION_ID_AVAILABLE = YES`

`START_BRIDGE_REQUESTS = 2`

`START_EXIT_CODE = 0`

`START_RESULT_SUBTYPE = success`

`RESUME_ATTEMPTED = YES`

`RESUME_EXIT_CODE = 0`

`RESUME_RESULT_SUBTYPE = success`

`RESUME_BRIDGE_REQUESTS = 2`

`RESUME_CLIENT_ID_SAME_AS_START = YES`

`RESUME_CONTEXT_MATCH = YES`

`CONTINUE_ATTEMPTED = YES`

`CONTINUE_EXIT_CODE = 0`

`CONTINUE_RESULT_SUBTYPE = success`

`CONTINUE_BRIDGE_REQUESTS = 2`

`CONTINUE_CLIENT_ID_SAME_AS_START = YES`

`CONTINUE_CONTEXT_MATCH = YES`

`RESOLVER_KEY_SAME_AS_START = YES`

The resolver equality field refers only to the bounded diagnostic client
reference derived from the native Claude header. It is not a claim that the
anonymous upstream session key was reused.

## Resume finding

Explicit resume reached the Bridge, supplied structurally preserved prior
context, retained the same native client fingerprint and resolver-derived
client reference, exactly matched the synthetic context probe, and returned a
terminal successful result.

- First failing boundary: none
- Historical zero-request resume boundary: `NOT_REPRODUCED`
- Resume classification: `PASS`

## Continue finding

Continue reached the Bridge, supplied structurally preserved prior context,
retained the same native client fingerprint and resolver-derived client
reference as START, exactly matched the synthetic context probe, and returned
a terminal successful result.

- `CONTINUE_IDENTITY_STABLE = YES`
- `CONTINUE_CONTEXT_PASS = YES`
- Historical different-client observation: `NOT_REPRODUCED`
- Continue classification: `PASS`

Functional continuity and identity equality are recorded separately. Both
passed in this chain; neither conclusion depends on raw identifier values.

## Bridge decision

All three processes reached the unchanged Bridge. Resume and continue carried
their previous conversation structurally in the client request, preserved the
native client correlation, and recovered the synthetic context without a
network or model ambiguity. The ordinary upstream source remained `anonymous`,
consistent with the documented resolver behavior for no-tool requests without
an explicit upstream identity.

No misrouting, lost request, client-identity change, or context-continuity
failure was observed.

`BRIDGE_DEFECT_EVIDENCE = NO`

`PRODUCTION_FIX_REQUIRED = NO`

`CLIENT_PERSISTENCE_ROOT_CAUSE = UNKNOWN`

The current pass does not establish why the historical client-side resume
failure occurred.

## Security and cleanup

The raw Claude session ID was held only in memory long enough to perform the
single explicit resume. It was not written to the safe summary, journal,
report, command output, or Git history.

No raw prompts, responses, context marker, headers, request/response bodies,
credentials, session IDs, call IDs, or private paths were retained. Only
counts, booleans, enums, structural context presence, and salted equality
observations were persisted temporarily.

- Test-owned Claude leftovers: `0`
- Test-owned Bridge/observer leftovers: `0`
- Ports 9655/9656 free: `YES`
- Disposable fixture removed: `YES`
- Temporary observer/harness and safe artifacts removed: `YES`

## Validation

- Pre-live tests: `202/202 PASS`
- Post-live tests: `202/202 PASS`
- Required `node --check`: `PASS`
- `git diff --check`: `PASS`
- Production files changed: `NO`
- Test files changed: `NO`

## Final classification

`CC_007_REEVALUATED_PASS`

`RESUME_CLASSIFICATION = PASS`

`CONTINUE_CLASSIFICATION = PASS`

`HISTORICAL_RESUME_FAILURE = NOT_REPRODUCED`

`HISTORICAL_CONTINUE_IDENTITY_DIFFERENCE = NOT_REPRODUCED`

`BRIDGE_DEFECT_EVIDENCE = NO`

`PRODUCTION_FIX_REQUIRED = NO`

`NEXT_ACTION = NO_CC007_FIX`
