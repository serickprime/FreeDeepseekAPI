# Upstream network diagnostics: final branch review

## Review result

- Date: 2026-08-10
- Branch: `fix/upstream-network-diagnostics`
- Base: `origin/main` at `d4c92bb7c644b20c52848117f3523dd30c79036a`
- Audited feature head: `a090219fec032bd297f42b9998da29a99f5b6e12`
- Blockers: none

This review covers the per-request upstream diagnostics implementation, its
offline tests, the bounded live evidence, and the separate Claude Code 2.1.226
tool-exposure investigation. It does not add a network workaround, retry,
session-routing change, tool inheritance, or capability cache.

## Production changes

The production diff is limited to:

- `server.js`: creates and connects one diagnostic request controller to each
  handled completion request and forwards existing upstream stage/error
  callbacks through all existing completion paths;
- `client.js`: emits stages at real execution boundaries, exposes safe error
  metadata to diagnostics, and prevents arbitrary upstream HTTP bodies or fetch
  messages from entering the ordinary error path;
- `lib/tool_diagnostics.js`: implements opt-in structured events, process-local
  correlation, allowlisted fields, and provable error classification;
- `lib/pow.js`: forwards real WASM download/compile/solve stages and safe
  network/HTTP metadata.

No production file outside that list changed.

## Diagnostics architecture and request_ref

`BRIDGE_TOOL_DIAGNOSTICS=1` remains the only switch that emits the new
structured records. With diagnostics disabled, the diagnostic request factory
returns no controller and no structured record is written.

For every handled `/v1/chat/completions`, `/v1/messages`, or `/v1/responses`
request, the Bridge creates a random 16-character lowercase hex `request_ref`
from eight cryptographic random bytes. It is independent of client identity,
upstream session identity, call ID, and request content. It exists only in the
running process and is not persisted. The same value appears in that HTTP
request's `tool_request`, `upstream_stage`, `upstream_error`, and
`tool_response` events. A continuation is another HTTP request and receives a
new value, while its independently hashed upstream session reference may remain
the same. `request_ref` is neither sent to DeepSeek nor returned in OpenAI,
Anthropic, or Responses API payloads.

The real stage sequence is:

- `remote_session_start`, `remote_session_created`;
- `challenge_start`, `challenge_received`;
- `wasm_download_start`, `wasm_downloaded`;
- `wasm_compile_start`, `wasm_compiled`;
- `pow_solve_start`, `pow_solved`;
- `completion_start`, `completion_completed`;
- `stream_received`, `stream_read`, `stream_parsed`.

`stream_read` is emitted immediately before `parseStream()` starts calling
`reader.read()`. A reader failure is therefore reported at `stream_read`, not
at mere HTTP-response receipt.

## Error classification and logging safety

The structured classifier permits only `dns`, `connect`, `tls`, `timeout`,
`http`, `stream`, `pow`, and `unknown`. It maps `ENOTFOUND` and `EAI_AGAIN` to
DNS; `ECONNREFUSED` and `ECONNRESET` to connect; `ETIMEDOUT`, `TimeoutError`,
and `AbortError` to timeout; an allowlist of TLS codes to TLS; valid upstream
HTTP status to HTTP; and active reader failures to stream. WASM/PoW stages are
classified as `pow` only when no more specific code or status proves another
category. Everything else remains `unknown`.

`upstream_error` has an explicit field allowlist and never serializes the error
message, nested cause message, stack, URL, headers, request/response body,
credentials, prompt, content, reasoning, tool schema, tool arguments/results,
session IDs, call IDs, or local paths. Error names, cause codes, status values,
attempt counters, and stages are validated and bounded before logging.

The ordinary `[deepseek-bridge] request error: ...` logger remains. Fetch
exceptions are converted to `fetch failed` or `Upstream request timed out`,
with only a syntactically safe cause code retained. Non-success upstream HTTP
bodies are discarded and are no longer appended to `error.message`. The API
continues to return its existing generalized upstream failure contract.

## Retry invariants

The retry loop, `maxRetries = 2`, `maxRetryDelayMs = 10000`, exponential
backoff, `Retry-After` handling, reset points, and retryable status rules are
unchanged from `origin/main`. Diagnostics observe attempt numbers but do not
create attempts. In particular, an ordinary `fetch failed` without a preexisting
retryable marker remains non-retryable; timeout handling retains the existing
504/retryable behavior.

