'use strict';

const fs = require('fs');
const path = require('path');
const { solvePOW } = require('./lib/pow');

const AUTH_PATH = process.env.DEEPSEEK_AUTH_PATH || path.join(__dirname, 'deepseek-auth.json');
const BASE_URL = 'https://chat.deepseek.com';
const COMPLETION_PATH = '/api/v0/chat/completion';
const DEFAULT_WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

function loadAuth(authPath = AUTH_PATH) {
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    const hasCredential = value => typeof value === 'string' && value.trim().length > 0;
    if (!auth || typeof auth !== 'object' || !hasCredential(auth.token) || !hasCredential(auth.cookie)) {
      throw new Error('token or cookie missing');
    }
    return auth;
  } catch (error) {
    throw new Error(`Run npm run auth first (${error.message}).`);
  }
}

function headers(auth) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${auth.token}`,
    cookie: auth.cookie,
    origin: BASE_URL,
    referer: `${BASE_URL}/`,
    'user-agent': 'Mozilla/5.0',
    'x-client-platform': 'web',
    ...(auth.hif_dliq ? { 'x-hif-dliq': auth.hif_dliq } : {}),
    ...(auth.hif_leim ? { 'x-hif-leim': auth.hif_leim } : {}),
  };
}

function parseRetryAfter(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function upstreamError(status, retryAfter) {
  const error = new Error(`DeepSeek Web HTTP ${status}`);
  error.name = 'DeepSeekUpstreamError';
  error.status = status;
  error.retryAfterMs = parseRetryAfter(retryAfter);
  error.retryable = status === 429 || status >= 500;
  return error;
}

async function checked(url, options, timeoutMs, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const causeCode = error?.cause?.code ?? error?.code;
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    const safe = new Error(timeout ? 'Upstream request timed out' : 'fetch failed');
    safe.name = typeof error?.name === 'string' ? error.name : 'Error';
    if (typeof causeCode === 'string' && /^[A-Z0-9_]{1,64}$/.test(causeCode)) safe.causeCode = causeCode;
    if (Number.isInteger(error?.status)) safe.status = error.status;
    if (error?.retryable === true) safe.retryable = true;
    if (Number.isFinite(error?.retryAfterMs)) safe.retryAfterMs = error.retryAfterMs;
    if (timeout) {
      safe.status = 504;
      safe.retryable = true;
    }
    throw safe;
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch {}
    throw upstreamError(response.status, response.headers.get('retry-after'));
  }
  return response;
}

async function parseStream(stream, onDelta) {
  if (!stream) throw new Error('DeepSeek returned an empty response body.');
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentPath = '';
  let content = '';
  let reasoning = '';
  let parentMessageId = null;

  const fragments = [];
  const isContentFragment = fragment => fragment && (fragment.type === 'RESPONSE' || fragment.type === 'SEARCH') && typeof fragment.content === 'string';
  const isReasoningFragment = fragment => fragment && (fragment.type === 'THINK' || fragment.type === 'REASONING') && typeof fragment.content === 'string';
  const emitSuffix = (previous, next, field) => {
    if (next === previous) return;
    if (next.startsWith(previous)) {
      const suffix = next.slice(previous.length);
      if (suffix) onDelta?.({ [field]: suffix });
    }
  };
  const setContent = next => {
    next = String(next || '');
    emitSuffix(content, next, 'content');
    content = next;
  };
  const setReasoning = next => {
    next = String(next || '');
    emitSuffix(reasoning, next, 'reasoning');
    reasoning = next;
  };
  const rebuildFragments = () => {
    setContent(fragments.filter(isContentFragment).map(fragment => fragment.content).join(''));
    setReasoning(fragments.filter(isReasoningFragment).map(fragment => fragment.content).join(''));
  };
  const appendFragments = value => {
    for (const fragment of Array.isArray(value) ? value : [value]) {
      if (fragment && typeof fragment === 'object') fragments.push({ ...fragment });
    }
    rebuildFragments();
  };

  const consume = (line) => {
    if (!line.startsWith('data:')) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') return;
    let item;
    try { item = JSON.parse(raw); } catch { return; }
    if (item.response_message_id !== undefined && !parentMessageId) parentMessageId = item.response_message_id;
    if (typeof item.p === 'string') currentPath = item.p;

    if (item.v && typeof item.v === 'object' && item.v.response) {
      const response = item.v.response;
      if (response.message_id !== undefined) parentMessageId = response.message_id;
      if (Array.isArray(response.fragments)) {
        fragments.length = 0;
        appendFragments(response.fragments);
      } else if (response.content !== undefined) {
        setContent(response.content);
      }
    }
    if (currentPath === 'response/fragments' && item.v !== undefined) appendFragments(item.v);
    if (currentPath === 'response' && Array.isArray(item.v)) {
      for (const operation of item.v) {
        if (operation?.p === 'fragments' && operation.o === 'APPEND' && operation.v !== undefined) appendFragments(operation.v);
      }
    }
    if (currentPath === 'response/fragments/-1/content' && item.v !== undefined && typeof item.v !== 'object' && fragments.length) {
      const fragment = fragments[fragments.length - 1];
      fragment.content = `${fragment.content || ''}${item.v}`;
      rebuildFragments();
    } else if (currentPath === 'response/content' && item.v !== undefined && typeof item.v !== 'object') {
      setContent(content + item.v);
    } else if (/parent_message_id|message\/id/.test(currentPath) && typeof item.v === 'string') {
      parentMessageId = item.v;
    } else if (/reasoning|thinking/i.test(currentPath) && typeof item.v === 'string') {
      setReasoning(reasoning + item.v);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) consume(line);
  }
  buffer += decoder.decode();
  if (buffer) consume(buffer);
  return { content, reasoning, parentMessageId };
}

async function createRemoteSession(auth, timeoutMs, fetchImpl = fetch) {
  const response = await checked(`${BASE_URL}/api/v0/chat_session/create`, {
    method: 'POST', headers: headers(auth), body: '{}',
  }, timeoutMs, fetchImpl);
  const data = await response.json();
  const id = data?.data?.biz_data?.chat_session?.id || data?.data?.biz_data?.id;
  if (!id) throw new Error('DeepSeek did not return a chat session id.');
  return id;
}

function resetRemoteSession(session) {
  session.id = null;
  session.parentMessageId = null;
}

async function completeOnce({ prompt, session, model, onDelta, onStage, timeoutMs, auth, fetchImpl, solvePow }) {
  const baseHeaders = headers(auth);
  if (!session.id) {
    onStage?.('remote_session_start');
    session.id = await createRemoteSession(auth, timeoutMs, fetchImpl);
    onStage?.('remote_session_created');
  }
  onStage?.('challenge_start');
  const challengeResponse = await checked(`${BASE_URL}/api/v0/chat/create_pow_challenge`, {
    method: 'POST', headers: baseHeaders, body: JSON.stringify({ target_path: COMPLETION_PATH }),
  }, timeoutMs, fetchImpl);
  const challenge = (await challengeResponse.json())?.data?.biz_data?.challenge;
  if (!challenge) throw new Error('DeepSeek did not return a PoW challenge. Run npm run doctor.');
  onStage?.('challenge_received');
  onStage?.('wasm_download_start');
  const answer = await solvePow(challenge, auth.wasmUrl || DEFAULT_WASM_URL, Math.min(timeoutMs, 15_000), onStage);
  const pow = Buffer.from(JSON.stringify({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: COMPLETION_PATH,
  })).toString('base64');
  onStage?.('completion_start');
  const response = await checked(`${BASE_URL}${COMPLETION_PATH}`, {
    method: 'POST',
    headers: { ...baseHeaders, 'x-ds-pow-response': pow },
    body: JSON.stringify({
      chat_session_id: session.id,
      parent_message_id: session.parentMessageId,
      model_type: model.model_type,
      prompt,
      ref_file_ids: [],
      thinking_enabled: model.reasoning,
      search_enabled: model.search,
      action: null,
      preempt: false,
    }),
  }, timeoutMs, fetchImpl);
  onStage?.('completion_completed');
  if (!response.body) throw new Error('DeepSeek returned an empty response body.');
  onStage?.('stream_received');
  onStage?.('stream_read');
  const result = await parseStream(response.body, onDelta);
  onStage?.('stream_parsed');
  if (result.parentMessageId) session.parentMessageId = result.parentMessageId;
  return result;
}

async function complete({
  prompt,
  session,
  model,
  onDelta,
  onStage,
  onError,
  timeoutMs = 120_000,
  maxRetries = 2,
  maxRetryDelayMs = 10_000,
  auth = loadAuth(),
  fetchImpl = fetch,
  solvePow = solvePOW,
  sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  let lastError;
  const maxAttempts = Number(maxRetries) + 1;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const attemptNumber = attempt + 1;
    let currentStage = 'unknown';
    const attemptStage = stage => {
      currentStage = stage;
      onStage?.(stage, { attempt: attemptNumber, maxAttempts });
    };
    try {
      return await completeOnce({ prompt, session, model, onDelta, onStage: attemptStage, timeoutMs, auth, fetchImpl, solvePow });
    } catch (error) {
      lastError = error;
      try { onError?.(error, { stage: currentStage, attempt: attemptNumber, maxAttempts }); } catch {}
      if (error.status === 401 || error.status === 403) resetRemoteSession(session);
      if (!error.retryable || attempt === maxRetries) throw error;
      resetRemoteSession(session);
      const exponential = 500 * (2 ** attempt);
      await sleep(Math.min(Math.max(error.retryAfterMs || 0, exponential), maxRetryDelayMs));
    }
  }
  throw lastError;
}

module.exports = {
  BASE_URL,
  checked,
  complete,
  createRemoteSession,
  headers,
  loadAuth,
  parseRetryAfter,
  parseStream,
  resetRemoteSession,
  upstreamError,
};
