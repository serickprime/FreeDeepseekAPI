'use strict';

const TOOL_NAME = /^[A-Za-z_][\w.-]{0,127}$/;
const PRIVATE_PROMPT_MARKERS = [
  '--- TOOL REQUEST SYSTEM ---',
  '--- END TOOL REQUEST SYSTEM ---',
];
const STREAM_PROTOCOL_MARKERS = [
  ...PRIVATE_PROMPT_MARKERS,
  '[Tool Call]',
  '{"tool_call"',
  '"tool_call"',
];
const TEXTUAL_TOOL_TRANSCRIPT = /^\s*\[Tool Call\]\s*\r?\nname:\s*([A-Za-z_][\w.-]{0,127})\s*\r?\n(?:call_id:\s*[^\r\n]{1,256}\s*\r?\n)?arguments:\s*([^\r\n]{1,49152})\s*$/;
const WHOLE_TOOL_ENVELOPE = /^\s*\{\s*"tool_call"\s*:\s*\{\s*"name"\s*:\s*"([A-Za-z_][\w.-]{0,127})"\s*,\s*"arguments"\s*:[\s\S]*$/;
const STANDALONE_TOOL_ENVELOPE = /^\s*\{\s*"tool_call"\s*:\s*\{\s*"name"\s*:\s*"([A-Za-z_][\w.-]{0,127})"\s*,\s*"arguments"\s*:[^\r\n]*$/;

function safeAllowedNames(allowedNames) {
  return new Set((Array.isArray(allowedNames) ? allowedNames : [])
    .filter(name => typeof name === 'string' && TOOL_NAME.test(name))
    .slice(0, 32));
}

function hasDocumentationContext(text) {
  if (/```|~~~|`[^`]*tool_call[^`]*`/i.test(text)) return true;
  if (/^\s*>/m.test(text)) return true;
  if (/^\s*#{1,6}\s/m.test(text)) return true;
  return /^\s*(?:(?:here(?:'s|\s+is)?|this\s+is)\s+an?\s+)?(?:documentation|example|sample|json\s+tutorial|readme\s+(?:content|example|documentation))\s*:|^\s*(?:вот\s+)?пример(?:а|ы|ов)?\s*:|^\s*(?:quoted|previous)\s+(?:error|failure|output|response)\s*:/imu.test(text);
}

function protocolIntent(structuralClass, action, mentionedToolName = '') {
  return { structuralClass, action, mentionedToolName };
}

function noProtocolIntent() {
  return protocolIntent('none', 'none');
}

function actionForName(name, allowed) {
  return allowed.has(name) ? 'correctable' : 'contain_only';
}

function classifyToolProtocolOutput({ output, allowedNames } = {}) {
  const content = typeof output?.content === 'string' ? output.content.trim() : '';
  const reasoning = typeof output?.reasoning === 'string' ? output.reasoning.trim() : '';

  if (PRIVATE_PROMPT_MARKERS.some(marker => content.includes(marker) || reasoning.includes(marker))) {
    return protocolIntent('internal_tool_prompt', 'contain_only');
  }
  const selected = content || reasoning;
  if (!selected) return noProtocolIntent();

  const transcript = selected.match(TEXTUAL_TOOL_TRANSCRIPT);
  if (transcript) {
    const allowed = safeAllowedNames(allowedNames);
    const name = transcript[1];
    const action = actionForName(name, allowed);
    return protocolIntent('textual_tool_transcript', action, action === 'correctable' ? name : '');
  }

  if (hasDocumentationContext(selected)) return noProtocolIntent();
  const allowed = safeAllowedNames(allowedNames);
  const whole = selected.match(WHOLE_TOOL_ENVELOPE);
  if (whole) {
    const name = whole[1];
    const action = actionForName(name, allowed);
    return protocolIntent('tool_protocol_envelope', action, action === 'correctable' ? name : '');
  }

  const lines = selected.split(/\r?\n/);
  const names = lines.flatMap(line => {
    const match = line.match(STANDALONE_TOOL_ENVELOPE);
    return match ? [match[1]] : [];
  });
  if (names.length > 0) {
    const allAllowed = names.every(name => allowed.has(name));
    return protocolIntent('tool_protocol_envelope', allAllowed ? 'correctable' : 'contain_only', names.length === 1 && allAllowed ? names[0] : '');
  }
  return noProtocolIntent();
}

function containsStreamProtocolMarker(text) {
  return typeof text === 'string' && STREAM_PROTOCOL_MARKERS.some(marker => text.includes(marker));
}

module.exports = {
  PRIVATE_PROMPT_MARKERS,
  STREAM_PROTOCOL_MARKERS,
  classifyToolProtocolOutput,
  containsStreamProtocolMarker,
};
