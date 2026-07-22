import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SAFE_RECORD_FIELDS = Object.freeze([
  'sequence', 'method', 'pathname', 'top_level_keys', 'model', 'stream',
  'system_shape', 'messages_shape', 'message_roles', 'content_block_types',
  'tools_field_present', 'tools_field_type', 'tool_count', 'tool_names',
  'tool_object_keys', 'tool_schema_present', 'tool_result_count',
  'tool_result_id_fingerprint', 'tool_use_count', 'metadata_keys',
  'count_tokens_requested',
]);

const SAFE_TOP_LEVEL_KEYS = new Set([
  'max_tokens', 'messages', 'metadata', 'model', 'service_tier', 'stop_sequences',
  'stream', 'system', 'temperature', 'thinking', 'tool_choice', 'tools', 'top_k', 'top_p',
]);
const SAFE_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
const FORBIDDEN_KEY_NAMES = /^(authorization|cookie|token|proxy_api_key|api_key|password|secret)$/i;
const MAX_TOOL_NAMES = 32;
const MAX_TOOL_NAME_CHARS = 64;
const MAX_OBJECT_KEYS = 24;
const MAX_MESSAGE_REQUESTS = 5;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 45_000;

function shape(value, present = true) {
  if (!present) return 'absent';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function safeKeyList(value, allowlist = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value)
    .filter(key => SAFE_KEY.test(key) && !FORBIDDEN_KEY_NAMES.test(key) && (!allowlist || allowlist.has(key)))
    .slice(0, MAX_OBJECT_KEYS)
    .sort();
}

export function safeToolName(value) {
  if (typeof value !== 'string') return 'invalid';
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, MAX_TOOL_NAME_CHARS);
  return cleaned || 'invalid';
}

function fingerprint(value, salt) {
  if (typeof value !== 'string' || !value) return 'invalid';
  return createHmac('sha256', salt).update(value).digest('hex').slice(0, 12);
}

function contentBlocks(messages) {
  const blocks = [];
  if (!Array.isArray(messages)) return blocks;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (block && typeof block === 'object' && typeof block.type === 'string') blocks.push(block);
    }
  }
  return blocks;
}

export function sanitizeContractRequest({ sequence, method, pathname, body, salt }) {
  const safeBody = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const messages = Array.isArray(safeBody.messages) ? safeBody.messages : [];
  const toolsPresent = Object.prototype.hasOwnProperty.call(safeBody, 'tools');
  const tools = Array.isArray(safeBody.tools) ? safeBody.tools : [];
  const blocks = contentBlocks(messages);
  const toolResults = blocks.filter(block => block.type === 'tool_result');
  const toolUses = blocks.filter(block => block.type === 'tool_use');
  const toolNames = tools.slice(0, MAX_TOOL_NAMES).map(tool => safeToolName(tool?.name));
  const toolObjectKeys = tools.slice(0, MAX_TOOL_NAMES).map(tool => safeKeyList(tool));
  const record = {
    sequence: Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0,
    method: typeof method === 'string' ? method.slice(0, 12).toUpperCase() : 'UNKNOWN',
    pathname: typeof pathname === 'string' ? pathname.slice(0, 96) : '/',
    top_level_keys: safeKeyList(safeBody, SAFE_TOP_LEVEL_KEYS),
    model: typeof safeBody.model === 'string' ? safeBody.model.slice(0, 96) : 'unknown',
    stream: safeBody.stream === true,
    system_shape: shape(safeBody.system, Object.prototype.hasOwnProperty.call(safeBody, 'system')),
    messages_shape: shape(safeBody.messages, Object.prototype.hasOwnProperty.call(safeBody, 'messages')),
    message_roles: messages.slice(0, 64).map(message => safeToolName(message?.role)),
    content_block_types: blocks.slice(0, 128).map(block => safeToolName(block.type)),
    tools_field_present: toolsPresent,
    tools_field_type: shape(safeBody.tools, toolsPresent),
    tool_count: tools.length,
    tool_names: toolNames,
    tool_object_keys: toolObjectKeys,
    tool_schema_present: tools.some(tool => tool && typeof tool === 'object' && tool.input_schema && typeof tool.input_schema === 'object'),
    tool_result_count: toolResults.length,
    tool_result_id_fingerprint: toolResults.slice(0, 16).map(block => fingerprint(block.tool_use_id, salt)),
    tool_use_count: toolUses.length,
    metadata_keys: safeKeyList(safeBody.metadata),
    count_tokens_requested: pathname === '/v1/messages/count_tokens',
  };
  return Object.fromEntries(SAFE_RECORD_FIELDS.map(field => [field, record[field]]));
}

