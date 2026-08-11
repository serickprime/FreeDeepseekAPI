# CC-004 Agent Reproduction

Date: 2026-08-11

Production baseline: `6f0fb69331919ca0c95453a61cf211cfb2fdeb2e`

Branch: `fix/cc-004-agent-model-alias`

Claude Code: `2.1.226`

Node.js: `v24.12.0`

## Scope and authorization

This report records the one explicitly authorized replacement reproduction on
unchanged production code. The previous invocation is `NON_EVIDENTIARY`: its
execution wrapper stopped waiting before the bounded in-memory summary was
persisted, so it cannot support a CC-004 classification.

The replacement used the proven direct native Claude executable pattern,
structured `stream-json`, verbose mode, `deepseek-reasoner` as the top-level
model, normal Claude Code tool inventory, and a disposable read-only fixture.
It sent one user prompt in one foreground invocation. No production or test
file was changed before or during reproduction.

The replacement harness synchronously appended and flushed only bounded safe
records. It did not retain prompts, Agent arguments, tool arguments, tool
results, model output, reasoning, message bodies, headers, credentials,
session IDs, call IDs, or absolute user paths.

## Runtime result

- Foreground invocations: 1 replacement.
- User prompts: 1.
- Foreground exit code: 0.
- Messages requests: 5.
- Parent tool inventory: 25.
- Agent advertised: yes.
- Agent selected as a strict tool call: yes.
- Structurally nested requests: 3.
- Nested requested model: `deepseek-reasoner` on all three requests.
- `claude-opus-5` observed: no.
- Local unsupported-model rejection: no.
- Nested upstream reached: yes.
- Agent result reached the parent: yes, with zero explicit tool-result errors.
- Parent final reached: yes.
- Pending requests after the quiet interval: 0.
- Orphan requests after parent final: 0.
- Active test Claude processes after the quiet interval: 0.
- Network errors: 0.
- Raw tool-like JSON occurrences: 0.
- Brace recovery events: 0.
- Other retry events: 0.
- Maximum completions per request: 1.

### Request sequence

| Boundary | Request ref | Requested model | Tools | Current results / errors | Upstream | Outcome |
| --- | --- | --- | --- | ---: | --- | --- |
| Parent initial | `80670126973608fd` | `deepseek-reasoner` | strict `Agent` | 0 / 0 | reached | tool call |
| Nested initial | `7c36c62b5a7bd67a` | `deepseek-reasoner` | strict `Glob` | 0 / 0 | reached | tool call |
| Nested continuation | `4f54618aa5380326` | `deepseek-reasoner` | strict `Read` | 1 / 0 | reached | tool call |
| Nested continuation | `0f18a6ff59466e86` | `deepseek-reasoner` | none | 1 / 0 | reached | nested final text |
| Parent continuation | `262940b092669493` | `deepseek-reasoner` | none | 1 / 0 | reached | parent final text |

The safe client correlation fingerprint was shared across these requests, so
it was not used alone to label the nested boundary. The nested classification
is structural: the three middle requests occurred after the parent Agent
tool use and before its parent-side tool result, used a 22-tool inventory
instead of the parent's 25-tool inventory, completed the `Glob` and `Read`
result lifecycles, and were followed by the Agent result and the restored
25-tool parent continuation. No prompt-content heuristic was used.

## CC-004 decision

The historical exact alias failure did not reproduce on the current main.
The current Claude Code runtime used the already supported
`deepseek-reasoner` model for the nested Agent lifecycle. Nested `Glob` and
`Read` both completed successfully, the nested result reached the parent, and
the parent produced a final response.

Classification: `CC_004_REEVALUATED_PASS`

`PRODUCTION_FIX_REQUIRED = NO`

No compatibility alias was added. In particular, no exact or wildcard Claude
alias was added to model resolution or to the public model catalogue.

`NEXT_ACTION = NO_CC004_FIX`
