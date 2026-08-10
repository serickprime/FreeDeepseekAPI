'use strict';
const cache = new Map();
function stage(onStage, name) { if (typeof onStage === 'function') onStage(name); }
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
async function load(url, timeoutMs, onStage) {
  if (!url) throw new Error('Missing PoW WASM URL');
  if (!cache.has(url)) {
    const p = fetch(url, { signal: AbortSignal.timeout(timeoutMs) }).then(async response => {
      if (!response.ok) {
        const error = new Error(`PoW WASM HTTP ${response.status}`);
        error.upstreamStatus = response.status;
        throw error;
      }
      const bytes = await response.arrayBuffer();
      stage(onStage, 'wasm_downloaded');
      stage(onStage, 'wasm_compile_start');
      const module = await WebAssembly.compile(bytes);
      stage(onStage, 'wasm_compiled');
      return module;
    }).catch(error => { throw withSafeNetworkMetadata(error); });
    cache.set(url, p);
    p.catch(() => cache.delete(url));
  }
  return cache.get(url);
}
async function solvePOW(challenge, url, timeoutMs = 15000, onStage) {
  const instance = await WebAssembly.instantiate(await load(url, timeoutMs, onStage), { wbg: {} });
  stage(onStage, 'pow_solve_start');
  const e = instance.exports; const enc = new TextEncoder(); const c = enc.encode(challenge.challenge); const p = enc.encode(`${challenge.salt}_${challenge.expire_at}_`); const cp = e.__wbindgen_export_0(c.length, 1) >>> 0; const pp = e.__wbindgen_export_0(p.length, 1) >>> 0; new Uint8Array(e.memory.buffer, cp, c.length).set(c); new Uint8Array(e.memory.buffer, pp, p.length).set(p); const sp = e.__wbindgen_add_to_stack_pointer(-16); e.wasm_solve(sp, cp, c.length, pp, p.length, challenge.difficulty); const code = new DataView(e.memory.buffer).getInt32(sp, true); const answer = new DataView(e.memory.buffer).getFloat64(sp + 8, true); e.__wbindgen_add_to_stack_pointer(16); if (!code || !Number.isFinite(answer)) throw new Error('PoW failed');
  stage(onStage, 'pow_solved');
  return Math.floor(answer);
}
module.exports = { solvePOW };