function safeLog(logger, record) {
  try { logger(JSON.stringify(record)); } catch {}
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function findReadTool(tools) {
  if (!Array.isArray(tools)) return null;
  return tools.find(tool => tool && typeof tool === 'object' && tool.name === 'Read') || null;
}

export function deriveReadArguments(readTool, filePath) {
  const schema = readTool?.input_schema;
  const properties = schema && typeof schema === 'object' && !Array.isArray(schema)
    && schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties : null;
  if (!properties) throw new Error('Read tool schema has no object properties.');
  const field = ['file_path', 'path', 'filename'].find(name => properties[name]?.type === 'string');
  if (!field) throw new Error('Read tool schema has no supported string path field.');
  return { [field]: filePath };
}

function findToolResult(body, expectedId) {
  for (const block of contentBlocks(body?.messages)) {
    if (block.type === 'tool_result' && block.tool_use_id === expectedId) return block;
  }
  return null;
}

function containsMarkerInMemory(block, marker) {
  if (!block) return false;
  try { return JSON.stringify(block.content).includes(marker); } catch { return false; }
}

function sendJson(res, status, value) {
  const payload = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function writeSse(res, event, value) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function anthropicMessage({ id, model, block, stopReason }) {
  return {
    id, type: 'message', role: 'assistant', model,
    content: [block], stop_reason: stopReason, stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}

function sendAnthropicResponse(res, body, response) {
  if (body.stream !== true) return sendJson(res, 200, response);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  writeSse(res, 'message_start', {
    type: 'message_start',
    message: { ...response, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } },
  });
  const block = response.content[0];
  if (block.type === 'tool_use') {
    writeSse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
    writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
  } else {
    writeSse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block.text } });
  }
  writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  writeSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: response.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
  writeSse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('request_too_large'), { code: 'REQUEST_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('invalid_json'), { code: 'INVALID_JSON' })); }
    });
    req.on('error', reject);
  });
}

