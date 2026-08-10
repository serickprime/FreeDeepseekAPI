import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_REQUESTS = 8;
const TIMEOUT_MS = 60_000;
const SAFE_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const PROBES = new Set(['default', 'glob', 'read', 'glob-read', 'previous']);

function safeName(value, fallback = 'unknown') {
  return typeof value === 'string' && SAFE_NAME.test(value) ? value : fallback;
}

function contentBlocks(messages) {
  const blocks = [];
  if (!Array.isArray(messages)) return blocks;
  for (const message of messages) {
    if (!message || typeof message !== 'object' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block && typeof block === 'object') blocks.push(block);
    }
  }
  return blocks;
}

export function sanitizeRequest(body, headers, requestNumber) {
  const toolsPresent = Object.prototype.hasOwnProperty.call(body, 'tools');
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const toolNames = tools.slice(0, 32).map(tool => safeName(tool?.name, 'invalid'));
  const toolResultCount = contentBlocks(body.messages)
    .filter(block => block.type === 'tool_result').length;
  return {
    request_number: requestNumber,
    request_kind: toolNames.length > 0 ? 'tool_capable' : 'internal_candidate',
    tools_field_present: toolsPresent,
    tools_field_type: toolsPresent ? (Array.isArray(body.tools) ? 'array' : typeof body.tools) : 'absent',
    tool_count: tools.length,
    tool_names: toolNames,
    model: safeName(body.model),
    stream: body.stream === true,
    tool_result_count: toolResultCount,
    claude_session_header_present: typeof headers['x-claude-code-session-id'] === 'string'
      && headers['x-claude-code-session-id'].length > 0,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function writeSse(res, event, value) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function sendAnthropicResponse(res, requestBody, block, stopReason) {
  const response = {
    id: 'msg_local_tool_exposure_probe',
    type: 'message',
    role: 'assistant',
    model: safeName(requestBody.model),
    content: [block],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 5 },
  };
  if (requestBody.stream !== true) return sendJson(res, 200, response);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  writeSse(res, 'message_start', {
    type: 'message_start',
    message: { ...response, content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } },
  });
  if (block.type === 'tool_use') {
    writeSse(res, 'content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
    });
    writeSse(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
    });
  } else {
    writeSse(res, 'content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    writeSse(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: block.text },
    });
  }
  writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  writeSse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 5 },
  });
  writeSse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function globInput(tool) {
  const properties = tool?.input_schema?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;
  const input = {};
  if (properties.pattern?.type === 'string') input.pattern = '**/*.tsx';
  if (properties.path?.type === 'string') input.path = '.';
  return typeof input.pattern === 'string' ? input : null;
}

function hasToolResult(body, expectedId) {
  return contentBlocks(body.messages)
    .some(block => block.type === 'tool_result' && block.tool_use_id === expectedId);
}

