'use strict';

const MAX_DEPTH = 32;
const MAX_NODES = 20_000;
const MAX_TEXT_CODE_UNITS = 262_144;
const IMAGE_BLOCK_TOKENS = 1_024;
const UNKNOWN_BLOCK_TOKENS = 64;
const DEPTH_LIMIT_TOKENS = 32;
const NODE_LIMIT_TOKENS = 256;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function estimateTextTokens(value) {
  if (typeof value !== 'string' || !value) return 0;
  const limited = value.slice(0, MAX_TEXT_CODE_UNITS);
  let units = 0;
  for (const character of limited) {
    const point = character.codePointAt(0);
    if (point <= 0x7f) {
      if (/\s/.test(character)) units += 0.25;
      else if (/[A-Za-z0-9_]/.test(character)) units += 0.29;
      else units += 0.75;
    } else if (/\p{Extended_Pictographic}/u.test(character)) {
      units += 2;
    } else if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) {
      units += 1;
    } else {
      units += Math.max(0.5, Buffer.byteLength(character, 'utf8') / 3);
    }
  }
  if (value.length > limited.length) units += Math.ceil((value.length - limited.length) / 2);
  return Math.ceil(units);
}

function enter(state) {
  if (state.nodes < MAX_NODES) {
    state.nodes += 1;
    return 0;
  }
  if (state.nodeLimitCharged) return null;
  state.nodeLimitCharged = true;
  return NODE_LIMIT_TOKENS;
}

function estimateJson(value, state, depth = 0) {
  if (depth > MAX_DEPTH) return DEPTH_LIMIT_TOKENS;
  const entered = enter(state);
  if (entered === null) return 0;
  if (entered) return entered;
  if (value === null || value === undefined) return 1;
  if (typeof value === 'string') return estimateTextTokens(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return 1;
  if (typeof value !== 'object') return 2;
  if (state.seen.has(value)) return 2;
  state.seen.add(value);
  if (Array.isArray(value)) {
    let total = 2;
    for (const item of value) {
      total += 1 + estimateJson(item, state, depth + 1);
      if (state.nodeLimitCharged && state.nodes >= MAX_NODES) break;
    }
    return total;
  }
  if (!isPlainObject(value)) return UNKNOWN_BLOCK_TOKENS;
  let total = 2;
  for (const [key, nested] of Object.entries(value)) {
    total += 1 + estimateTextTokens(key) + estimateJson(nested, state, depth + 1);
    if (state.nodeLimitCharged && state.nodes >= MAX_NODES) break;
  }
  return total;
}

function estimateBlock(block, state, depth = 0) {
  if (depth > MAX_DEPTH) return DEPTH_LIMIT_TOKENS;
  const entered = enter(state);
  if (entered === null) return 0;
  if (entered) return entered;
  if (typeof block === 'string') return 2 + estimateTextTokens(block);
  if (!isPlainObject(block)) return UNKNOWN_BLOCK_TOKENS;
  if (state.seen.has(block)) return 2;
  state.seen.add(block);
  const type = typeof block.type === 'string' ? block.type : '';
  if (type === 'text' || type === 'input_text' || type === 'output_text') return 3 + estimateTextTokens(block.text || '');
  if (type === 'thinking') return 4 + estimateTextTokens(block.thinking || block.text || '');
  if (type === 'redacted_thinking') return 16;
  if (type === 'tool_use') {
    return 10 + estimateTextTokens(block.name || '') + estimateTextTokens(block.id || '') + estimateJson(block.input, state, depth + 1);
  }
  if (type === 'tool_result') {
    return 8 + estimateTextTokens(block.tool_use_id || '') + estimateContent(block.content, state, depth + 1) + (block.is_error ? 1 : 0);
  }
  if (type === 'image') return IMAGE_BLOCK_TOKENS;
  return UNKNOWN_BLOCK_TOKENS;
}

function estimateContent(content, state, depth = 0) {
  if (depth > MAX_DEPTH) return DEPTH_LIMIT_TOKENS;
  if (typeof content === 'string') return estimateTextTokens(content);
  if (Array.isArray(content)) {
    if (state.seen.has(content)) return 2;
    state.seen.add(content);
    let total = 0;
    for (const block of content) {
      total += estimateBlock(block, state, depth + 1);
      if (state.nodeLimitCharged && state.nodes >= MAX_NODES) break;
    }
    return total;
  }
  if (content === null || content === undefined) return 0;
  return estimateBlock(content, state, depth + 1);
}

function estimateTokenCount(body = {}) {
  const state = { nodes: 0, nodeLimitCharged: false, seen: new WeakSet() };
  let total = 4;
  if (body.system !== undefined) total += 4 + estimateContent(body.system, state);
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      const entered = enter(state);
      if (entered === null) break;
      if (entered) { total += entered; break; }
      total += 6;
      if (isPlainObject(message)) {
        total += estimateTextTokens(message.role || '');
        total += estimateContent(message.content, state);
      } else total += UNKNOWN_BLOCK_TOKENS;
      if (state.nodeLimitCharged && state.nodes >= MAX_NODES) break;
    }
  }
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      const entered = enter(state);
      if (entered === null) break;
      if (entered) { total += entered; break; }
      total += 12;
      if (!isPlainObject(tool)) {
        total += UNKNOWN_BLOCK_TOKENS;
        continue;
      }
      total += estimateTextTokens(tool.name || '');
      total += estimateTextTokens(tool.description || '');
      total += estimateJson(tool.input_schema, state);
      if (state.nodeLimitCharged && state.nodes >= MAX_NODES) break;
    }
  }
  return Math.max(0, Math.ceil(total));
}

function validateCountTokensBody(body) {
  if (!isPlainObject(body)) return 'Request body must be a JSON object.';
  if (typeof body.model !== 'string' || !body.model.trim()) return 'model is required and must be a non-empty string.';
  if (!Array.isArray(body.messages)) return 'messages is required and must be an array.';
  if (body.system !== undefined && typeof body.system !== 'string' && !Array.isArray(body.system)) return 'system must be a string or an array of content blocks.';
  if (body.tools !== undefined && !Array.isArray(body.tools)) return 'tools must be an array.';
  return null;
}

module.exports = {
  IMAGE_BLOCK_TOKENS,
  MAX_DEPTH,
  MAX_NODES,
  UNKNOWN_BLOCK_TOKENS,
  estimateTextTokens,
  estimateTokenCount,
  validateCountTokensBody,
};
