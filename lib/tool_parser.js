'use strict';
const MAX = 48 * 1024;
function parseToolCall(text, allowedNames = []) {
  if (typeof text !== 'string' || text.length > MAX) return null;
  const trimmed = text.trim();
  const match = trimmed.match(/^<tool_call>\s*([\s\S]*?)\s*<\/tool_call>$/i);
  let envelope;
  try { envelope = JSON.parse(match ? match[1] : trimmed); } catch { return null; }
  const value = envelope?.tool_call || envelope;
  if (!match && !envelope?.tool_call) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.name !== 'string' || !/^[A-Za-z_][\w.-]{0,127}$/.test(value.name)) return null;
  if (allowedNames.length && !allowedNames.includes(value.name)) return null;
  if (!value.arguments || typeof value.arguments !== 'object' || Array.isArray(value.arguments)) return null;
  const argumentsJson = JSON.stringify(value.arguments);
  if (Buffer.byteLength(argumentsJson) > MAX) return null;
  return { id: `call_${require('crypto').randomUUID().replace(/-/g, '')}`, type: 'function', function: { name: value.name, arguments: argumentsJson } };
}
function toolPrompt(tools) {
  if (!Array.isArray(tools) || !tools.length) return '';
  const safe = tools.slice(0, 32).map(t => t?.function || t).filter(t => t && typeof t.name === 'string').map(t => ({ name: t.name, description: String(t.description || '').slice(0, 1000), parameters: t.parameters || t.input_schema || {} }));
  return safe.length ? `\n\n--- TOOL REQUEST SYSTEM ---\nYou only reason and REQUEST tool execution. Never execute commands yourself. When a tool is needed, output exactly one JSON object and nothing else:\n{"tool_call":{"name":"tool_name","arguments":{}}}\nDo not describe the tool request in prose. Do not write "Tool:" or simulate its result. Wait for the real tool result in the next message. A normal JSON example is not a tool request unless the entire response is this exact tool_call envelope. Available tools: ${JSON.stringify(safe)}\n--- END TOOL REQUEST SYSTEM ---` : '';
}
module.exports = { parseToolCall, toolPrompt };
