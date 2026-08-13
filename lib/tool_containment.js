'use strict';

const TOOL_NAME = /^[A-Za-z_][\w.-]{0,127}$/;
const PRIVATE_PROMPT_MARKERS = [
  '--- TOOL REQUEST SYSTEM ---',
  '--- END TOOL REQUEST SYSTEM ---',
];
const PRIVATE_PROMPT_PREFIXES = [
  '--- TOOL REQUEST SYS',
  '--- END TOOL REQUEST SYS',
];
const STREAM_PROTOCOL_MARKERS = [
  ...PRIVATE_PROMPT_PREFIXES,
  '[Tool Call]',
  '{"tool_call"',
  '"tool_call"',
  '<tool_call>',
];
const TEXTUAL_TOOL_TRANSCRIPT = /^\s*\[Tool Call\]\s*\r?\nname:\s*([A-Za-z_][\w.-]{0,127})\s*\r?\n(?:call_id:\s*[^\r\n]{1,256}\s*\r?\n)?arguments:\s*([^\r\n]{1,49152})\s*$/;
const TOOL_ENVELOPE_MARKER = /\{\s*"tool_call"\s*:\s*\{\s*"name"\s*:\s*"([A-Za-z_][\w.-]{0,127})"\s*,\s*"arguments"\s*:/g;
const XML_TOOL_ENVELOPE_MARKER = /<tool_call>\s*\{\s*"name"\s*:\s*"([A-Za-z_][\w.-]{0,127})"\s*,\s*"arguments"\s*:/gi;
const INVISIBLE_PROTOCOL_CHARS = /[\u200B-\u200D\uFEFF]/gu;

function safeAllowedNames(allowedNames) {
  return new Set((Array.isArray(allowedNames) ? allowedNames : [])
    .filter(name => typeof name === 'string' && TOOL_NAME.test(name))
    .slice(0, 32));
}

function hasDocumentationContext(text) {
  if (/```|~~~|`[^`]*tool_call[^`]*`/i.test(text)) return true;
  if (/^\s*>/m.test(text)) return true;
  if (/^\s*#{1,6}\s/m.test(text)) return true;
  return /^\s*(?:(?:here(?:'s|\s+is)?|this\s+is)\s+an?\s+)?(?:documentation|example(?:\s+only)?|sample|json\s+tutorial|readme\s+(?:content|example|documentation))(?:\s+(?:tool\s+protocol|tool\s+call|json))?\s*:|^\s*(?:вот\s+)?пример(?:а|ы|ов)?(?:\s+(?:tool\s+protocol|tool\s+call|json|протокола\s+инструмента))?\s*:|^\s*(?:quoted\s+)?previous\s+(?:error|failure|output|response)\s*:/imu.test(text);
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

function normalizeProtocolText(value) {
  return String(value || '').replace(INVISIBLE_PROTOCOL_CHARS, '');
}

function normalizedWithOriginalIndexes(value) {
  const text = String(value || '');
  let normalized = '';
  const indexes = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const codePoint = character.codePointAt(0);
    if ((codePoint >= 0x200B && codePoint <= 0x200D) || codePoint === 0xFEFF) continue;
    indexes.push(index);
    normalized += character;
  }
  return { text, normalized, indexes };
}

function findStreamProtocolMarkerIndex(value) {
  const { normalized, indexes } = normalizedWithOriginalIndexes(value);
  let normalizedIndex = -1;
  for (const marker of STREAM_PROTOCOL_MARKERS) {
    const index = normalized.indexOf(marker);
    if (index >= 0 && (normalizedIndex < 0 || index < normalizedIndex)) normalizedIndex = index;
  }
  return normalizedIndex < 0 ? -1 : indexes[normalizedIndex] ?? -1;
}

function streamProtocolMarkerSuffixLength(value) {
  const { text, normalized, indexes } = normalizedWithOriginalIndexes(value);
  let normalizedLength = 0;
  for (const marker of STREAM_PROTOCOL_MARKERS) {
    const limit = Math.min(marker.length - 1, normalized.length);
    for (let size = limit; size > normalizedLength; size -= 1) {
      if (marker.startsWith(normalized.slice(-size))) {
        normalizedLength = size;
        break;
      }
    }
  }
  if (normalizedLength === 0) return 0;
  const normalizedStart = normalized.length - normalizedLength;
  const originalStart = indexes[normalizedStart] ?? text.length;
  return text.length - originalStart;
}

function protocolEnvelopeNames(text) {
  const names = [];
  for (const pattern of [TOOL_ENVELOPE_MARKER, XML_TOOL_ENVELOPE_MARKER]) {
    pattern.lastIndex = 0;
    for (let match; (match = pattern.exec(text)) !== null;) {
      names.push(match[1]);
      if (names.length >= 32) return names;
    }
  }
  return names;
}

function classifySelectedProtocolOutput(selected, allowed) {
  if (!selected) return noProtocolIntent();
  const normalized = normalizeProtocolText(selected).trim();
  if (!normalized || hasDocumentationContext(normalized)) return noProtocolIntent();

  const transcript = normalized.match(TEXTUAL_TOOL_TRANSCRIPT);
  if (transcript) {
    const name = transcript[1];
    const action = actionForName(name, allowed);
    return protocolIntent('textual_tool_transcript', action, action === 'correctable' ? name : '');
  }

  const names = protocolEnvelopeNames(normalized);
  if (names.length === 0) return noProtocolIntent();
  const allAllowed = names.every(name => allowed.has(name));
  return protocolIntent(
    'tool_protocol_envelope',
    allAllowed ? 'correctable' : 'contain_only',
    names.length === 1 && allAllowed ? names[0] : '',
  );
}

function mergeProtocolIntents(contentIntent, reasoningIntent) {
  const intents = [contentIntent, reasoningIntent].filter(intent => intent.action !== 'none');
  if (intents.length === 0) return noProtocolIntent();
  if (intents.some(intent => intent.action === 'contain_only')) {
    const source = intents.find(intent => intent.action === 'contain_only');
    return protocolIntent(source.structuralClass, 'contain_only');
  }
  const classes = new Set(intents.map(intent => intent.structuralClass));
  const names = [...new Set(intents.map(intent => intent.mentionedToolName).filter(Boolean))];
  return protocolIntent(
    classes.size === 1 ? intents[0].structuralClass : 'tool_protocol_envelope',
    'correctable',
    names.length === 1 ? names[0] : '',
  );
}

function decideToolProtocolOutput({ output, allowedNames, toolCall, correctionAttempted = false } = {}) {
  const content = typeof output?.content === 'string' ? output.content : '';
  const reasoning = typeof output?.reasoning === 'string' ? output.reasoning : '';
  if (PRIVATE_PROMPT_PREFIXES.some(marker => content.includes(marker) || reasoning.includes(marker))) {
    return { action: 'contain', intent: protocolIntent('internal_tool_prompt', 'contain_only'), suppressReasoning: true };
  }
  const allowed = safeAllowedNames(allowedNames);
  const contentIntent = classifySelectedProtocolOutput(content, allowed);
  const reasoningIntent = classifySelectedProtocolOutput(reasoning, allowed);
  const suppressReasoning = reasoningIntent.action !== 'none';
  if (toolCall) return { action: 'tool_use', intent: contentIntent, suppressReasoning };

  const selectedIntent = content.trim() ? contentIntent : reasoningIntent;
  if (selectedIntent.action === 'none') return { action: 'final_text', intent: selectedIntent, suppressReasoning };
  if (selectedIntent.action === 'correctable' && correctionAttempted !== true) {
    return { action: 'correct', intent: selectedIntent, suppressReasoning };
  }
  return { action: 'contain', intent: selectedIntent, suppressReasoning: true };
}

function classifyToolProtocolOutput({ output, allowedNames } = {}) {
  const content = typeof output?.content === 'string' ? output.content : '';
  const reasoning = typeof output?.reasoning === 'string' ? output.reasoning : '';

  if (PRIVATE_PROMPT_PREFIXES.some(marker => content.includes(marker) || reasoning.includes(marker))) {
    return protocolIntent('internal_tool_prompt', 'contain_only');
  }
  const allowed = safeAllowedNames(allowedNames);
  return mergeProtocolIntents(
    classifySelectedProtocolOutput(content, allowed),
    classifySelectedProtocolOutput(reasoning, allowed),
  );
}

function containsStreamProtocolMarker(text) {
  return typeof text === 'string' && findStreamProtocolMarkerIndex(text) >= 0;
}

module.exports = {
  PRIVATE_PROMPT_MARKERS,
  STREAM_PROTOCOL_MARKERS,
  classifyToolProtocolOutput,
  containsStreamProtocolMarker,
  decideToolProtocolOutput,
  findStreamProtocolMarkerIndex,
  streamProtocolMarkerSuffixLength,
};
