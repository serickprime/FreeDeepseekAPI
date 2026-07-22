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

function createToolRetryPrompt(allowedNames = []) {
  const names = [...new Set(allowedNames.filter(name => typeof name === 'string' && TOOL_NAME.test(name)))].slice(0, 32);
  return [
    'Return the final answer for the current task now.',
    'If a tool is required, return exactly one strict JSON tool call and nothing else:',
    '{"tool_call":{"name":"tool_name","arguments":{}}}',
    'If no tool is required, return only the final text answer.',
    'Do not write planning, reasoning, Markdown, or explanations about tool use.',
    `Use only one of these tool names: ${JSON.stringify(names)}`,
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

module.exports = {
  TOOL_RETRY_FAILURE_MESSAGE,
  createToolRetryPrompt,
  hideRetryReasoning,
  logToolRetry,
  shouldRetryToolResponse,
};
