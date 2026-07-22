'use strict';
const MAX = 48 * 1024;
const MAX_NESTING_DEPTH = 32;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasSafeNestedValues(argumentsValue) {
  const pending = [{ value: argumentsValue, depth: 0 }];
  while (pending.length) {
    const { value, depth } = pending.pop();
    if (depth > MAX_NESTING_DEPTH) return false;
    if (!value || typeof value !== 'object') continue;
    if (!Array.isArray(value) && !isPlainObject(value)) return false;
    if (!Array.isArray(value) && Object.keys(value).some(key => DANGEROUS_KEYS.has(key))) return false;
    for (const nested of Array.isArray(value) ? value : Object.values(value)) {
      if (nested && typeof nested === 'object') pending.push({ value: nested, depth: depth + 1 });
    }
  }
  return true;
}

function parseToolCall(text, allowedNames = []) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX) return null;
  const trimmed = text.trim();
  const match = trimmed.match(/^<tool_call>\s*([\s\S]*?)\s*<\/tool_call>$/i);
  let envelope;
  try { envelope = JSON.parse(match ? match[1] : trimmed); } catch { return null; }
  if (!isPlainObject(envelope)) return null;
  const value = match ? envelope : envelope.tool_call;
  if (!match && (Object.keys(envelope).length !== 1 || !isPlainObject(value))) return null;
  if (!isPlainObject(value) || Object.keys(value).some(key => key !== 'name' && key !== 'arguments')) return null;
  if (typeof value.name !== 'string' || !/^[A-Za-z_][\w.-]{0,127}$/.test(value.name)) return null;
  if (!Array.isArray(allowedNames) || !allowedNames.includes(value.name)) return null;
  if (!isPlainObject(value.arguments) || !hasSafeNestedValues(value.arguments)) return null;
  let argumentsJson;
  try { argumentsJson = JSON.stringify(value.arguments); } catch { return null; }
  if (Buffer.byteLength(argumentsJson) > MAX) return null;
  return { id: `call_${require('crypto').randomUUID().replace(/-/g, '')}`, type: 'function', function: { name: value.name, arguments: argumentsJson } };
}

function parseToolCallFromOutput(output, allowedNames = []) {
  if (!output || typeof output !== 'object') return null;
  if (typeof output.content !== 'string') return null;
  const content = output.content;
  if (content.trim()) return parseToolCall(content, allowedNames);
  const reasoning = typeof output.reasoning === 'string' ? output.reasoning : '';
  return parseToolCall(reasoning, allowedNames);
}

function toolPrompt(tools) {
  if (!Array.isArray(tools) || !tools.length) return '';
  const safe = tools.slice(0, 32).map(t => t?.function || t).filter(t => t && typeof t.name === 'string').map(t => ({ name: t.name, description: String(t.description || '').slice(0, 1000), parameters: t.parameters || t.input_schema || {} }));
  return safe.length ? `\n\n--- TOOL REQUEST SYSTEM ---\nYou only reason and REQUEST tool execution. Never execute commands yourself. When a tool is needed, output exactly one JSON object and nothing else:\n{"tool_call":{"name":"tool_name","arguments":{}}}\nDo not describe the tool request in prose. Do not write "Tool:" or simulate its result. Wait for the real tool result in the next message. A normal JSON example is not a tool request unless the entire response is this exact tool_call envelope. Available tools: ${JSON.stringify(safe)}\n--- END TOOL REQUEST SYSTEM ---` : '';
}
module.exports = { MAX_TOOL_BYTES: MAX, MAX_NESTING_DEPTH, parseToolCall, parseToolCallFromOutput, toolPrompt };
