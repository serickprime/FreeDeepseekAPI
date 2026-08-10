'use strict';

const crypto = require('crypto');

const MAX_EXPLICIT_ID_BYTES = 128;
const MAX_CALL_ID_BYTES = 128;
const MAX_RESULT_CALL_IDS = 16;
const DEFAULT_LINK_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_LINKS = 512;
const SAFE_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function boundedString(value, maxBytes) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  if (!normalized || Buffer.byteLength(normalized) > maxBytes) return null;
  return normalized;
}

function explicitSessionKey(source, value) {
  const normalized = boundedString(value, MAX_EXPLICIT_ID_BYTES);
  if (!normalized) return null;
  const digest = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
  return `explicit:${source}:${digest}`;
}

function explicitSession(headers = {}, body = {}) {
  const safeHeaders = headers && typeof headers === 'object' ? headers : {};
  const safeBody = body && typeof body === 'object' ? body : {};
  const candidates = [
    ['header', safeHeaders['x-agent-session']],
    ['metadata', safeBody?.metadata?.user_id],
    ['user', safeBody?.user],
  ];
  for (const [source, value] of candidates) {
    if (value === undefined || value === null) continue;
    const key = explicitSessionKey(source, value);
    return key ? { key, source: `explicit_${source}` } : null;
  }
  return null;
}

function boundedClientString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || Buffer.byteLength(normalized) > MAX_EXPLICIT_ID_BYTES) return null;
  return normalized;
}

function clientSessionKey(source, value) {
  const normalized = boundedClientString(value);
  if (!normalized) return null;
  const digest = crypto.createHash('sha256').update(normalized).digest('hex');
  return `client:${source}:${digest}`;
}

function clientSession(headers = {}, body = {}) {
  const safeHeaders = headers && typeof headers === 'object' ? headers : {};
  const safeBody = body && typeof body === 'object' ? body : {};
  const candidates = [
    ['claude', 'claude_header', safeHeaders['x-claude-code-session-id']],
    ['header', 'explicit_header', safeHeaders['x-agent-session']],
    ['metadata', 'explicit_metadata', safeBody?.metadata?.user_id],
    ['user', 'explicit_user', safeBody?.user],
  ];
  for (const [keySource, clientSource, value] of candidates) {
    if (value === undefined || value === null) continue;
    const key = clientSessionKey(keySource, value);
    if (key) return { key, source: clientSource };
  }
  return null;
}

function normalizeCallId(value) {
  const normalized = boundedString(value, MAX_CALL_ID_BYTES);
  return normalized && SAFE_CALL_ID.test(normalized) ? normalized : null;
}

function extractToolResultCallIds(body = {}, kind) {
  const safeBody = body && typeof body === 'object' ? body : {};
  const values = [];
  if (kind === 'openai') {
    for (const message of Array.isArray(safeBody.messages) ? safeBody.messages : []) {
      if (message?.role === 'tool') values.push(message.tool_call_id);
    }
  } else if (kind === 'anthropic') {
    for (const message of Array.isArray(safeBody.messages) ? safeBody.messages : []) {
      for (const block of Array.isArray(message?.content) ? message.content : []) {
        if (block?.type === 'tool_result') values.push(block.tool_use_id);
      }
    }
  } else if (kind === 'responses') {
    for (const item of Array.isArray(safeBody.input) ? safeBody.input : []) {
      if (item?.type === 'function_call_output') values.push(item.call_id);
    }
  }
  return [...new Set(values.map(normalizeCallId).filter(Boolean))].slice(0, MAX_RESULT_CALL_IDS);
}

class SessionResolver {
  constructor({ ttlMs = DEFAULT_LINK_TTL_MS, maxLinks = DEFAULT_MAX_LINKS, now = () => Date.now(), randomUUID = () => crypto.randomUUID() } = {}) {
    this.ttlMs = Math.max(1, Number(ttlMs) || DEFAULT_LINK_TTL_MS);
    this.maxLinks = Math.max(1, Number(maxLinks) || DEFAULT_MAX_LINKS);
    this.now = now;
    this.randomUUID = randomUUID;
    this.links = new Map();
  }

  resolve({ headers = {}, body = {}, kind } = {}) {
    this.sweep();
    const callIds = extractToolResultCallIds(body, kind);
    const client = clientSession(headers, body);
    const explicit = explicitSession(headers, body);
    let upstream;
    if (explicit) {
      upstream = explicit;
    } else {
      const linkedKeys = new Set(callIds.map(callId => this.links.get(callId)?.sessionKey).filter(Boolean));
      upstream = linkedKeys.size === 1
        ? { key: [...linkedKeys][0], source: 'tool_result' }
        : { key: `anonymous:${this.randomUUID()}`, source: 'anonymous' };
    }
    return {
      upstreamKey: upstream.key,
      upstreamSource: upstream.source,
      clientKey: client?.key || null,
      clientSource: client?.source || 'unavailable',
      callIds,
    };
  }

  bind(callId, sessionKey) {
    this.sweep();
    const normalized = normalizeCallId(callId);
    if (!normalized || typeof sessionKey !== 'string' || !sessionKey) return false;
    this.links.delete(normalized);
    this.links.set(normalized, { sessionKey, expiresAt: this.now() + this.ttlMs });
    while (this.links.size > this.maxLinks) this.links.delete(this.links.keys().next().value);
    return true;
  }

  release(callIds, sessionKey) {
    for (const callId of Array.isArray(callIds) ? callIds : []) {
      const entry = this.links.get(callId);
      if (entry?.sessionKey === sessionKey) this.links.delete(callId);
    }
  }

  releaseSession(sessionKey) {
    for (const [callId, entry] of this.links) if (entry.sessionKey === sessionKey) this.links.delete(callId);
  }

  sweep() {
    const now = this.now();
    for (const [callId, entry] of this.links) if (entry.expiresAt <= now) this.links.delete(callId);
  }

  get size() {
    this.sweep();
    return this.links.size;
  }
}

module.exports = {
  DEFAULT_LINK_TTL_MS,
  DEFAULT_MAX_LINKS,
  MAX_CALL_ID_BYTES,
  MAX_EXPLICIT_ID_BYTES,
  SessionResolver,
  clientSessionKey,
  explicitSessionKey,
  extractToolResultCallIds,
  normalizeCallId,
};
