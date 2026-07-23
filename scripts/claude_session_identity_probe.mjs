import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { deriveReadArguments, withTimeout } from './claude_contract_probe.mjs';

export const SAFE_IDENTITY_RECORD_FIELDS = Object.freeze([
  'sequence', 'method', 'pathname', 'safe_header_names', 'candidate_header_names',
  'candidate_headers', 'body_candidates', 'metadata_keys', 'tool_result_count',
]);

export const IDENTITY_HEADER_ALLOWLIST = Object.freeze([
  'x-agent-session',
  'x-claude-code-session-id',
]);

const SAFE_HEADER_NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const FORBIDDEN_HEADER_NAMES = new Set([
  'authorization', 'cookie', 'proxy-authorization', 'set-cookie', 'x-api-key',
]);
const SESSION_LIKE_NAME = /(?:^|[-_.])(session|conversation)(?:[-_.]|$)/i;
const BODY_CANDIDATE_KEYS = Object.freeze([
  'session_id', 'sessionId', 'conversation_id', 'conversationId', 'user_id',
]);
const MAX_HEADER_NAMES = 64;
const MAX_METADATA_KEYS = 24;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_REQUESTS = 8;
const DEFAULT_TIMEOUT_MS = 45_000;

function safeNames(value, limit) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value)
    .map(name => name.toLowerCase())
    .filter(name => SAFE_HEADER_NAME.test(name) && !FORBIDDEN_HEADER_NAMES.has(name))
    .slice(0, limit)
    .sort();
}

function scalarHeader(value) {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null;
  return value;
}

export function summarizeIdentifier(value, salt) {
  const scalar = scalarHeader(value);
  const type = scalar === null ? 'null' : typeof scalar;
  if (type !== 'string') return {
    present: value !== undefined,
    type,
    length: 0,
    fingerprint: 'invalid',
  };
  const length = Buffer.byteLength(scalar);
  return {
    present: true,
    type: 'string',
    length,
    fingerprint: length > 0 && length <= MAX_IDENTIFIER_BYTES
      ? createHmac('sha256', salt).update(scalar).digest('hex').slice(0, 12)
      : 'invalid',
  };
}

function absentIdentifier() {
  return { present: false, type: 'absent', length: 0, fingerprint: 'invalid' };
}

function candidateValues(source, keys, salt) {
  const safeSource = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  return Object.fromEntries(keys.map(key => [
    key,
    Object.prototype.hasOwnProperty.call(safeSource, key)
      ? summarizeIdentifier(safeSource[key], salt)
      : absentIdentifier(),
  ]));
}

function contentBlocks(messages) {
  const blocks = [];
  if (!Array.isArray(messages)) return blocks;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block && typeof block === 'object') blocks.push(block);
    }
  }
  return blocks;
}

export function sanitizeIdentityRequest({ sequence, method, pathname, headers, body, salt }) {
  const safeHeaders = headers && typeof headers === 'object' && !Array.isArray(headers) ? headers : {};
  const normalizedHeaders = Object.fromEntries(Object.entries(safeHeaders).map(([key, value]) => [key.toLowerCase(), value]));
  const safeBody = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const metadata = safeBody.metadata && typeof safeBody.metadata === 'object' && !Array.isArray(safeBody.metadata)
    ? safeBody.metadata : {};
  const safeHeaderNames = safeNames(normalizedHeaders, MAX_HEADER_NAMES);
  const candidateHeaderNames = safeHeaderNames.filter(name => SESSION_LIKE_NAME.test(name));
  const candidateHeaders = candidateValues(normalizedHeaders, IDENTITY_HEADER_ALLOWLIST, salt);
  const bodyCandidates = {
    top_level: candidateValues(safeBody, BODY_CANDIDATE_KEYS, salt),
    metadata: candidateValues(metadata, BODY_CANDIDATE_KEYS, salt),
  };
  const record = {
    sequence: Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0,
    method: typeof method === 'string' ? method.slice(0, 12).toUpperCase() : 'UNKNOWN',
    pathname: typeof pathname === 'string' ? pathname.slice(0, 96) : '/',
    safe_header_names: safeHeaderNames,
    candidate_header_names: candidateHeaderNames,
    candidate_headers: candidateHeaders,
    body_candidates: bodyCandidates,
    metadata_keys: safeNames(metadata, MAX_METADATA_KEYS),
    tool_result_count: contentBlocks(safeBody.messages).filter(block => block.type === 'tool_result').length,
  };
  return Object.fromEntries(SAFE_IDENTITY_RECORD_FIELDS.map(field => [field, record[field]]));
}