async function startMock({ cycle }) {
  const records = [];
  const toolUseId = 'toolu_local_exposure_probe';
  const state = { messageRequests: 0, cycleIssued: false, toolResultSeen: false };
  const server = http.createServer(async (req, res) => {
    req.setTimeout(10_000, () => res.destroy());
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method !== 'POST') return sendJson(res, 405, { error: { type: 'method_not_allowed' } });
    let body;
    try { body = await readBody(req); }
    catch { return sendJson(res, 400, { error: { type: 'invalid_request' } }); }
    if (url.pathname === '/v1/messages/count_tokens') return sendJson(res, 200, { input_tokens: 20 });
    if (url.pathname !== '/v1/messages') return sendJson(res, 404, { error: { type: 'not_found' } });
    state.messageRequests += 1;
    if (state.messageRequests > MAX_MESSAGE_REQUESTS) {
      return sendJson(res, 429, { error: { type: 'request_limit' } });
    }
    records.push(sanitizeRequest(body, req.headers, state.messageRequests));
    const globTool = Array.isArray(body.tools)
      ? body.tools.find(tool => tool?.name === 'Glob') : null;
    if (cycle && !state.cycleIssued && globTool) {
      const input = globInput(globTool);
      if (!input) return sendJson(res, 400, { error: { type: 'unsupported_glob_schema' } });
      state.cycleIssued = true;
      return sendAnthropicResponse(res, body, {
        type: 'tool_use', id: toolUseId, name: 'Glob', input,
      }, 'tool_use');
    }
    if (cycle && state.cycleIssued && hasToolResult(body, toolUseId)) state.toolResultSeen = true;
    return sendAnthropicResponse(res, body, {
      type: 'text', text: 'Local tool exposure probe complete.',
    }, 'end_turn');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    records,
    state,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

function childEnvironment(origin) {
  const inherited = [
    'SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP',
    'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  ];
  const env = {};
  for (const name of inherited) if (typeof process.env[name] === 'string') env[name] = process.env[name];
  Object.assign(env, {
    ANTHROPIC_BASE_URL: origin,
    ANTHROPIC_AUTH_TOKEN: randomBytes(24).toString('hex'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_UPDATES: '1',
    NO_PROXY: '127.0.0.1,localhost',
  });
  return env;
}

function commonArgs() {
  return [
    '--print', '--output-format', 'text', '--no-session-persistence',
    '--no-chrome', '--disable-slash-commands', '--model', 'sonnet',
  ];
}

export function argsForProbe(probe, prompt) {
  const args = commonArgs();
  if (probe === 'glob') args.push('--tools', 'Glob', '--allowedTools', 'Glob', '--permission-mode', 'dontAsk');
  if (probe === 'read') args.push('--tools', 'Read', '--allowedTools', 'Read', '--permission-mode', 'dontAsk');
  if (probe === 'glob-read') args.push('--tools', 'Glob,Read', '--allowedTools', 'Glob,Read', '--permission-mode', 'dontAsk');
  if (probe === 'previous') {
    args.splice(1, 0, '--safe-mode', '--bare');
    args.push(
      '--tools', 'Glob', 'Read', '--allowedTools', 'Glob', 'Read',
      '--disallowedTools', 'Edit,Write,Bash,NotebookEdit,WebFetch,WebSearch',
      '--permission-mode', 'dontAsk',
    );
  }
  args.push(prompt);
  return args;
}

function runClaude({ origin, probe, prompt }) {
  const child = spawn('claude.cmd', argsForProbe(probe, prompt), {
    cwd: process.cwd(),
    env: childEnvironment(origin),
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdoutReceived = false;
  let stderrReceived = false;
  child.stdout.on('data', chunk => { if (chunk.length > 0) stdoutReceived = true; });
  child.stderr.on('data', chunk => { if (chunk.length > 0) stderrReceived = true; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('probe_timeout'));
    }, TIMEOUT_MS);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stdoutReceived, stderrReceived });
    });
  });
}

export async function runProbe(probe, prompt) {
  if (!PROBES.has(probe)) throw new Error('unsupported_probe');
  if (typeof prompt !== 'string' || prompt.length < 1 || prompt.length > 500
      || !/^[A-Za-z0-9 .,/*_-]+$/.test(prompt)) {
    throw new Error('invalid_probe_prompt');
  }
  const cycle = probe === 'glob-read';
  const mock = await startMock({ cycle });
  try {
    const cli = await runClaude({ origin: mock.origin, probe, prompt });
    return {
      probe,
      claude_exit_code: cli.exitCode,
      claude_signal: cli.signal,
      stdout_received: cli.stdoutReceived,
      stderr_received: cli.stderrReceived,
      message_request_count: mock.state.messageRequests,
      cycle_requested: cycle,
      cycle_tool_call_issued: mock.state.cycleIssued,
      cycle_tool_result_seen: mock.state.toolResultSeen,
      requests: mock.records,
    };
  } finally {
    await mock.close();
  }
}

function parseProbe(argv) {
  const index = argv.indexOf('--probe');
  return index >= 0 ? argv[index + 1] : null;
}

async function main() {
  const probe = parseProbe(process.argv.slice(2));
  const prompt = process.env.CLAUDE_TOOL_EXPOSURE_PROMPT;
  const result = await runProbe(probe, prompt);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.claude_exit_code !== 0 || result.message_request_count < 1
      || (result.cycle_requested && (!result.cycle_tool_call_issued || !result.cycle_tool_result_seen))) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write('Claude Code tool exposure probe failed safely.\n');
    process.exitCode = 1;
  });
}
