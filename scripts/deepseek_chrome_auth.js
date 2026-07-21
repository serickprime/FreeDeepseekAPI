#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), net = require('net'), { spawn } = require('child_process'), readline = require('readline');
const ROOT = path.resolve(__dirname, '..'), profile = process.env.DEEPSEEK_CHROME_PROFILE || path.join(ROOT, '.chrome-profile-deepseek'), out = process.env.DEEPSEEK_AUTH_PATH || path.join(ROOT, 'deepseek-auth.json'), port = Number(process.env.DEEPSEEK_CHROME_PORT || 9655 + 378);
function chrome() { for (const p of [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].filter(Boolean)) if (fs.existsSync(p)) return p; throw new Error('Chrome not found. Set CHROME_PATH to chrome.exe and rerun npm run auth.'); }
function ask(q) { const r = readline.createInterface({ input: process.stdin, output: process.stdout }); return new Promise(ok => r.question(q, () => { r.close(); ok(); })); }
async function json(url) { const r = await fetch(url); if (!r.ok) throw new Error(`Chrome DevTools HTTP ${r.status}`); return r.json(); }
async function wait() { for (let i=0;i<80;i++) { try { return await json(`http://127.0.0.1:${port}/json`); } catch {} await new Promise(r=>setTimeout(r,250)); } throw new Error('Chrome DevTools did not start.'); }
class Cdp { constructor(ws) { const u = new URL(ws); this.host=u.hostname; this.port=Number(u.port); this.path=u.pathname+u.search; this.id=0; this.pending=new Map(); this.events=[]; }
  async open() { return new Promise((resolve,reject)=>{ const key=crypto.randomBytes(16).toString('base64'); const s=this.socket=net.connect(this.port,this.host); let handshake=true, buf=Buffer.alloc(0); s.once('error',reject); s.on('connect',()=>s.write(`GET ${this.path} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`)); s.on('data',chunk=>{ buf=Buffer.concat([buf,chunk]); if(handshake){const n=buf.indexOf('\r\n\r\n');if(n<0)return;const head=buf.subarray(0,n).toString();if(!head.startsWith('HTTP/1.1 101'))return reject(new Error('CDP WebSocket upgrade failed'));handshake=false;buf=buf.subarray(n+4);resolve();} while(buf.length>=2){let len=buf[1]&127, off=2;if(len===126){if(buf.length<4)return;len=buf.readUInt16BE(2);off=4;} if(len===127){if(buf.length<10)return;const high=buf.readUInt32BE(2),low=buf.readUInt32BE(6);if(high!==0||low>4*1024*1024)return reject(new Error('CDP frame exceeds safety limit'));len=low;off=10;} if(buf.length<off+len)return; const text=buf.subarray(off,off+len).toString();buf=buf.subarray(off+len); try{const m=JSON.parse(text);if(m.id&&this.pending.has(m.id)){const p=this.pending.get(m.id);this.pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method){this.events.push(m);if(this.events.length>1000)this.events.shift();}}catch{}} }); s.on('error',e=>{for(const p of this.pending.values())p.reject(e);}); }); }
  send(method,params={}) { const id=++this.id, payload=Buffer.from(JSON.stringify({id,method,params})), mask=crypto.randomBytes(4); let h; if(payload.length<126)h=Buffer.from([129,128|payload.length]);else {h=Buffer.alloc(4);h[0]=129;h[1]=254;h.writeUInt16BE(payload.length,2);}const data=Buffer.from(payload);for(let i=0;i<data.length;i++)data[i]^=mask[i%4];this.socket.write(Buffer.concat([h,mask,data]));return new Promise((resolve,reject)=>this.pending.set(id,{resolve,reject})); }
  close(){this.socket?.end();}
}
function token(values) { for(const [k,v] of Object.entries(values||{})) if(/token/i.test(k)){try{const x=JSON.parse(v);if(x?.token||x?.access_token)return x.token||x.access_token;}catch{}if(typeof v==='string'&&v.length>20)return v;} return ''; }
(async()=>{
  fs.mkdirSync(profile,{recursive:true});
  spawn(chrome(),[
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--disable-sync',
    'https://chat.deepseek.com',
  ],{detached:true,stdio:'ignore'}).unref();

  await wait();
  const targets=await json(`http://127.0.0.1:${port}/json`);
  const page=targets.find(t=>t.type==='page'&&/chat\.deepseek\.com/.test(t.url));
  if(!page)throw new Error('DeepSeek tab was not found.');
  const c=new Cdp(page.webSocketDebuggerUrl);
  await c.open();
  await c.send('Network.enable');
  await c.send('Runtime.enable');

  console.log('CDP capture is active. In the separate Chrome, sign in to DeepSeek and send: ok');
  console.log('Complete CAPTCHA and 2FA yourself. Do not close Chrome before returning here.');
  await ask('After the DeepSeek response appears, press Enter here: ');

  const state=await c.send('Runtime.evaluate',{
    expression:'JSON.stringify({l:Object.fromEntries(Object.entries(localStorage)),s:Object.fromEntries(Object.entries(sessionStorage)),r:performance.getEntriesByType("resource").map(x=>x.name)})',
    returnByValue:true,
  });
  const values=JSON.parse(state.result.value);
  const cookies=(await c.send('Network.getAllCookies')).cookies.filter(x=>/deepseek\.com$/.test(x.domain));
  const captured={authorization:'',hif_dliq:'',hif_leim:''};
  for(const event of c.events){
    const eventHeaders=event.params?.request?.headers||event.params?.headers||{};
    for(const [name,value] of Object.entries(eventHeaders)){
      const lower=name.toLowerCase();
      if(lower==='authorization'&&/^Bearer\s+/i.test(String(value)))captured.authorization=String(value).replace(/^Bearer\s+/i,'');
      if(lower==='x-hif-dliq')captured.hif_dliq=String(value);
      if(lower==='x-hif-leim')captured.hif_leim=String(value);
    }
  }
  const auth={
    token:captured.authorization||token(values.l)||token(values.s),
    cookie:cookies.map(x=>`${x.name}=${x.value}`).join('; '),
    wasmUrl:values.r.find(x=>/\.wasm(?:$|\?)/.test(x))||'',
    baseUrl:'https://chat.deepseek.com',
    ...(captured.hif_dliq?{hif_dliq:captured.hif_dliq}:{}),
    ...(captured.hif_leim?{hif_leim:captured.hif_leim}:{}),
  };
  c.close();
  if(!captured.authorization)throw new Error('Authorization header was not captured. Send a new message after the capture-ready notice, then retry.');
  if(!auth.cookie)throw new Error('DeepSeek cookies were not captured.');
  fs.writeFileSync(out,JSON.stringify(auth,null,2),{mode:0o600});
  console.log(`Authorization saved: ${out}. Secrets were not printed.`);
})().catch(e=>{console.error(`[auth] ${e.message}`);process.exitCode=1;});
