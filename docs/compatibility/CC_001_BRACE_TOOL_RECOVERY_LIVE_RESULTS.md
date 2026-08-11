# CC-001 Brace Tool Recovery Live Results

Date: 2026-08-11

Branch: `fix/cc-001-brace-tool-recovery`

Implementation SHA: `7d1e57c78e5ca5a5e5e0d12f7b6faa9e77853dbd`

Classification: `CC_001_LIVE_PASS_DIRECT`

## Environment and invocation guard

- Claude Code: `2.1.226`
- Node.js: `v24.12.0`
- model: `deepseek-reasoner`
- Bridge endpoint: loopback port 9655
- diagnostics: enabled
- foreground Claude invocations: 1
- prompts: 2
- foreground wrapper root PID: 10396
- maximum matching Claude processes: 1 (PID 10140)
- independent second Claude root: no

The validation used one disposable fixture outside the production repository.
No shell tool was enabled or tested.

## Request summary

- `/v1/messages`: 7
- tool-capable requests: 7
- tool-result continuations: 5
- advertised tools: `Edit`, `Glob`, `Grep`, `Read`
- real tool-use events: 5
- real tool-result events: 5
- maximum upstream completions per request: 1
- network errors: 0

Every request reached `completion_completed`, `stream_received`,
`stream_read`, and `stream_parsed` exactly once.

| request_ref | continuation | results/errors | selected tool | parse source/reason | strict | retries | outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `30b3faf695b85416` | no | 0/0 | Glob | content/accepted | yes | none | tool_call |
| `8e15e934382fa991` | yes | 1/0 | Read | content/accepted | yes | none | tool_call |
| `db6eaa3bdccf480b` | yes | 1/0 | Grep | content/accepted | yes | none | tool_call |
| `f5e5b681c1da3206` | yes | 1/0 | none | content/invalid_json | no | none | final_text |
| `f46fd4d95f614eca` | no | 0/0 | Edit | content/accepted | yes | none | tool_call |
| `289897a4f8e3fc09` | yes | 1/0 | Read | content/accepted | yes | none | tool_call |
| `0ae38e7bedde46a1` | yes | 1/0 | none | content/invalid_json | no | none | final_text |

The two `invalid_json` final responses were ordinary final text selections:
they did not produce tool calls, recovery flags, or raw tool-like text in the
Claude UI. No rejected matching brace class occurred.

For all seven responses:

- `reasoning_retry_attempted = false`
- `fenced_tool_retry_attempted = false`
- `prefixed_tool_retry_attempted = false`
- `brace_tool_retry_attempted = false`
- `repeated_tool_retry_attempted = false`
- `tool_retry_reason = none`

## Tool flows

Prompt 1 produced the requested real sequence:

`Glob -> tool_result -> Read -> tool_result -> Grep -> tool_result -> final_text`

Prompt 2 produced:

`Edit -> tool_result -> Read -> tool_result -> final_text`

The Edit result was successful and the subsequent Read completed. Independent
physical verification found the expected punctuation change in the disposable
source file.

## Recovery and safety observations

- brace recovery: `NOT_TRIGGERED`
- brace retry count: 0
- CODE_FENCE retry count: 0
- PREFIXED_TOOL_LIKE retry count: 0
- reasoning retry count: 0
- repeated-tool retry count: 0
- raw tool-like JSON visible: no
- safe failures: 0
- duplicate final events observed: no

The model returned strict calls directly for all five tools. The stochastic
brace-delimited malformed class did not recur, so the prompts were not
repeated. This is a valid no-regression live result; deterministic offline
tests remain the direct evidence for the recovery path.

## Cleanup

- Claude process tree closed: yes
- leftover test Claude processes: 0
- Bridge stopped: yes
- port 9655 free: yes
- disposable fixture removed: yes
- production repository modified by live tools: no

Final live classification: `CC_001_LIVE_PASS_DIRECT`.
