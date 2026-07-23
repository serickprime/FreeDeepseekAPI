'use strict';

const crypto = require('crypto');

const PROCESS_SALT = crypto.randomBytes(32);
const MAX_TOOL_NAMES = 32;
const MAX_TOOL_NAME_CHARS = 128;
const SAFE_MODEL = /^[A-Za-z0-9_.:-]{1,128}$/;
const SESSION_SOURCES = new Set(['explicit_header', 'explicit_metadata', 'explicit_user', 'tool_result', 'anonymous']);
const CLIENT_SESSION_SOURCES = new Set(['claude_header', 'explicit_header', 'explicit_metadata', 'explicit_user', 'unavailable']);
const OUTCOMES = new Set(['tool_call', 'final_text', 'safe_failure', 'upstream_error']);

function safeToolName(value) {
  if (typeof value !== 'string') return 'invalid';
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, MAX_TOOL_NAME_CHARS);
  return cleaned || 'invalid';
}

function toolsShape(body) {
  if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'tools')) return 'absent';
  if (Array.isArray(body.tools)) return 'array';
  if (body.tools === null) return 'null';
  return typeof body.tools;
}

function diagnosticTools(body, protocol) {
  const raw = Array.isArray(body?.tools) ? body.tools : [];
  const normalized = protocol === 'responses'
    ? raw.filter(tool => tool?.type === 'function')
    : raw;
  const names = normalized.slice(0, MAX_TOOL_NAMES).map(tool => {
    if (protocol === 'openai') return safeToolName(tool?.function?.name);
    return safeToolName(tool?.name);
  });
  return { rawCount: raw.length, normalizedCount: normalized.length, names };
}

function safeModel(value) {
  return typeof value === 'string' && SAFE_MODEL.test(value) ? value : 'invalid';
}

function sessionRef(value, salt) {
  if (typeof value !== 'string' || !value) return null;
  return crypto.createHmac('sha256', salt).update(value).digest('hex').slice(0, 12);
}

function createToolDiagnostics({
  enabled = process.env.BRIDGE_TOOL_DIAGNOSTICS === '1',
  logger,
  processSalt = PROCESS_SALT,
} = {}) {
  const write = typeof logger === 'function' ? logger : console.warn;
  const salt = Buffer.isBuffer(processSalt) && processSalt.length >= 16 ? processSalt : PROCESS_SALT;

  function emit(record) {
    if (!enabled) return;
    try { write(JSON.stringify(record)); } catch {}
  }

  function request({
    protocol,
    route,
    body,
    upstreamSource,
    upstreamKey,
    clientSessionSource,
    clientSessionKey,
    isToolContinuation,
    toolResultCount,
  } = {}) {
    if (!enabled) return null;
    const tools = diagnosticTools(body, protocol);
    const safeClientSource = CLIENT_SESSION_SOURCES.has(clientSessionSource) ? clientSessionSource : 'unavailable';
    emit({
      event: 'tool_request',
      protocol: ['openai', 'anthropic', 'responses'].includes(protocol) ? protocol : 'unknown',
      route: ['/v1/chat/completions', '/v1/messages', '/v1/responses'].includes(route) ? route : 'unknown',
      model: safeModel(body?.model),
      stream: body?.stream === true,
      session_source: SESSION_SOURCES.has(upstreamSource) ? upstreamSource : 'unknown',
      session_ref: sessionRef(upstreamKey, salt),
      client_session_source: safeClientSource,
      client_session_ref: safeClientSource === 'unavailable' ? null : sessionRef(clientSessionKey, salt),
      tools_field_present: toolsShape(body) !== 'absent',
      tools_field_shape: toolsShape(body),
      raw_tool_count: tools.rawCount,
      normalized_tool_count: tools.normalizedCount,
      tool_names: tools.names,
      is_tool_continuation: isToolContinuation === true,
      tool_result_count: Number.isSafeInteger(toolResultCount) && toolResultCount >= 0 ? toolResultCount : 0,
    });

    let finished = false;
    return {
      response({ strictToolCallDetected, reasoningNonempty, contentNonempty, reasoningRetryAttempted, repeatedToolRetryAttempted, outcome } = {}) {
        if (finished) return;
        finished = true;
        emit({
          event: 'tool_response',
          strict_tool_call_detected: strictToolCallDetected === true,
          reasoning_nonempty: reasoningNonempty === true,
          content_nonempty: contentNonempty === true,
          reasoning_retry_attempted: reasoningRetryAttempted === true,
          repeated_tool_retry_attempted: repeatedToolRetryAttempted === true,
          outcome: OUTCOMES.has(outcome) ? outcome : 'safe_failure',
        });
      },
    };
  }

  return { enabled, request };
}

module.exports = {
  MAX_TOOL_NAMES,
  MAX_TOOL_NAME_CHARS,
  createToolDiagnostics,
};
