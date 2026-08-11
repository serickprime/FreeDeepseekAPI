'use strict';

const TOOL_RETRY_FAILURE_MESSAGE = 'The model could not produce a valid tool call. Please retry or rephrase the request.';
const TOOL_NAME = /^[A-Za-z_][\w.-]{0,127}$/;

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

function shouldRetryPrefixedToolResponse({ hasTools, toolCall, retryCount = 0, inspection } = {}) {
  return retryCount === 0
    && hasTools === true
    && !toolCall
    && inspection?.source === 'content'
    && inspection.reason === 'invalid_json'
    && inspection.metadata?.content_starts_with_code_fence === false
    && inspection.metadata?.content_starts_with_brace === false
    && inspection.metadata?.content_ends_with_brace === true
    && inspection.metadata?.content_contains_tool_call_marker === true;
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

module.exports = {
  TOOL_RETRY_FAILURE_MESSAGE,
  braceToolFailure,
  createFencedToolRetryPrompt,
  createToolRetryPrompt,
  fencedToolFailure,
  hideRetryReasoning,
  logBraceToolRetry,
  logFencedToolRetry,
  logPrefixedToolRetry,
  logToolRetry,
  prefixedToolFailure,
  shouldRetryBraceDelimitedToolLikeResponse,
  shouldRetryFencedToolResponse,
  shouldRetryPrefixedToolResponse,
  shouldRetryToolResponse,
};
