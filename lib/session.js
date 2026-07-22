'use strict';
const crypto = require('crypto');
class SessionStore {
  constructor({ ttlMs = 1_800_000, maxHistory = 24, maxChars = 60_000, maxSessions = 512, now = () => Date.now() } = {}) { this.ttlMs = ttlMs; this.maxHistory = maxHistory; this.maxChars = maxChars; this.maxSessions = Math.max(1, maxSessions); this.now = now; this.sessions = new Map(); }
  get(key) { const safeKey = String(key || `anonymous:${crypto.randomUUID()}`); this.sweep(); let s = this.sessions.get(safeKey); if (!s) { while (this.sessions.size >= this.maxSessions) this.evictOldest(); s = { id: null, parentMessageId: null, history: [], updatedAt: this.now() }; this.sessions.set(safeKey, s); } s.updatedAt = this.now(); return s; }
  reset(key) { if (key) this.sessions.delete(String(key)); }
  list() { this.sweep(); return [...this.sessions.entries()].map(([key, s]) => ({ key, remote_session: Boolean(s.id), turns: s.history.length, updated_at: new Date(s.updatedAt).toISOString() })); }
  sweep() { const now = this.now(); for (const [k, s] of this.sessions) if (now - s.updatedAt > this.ttlMs) this.sessions.delete(k); }
  evictOldest() { let oldestKey; let oldestTime = Infinity; for (const [key, session] of this.sessions) if (session.updatedAt < oldestTime) { oldestKey = key; oldestTime = session.updatedAt; } if (oldestKey !== undefined) this.sessions.delete(oldestKey); }
  add(s, user, assistant) { s.history.push({ user: String(user).slice(0, this.maxChars), assistant: String(assistant).slice(0, this.maxChars) }); while (s.history.length > this.maxHistory) s.history.shift(); s.updatedAt = this.now(); }
  key(input) { return String(input || `anonymous:${crypto.randomUUID()}`).slice(0, 128); }
}
module.exports = { SessionStore };
