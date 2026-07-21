'use strict';
const crypto = require('crypto');
class SessionStore {
  constructor({ ttlMs = 1_800_000, maxHistory = 24, maxChars = 60_000 } = {}) { this.ttlMs = ttlMs; this.maxHistory = maxHistory; this.maxChars = maxChars; this.sessions = new Map(); }
  get(key = 'default') { let s = this.sessions.get(key); if (!s || Date.now() - s.updatedAt > this.ttlMs) { s = { id: null, parentMessageId: null, history: [], updatedAt: Date.now() }; this.sessions.set(key, s); } s.updatedAt = Date.now(); return s; }
  reset(key = 'default') { this.sessions.delete(key); }
  list() { this.sweep(); return [...this.sessions.entries()].map(([key, s]) => ({ key, remote_session: Boolean(s.id), turns: s.history.length, updated_at: new Date(s.updatedAt).toISOString() })); }
  sweep() { for (const [k, s] of this.sessions) if (Date.now() - s.updatedAt > this.ttlMs) this.sessions.delete(k); }
  add(s, user, assistant) { s.history.push({ user: String(user).slice(0, this.maxChars), assistant: String(assistant).slice(0, this.maxChars) }); while (s.history.length > this.maxHistory) s.history.shift(); s.updatedAt = Date.now(); }
  key(input) { return String(input || crypto.randomUUID()).slice(0, 128); }
}
module.exports = { SessionStore };
