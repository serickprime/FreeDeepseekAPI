#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { BASE_URL, checked, complete, createRemoteSession } = require('../client');
const { solvePOW } = require('../lib/pow');
const { safeError } = require('../lib/security');

const DEFAULT_AUTH_PATH = process.env.DEEPSEEK_AUTH_PATH || path.join(__dirname, '..', 'deepseek-auth.json');
const DEFAULT_TIMEOUT_MS = 150_000;
const MAX_TIMEOUT_MS = 180_000;

const LABELS = {
  auth_file: 'Файл авторизации',
  auth_fields: 'Token и cookie',
  web: 'Доступность DeepSeek Web',
  session: 'Создание удалённой сессии',
  challenge: 'Получение PoW challenge',
  wasm_download: 'Загрузка WASM',
  wasm_compile: 'Компиляция WASM',
  pow: 'Решение PoW',
  completion: 'Completion запрос',
  stream_receive: 'Получение streaming ответа',
  stream_parse: 'Разбор SSE потока',
  answer: 'Ответ модели',
  timeout: 'Общее время диагностики',
};

function boundedTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(parsed, 10_000), MAX_TIMEOUT_MS);
}

function diagnosticDetail(error) {
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 100 && status <= 599) return `HTTP ${status}`;
  return safeError(error).replace(/[\r\n]+/g, ' ').slice(0, 240);
}

async function runDiagnostics({
  authPath = DEFAULT_AUTH_PATH,
  readFile = file => fs.readFileSync(file, 'utf8'),
  fetchImpl = fetch,
  solvePow = solvePOW,
  checkImpl = checked,
  createSessionImpl = createRemoteSession,
  completeImpl = complete,
  timeoutMs = boundedTimeout(process.env.DEEPSEEK_DOCTOR_TIMEOUT_MS),
  marker = `DEEPSEEK_DOCTOR_${crypto.randomUUID().replace(/-/g, '')}`,
  output = line => console.log(line),
  errorOutput = line => console.error(line),
} = {}) {
  const started = Date.now();
  const lines = [];
  let current = 'auth_file';
  let active = true;
  let timer;

  const emit = (ok, label, detail = '') => {
    if (!active) return;
    const line = `${ok ? '✓' : '✗'} ${label}${detail ? `: ${detail}` : ''}`;
    lines.push(line);
    try { (ok ? output : errorOutput)(line); } catch {}
  };
  const pass = (name, label) => { current = name; emit(true, label || LABELS[name]); };
  const remaining = () => {
    const value = timeoutMs - (Date.now() - started);
    if (value <= 0) throw Object.assign(new Error('Диагностика превысила ограничение времени'), { diagnosticTimeout: true });
    return value;
  };
  const onStage = name => {
    if (name === 'challenge_start') current = 'challenge';
    else if (name === 'challenge_received') pass('challenge', 'PoW challenge получен');
    else if (name === 'wasm_download_start') current = 'wasm_download';
    else if (name === 'wasm_downloaded') pass('wasm_download', 'WASM загружен');
    else if (name === 'wasm_compile_start') current = 'wasm_compile';
    else if (name === 'wasm_compiled') pass('wasm_compile', 'WASM скомпилирован');
    else if (name === 'pow_solve_start') current = 'pow';
    else if (name === 'pow_solved') pass('pow', 'PoW решён');
    else if (name === 'completion_start') current = 'completion';
    else if (name === 'completion_completed') pass('completion', 'Completion запрос выполнен');
    else if (name === 'stream_received') pass('stream_receive', 'Streaming ответ получен');
    else if (name === 'stream_parsed') pass('stream_parse', 'Streaming ответ разобран');
  };

  const operation = async () => {
    let auth;
    try { auth = JSON.parse(readFile(authPath)); }
    catch (error) { throw new Error(`deepseek-auth.json недоступен или содержит некорректный JSON (${diagnosticDetail(error)})`); }
    pass('auth_file', 'Авторизация загружена');

    current = 'auth_fields';
    if (!auth || typeof auth !== 'object' || typeof auth.token !== 'string' || !auth.token.trim() || typeof auth.cookie !== 'string' || !auth.cookie.trim()) {
      throw new Error('в deepseek-auth.json отсутствуют token или cookie');
    }
    pass('auth_fields', 'Token и cookie присутствуют');

    current = 'web';
    await checkImpl(BASE_URL, { method: 'GET' }, remaining(), fetchImpl);
    pass('web', 'DeepSeek Web доступен');

    current = 'session';
    const session = { id: await createSessionImpl(auth, remaining(), fetchImpl), parentMessageId: null, history: [] };
    pass('session', 'Удалённая сессия создана');

    current = 'challenge';
    const result = await completeImpl({
      prompt: `Reply with this exact marker and nothing else: ${marker}`,
      session,
      model: { model_type: 'default', reasoning: false, search: false },
      onStage,
      timeoutMs: remaining(),
      maxRetries: 0,
      auth,
      fetchImpl,
      solvePow,
    });

    current = 'answer';
    const finalText = String(result?.content || '').trim();
    if (!finalText) throw new Error('DeepSeek вернул пустой финальный текст');
    if (!finalText.includes(marker)) throw new Error('финальный текст не содержит ожидаемый диагностический маркер');
    pass('answer', 'Ответ модели получен');
    return { ok: true, marker, lines: [...lines] };
  };

  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Диагностика превысила ограничение времени'), { diagnosticTimeout: true })), timeoutMs);
    });
    return await Promise.race([operation(), timeout]);
  } catch (error) {
    if (error?.diagnosticTimeout) current = 'timeout';
    emit(false, LABELS[current] || 'Диагностика', diagnosticDetail(error));
    return { ok: false, stage: current, error: diagnosticDetail(error), lines: [...lines] };
  } finally {
    active = false;
    clearTimeout(timer);
  }
}

async function main() {
  const result = await runDiagnostics();
  if (!result.ok) process.exitCode = result.stage === 'auth_file' || result.stage === 'auth_fields' ? 2 : 1;
}

if (require.main === module) main();

module.exports = { LABELS, boundedTimeout, runDiagnostics };
