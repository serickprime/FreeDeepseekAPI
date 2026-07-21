'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFile } = require('child_process');
const { MODELS, publicModels } = require('./models');

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
  if (process.platform !== 'win32') return Promise.reject(new Error('Automatic terminal launch is currently supported only on Windows.'));
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
  const terminalAlias = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe');

  if (fs.existsSync(terminalAlias)) {
    return new Promise((resolve, reject) => {
      const child = spawn(terminalAlias, [
        '-w', 'new', 'new-tab', '--title', 'DeepSeek Bridge', '-d', root,
        'powershell.exe', '-NoExit', '-NoProfile', '-EncodedCommand', encodedCommand,
      ], { cwd: root, stdio: 'ignore', windowsHide: false });
      child.once('error', () => reject(new Error('Windows Terminal could not be opened.')));
      child.once('spawn', () => setTimeout(() => resolve(child.pid), 350));
    });
  }

  return new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', [
      '/d', '/c', 'start', '', 'powershell.exe',
      '-NoExit', '-NoProfile', '-EncodedCommand', encodedCommand,
    ], { cwd: root, stdio: 'ignore', windowsHide: true });
    child.once('error', () => reject(new Error('A visible PowerShell window could not be opened.')));
    child.once('exit', code => code === 0
      ? resolve(child.pid)
      : reject(new Error('Windows rejected the terminal launch request.')));
  });
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

function chooseWindowsFolder(initialDirectory) {
  if (process.platform !== 'win32') return Promise.reject(new Error('The folder picker is currently supported only on Windows.'));
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = 'Выберите папку проекта для запуска CLI-агента'",
    '$dialog.ShowNewFolderButton = $true',
    "if (Test-Path -LiteralPath $env:DEEPSEEK_BRIDGE_INITIAL_FOLDER -PathType Container) { $dialog.SelectedPath = $env:DEEPSEEK_BRIDGE_INITIAL_FOLDER }",
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); [Console]::Write($dialog.SelectedPath) }',
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
      windowsHide: true,
      timeout: 10 * 60_000,
      maxBuffer: 16 * 1024,
      env: { ...process.env, DEEPSEEK_BRIDGE_INITIAL_FOLDER: initialDirectory },
    }, (error, stdout) => {
      if (error) return reject(new Error('Не удалось открыть системный выбор папки.'));
      resolve(String(stdout || '').trim() || null);
    });
  });
}

function existingDirectory(value, fallback) {
  try {
    const directory = path.resolve(String(value || fallback));
    return fs.statSync(directory).isDirectory() ? directory : null;
  } catch { return null; }
}

function powerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function createSetupController({
  root = path.resolve(__dirname, '..'),
  launchTerminal = visiblePowerShell,
  hasCommand = commandExists,
  selectFolder = chooseWindowsFolder,
} = {}) {
  const token = crypto.randomBytes(32).toString('hex');

  function status() {
    return {
      platform: process.platform,
      node: process.version,
      auth: readAuthStatus(root),
      agents: {
        claude: hasCommand(process.platform === 'win32' ? 'claude.cmd' : 'claude'),
        opencode: hasCommand(process.platform === 'win32' ? 'opencode.cmd' : 'opencode'),
      },
      models: publicModels(),
      workingDirectory: root,
      api: { baseUrl: 'http://127.0.0.1:9655', ready: readAuthStatus(root).valid },
    };
  }

  function authorized(value) {
    const supplied = Buffer.from(String(value || ''));
    const expected = Buffer.from(token);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  }

  async function action(name, options = {}) {
    if (name === 'auth') {
      const pid = await launchTerminal(root, 'npm.cmd run auth');
      return { ok: true, pid, message: 'Открыто окно авторизации. Следуйте инструкциям в PowerShell и Chrome.' };
    }
    if (name === 'doctor') return runDoctor(root);
    if (name === 'choose-folder') {
      const initialDirectory = existingDirectory(options.workingDirectory, root) || root;
      const selected = await selectFolder(initialDirectory);
      if (!selected) return { ok: true, canceled: true };
      const selectedDirectory = existingDirectory(selected, root);
      return selectedDirectory
        ? { ok: true, path: selectedDirectory }
        : { ok: false, message: 'Выбранная папка больше не существует или недоступна.' };
    }
    const modelName = String(options.model || 'deepseek-reasoner').toLowerCase();
    const model = MODELS[modelName];
    if ((name === 'claude' || name === 'opencode') && (!model || !model.available)) {
      return { ok: false, message: 'Выбранный режим DeepSeek сейчас недоступен.' };
    }
    const workingDirectory = existingDirectory(options.workingDirectory, root);
    if ((name === 'claude' || name === 'opencode') && !workingDirectory) {
      return { ok: false, message: 'Папка проекта не существует или недоступна.' };
    }
    if (name === 'claude') {
      if (!status().agents.claude) return { ok: false, message: 'Claude Code не найден. Установите его и обновите страницу.' };
      const command = `$env:ANTHROPIC_BASE_URL='http://127.0.0.1:9655'; $env:ANTHROPIC_AUTH_TOKEN='local-key'; $env:CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY='1'; claude.cmd --model ${modelName}`;
      const pid = await launchTerminal(workingDirectory, command);
      return { ok: true, pid, model: modelName, workingDirectory, message: `Claude Code запущен в выбранной папке с ${modelName}.` };
    }
    if (name === 'opencode') {
      if (!status().agents.opencode) return { ok: false, message: 'OpenCode не найден. Установите его и обновите страницу.' };
      const configPath = path.join(root, 'opencode.json');
      const command = `$env:OPENCODE_CONFIG=${powerShellLiteral(configPath)}; opencode.cmd --model deepseek-web/${modelName}`;
      const pid = await launchTerminal(workingDirectory, command);
      return { ok: true, pid, model: modelName, workingDirectory, message: `OpenCode запущен в выбранной папке с ${modelName}.` };
    }
    return { ok: false, message: 'Неизвестное действие.' };
  }

  return { action, authorized, bootstrap: () => ({ token, status: status() }), status };
}

module.exports = { createSetupController, readAuthStatus, visiblePowerShell, chooseWindowsFolder, existingDirectory };
