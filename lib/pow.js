'use strict';
const cache = new Map();
function stage(onStage, name) {
  try { if (typeof onStage === 'function') onStage(name); } catch {}
}
function withSafeNetworkMetadata(error) {
  const causeCode = error?.cause?.code ?? error?.code;
  const safeCauseCode = typeof causeCode === 'string' && /^[A-Z0-9_]{1,64}$/.test(causeCode) ? causeCode : null;
  const networkError = safeCauseCode || error?.name === 'TypeError' || error?.name === 'TimeoutError' || error?.name === 'AbortError';
  if (networkError) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    const safe = new Error(timeout ? 'Upstream request timed out' : 'fetch failed');
    safe.name = typeof error?.name === 'string' ? error.name : 'Error';
    if (safeCauseCode) safe.causeCode = safeCauseCode;
    return safe;
  }
  return error;
}
function withUpstreamStage(error, upstreamStage) {
  const safe = withSafeNetworkMetadata(error);
  try {
    if (safe && (typeof safe === 'object' || typeof safe === 'function')) {
      safe.upstreamStage = upstreamStage;
      return safe;
    }
  } catch {}
  const fallback = new Error(upstreamStage === 'wasm_compile_start'
    ? 'PoW WASM compilation failed' : 'fetch failed');
  fallback.name = typeof safe?.name === 'string' ? safe.name : 'Error';
  if (typeof safe?.causeCode === 'string') fallback.causeCode = safe.causeCode;
  if (Number.isInteger(safe?.upstreamStatus)) fallback.upstreamStatus = safe.upstreamStatus;
  fallback.upstreamStage = upstreamStage;
  return fallback;
}
function notify(entry, name) {
  entry.phase = name;
  for (const listener of entry.listeners) stage(listener, name);
}
function startLoad(entry, url, timeoutMs) {
  entry.promise = (async () => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        const error = new Error(`PoW WASM HTTP ${response.status}`);
        error.upstreamStatus = response.status;
        throw error;
      }
      const bytes = await response.arrayBuffer();
      notify(entry, 'wasm_downloaded');
      notify(entry, 'wasm_compile_start');
      const module = await WebAssembly.compile(bytes);
      entry.status = 'ready';
      notify(entry, 'wasm_compiled');
      return module;
    } catch (error) {
      const failureStage = entry.phase === 'wasm_compile_start'
        ? 'wasm_compile_start' : 'wasm_download_start';
      throw withUpstreamStage(error, failureStage);
    }
  })();
  entry.promise.catch(() => {
    if (cache.get(url) === entry) cache.delete(url);
  });
}
async function load(url, timeoutMs, onStage) {
  if (!url) throw new Error('Missing PoW WASM URL');
  let entry = cache.get(url);
  if (entry?.status === 'ready') {
    stage(onStage, 'wasm_cache_hit');
    return entry.promise;
  }
  const listener = name => stage(onStage, name);
  if (!entry) {
    entry = {
      status: 'loading',
      phase: 'wasm_download_start',
      promise: null,
      listeners: new Set([listener]),
    };
    cache.set(url, entry);
    stage(onStage, 'wasm_download_start');
    startLoad(entry, url, timeoutMs);
  } else {
    stage(onStage, 'wasm_wait_shared');
    entry.listeners.add(listener);
  }
  try {
    return await entry.promise;
  } finally {
    entry.listeners.delete(listener);
  }
}
async function solvePOW(challenge, url, timeoutMs = 15000, onStage) {
  const instance = await WebAssembly.instantiate(await load(url, timeoutMs, onStage), { wbg: {} });
  stage(onStage, 'pow_solve_start');
  const e = instance.exports; const enc = new TextEncoder(); const c = enc.encode(challenge.challenge); const p = enc.encode(`${challenge.salt}_${challenge.expire_at}_`); const cp = e.__wbindgen_export_0(c.length, 1) >>> 0; const pp = e.__wbindgen_export_0(p.length, 1) >>> 0; new Uint8Array(e.memory.buffer, cp, c.length).set(c); new Uint8Array(e.memory.buffer, pp, p.length).set(p); const sp = e.__wbindgen_add_to_stack_pointer(-16); e.wasm_solve(sp, cp, c.length, pp, p.length, challenge.difficulty); const code = new DataView(e.memory.buffer).getInt32(sp, true); const answer = new DataView(e.memory.buffer).getFloat64(sp + 8, true); e.__wbindgen_add_to_stack_pointer(16); if (!code || !Number.isFinite(answer)) throw new Error('PoW failed');
  stage(onStage, 'pow_solved');
  return Math.floor(answer);
}
module.exports = { solvePOW };
