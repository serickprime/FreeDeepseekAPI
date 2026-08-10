# Claude Code 2.1.226 tool exposure investigation

## Result

- Confirmed classification: `CLI_INVOCATION_ERROR`
- Root cause: the previous live invocation included `--bare`. Claude Code
  documents that this flag sets `CLAUDE_CODE_SIMPLE=1`, and the installed
  2.1.226 binary contains a separate reduced built-in-tool construction branch
  for SIMPLE mode. In the reproduced command, that mode retained `Read` but
  removed `Glob` from the requested built-ins.
- Bridge production changes required: no

The Bridge correctly used the tools sent by the client. It must not synthesize,
inherit, or cache the missing `Glob` capability.

## Installed Claude Code

- Version: `2.1.226`
- Installation: global npm package `@anthropic-ai/claude-code@2.1.226`
- The npm command shim launches the package's bundled native executable.
- No update, reinstall, or downgrade was performed.

## Relevant local help

The installed `claude --help` reports:

- `--tools <tools...>` selects available built-in tools; it accepts comma- or
  space-separated names and uses `default` for the default built-in set.
- `--allowedTools <tools...>` and `--disallowedTools <tools...>` control tool
  permissions and accept comma- or space-separated names.
- `--permission-mode` accepts `acceptEdits`, `auto`, `bypassPermissions`,
  `manual`, `dontAsk`, and `plan`.
- `--settings` loads a settings file or JSON; `--setting-sources` selects user,
  project, and local settings sources.
- `--agent` and `--agents` select or define agents.
- `--mcp-config` and `--strict-mcp-config` control MCP configuration.
- `--safe-mode` disables customizations but states that built-in tools and
  permissions continue normally.
- `--bare` enables minimal mode and sets `CLAUDE_CODE_SIMPLE=1`.

`--tools` limits built-in tools, not separately configured MCP tools. This is
why the correct Glob+Read probe also contained the two configured `context7`
MCP tools.

## Relevant settings

- NOCTIS has no project `.claude` directory, project settings, `CLAUDE.md`,
  project agents, or project MCP configuration.
- User settings contain only UI keys and have no `tools`, `allowedTools`,
  `disallowedTools`, `permissions`, `permissionMode`, or `agent` setting.
- No known managed settings file or Anthropic policy registry key was present.
- The legacy user configuration has no NOCTIS project entry. It defines one
  global MCP server, `context7`; this adds MCP tools but does not remove Glob.

No project or user permission restriction explains the live Read-only request.

## Previous live invocation

The previous tool-cycle live used this tool-related command shape:

```text
claude.cmd --print --output-format stream-json --verbose --no-session-persistence --safe-mode --bare --no-chrome --disable-slash-commands --tools Glob Read --allowedTools Glob Read --disallowedTools Edit,Write,Bash,NotebookEdit,WebFetch,WebSearch --permission-mode dontAsk --model deepseek-reasoner <single-line-prompt>
```

Although the installed help accepts space-separated tool names, `--bare`
activated SIMPLE mode before tool exposure. The exact command shape was
reproduced by Probe E and sent only `Read`.

## Localhost contract probes

All five probes used new Claude sessions and a bounded mock Anthropic endpoint
on `127.0.0.1`. They made no DeepSeek request. The mock retained only safe tool
metadata and never retained prompts, schemas, request bodies, tool arguments,
tool results, credentials, or identifier values.

### Probe A — default

- Requests: 1
- Tool count: 30
- Included built-ins: `Agent`, `Bash`, `CronCreate`, `CronDelete`, `CronList`,
  `Edit`, `EnterWorktree`, `ExitWorktree`, `Glob`, `Grep`, `NotebookEdit`,
  `Read`, `ReportFindings`, `ScheduleWakeup`, `SendMessage`, `TaskCreate`,
  `TaskGet`, `TaskList`, `TaskOutput`, `TaskStop`, `TaskUpdate`, `WebFetch`,
  `WebSearch`, `Workflow`, and `Write`
- Also included resource-related built-ins and the two configured `context7`
  MCP tools.
- Both `Glob` and `Read` were present by default.

### Probe B — Glob only

- Official mechanism: `--tools Glob --allowedTools Glob`
- Requests: 1
- Tools: `Glob`

### Probe C — Read only

- Official mechanism: `--tools Read --allowedTools Read`
- Requests: 1
- Tools: `Read`

This control reproduces the single built-in tool shape seen in the live
request.

### Probe D — Glob + Read

- Official mechanism: `--tools "Glob,Read" --allowedTools "Glob,Read"`
- Requests: 2
- First request tools: `Glob`, `Read`, plus the two configured `context7` MCP
  tools
- The mock returned one Glob tool call; Claude executed it and sent one tool
  result.
- Request after tool result contained the same four tools. `Glob` and `Read`
  were therefore retained across continuation.

### Probe E — previous command

- Reproduced the previous space-separated tool arguments together with
  `--safe-mode`, `--bare`, the previous deny list, and `dontAsk`.
- Requests: 1
- Tools: `Read`

No probe produced a parallel internal `/v1/messages` request. Probe D produced
two sequential requests because of its single bounded tool-result cycle.

### Review-fix isolation recheck

The five results above remain historical evidence from the original
investigation. The tracked helper now adds the documented Claude Code 2.1.226
flags `--safe-mode` and `--strict-mcp-config` to every probe. Safe mode disables
user/project customizations and MCP configuration, while strict MCP mode allows
only explicitly supplied `--mcp-config` entries; the helper supplies none.
Admin-managed policy remains outside CLI control.

One authorized bounded `glob-read` localhost recheck completed with exit code
0 and two `/v1/messages` requests. Both requests contained exactly `Glob` and
`Read`; the second contained the expected tool result. No `context7` or other
inherited MCP tool was exposed. No DeepSeek or Bridge-to-DeepSeek request was
made.

## Verified invocation

The locally verified tool-selection fragment for Claude Code 2.1.226 is:

```text
--tools "Glob,Read" --allowedTools "Glob,Read" --permission-mode dontAsk
```

It must be used without `--bare`. The complete mock probe used `--print`,
`--no-session-persistence`, `--no-chrome`, `--disable-slash-commands`, and a
local mock model in addition to that fragment. Model selection is independent
of the client-side built-in tool list.

## Conclusion

The previous live absence of Glob was caused before the request reached the
Bridge: Claude Code's `--bare` SIMPLE mode reduced the exposed built-in set.
Claude Code 2.1.226 can send `Glob` and `Read` together, and it preserves both
after a tool result when invoked without `--bare` using the verified comma-list
form. There is no evidence for a NOCTIS restriction, user permission
restriction, agent-mode restriction, Bridge defect, or general Claude 2.1.226
inability to expose Glob.
