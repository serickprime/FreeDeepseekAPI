'use strict';
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
function isLoopback(host) { return LOOPBACK.has(String(host || '').replace(/^\[|\]$/g, '').toLowerCase()); }
function safeError(error) {
  const message = String(error?.message || error || 'Internal error');
  return message.replace(/(Bearer\s+)[^\s,]+/ig, '$1[REDACTED]').replace(/(cookie|token|authorization)\s*[:=]\s*[^,\s]+/ig, '$1=[REDACTED]');
}
function parseOrigins(raw = '') {
  const defaults = ['http://127.0.0.1', 'http://localhost'];
  return new Set([...defaults, ...raw.split(',').map(x => x.trim()).filter(Boolean)]);
}
function isLocalOrigin(origin) {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopback(url.hostname);
  } catch { return false; }
}
function cors(req, res, origins) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!isLocalOrigin(origin) && !origins.has(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-agent-session, x-setup-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  return true;
}
function authorized(req, key, required) {
  if (!required) return true;
  const value = req.headers.authorization || '';
  return Boolean(key) && value === `Bearer ${key}`;
}
function assertConfig(env = process.env) {
  const host = env.HOST || '127.0.0.1'; const key = env.PROXY_API_KEY || '';
  if (!isLoopback(host) && key.length < 24) throw new Error('External HOST requires PROXY_API_KEY of at least 24 characters.');
  return { host, port: Number(env.PORT || 9655), key, maxBytes: Number(env.REQUEST_MAX_BYTES || 1048576), timeoutMs: Number(env.DEEPSEEK_TIMEOUT_MS || 120000), origins: parseOrigins(env.PROXY_CORS_ORIGINS) };
}
module.exports = { isLoopback, isLocalOrigin, safeError, cors, authorized, assertConfig };
