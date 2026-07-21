#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const url = 'http://127.0.0.1:9655/setup';

async function healthy() {
  try { return (await fetch('http://127.0.0.1:9655/health', { signal: AbortSignal.timeout(1000) })).ok; }
  catch { return false; }
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await healthy()) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

function openBrowser() {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/d', '/s', '/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(command, [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

(async () => {
  if (!await healthy()) {
    spawn(process.execPath, [path.join(root, 'server.js')], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
  if (!await waitForServer()) throw new Error('Не удалось запустить локальный сервер на порту 9655. Возможно, порт занят.');
  openBrowser();
  console.log(`DeepSeek Bridge открыт: ${url}`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