function safeLog(logger, record) {
  try { logger(JSON.stringify(record)); } catch {}
}

function sendJson(res, status, value) {
  const payload = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function writeSse(res, event, value) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
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
      type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
    });
    writeSse(res, 'content_block_delta', {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block.text },
    });
  }
  writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  writeSse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: response.stop_reason, stop_sequence: null },
    usage: { output_tokens: 10 },
  });
  writeSse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function anthropicMessage({ id, model, block, stopReason }) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: [block],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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

function findReadTool(tools) {
  return Array.isArray(tools)
    ? tools.find(tool => tool && typeof tool === 'object' && tool.name === 'Read') || null
    : null;
}

function toolResultBlocks(body) {
  return contentBlocks(body?.messages).filter(block => block.type === 'tool_result');
}

function containsMarkerInMemory(blocks, marker) {
  try { return JSON.stringify(blocks).includes(marker); } catch { return false; }
}

export async function startIdentityMockServer({
  logger = () => {},
  markers = ['IDENTITY_MARKER_ONE', 'IDENTITY_MARKER_TWO'],
  markerPaths = ['marker.txt', 'second-marker.txt'],
  maxMessageRequests = MAX_MESSAGE_REQUESTS,
  requestTimeoutMs = 10_000,
} = {}) {
  const salt = randomBytes(32);
  const records = [];
  const processState = new Map();
  const state = {
    messageRequests: 0,
    countTokenRequests: 0,
    markerResultsObserved: [false, false],
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
    try { body = await readBody(req); }
    catch (error) {
      if (!res.writableEnded) sendJson(res, error.code === 'REQUEST_TOO_LARGE' ? 413 : 400, { error: { type: 'invalid_request', message: 'Invalid local probe request.' } });
      return;
    }
    const record = sanitizeIdentityRequest({
      sequence: ++sequence,
      method: req.method,
      pathname: url.pathname,
      headers: req.headers,
      body,
      salt,
    });
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

    const rawProcessId = scalarHeader(req.headers['x-agent-session']);
    const processKey = typeof rawProcessId === 'string' && Buffer.byteLength(rawProcessId) <= MAX_IDENTIFIER_BYTES
      ? rawProcessId : `invalid:${state.messageRequests}`;
    let current = processState.get(processKey);
    if (!current) {
      current = { index: processState.size, toolId: `toolu_identity_${processState.size + 1}`, requested: false };
      processState.set(processKey, current);
    }
    const results = toolResultBlocks(body);
    if (!current.requested) {
      const readTool = findReadTool(body.tools);
      if (!readTool) return sendJson(res, 400, { error: { type: 'contract_error', message: 'Read tool was not supplied.' } });
      let input;
      try { input = deriveReadArguments(readTool, markerPaths[current.index] || markerPaths[0]); }
      catch { return sendJson(res, 400, { error: { type: 'contract_error', message: 'Unsupported Read schema.' } }); }
      current.requested = true;
      return sendAnthropicResponse(res, body, anthropicMessage({
        id: `msg_identity_${current.index + 1}_tool`,
        model: body.model,
        block: { type: 'tool_use', id: current.toolId, name: 'Read', input },
        stopReason: 'tool_use',
      }));
    }
    const expectedMarker = markers[current.index] || markers[0];
    const resultObserved = results.some(block => block.tool_use_id === current.toolId)
      && containsMarkerInMemory(results, expectedMarker);
    state.markerResultsObserved[current.index] = resultObserved;
    if (!resultObserved) {
      return sendJson(res, 400, { error: { type: 'contract_error', message: 'Tool result did not match.' } });
    }
    return sendAnthropicResponse(res, body, anthropicMessage({
      id: `msg_identity_${current.index + 1}_done`,
      model: body.model,
      block: { type: 'text', text: 'Local identity probe turn complete.' },
      stopReason: 'end_turn',
    }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    records,
    state,
    fingerprint: value => summarizeIdentifier(value, salt).fingerprint,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

function minimalChildEnvironment({ baseUrl, configDirectory, processId }) {
  const names = [
    'SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP',
    'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  ];
  const env = {};
  for (const name of names) if (typeof process.env[name] === 'string') env[name] = process.env[name];
  Object.assign(env, {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: 'local-identity-probe-token',
    ANTHROPIC_CUSTOM_HEADERS: `x-agent-session: ${processId}`,
    CLAUDE_CONFIG_DIR: configDirectory,
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

function collectStructuredSessionIds(chunk, state, salt) {
  state.buffer += chunk.toString('utf8');
  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const values = [];
    const pending = [event];
    while (pending.length) {
      const value = pending.pop();
      if (Array.isArray(value)) {
        pending.push(...value);
      } else if (value && typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) {
          if ((key === 'session_id' || key === 'sessionId') && typeof nested === 'string') values.push(nested);
          else if (nested && typeof nested === 'object') pending.push(nested);
        }
      }
    }
    for (const value of values) state.summaries.push(summarizeIdentifier(value, salt));
  }
}

function runClaudeTurn({
  cwd,
  baseUrl,
  configDirectory,
  sessionId,
  processId,
  first,
  prompt,
  outputSalt = randomBytes(32),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const args = [
    '--print', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands',
    '--no-chrome', '--tools', 'Read', '--allowedTools', 'Read',
    '--disallowedTools', 'Write,Edit,Bash,NotebookEdit,WebFetch,WebSearch',
    '--output-format', 'stream-json', '--verbose', '--model', 'sonnet',
    first ? '--session-id' : '--resume', sessionId, prompt,
  ];
  const child = spawn('claude.cmd', args, {
    cwd,
    env: minimalChildEnvironment({ baseUrl, configDirectory, processId }),
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const outputState = { buffer: '', summaries: [] };
  let stdoutSeen = false;
  let stderrSeen = false;
  child.stdout.on('data', chunk => {
    if (chunk.length) stdoutSeen = true;
    collectStructuredSessionIds(chunk, outputState, outputSalt);
  });
  child.stderr.on('data', chunk => { if (chunk.length) stderrSeen = true; });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({
      exit_code: code,
      signal,
      stdout_received: stdoutSeen,
      stderr_received: stderrSeen,
      structured_session_id_count: outputState.summaries.length,
      structured_session_ids: outputState.summaries,
    }));
  });
  return withTimeout(completion, timeoutMs, () => child.kill());
}

function summaries(records, headerName) {
  return records.map(record => record.candidate_headers[headerName]);
}

function presentAndValid(values) {
  return values.length > 0 && values.every(value => value.present && value.fingerprint !== 'invalid');
}

function oneFingerprint(values) {
  return presentAndValid(values) && new Set(values.map(value => value.fingerprint)).size === 1;
}

export function summarizeIdentityExperiment({ records, requestedSessionId, processIds, fingerprint }) {
  const messages = records.filter(record => record.pathname === '/v1/messages');
  const native = summaries(messages, 'x-claude-code-session-id');
  const custom = summaries(messages, 'x-agent-session');
  const processFingerprints = processIds.map(value => fingerprint(value));
  const requestedFingerprint = fingerprint(requestedSessionId);
  const byCustomFingerprint = new Map();
  for (const record of messages) {
    const key = record.candidate_headers['x-agent-session'].fingerprint;
    if (!byCustomFingerprint.has(key)) byCustomFingerprint.set(key, []);
    byCustomFingerprint.get(key).push(record);
  }
  return {
    message_request_count: messages.length,
    native_session_header_present_on_all: presentAndValid(native),
    native_session_header_stable: oneFingerprint(native),
    native_session_header_matches_requested_session: native.length > 0
      && native.every(value => value.fingerprint === requestedFingerprint),
    custom_header_present_on_all: presentAndValid(custom),
    custom_header_fingerprints_match_processes: processFingerprints.every(fingerprint => byCustomFingerprint.has(fingerprint)),
    custom_header_stable_within_process: [...byCustomFingerprint.values()].every(group => oneFingerprint(summaries(group, 'x-agent-session'))),
    custom_header_differs_between_processes: processFingerprints.length === 2
      && processFingerprints[0] !== processFingerprints[1],
    body_session_candidates_present: messages.some(record => [
      ...Object.values(record.body_candidates.top_level),
      ...Object.values(record.body_candidates.metadata),
    ].some(value => value.present)),
  };
}

export async function withIdentityWorkspace(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deepseek-bridge-claude-identity-'));
  const configDirectory = path.join(directory, '.claude-probe');
  const markers = [
    `CLAUDE_IDENTITY_ONE_${randomBytes(8).toString('hex')}`,
    `CLAUDE_IDENTITY_TWO_${randomBytes(8).toString('hex')}`,
  ];
  await writeFile(path.join(directory, 'marker.txt'), markers[0], 'utf8');
  await writeFile(path.join(directory, 'second-marker.txt'), markers[1], 'utf8');
  try { return await run({ directory, configDirectory, markers }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

export async function runIdentityProbe() {
  return withIdentityWorkspace(async ({ directory, configDirectory, markers }) => {
    const sessionId = randomUUID();
    const processIds = [randomUUID(), randomUUID()];
    const outputSalt = randomBytes(32);
    const mock = await startIdentityMockServer({ markers });
    try {
      const first = await runClaudeTurn({
        cwd: directory,
        baseUrl: mock.origin,
        configDirectory,
        sessionId,
        processId: processIds[0],
        first: true,
        prompt: 'Read marker.txt and return a short confirmation. Do not modify files.',
        outputSalt,
      });
      const resumed = await runClaudeTurn({
        cwd: directory,
        baseUrl: mock.origin,
        configDirectory,
        sessionId,
        processId: processIds[1],
        first: false,
        prompt: 'Read second-marker.txt and return a short confirmation. Do not modify files.',
        outputSalt,
      });
      return {
        first_process: first,
        resumed_process: resumed,
        count_tokens_request_count: mock.state.countTokenRequests,
        marker_results_observed: mock.state.markerResultsObserved,
        ...summarizeIdentityExperiment({
          records: mock.records,
          requestedSessionId: sessionId,
          processIds,
          fingerprint: mock.fingerprint,
        }),
        records: mock.records,
      };
    } finally {
      await mock.close();
    }
  });
}

async function main() {
  const result = await runIdentityProbe();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.first_process.exit_code !== 0 || result.resumed_process.exit_code !== 0
      || result.message_request_count < 4
      || !result.marker_results_observed.every(Boolean)
      || !result.native_session_header_present_on_all
      || !result.native_session_header_stable
      || !result.native_session_header_matches_requested_session
      || !result.custom_header_present_on_all
      || !result.custom_header_stable_within_process
      || !result.custom_header_differs_between_processes) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write('Claude Code session identity probe failed safely.\n');
    process.exitCode = 1;
  });
}