Offline tests demonstrate both an existing retry recovering and exhaustion of
the existing three-attempt budget under one `request_ref` without changing the
policy.

## Session and tool invariants

There is no branch diff in `SessionResolver`, `SessionStore`, the client versus
upstream identity split, Claude session-header semantics, the strict tool
parser, `toolPrompt`, allowed-tool validation, reasoning-only correction,
repeated-tool correction, call-ID linking, continuation construction, or
stateless normal-turn behavior.

Tests confirm that a continuation receives a new `request_ref`, keeps the
appropriate upstream session reference, and may keep the same client session
reference. The Bridge continues to trust only the tools included in the
current client request. A `tools = 0` internal request is not automatically a
defect and does not inherit an earlier allowlist.

## PoW invariants

The DeepSeek WASM URL, cache key and eviction behavior, challenge fields,
WebAssembly imports, memory operations, solve call, numeric validation, and
returned answer calculation are unchanged. The only additions are stage
callbacks and safe network/HTTP metadata propagation. No alternative URL,
algorithm change, or new cache was added.

## Tests and probe review

The unit suite covers:

- same-request and parallel `request_ref` correlation, continuation identity,
  response exclusion, and diagnostics disabled by default;
- DNS, connect, TLS, timeout, HTTP 403/429/500, WASM, and stream-reader errors;
- safe cause/status/category/attempt fields, successful retry, exhausted retry,
  and secret-free ordinary and structured logging;
- the Claude Code 2.1.226 probe's exact argument shapes and safe record
  allowlist.

All network-error tests use injected mock fetch/streams and make no external
request. The tool-exposure helper listens only on an ephemeral `127.0.0.1`
port, caps message requests at eight, has a 60-second process timeout, records
only safe structural fields, and neither reads nor modifies user settings. It
is not wired into normal Bridge startup or the npm test command as an executing
CLI probe; unit tests import only its pure helpers.

## Claude Code 2.1.226 investigation

The live tool-cycle evidence was correctly classified as
`TOOL_MISSING_FROM_REQUEST`, not `MODEL_SKIPPED_GLOB`: every tool-capable Bridge
request contained `Read` but not `Glob`. Read calls and their tool-result
continuations worked.

Five localhost contract probes then established `CLI_INVOCATION_ERROR` for that
missing tool. Default mode included both built-ins; explicit Glob-only and
Read-only selections sent the corresponding single tool; and
`--tools "Glob,Read" --allowedTools "Glob,Read" --permission-mode dontAsk`
sent both tools and retained both after a tool result. Reproducing the previous
command with `--bare` sent only `Read`. Installed help identifies `--bare` as
SIMPLE mode (`CLAUDE_CODE_SIMPLE=1`), and the installed binary contains a
reduced built-in-tool branch for that mode.

The supported conclusion is specific to the tested Claude Code 2.1.226
invocation: do not use `--bare` when excluded SIMPLE-mode tools such as `Glob`
are required. This is not a Bridge parsing or capability defect, and the Bridge
must not synthesize missing tools.

## Controlled network evidence

The one authorized doctor run passed authentication, remote session creation,
challenge, WASM download/compile, PoW, completion, and stream parsing. Bounded
Claude Code 2.1.226 live runs confirmed that `request_ref` separates interleaved
main and internal requests and that Read tool-result continuation works.

Neither `fetch failed` nor timeout recurred, no `upstream_error` was emitted,
and no retry was observed in those runs. Consequently, the root cause of the
older network failures remains unconfirmed. This branch provides the safe
correlation needed for a future natural recurrence but provides no factual
basis for a new network retry or fallback.

## Validation and merge compatibility

- Syntax checks: passed for all changed JavaScript files and the unit suite.
- `git diff --check origin/main...HEAD`: passed.
- `npm.cmd test`: 144/144 passed.
- `git merge-tree` against current `origin/main`: no conflicts.
- Secret/personal-path scan of the branch diff: no sensitive value found.
- Unexpected tracked files: none.

Known limitations are that the historical network failure was not reproduced,
Claude Code behavior is version- and invocation-specific, and diagnostics must
be enabled before an incident to provide correlation. No blocker remains for a
review-only pull request. Merge and auto-merge are outside this review.
