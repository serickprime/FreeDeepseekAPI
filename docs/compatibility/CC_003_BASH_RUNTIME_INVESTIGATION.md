# CC-003 Bash Runtime Investigation

## Environment

- Date: 2026-08-11
- Main baseline: `6105951d45a45fde11e298b4c85778d16e1a50fc`
- Audit branch: `audit/cc-003-bash-runtime-investigation`
- Claude Code: `2.1.226`
- Node.js: `v24.12.0`
- OS: Windows 11, `win32-x64`
- Model: `deepseek-reasoner`
- Bridge endpoint: loopback port 9655
- Diagnostics: `BRIDGE_TOOL_DIAGNOSTICS=1`

This was a runtime-cause investigation only. Bridge production code, tests,
configuration, parser behavior, retry behavior, session behavior, network
behavior, model aliases, and global Claude configuration were not changed.

## Prior evidence

The preceding CC-002/CC-003 re-evaluation classified CC-003 as
`CC_003_PARTIAL`:

- the normal Windows Claude Code inventory advertised `Bash` but not
  `PowerShell`;
- a Bash `node --version` lifecycle passed;
- two strict Bash file-operation calls returned explicit `is_error=true`;
- a later `Write` fallback created the requested file, which was correctly not
  attributed to Bash;
- the first known failure boundary was `CLAUDE_CODE_TOOL_RUNTIME`;
- the exact historical runtime cause was `UNKNOWN` because result text was not
  retained.

This report adds new controlled evidence without rewriting that history.

## Invocation and safety boundary

The investigation reused the proven client launch pattern:

- direct native Claude executable;
- no shell wrapper and no `shell:true`;
- `--print`, structured `stream-json`, and `--verbose`;
- realtime `stream-json` stdin for the dedicated multi-turn invocation;
- `deepseek-reasoner`;
- no `--bare`, `--resume`, `--continue`, permission bypass, global Bash allow,
  or persistent permission update;
- absolute temporary paths and a disposable fixture outside the repository.

Invocation 1 used the normal tool inventory and an exact temporary permission
rule for the read-only Bash control. Invocation 2 exposed only `Bash` and
`Read`; `Write` and `Edit` were unavailable, preventing fallback from being
misattributed to Bash. It supplied exact temporary rules for only the three
deterministic mutation commands. The structured tool input was compared in
memory with the expected command before classification. Unexpected command
text was not retained.

No interactive permission prompt appeared. A configured rule is recorded
separately from its effective runtime result: the redirection command had an
exact temporary rule but Claude Code still returned a permission-denied tool
result.

Raw prompts, commands, tool arguments, result text, model content, reasoning,
credentials, session IDs, and call IDs are not stored in this report. Failed
result text was inspected in memory only. No error excerpt was retained; only
the bounded category `PERMISSION_DENIED` was kept.

## Tool inventory

The first normal-inventory request advertised 25 tools.

| Tool | Advertised |
| --- | --- |
| Bash | Yes |
| PowerShell | No |
| Read | Yes |
| Write | Yes |
| Edit | Yes |

The dedicated mutation invocation restricted the inventory to `Bash` and
`Read` only.

## New test matrix

| Test | Strict Bash | Expected command matched | Permission | Explicit error | Physical result | External Bash control | Safe error category | Classification |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- |
| Node version control | Yes | Yes | exact temporary rule effective; no prompt | 0 | no mutation expected | exit 1 | `NONE` | PASS |
| Node-based file write | Yes | Yes | exact temporary rule effective; no prompt | 0 | exact file content created | exit 1; no file | `NONE` | PASS |
| POSIX-style redirection | Yes | Yes | exact temporary rule supplied but denied at runtime; no prompt | 1 | file absent | exit 1; no file | `PERMISSION_DENIED` | `PERMISSION_FAIL` |
| Simple touch | Yes | Yes | exact temporary rule effective; no prompt | 0 | file created | exit 1; no file | `NONE` | PASS |

The touch discriminator was run because redirection failed. No identical
failing command was repeated.

The Node-based write proves that filesystem mutation from the Claude Code
Bash tool is not categorically blocked. The touch result independently
confirms that a simple mutating shell operation works. The failure is limited
to the tested redirection command form under the exact temporary permission
policy.