export async function startContractMockServer({
  logger = () => {},
  markerOne = 'PROBE_MARKER_ONE',
  markerTwo = 'PROBE_MARKER_TWO',
  markerOnePath = 'marker.txt',
  markerTwoPath = 'second-marker.txt',
  maxMessageRequests = MAX_MESSAGE_REQUESTS,
  requestTimeoutMs = 10_000,
} = {}) {
  const salt = randomBytes(32);
  const records = [];
  const state = {
    messageRequests: 0,
    countTokenRequests: 0,
    firstResultLinked: false,
    secondResultLinked: false,
    firstMarkerObserved: false,
    secondMarkerObserved: false,
    firstToolId: 'toolu_probe_first',
    secondToolId: 'toolu_probe_second',
    initialToolSignature: null,
    toolSignatures: [],
  };
  let sequence = 0;

  const server = http.createServer(async (req, res) => {
    req.setTimeout(requestTimeoutMs, () => {
      if (!res.headersSent) sendJson(res, 408, { error: { type: 'timeout', message: 'Local probe request timed out.' } });
      else res.destroy();
    });
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method !== 'POST') return sendJson(res, 405, { error: { type: 'method_not_allowed', message: 'POST required.' } });
    let body;
    try { body = await readBody(req, MAX_BODY_BYTES); }
    catch (error) {
      if (!res.writableEnded) sendJson(res, error.code === 'REQUEST_TOO_LARGE' ? 413 : 400, { error: { type: 'invalid_request', message: 'Invalid local probe request.' } });
      return;
    }
    const record = sanitizeContractRequest({ sequence: ++sequence, method: req.method, pathname: url.pathname, body, salt });
    records.push(record);
    safeLog(logger, record);

    if (url.pathname === '/v1/messages/count_tokens') {
      state.countTokenRequests += 1;
      return sendJson(res, 200, { input_tokens: 100 });
    }
    if (url.pathname !== '/v1/messages') {
      return sendJson(res, 404, { error: { type: 'not_found', message: 'Unsupported local probe route.' } });
    }
    state.messageRequests += 1;
    if (state.messageRequests > maxMessageRequests) {
      return sendJson(res, 429, { error: { type: 'request_limit', message: 'Local probe request limit reached.' } });
    }
    const readTool = findReadTool(body.tools);
    const signature = Array.isArray(body.tools) ? stableJson(body.tools) : null;
    state.toolSignatures.push(signature);
    if (state.messageRequests === 1) {
      if (!readTool) return sendJson(res, 400, { error: { type: 'contract_error', message: 'Read tool was not supplied.' } });
      state.initialToolSignature = signature;
      let input;
      try { input = deriveReadArguments(readTool, markerOnePath); }
      catch { return sendJson(res, 400, { error: { type: 'contract_error', message: 'Unsupported Read schema.' } }); }
      return sendAnthropicResponse(res, body, anthropicMessage({ id: 'msg_probe_1', model: body.model, block: { type: 'tool_use', id: state.firstToolId, name: 'Read', input }, stopReason: 'tool_use' }));
    }
    if (state.messageRequests === 2) {
      const result = findToolResult(body, state.firstToolId);
      state.firstResultLinked = Boolean(result);
      state.firstMarkerObserved = containsMarkerInMemory(result, markerOne);
      if (!state.firstResultLinked || !state.firstMarkerObserved) return sendJson(res, 400, { error: { type: 'contract_error', message: 'First tool result did not match.' } });
      if (!readTool) return sendJson(res, 400, { error: { type: 'contract_error', message: 'Read tool was not retained.' } });
      let input;
      try { input = deriveReadArguments(readTool, markerTwoPath); }
      catch { return sendJson(res, 400, { error: { type: 'contract_error', message: 'Unsupported Read schema.' } }); }
      return sendAnthropicResponse(res, body, anthropicMessage({ id: 'msg_probe_2', model: body.model, block: { type: 'tool_use', id: state.secondToolId, name: 'Read', input }, stopReason: 'tool_use' }));
    }
    if (state.messageRequests === 3) {
      const result = findToolResult(body, state.secondToolId);
      state.secondResultLinked = Boolean(result);
      state.secondMarkerObserved = containsMarkerInMemory(result, markerTwo);
      if (!state.secondResultLinked || !state.secondMarkerObserved) return sendJson(res, 400, { error: { type: 'contract_error', message: 'Second tool result did not match.' } });
      return sendAnthropicResponse(res, body, anthropicMessage({ id: 'msg_probe_3', model: body.model, block: { type: 'text', text: 'Local contract probe complete.' }, stopReason: 'end_turn' }));
    }
    return sendJson(res, 429, { error: { type: 'request_limit', message: 'Unexpected extra message request.' } });
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

export function withTimeout(promise, timeoutMs, onTimeout = () => {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { onTimeout(); } catch {}
      reject(new Error('Local contract probe timed out.'));
    }, timeoutMs);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

export async function withProbeWorkspace(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deepseek-bridge-claude-probe-'));
  const markerOne = `CLAUDE_PROBE_ONE_${randomBytes(8).toString('hex')}`;
  const markerTwo = `CLAUDE_PROBE_TWO_${randomBytes(8).toString('hex')}`;
  await writeFile(path.join(directory, 'marker.txt'), markerOne, 'utf8');
  await writeFile(path.join(directory, 'second-marker.txt'), markerTwo, 'utf8');
  try { return await run({ directory, markerOne, markerTwo }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function minimalChildEnvironment(baseUrl) {
  const names = ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'];
  const env = {};
  for (const name of names) if (typeof process.env[name] === 'string') env[name] = process.env[name];
  Object.assign(env, {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: 'local-contract-probe-token',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_UPDATES: '1',
  });
  delete env.DEEPSEEK_AUTH_PATH;
  delete env.PROXY_API_KEY;
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.ALL_PROXY;
  return env;
}

function runClaude({ cwd, baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const args = [
    '--print', '--safe-mode', '--strict-mcp-config', '--no-session-persistence',
    '--disable-slash-commands', '--tools', 'Read', '--allowedTools', 'Read',
    '--disallowedTools', 'Write,Edit,Bash,NotebookEdit,WebFetch,WebSearch',
    '--output-format', 'text', '--model', 'sonnet',
    'Read marker.txt, then read second-marker.txt, then return a short final summary. Do not modify files.',
  ];
  const child = spawn('claude.cmd', args, {
    cwd,
    env: minimalChildEnvironment(baseUrl),
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdoutSeen = false;
  let stderrSeen = false;
  child.stdout.on('data', chunk => { if (chunk.length) stdoutSeen = true; });
  child.stderr.on('data', chunk => { if (chunk.length) stderrSeen = true; });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ exitCode: code, signal, stdoutSeen, stderrSeen }));
  });
  return withTimeout(completion, timeoutMs, () => child.kill());
}

export async function runBasicProbe() {
  return withProbeWorkspace(async ({ directory, markerOne, markerTwo }) => {
    const mock = await startContractMockServer({
      markerOne,
      markerTwo,
      markerOnePath: path.join(directory, 'marker.txt'),
      markerTwoPath: path.join(directory, 'second-marker.txt'),
    });
    try {
      const cli = await runClaude({ cwd: directory, baseUrl: mock.origin });
      const messageRecords = mock.records.filter(record => record.pathname === '/v1/messages');
      const countRecords = mock.records.filter(record => record.pathname === '/v1/messages/count_tokens');
      return {
        claude_exit_code: cli.exitCode,
        claude_signal: cli.signal,
        stdout_received: cli.stdoutSeen,
        stderr_received: cli.stderrSeen,
        message_request_count: mock.state.messageRequests,
        count_tokens_request_count: mock.state.countTokenRequests,
        first_tools_present: messageRecords[0]?.tools_field_present === true,
        read_tool_present: messageRecords[0]?.tool_names.includes('Read') === true,
        tools_after_first_result: messageRecords[1]?.tools_field_present ?? null,
        tools_after_second_result: messageRecords[2]?.tools_field_present ?? null,
        first_tool_result_linked: mock.state.firstResultLinked,
        second_tool_result_linked: mock.state.secondResultLinked,
        first_marker_observed_in_memory: mock.state.firstMarkerObserved,
        second_marker_observed_in_memory: mock.state.secondMarkerObserved,
        tools_shape_unchanged_after_first_result: mock.state.toolSignatures[1] === mock.state.initialToolSignature,
        tools_shape_unchanged_after_second_result: mock.state.toolSignatures[2] === mock.state.initialToolSignature,
        count_tokens_tools_present: countRecords.map(record => record.tools_field_present),
        records: mock.records,
      };
    } finally {
      await mock.close();
    }
  });
}

async function main() {
  const result = await runBasicProbe();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.claude_exit_code !== 0 || result.message_request_count !== 3
      || !result.first_tool_result_linked || !result.second_tool_result_linked
      || !result.first_marker_observed_in_memory || !result.second_marker_observed_in_memory) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write('Claude Code contract probe failed safely.\n');
    process.exitCode = 1;
  });
}
