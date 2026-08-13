'use strict';

const TOOL_RETRY_FAILURE_MESSAGE = 'The model could not produce a valid tool call. Please retry or rephrase the request.';
const TOOL_NAME = /^[A-Za-z_][\w.-]{0,127}$/;
const JSON_ENVELOPE_LINE = /^\s*\{\s*"tool_call"\s*:\s*\{\s*"name"\s*:\s*"([A-Za-z_][\w.-]{0,127})"\s*,\s*"arguments"\s*:\s*[\s\S]+\}\s*\}\s*$/;
const TRUNCATED_ENVELOPE_PREFIX = /^\s*\{\s*"tool_call"\s*:\s*\{\s*"name"\s*:\s*"([A-Za-z_][\w.-]{0,127})"\s*,\s*"arguments"\s*:/;
const TEXTUAL_TOOL_TRANSCRIPT = /^\s*\[Tool Call\]\s*\r?\nname:\s*([A-Za-z_][\w.-]{0,127})\s*\r?\n(?:call_id:\s*[^\r\n]{1,256}\s*\r?\n)?arguments:\s*([^\r\n]{1,49152})\s*$/;
const CORRECTABLE_ENVELOPE_REASONS = new Set([
  'arguments_not_object',
  'invalid_tool_shape',
  'unexpected_envelope_keys',
]);
const REJECTED_ENVELOPE_REASONS = new Set([
  'arguments_too_large',
  'excessive_nesting',
  'invalid_envelope',
  'invalid_tool_name',
  'tool_not_allowed',
  'unsafe_arguments',
]);

function shouldRetryToolResponse({ hasTools, output, toolCall, retryCount = 0 }) {
  return retryCount === 0
    && hasTools === true
    && !toolCall
    && typeof output?.content === 'string'
    && output.content.trim() === ''
    && typeof output.reasoning === 'string'
    && output.reasoning.trim() !== '';
}

function shouldRetryFencedToolResponse({ hasTools, toolCall, retryCount = 0, inspection } = {}) {
  return retryCount === 0
    && hasTools === true
    && !toolCall
    && inspection?.source === 'content'
    && inspection.reason === 'invalid_json'
    && inspection.metadata?.content_starts_with_code_fence === true
    && inspection.metadata?.content_contains_tool_call_marker === true;
}

function shouldRetryPrefixedToolResponse({ hasTools, toolCall, retryCount = 0, inspection, output, allowedNames } = {}) {
  const content = typeof output?.content === 'string' ? output.content.trim() : '';
  const names = safeAllowedNames(allowedNames);
  const envelopeNames = standaloneEnvelopeNames(content);
  const genericPrefix = !hasDocumentationContext(content)
    && envelopeNames.length === 1
    && names.includes(envelopeNames[0]);
  const bracketMatch = content.match(/^\[调用\s+([A-Za-z_][\w.-]{0,127})\]\s+([\s\S]+)$/u);
  const bracketEnvelope = bracketMatch?.[2]?.match(JSON_ENVELOPE_LINE);
  const bracketPrefix = Boolean(bracketMatch)
    && Boolean(bracketEnvelope)
    && bracketMatch[1] === bracketEnvelope[1]
    && names.includes(bracketEnvelope[1]);
  return retryCount === 0
    && hasTools === true
    && !toolCall
    && inspection?.source === 'content'
    && inspection.reason === 'invalid_json'
    && inspection.metadata?.content_starts_with_code_fence === false
    && inspection.metadata?.content_starts_with_brace === false
    && inspection.metadata?.content_ends_with_brace === true
    && inspection.metadata?.content_contains_tool_call_marker === true
    && (genericPrefix || bracketPrefix);
}

function shouldRetryBraceDelimitedToolLikeResponse({ hasTools, toolCall, retryCount = 0, inspection } = {}) {
  return retryCount === 0
    && hasTools === true
    && !toolCall
    && inspection?.source === 'content'
    && inspection.reason === 'invalid_json'
    && inspection.metadata?.content_starts_with_code_fence === false
    && inspection.metadata?.content_starts_with_brace === true
    && inspection.metadata?.content_ends_with_brace === true
    && inspection.metadata?.content_contains_tool_call_marker === true;
}

function safeAllowedNames(allowedNames) {
  return [...new Set((Array.isArray(allowedNames) ? allowedNames : [])
    .filter(name => typeof name === 'string' && TOOL_NAME.test(name)))].slice(0, 32);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasDocumentationContext(text) {
  if (/`/.test(text) || /^\s*>/m.test(text) || /^\s*#{1,6}\s/m.test(text)) return true;
  return /^\s*(?:(?:here(?:'s|\s+is)?|this\s+is)\s+an?\s+)?(?:documentation|example|sample|json\s+tutorial|readme\s+(?:content|example|documentation))\s*:|^\s*(?:вот\s+)?пример(?:а|ы|ов)?\s*:/imu.test(text);
}

function standaloneEnvelopeNames(text) {
  const names = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(JSON_ENVELOPE_LINE);
    if (match) names.push(match[1]);
  }
  return names;
}

function exactJsonEnvelope(text) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!isPlainObject(value) || !Object.prototype.hasOwnProperty.call(value, 'tool_call')) return null;
  const tool = value.tool_call;
  const name = isPlainObject(tool) && typeof tool.name === 'string' && TOOL_NAME.test(tool.name)
    ? tool.name
    : '';
  return { name };
}

function malformedIntent(structuralClass, action, mentionedToolName = '') {
  return { structuralClass, action, mentionedToolName };
}

function noMalformedIntent() {
  return malformedIntent('none', 'none');
}

function isSafeCorrectionFinalText(output, inspection) {
  return typeof output?.content === 'string'
    && output.content.trim() !== ''
    && inspection?.source === 'content'
    && inspection.reason === 'invalid_json'
    && inspection.metadata?.content_contains_tool_call_marker === false
    && !/\[Tool Call\]/i.test(output.content);
}

function classifyMalformedToolIntent({ hasTools, toolCall, retryCount = 0, inspection, output, allowedNames } = {}) {
  if (retryCount !== 0
    || hasTools !== true
    || toolCall
    || inspection?.source !== 'content'
    || typeof output?.content !== 'string') return noMalformedIntent();
  const content = output.content.trim();
  if (!content) return noMalformedIntent();
  const allowed = new Set(safeAllowedNames(allowedNames));

  const transcript = content.match(TEXTUAL_TOOL_TRANSCRIPT);
  if (transcript) {
    const name = transcript[1];
    return malformedIntent('textual_tool_transcript', allowed.has(name) ? 'correct' : 'reject', allowed.has(name) ? name : '');
  }
  if (hasDocumentationContext(content)) return noMalformedIntent();

  const envelopeNames = standaloneEnvelopeNames(content);
  if (envelopeNames.length >= 2) {
    const allAllowed = envelopeNames.every(name => allowed.has(name));
    return malformedIntent('multi_tool_like', allAllowed ? 'correct' : 'reject');
  }
  if (envelopeNames.length === 1) {
    const envelopeLine = content.split(/\r?\n/).find(line => JSON_ENVELOPE_LINE.test(line))?.trim() || '';
    if (content !== envelopeLine) {
      const name = envelopeNames[0];
      return malformedIntent('malformed_tool_envelope', allowed.has(name) ? 'correct' : 'reject', allowed.has(name) ? name : '');
    }
  }

  const exactEnvelope = exactJsonEnvelope(content);
  if (exactEnvelope && (CORRECTABLE_ENVELOPE_REASONS.has(inspection.reason) || REJECTED_ENVELOPE_REASONS.has(inspection.reason))) {
    const nameAllowed = allowed.has(exactEnvelope.name);
    const action = nameAllowed && CORRECTABLE_ENVELOPE_REASONS.has(inspection.reason) ? 'correct' : 'reject';
    return malformedIntent('malformed_tool_envelope', action, nameAllowed ? exactEnvelope.name : '');
  }

  if (inspection.reason === 'invalid_json') {
    const truncated = content.match(TRUNCATED_ENVELOPE_PREFIX);
    if (truncated) {
      const name = truncated[1];
      return malformedIntent('malformed_tool_envelope', allowed.has(name) ? 'correct' : 'reject', allowed.has(name) ? name : '');
    }
  }
  return noMalformedIntent();
}

function createToolRetryPrompt(allowedNames = []) {
  const names = safeAllowedNames(allowedNames);
  return [
    'Return the final answer for the current task now.',
    'If a tool is required, return exactly one strict JSON tool call and nothing else:',
    '{"tool_call":{"name":"tool_name","arguments":{}}}',
    'If no tool is required, return only the final text answer.',
    'Do not write planning, reasoning, Markdown, or explanations about tool use.',
    `Use only one of these tool names: ${JSON.stringify(names)}`,
  ].join('\n');
}

function createFencedToolRetryPrompt(allowedNames = []) {
  return [
    'Return the intended tool call for the current task now.',
    'Return exactly one strict JSON object and nothing else:',
    '{"tool_call":{"name":"tool_name","arguments":{}}}',
    'Do not use Markdown or code fences.',
    'Do not include reasoning, prose, explanations, comments, or any text before or after the JSON.',
    `Use only one of these tool names: ${JSON.stringify(safeAllowedNames(allowedNames))}`,
  ].join('\n');
}

function hideRetryReasoning(output, toolCall) {
  if (toolCall) return output;
  const content = typeof output?.content === 'string' ? output.content : '';
  return {
    ...output,
    content: content.trim() ? content : TOOL_RETRY_FAILURE_MESSAGE,
    reasoning: '',
  };
}

function logToolRetry(logger) {
  const write = typeof logger === 'function' ? logger : console.warn;
  try { write('[bridge] Retrying one reasoning-only tool response.'); } catch {}
}

function fencedToolFailure(output = {}) {
  return { ...output, content: TOOL_RETRY_FAILURE_MESSAGE, reasoning: '' };
}

function prefixedToolFailure(output = {}) {
  return fencedToolFailure(output);
}

function braceToolFailure(output = {}) {
  return fencedToolFailure(output);
}

function malformedToolFailure(output = {}) {
  return fencedToolFailure(output);
}

function logFencedToolRetry(logger) {
  const write = typeof logger === 'function' ? logger : console.warn;
  try { write('[bridge] Retrying one fenced tool response.'); } catch {}
}

function logPrefixedToolRetry(logger) {
  const write = typeof logger === 'function' ? logger : console.warn;
  try { write('[bridge] Retrying one prefixed tool response.'); } catch {}
}

function logBraceToolRetry(logger) {
  const write = typeof logger === 'function' ? logger : console.warn;
  try { write('[bridge] Retrying one brace-delimited tool-like response.'); } catch {}
}

function logMalformedToolRetry(logger, structuralClass) {
  const write = typeof logger === 'function' ? logger : console.warn;
  const safeClass = ['textual_tool_transcript', 'multi_tool_like', 'malformed_tool_envelope'].includes(structuralClass)
    ? structuralClass
    : 'malformed_tool_envelope';
  try { write(`[bridge] Retrying one ${safeClass} response.`); } catch {}
}

module.exports = {
  TOOL_RETRY_FAILURE_MESSAGE,
  braceToolFailure,
  classifyMalformedToolIntent,
  createFencedToolRetryPrompt,
  createToolRetryPrompt,
  fencedToolFailure,
  hideRetryReasoning,
  isSafeCorrectionFinalText,
  logBraceToolRetry,
  logFencedToolRetry,
  logMalformedToolRetry,
  logPrefixedToolRetry,
  logToolRetry,
  malformedToolFailure,
  prefixedToolFailure,
  shouldRetryBraceDelimitedToolLikeResponse,
  shouldRetryFencedToolResponse,
  shouldRetryPrefixedToolResponse,
  shouldRetryToolResponse,
};
