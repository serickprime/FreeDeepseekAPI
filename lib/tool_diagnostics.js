'use strict';

const crypto = require('crypto');

const PROCESS_SALT = crypto.randomBytes(32);
const MAX_TOOL_NAMES = 32;
const MAX_TOOL_NAME_CHARS = 128;
const SAFE_TOOL_NAME = new RegExp(`^[A-Za-z0-9_.:-]{1,${MAX_TOOL_NAME_CHARS}}$`);
const SAFE_MODEL = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_REQUEST_REF = /^[a-f0-9]{16}$/;
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const SAFE_CAUSE_CODE = /^[A-Z0-9_]{1,64}$/;
const SESSION_SOURCES = new Set(['explicit_header', 'explicit_metadata', 'explicit_user', 'tool_result', 'anonymous']);
const CLIENT_SESSION_SOURCES = new Set(['claude_header', 'explicit_header', 'explicit_metadata', 'explicit_user', 'unavailable']);
const OUTCOMES = new Set(['tool_call', 'final_text', 'safe_failure', 'upstream_error']);
const TOOL_RETRY_REASONS = new Set([
  'none',
  'reasoning_only',
  'code_fence',
  'prefixed_tool',
  'brace_tool',
  'repeated_tool',
  'textual_tool_transcript',
  'multi_tool_like',
  'malformed_tool_envelope',
]);
const TOOL_STRUCTURAL_CLASSES = new Set(TOOL_RETRY_REASONS);
const TOOL_PARSE_SOURCES = new Set(['content', 'reasoning', 'none']);
const TOOL_PARSE_REASONS = new Set([
  'accepted',
  'arguments_not_object',
  'arguments_too_large',
  'empty_input',
  'excessive_nesting',
  'input_not_string',
  'input_too_large',
  'invalid_envelope',
  'invalid_json',
  'invalid_output',
  'invalid_tool_name',
  'invalid_tool_shape',
  'not_inspected',
  'tool_not_allowed',
  'unexpected_envelope_keys',
  'unsafe_arguments',
]);
const TOOL_PARSE_METADATA_FIELDS = [
  'content_bytes',
  'content_trimmed_bytes',
  'reasoning_bytes',
  'reasoning_trimmed_bytes',
  'content_starts_with_brace',
  'content_ends_with_brace',
  'content_starts_with_code_fence',
  'content_contains_tool_call_marker',
  'reasoning_starts_with_brace',
  'reasoning_ends_with_brace',
  'reasoning_starts_with_code_fence',
  'reasoning_contains_tool_call_marker',
];
const UPSTREAM_STAGES = new Set([
  'remote_session_start',
  'remote_session_created',
  'challenge_start',
  'challenge_received',
  'wasm_download_start',
  'wasm_wait_shared',
  'wasm_cache_hit',
  'wasm_downloaded',
  'wasm_compile_start',
  'wasm_compiled',
  'pow_solve_start',
  'pow_solved',
  'completion_start',
  'completion_completed',
  'stream_received',
  'stream_read',
  'stream_parsed',
]);
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const CONNECT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET']);
const TLS_CODES = new Set([
  'CERT_EXPIRED',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_SSL_CERT_AUTHORITY_INVALID',
  'ERR_SSL_PROTOCOL_ERROR',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function safeToolName(value) {
  return typeof value === 'string' && SAFE_TOOL_NAME.test(value) ? value : 'invalid';
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

function safeRequestRef(value) {
  return typeof value === 'string' && SAFE_REQUEST_REF.test(value) ? value : null;
}

function safeCauseCode(error) {
  const value = error?.causeCode ?? error?.cause?.code ?? error?.code;
  return typeof value === 'string' && SAFE_CAUSE_CODE.test(value) ? value : null;
}

function safeStatus(error) {
  const value = Number(error?.upstreamStatus ?? error?.status);
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function safeStage(value) {
  return UPSTREAM_STAGES.has(value) ? value : 'unknown';
}

function isTimeoutError(error) {
  const code = safeCauseCode(error);
  const name = typeof error?.name === 'string' ? error.name : '';
  return code === 'ETIMEDOUT' || name === 'TimeoutError' || name === 'AbortError';
}

function errorCategory(error, stage) {
  const code = safeCauseCode(error);
  if (stage === 'stream_read') return 'stream';
  if (isTimeoutError(error)) return 'timeout';
  if (DNS_CODES.has(code)) return 'dns';
  if (CONNECT_CODES.has(code)) return 'connect';
  if (TLS_CODES.has(code)) return 'tls';
  if (safeStatus(error) !== null) return 'http';
  if (stage.startsWith('wasm_') || stage.startsWith('pow_')) return 'pow';
  return 'unknown';
}

function classifyUpstreamError(error, stage) {
  const safeErrorStage = safeStage(stage);
  const category = errorCategory(error, safeErrorStage);
  const rawName = typeof error?.name === 'string' ? error.name : '';
  return {
    stage: safeErrorStage,
    error_name: SAFE_ERROR_NAME.test(rawName) ? rawName : 'Error',
    error_category: category,
    status: safeStatus(error),
    cause_code: safeCauseCode(error),
    retryable: error?.retryable === true,
    timeout: isTimeoutError(error),
  };
}

function safeToolParseResult(value) {
  const source = TOOL_PARSE_SOURCES.has(value?.source) ? value.source : 'none';
  const reason = TOOL_PARSE_REASONS.has(value?.reason) ? value.reason : 'not_inspected';
  const result = { tool_parse_source: source, tool_parse_reason: reason };
  if (reason === 'accepted' || reason === 'not_inspected') return result;
  const metadata = value?.metadata && typeof value.metadata === 'object' ? value.metadata : {};
  for (const field of TOOL_PARSE_METADATA_FIELDS) {
    if (field.endsWith('_bytes')) {
      const size = metadata[field];
      result[field] = Number.isSafeInteger(size) && size >= 0 ? size : 0;
    } else {
      result[field] = metadata[field] === true;
    }
  }
  return result;
}

function createToolDiagnostics({
  enabled = process.env.BRIDGE_TOOL_DIAGNOSTICS === '1',
  logger,
  processSalt = PROCESS_SALT,
  randomBytes = crypto.randomBytes,
} = {}) {
  const write = typeof logger === 'function' ? logger : console.warn;
  const salt = Buffer.isBuffer(processSalt) && processSalt.length >= 16 ? processSalt : PROCESS_SALT;

  function emit(record) {
    if (!enabled) return;
    try { write(JSON.stringify(record)); } catch {}
  }

  function createRequestRef() {
    try {
      const value = randomBytes(8).toString('hex');
      if (safeRequestRef(value)) return value;
    } catch {}
    return crypto.randomBytes(8).toString('hex');
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
    toolResultErrorCount,
    requestRef,
  } = {}) {
    if (!enabled) return null;
    const ref = safeRequestRef(requestRef) || createRequestRef();
    const tools = diagnosticTools(body, protocol);
    const safeClientSource = CLIENT_SESSION_SOURCES.has(clientSessionSource) ? clientSessionSource : 'unavailable';
    emit({
      event: 'tool_request',
      request_ref: ref,
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
      tool_result_error_count: protocol === 'anthropic'
        && Number.isSafeInteger(toolResultErrorCount) && toolResultErrorCount >= 0
        ? toolResultErrorCount : 0,
    });

    let finished = false;
    const reportedErrors = new Set();
    return {
      stage(stage) {
        emit({ event: 'upstream_stage', request_ref: ref, stage: safeStage(stage) });
      },
      upstreamError(error, { stage, attempt, maxAttempts } = {}) {
        if (reportedErrors.has(error)) return;
        reportedErrors.add(error);
        const safeAttempt = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1;
        const safeMaxAttempts = Number.isSafeInteger(maxAttempts) && maxAttempts >= safeAttempt ? maxAttempts : safeAttempt;
        emit({
          event: 'upstream_error',
          request_ref: ref,
          ...classifyUpstreamError(error, stage),
          attempt: safeAttempt,
          max_attempts: safeMaxAttempts,
        });
      },
      response({ strictToolCallDetected, selectedToolName, reasoningNonempty, contentNonempty, reasoningRetryAttempted, fencedToolRetryAttempted, prefixedToolRetryAttempted, braceToolRetryAttempted, repeatedToolRetryAttempted, toolRetryReason, correctionAttempted, structuralClass, mentionedToolName, completionCount, toolParseResult, outcome } = {}) {
        if (finished) return;
        finished = true;
        emit({
          event: 'tool_response',
          request_ref: ref,
          strict_tool_call_detected: strictToolCallDetected === true,
          selected_tool_name: strictToolCallDetected === true ? safeToolName(selectedToolName) : 'none',
          reasoning_nonempty: reasoningNonempty === true,
          content_nonempty: contentNonempty === true,
          reasoning_retry_attempted: reasoningRetryAttempted === true,
          fenced_tool_retry_attempted: fencedToolRetryAttempted === true,
          prefixed_tool_retry_attempted: prefixedToolRetryAttempted === true,
          brace_tool_retry_attempted: braceToolRetryAttempted === true,
          repeated_tool_retry_attempted: repeatedToolRetryAttempted === true,
          tool_retry_reason: TOOL_RETRY_REASONS.has(toolRetryReason) ? toolRetryReason : 'none',
          tool_correction_attempted: correctionAttempted === true,
          tool_structural_class: TOOL_STRUCTURAL_CLASSES.has(structuralClass) ? structuralClass : 'none',
          mentioned_tool_name: mentionedToolName ? safeToolName(mentionedToolName) : 'none',
          completion_count: Number.isSafeInteger(completionCount) && completionCount >= 0 ? Math.min(completionCount, 2) : 0,
          ...safeToolParseResult(toolParseResult),
          outcome: OUTCOMES.has(outcome) ? outcome : 'safe_failure',
        });
      },
    };
  }

  return { createRequestRef, enabled, request };
}

module.exports = {
  MAX_TOOL_NAMES,
  MAX_TOOL_NAME_CHARS,
  TOOL_PARSE_METADATA_FIELDS,
  TOOL_PARSE_REASONS,
  TOOL_RETRY_REASONS,
  TOOL_STRUCTURAL_CLASSES,
  UPSTREAM_STAGES,
  classifyUpstreamError,
  createToolDiagnostics,
};