## Safe request correlation

Each tool call was strict and each continuation contained exactly the current
result. Ordinary final text produced `invalid_json` parser reasons but did not
match the CC-001 brace predicate and was not exposed as raw tool JSON.

| Seq. | Test boundary | request_ref | Results/errors | Selected | Strict | Parse | Retry | Outcome | Completions |
| ---: | --- | --- | --- | --- | --- | --- | --- | --- | ---: |
| 1 | control call | `51c92d269618078f` | 0/0 | Bash | Yes | content/accepted | none | tool_call | 1 |
| 2 | control result | `c535aa7d0483396d` | 1/0 | none | No | content/invalid_json | none | final_text | 1 |
| 3 | Node write call | `a25d6795420d05f9` | 0/0 | Bash | Yes | content/accepted | none | tool_call | 1 |
| 4 | Node write result | `726d1d38203117ae` | 1/0 | none | No | content/invalid_json | none | final_text | 1 |
| 5 | redirection call | `dc5605cb2c5d15c0` | 0/0 | Bash | Yes | content/accepted | none | tool_call | 1 |
| 6 | redirection result | `160a1ff05b2d6c6c` | 1/1 | none | No | content/invalid_json | none | final_text | 1 |
| 7 | touch call | `638d9e8cc0ee8eaf` | 0/0 | Bash | Yes | content/accepted | none | tool_call | 1 |
| 8 | touch result | `46fc2dd223f607b4` | 1/0 | none | No | content/invalid_json | none | final_text | 1 |

For every row:

- `brace_tool_retry_attempted = false`;
- `tool_retry_reason = none`;
- network error = false;
- upstream completion count = 1.

## External Bash control

Windows exposed a system `bash.exe` launcher, but all four corresponding
external controls exited with code 1. No mutation file was created. No raw
stderr was retained, so the external cause is `UNKNOWN`.

This is secondary environment evidence only. It does not prove that Claude
Code uses the same executable or runtime. The Claude Code Bash tool itself
successfully executed the Node version control, Node-based file write, and
touch operation during this investigation.

## Root-cause decision

- First failing boundary: `CLAUDE_CODE_TOOL_RUNTIME`, specifically its Bash
  permission handling for the tested redirection command form.
- Evidence-based error category: `PERMISSION_DENIED`.
- Root-cause confidence: `CONFIRMED` for permission denial; `UNKNOWN` for the
  internal reason the supplied exact rule did not authorize that command
  form.
- Model command mismatch: no. Every tested tool input matched the expected
  deterministic command.
- General filesystem mutation failure: disproven by the successful Node write
  and touch operations.
- General Bash runtime failure: disproven by three successful Bash lifecycles.
- Bridge argument corruption evidence: no. Claude Code received the expected
  structured command after strict Bridge acceptance.
- Bridge parser, retry, continuation, session, or network defect: not shown.

The available evidence points to command-form-specific Claude Code permission
behavior, not quoting repair, model alteration, or Bridge mutation.

## Classification and action

- Final CC-003 classification: `CC_003_COMMAND_FORM_PARTIAL`.
- `BRIDGE_PRODUCTION_FIX_REQUIRED`: `NO`.
- Next action: `DOCUMENT_CLIENT_LIMITATION`.

No CC-003 production fix should be prepared from this evidence. Safe
Node-based writes and simple mutations already work through the current
Bridge, while POSIX-style redirection may require a different Claude Code
permission rule or client behavior. That client-side detail was not changed
or broadened in this audit branch.

## Run totals and cleanup

- Foreground Claude invocations: 2.
- User prompts: 4.
- `/v1/messages` requests: 8.
- Raw tool-like JSON occurrences: 0.
- CC-001 brace recovery events: 0.
- Network errors: 0.
- Maximum upstream completions per request: 1.
- Disposable fixture removed: yes.
- Port 9655 after cleanup: free.
- Leftover Claude processes: 0.
- `npm.cmd test`: 202/202 PASS after the investigation.
- Required `node --check`: PASS.
- `git diff --check`: PASS.
- Production files changed: no.

Overall investigation classification: `CC_003_INVESTIGATION_COMPLETE`.
