'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFile } = require('child_process');

function commandExists(name) {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [name], { stdio: 'ignore', windowsHide: true });
  return result.status === 0;
}

function readAuthStatus(root) {
  const authPath = process.env.DEEPSEEK_AUTH_PATH || path.join(root, 'deepseek-auth.json');
  if (!fs.existsSync(authPath)) return { present: false, valid: false };
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    return { present: true, valid: Boolean(auth.token && auth.cookie) };
  } catch {
    return { present: true, valid: false };
  }
}

function visiblePowerShell(root, command) {
  if (process.platform !== 'win32') throw new Error('Automatic terminal launch is currently supported only on Windows.');
  const child = spawn('powershell.exe', ['-NoExit', '-NoProfile', '-Command', command], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return child.pid;
}

function runDoctor(root) {
  return new Promise(resolve => {
    execFile(process.execPath, [path.join(root, 'scripts', 'doctor.js')], {
      cwd: root,
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`
        .replace(/(Bearer\s+)[^\s,]+/ig, '$1[REDACTED]')
        .replace(/(cookie|token|authorization)\s*[:=]\s*[^,\s]+/ig, '$1=[REDACTED]')
        .trim()
        .slice(0, 4000);
      resolve({ ok: !error, output: output || (error ? 'Диагностика завершилась с ошибкой.' : 'Диагностика пройдена.') });
    });
  });
}

function createSetupController({ root = path.resolve(__dirname, '..') } = {}) {
  const token = crypto.randomBytes(32).toString('hex');

  function status() {
    return {
      platform: process.platform,
      node: process.version,
      auth: readAuthStatus(root),
      agents: {
        claude: commandExists(process.platform === 'win32' ? 'claude.cmd' : 'claude'),
        opencode: commandExists(process.platform === 'win32' ? 'opencode.cmd' : 'opencode'),
      },
      api: { baseUrl: 'http://127.0.0.1:9655', ready: readAuthStatus(root).valid },
    };
  }

  function authorized(value) {
    const supplied = Buffer.from(String(value || ''));
    const expected = Buffer.from(token);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  }

  async function action(name) {
    if (name === 'auth') {
      const pid = visiblePowerShell(root, 'npm.cmd run auth');
      return { ok: true, pid, message: 'Открыто окно авторизации. Следуйте инструкциям в PowerShell и Chrome.' };
    }
    if (name === 'doctor') return runDoctor(root);
    if (name === 'claude') {
      if (!status().agents.claude) return { ok: false, message: 'Claude Code не найден. Установите его и обновите страницу.' };
      const command = "$env:ANTHROPIC_BASE_URL='http://127.0.0.1:9655'; $env:ANTHROPIC_AUTH_TOKEN='local-key'; $env:CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY='1'; claude.cmd --model deepseek-reasoner";
      const pid = visiblePowerShell(root, command);
      return { ok: true, pid, message: 'Claude Code запущен с deepseek-reasoner.' };
    }
    if (name === 'opencode') {
      if (!status().agents.opencode) return { ok: false, message: 'OpenCode не найден. Установите его и обновите страницу.' };
      const pid = visiblePowerShell(root, 'opencode.cmd --model deepseek-web/deepseek-reasoner');
      return { ok: true, pid, message: 'OpenCode запущен с deepseek-reasoner.' };
    }
    return { ok: false, message: 'Неизвестное действие.' };
  }

  return { action, authorized, bootstrap: () => ({ token, status: status() }), status };
}

module.exports = { createSetupController, readAuthStatus };
