'use strict';
const MAX = 48 * 1024;
const MAX_NESTING_DEPTH = 32;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function inspectNestedValues(argumentsValue) {
  const pending = [{ value: argumentsValue, depth: 0 }];
  while (pending.length) {
    const { value, depth } = pending.pop();
    if (depth > MAX_NESTING_DEPTH) return 'excessive_nesting';
    if (!value || typeof value !== 'object') continue;
    if (!Array.isArray(value) && !isPlainObject(value)) return 'unsafe_arguments';
    if (!Array.isArray(value) && Object.keys(value).some(key => DANGEROUS_KEYS.has(key))) return 'unsafe_arguments';
    for (const nested of Array.isArray(value) ? value : Object.values(value)) {
      if (nested && typeof nested === 'object') pending.push({ value: nested, depth: depth + 1 });
    }
  }
  return null;
}

function rejected(reason) {
  return { toolCall: null, reason };
}

function inspectToolCall(text, allowedNames = []) {
  if (typeof text !== 'string') return rejected('input_not_string');
  if (Buffer.byteLength(text) > MAX) return rejected('input_too_large');
  const trimmed = text.trim();
  if (!trimmed) return rejected('empty_input');
  const match = trimmed.match(/^<tool_call>\s*([\s\S]*?)\s*<\/tool_call>$/i);
  let envelope;
  try { envelope = JSON.parse(match ? match[1] : trimmed); } catch { return rejected('invalid_json'); }
  if (!isPlainObject(envelope)) return rejected('invalid_envelope');
  const value = match ? envelope : envelope.tool_call;
  if (!match && Object.keys(envelope).length !== 1) return rejected('unexpected_envelope_keys');
  if (!match && !Object.prototype.hasOwnProperty.call(envelope, 'tool_call')) return rejected('unexpected_envelope_keys');
  if (!isPlainObject(value)) return rejected('invalid_tool_shape');
  if (Object.keys(value).some(key => key !== 'name' && key !== 'arguments')) return rejected('invalid_tool_shape');
  if (typeof value.name !== 'string' || !/^[A-Za-z_][\w.-]{0,127}$/.test(value.name)) return rejected('invalid_tool_name');
  if (!Array.isArray(allowedNames) || !allowedNames.includes(value.name)) return rejected('tool_not_allowed');
  if (!isPlainObject(value.arguments)) return rejected('arguments_not_object');
  const nestedReason = inspectNestedValues(value.arguments);
  if (nestedReason) return rejected(nestedReason);
  let argumentsJson;
  try { argumentsJson = JSON.stringify(value.arguments); } catch { return rejected('unsafe_arguments'); }
  if (Buffer.byteLength(argumentsJson) > MAX) return rejected('arguments_too_large');
  return {
    toolCall: { id: `call_${require('crypto').randomUUID().replace(/-/g, '')}`, type: 'function', function: { name: value.name, arguments: argumentsJson } },
    reason: 'accepted',
  };
}

function parseToolCall(text, allowedNames = []) {
  return inspectToolCall(text, allowedNames).toolCall;
}

function structuralSignals(content, reasoning) {
  function signals(value, prefix) {
    const text = typeof value === 'string' ? value : '';
    const trimmed = text.trim();
    return {
      [`${prefix}_bytes`]: Buffer.byteLength(text),
      [`${prefix}_trimmed_bytes`]: Buffer.byteLength(trimmed),
      [`${prefix}_starts_with_brace`]: trimmed.startsWith('{'),
      [`${prefix}_ends_with_brace`]: trimmed.endsWith('}'),
      [`${prefix}_starts_with_code_fence`]: trimmed.startsWith('```'),
      [`${prefix}_contains_tool_call_marker`]: /tool_call/i.test(text),
    };
  }
  return { ...signals(content, 'content'), ...signals(reasoning, 'reasoning') };
}

function inspectToolCallFromOutput(output, allowedNames = []) {
  if (!output || typeof output !== 'object') {
    return { ...rejected('invalid_output'), source: 'none', metadata: structuralSignals('', '') };
  }
  if (typeof output.content !== 'string') {
    return { ...rejected('input_not_string'), source: 'none', metadata: structuralSignals('', output.reasoning) };
  }
  const content = output.content;
  const reasoning = typeof output.reasoning === 'string' ? output.reasoning : '';
  const metadata = structuralSignals(content, reasoning);
  if (content.trim()) return { ...inspectToolCall(content, allowedNames), source: 'content', metadata };
  return { ...inspectToolCall(reasoning, allowedNames), source: 'reasoning', metadata };
}

function parseToolCallFromOutput(output, allowedNames = []) {
  return inspectToolCallFromOutput(output, allowedNames).toolCall;
}

function toolPrompt(tools) {
  if (!Array.isArray(tools) || !tools.length) return '';
  const safe = tools.slice(0, 32).map(t => t?.function || t).filter(t => t && typeof t.name === 'string').map(t => ({ name: t.name, description: String(t.description || '').slice(0, 1000), parameters: t.parameters || t.input_schema || {} }));
  return safe.length ? `\n\n--- TOOL REQUEST SYSTEM ---\nYou only reason and REQUEST tool execution. Never execute commands yourself. When a tool is needed, output exactly one JSON object and nothing else:\n{"tool_call":{"name":"tool_name","arguments":{}}}\nDo not describe the tool request in prose. Do not write "Tool:" or simulate its result. Wait for the real tool result in the next message. If the task depends on information available only through an appropriate available tool, request that tool before answering. Do not claim that a file, project, or data is unavailable before attempting the appropriate available tool. A normal JSON example is not a tool request unless the entire response is this exact tool_call envelope. Available tools: ${JSON.stringify(safe)}\n--- END TOOL REQUEST SYSTEM ---` : '';
}
module.exports = {
  MAX_TOOL_BYTES: MAX,
  MAX_NESTING_DEPTH,
  inspectToolCall,
  inspectToolCallFromOutput,
  parseToolCall,
  parseToolCallFromOutput,
  toolPrompt,
};
