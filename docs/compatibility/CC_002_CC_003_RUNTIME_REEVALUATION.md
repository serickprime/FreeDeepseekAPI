# CC-002 / CC-003 Runtime Re-evaluation

## Environment

- Date: 2026-08-11
- Main SHA: `aef6ab62c55b11f87550534e094955f1297dd456`
- Audit branch: `audit/cc-002-cc-003-runtime-reevaluation`
- Claude Code: `2.1.226`
- Node.js: `v24.12.0`
- OS: Windows 11 Home 64-bit (`10.0.26200`)
- Intended model: `deepseek-reasoner`
- Bridge endpoint: loopback port 9655
- Diagnostics: `BRIDGE_TOOL_DIAGNOSTICS=1`

## Scope and safety

This was a documentation-only re-evaluation of CC-002 (`Write`) and CC-003
(Windows shell tools). Production code, tests, configuration, model aliases,
parser behavior, retry behavior, session behavior, and network behavior were
not changed.

The disposable fixture was outside the production repository. The test
instrumentation retained no prompts, tool arguments, tool-result text, model
content, reasoning, credentials, session IDs, or call IDs.

## Baseline

- `npm.cmd test`: 202/202 PASS before the attempted live run.
- Required `node --check` commands: PASS.
- `git diff --check`: PASS.
- Independent Claude roots before launch: 0.
- Port 9655 before Bridge startup: free.
- Relevant documented CLI flags: `--allowedTools`, `--permission-mode`, and
  `--tools`. The attempted normal-inventory launch did not pass `--tools`.

## Live attempt boundary

One Claude Code foreground process was launched. The process received one
planned user turn, then exited with code 1 before producing a structured
Claude event and before sending any request to the Bridge.

The safety harness recorded only that stderr was present. It intentionally did
not retain arbitrary stderr text. Therefore the exact client-side launch cause
is `UNKNOWN`; no Bridge, upstream, tool-runtime, or network cause is proven.
The run was not repeated because this phase authorized one foreground
invocation only.

Safe attempt statistics:

| Metric | Observed |
| --- | --- |
| Foreground invocations | 1 |
| User turns submitted to the process | 1 |
| Structured Claude result events | 0 |
| `/v1/messages` requests | 0 |
| Tool-capable requests | 0 |
| Tool inventory captured | No |
| Real `tool_use` events | 0 |
| Real `tool_result` events | 0 |
| Raw tool-like JSON visible | 0 |
| CC-001 recovery events | 0 |
| Upstream completions | 0 |
| Network errors | 0 observed; no network request was made |

## Request correlation

No Bridge request existed, so no `request_ref`, `selected_tool_name`, strict
parse result, retry reason, continuation count, or tool-result error count was
available.

| Test | Request ref | Selected tool | Result count | Error count | Strict | Retry | Outcome | Network | Physical result |
| --- | --- | --- | ---: | ---: | --- | --- | --- | --- | --- |
| CC-002A Write + Read | none | none | 0 | 0 | not reached | none | client process exited before request | not reached | file not created |
| CC-002B independent Write + Read | none | not reached | 0 | 0 | not reached | none | not run | not reached | not run |
| CC-003 shell read | none | not reached | 0 | 0 | not reached | none | not run | not reached | not run |
| CC-003 shell write + Read | none | not reached | 0 | 0 | not reached | none | not run | not reached | not run |

## CC-002 — Write

### Original finding

The historical compatibility audit classified `Write` as FAIL. Later
controlled CC-009 and CC-001 validations demonstrated successful strict
`Write` and `Edit` lifecycles, so CC-002 required re-evaluation rather than an
assumed production fix.

### New evidence

- `Write` advertised: `UNKNOWN` (no request reached the Bridge).
- `Write` selected: not reached.
- Strict tool call: not reached.
- Explicit tool-result error: not reached.
- Read continuation: not reached.
- Physical verification: the first planned file was not created; the tool was
  never invoked.
- Raw tool JSON: none observed.
- Recovery: none triggered.
- Network: not reached.
- Reproducibility: not evaluated; the single authorized process exited before
  the first API request.

### CC-002 decision

- Final status: `CC_002_BLOCKED`
- Production fix required: `UNKNOWN`
- Historical cause: `UNKNOWN / NOT RE-EVALUATED`

This result neither reproduces nor clears CC-002. It provides no evidence for
a Bridge production change.

## CC-003 — Bash / PowerShell

### Actual inventory

- `PowerShell` advertised: `UNKNOWN`
- `Bash` advertised: `UNKNOWN`

The normal tool inventory was not observable because Claude Code sent no
request. Absence from the captured inventory must not be inferred as
`SHELL_NOT_ADVERTISED`.

### Tool results

| Tool | Selected | Permission prompt | Permission approved | Error count | Read-only command | File operation | Continuation | Physical result | Status |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |
| PowerShell | not reached | not reached | not reached | 0 | not run | not run | not reached | not run | `SHELL_NOT_TESTED` |
| Bash | not reached | not reached | not reached | 0 | not run | not run | not reached | not run | `SHELL_NOT_TESTED` |

### CC-003 decision

- Final status: `CC_003_BLOCKED`
- Production fix required: `UNKNOWN`
- First failing boundary: `CLAUDE_CODE_CLIENT` launch, before Bridge contact.
- Root cause confidence: `UNKNOWN`

This result does not reproduce a shell runtime error and provides no evidence
for a Bridge production change.

## Cleanup and post-attempt validation

- Claude process leftovers: 0.
- Bridge stopped; port 9655: free.
- Disposable fixture: removed.
- `npm.cmd test`: 202/202 PASS.
- `node --check server.js`: PASS.
- `node --check lib/tool_diagnostics.js`: PASS.
- `node --check lib/tool_retry.js`: PASS.
- `git diff --check`: PASS.
- Production files changed: no.

## Decision

- CC-002: `CC_002_BLOCKED`
- CC-003: `CC_003_BLOCKED`
- Next action: `INVESTIGATE_CC002` and `INVESTIGATE_CC003` in a separately
  authorized controlled run that first establishes a successful normal Claude
  Code client launch. Do not begin a production fix from this evidence.
- Overall classification: `CC_002_CC_003_REEVALUATION_BLOCKED`
