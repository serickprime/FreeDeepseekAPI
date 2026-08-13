'use strict';

let setupToken = '';
let modelCatalog = [];
let serviceStatus = null;
let folderInitialized = false;
let folderValidation = 'empty';
let folderValidationSequence = 0;
let browserDirectory = null;
let folderInputTimer = null;
const FOLDER_STORAGE_KEY = 'deepseek-bridge-folder';
const MODEL_STORAGE_KEY = 'deepseek-bridge-model';
const byId = id => document.getElementById(id);

function toast(message, error = false) {
  const node = byId('toast');
  node.textContent = message;
  node.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.className = 'toast'; }, 4500);
}

function setState(node, text, type) {
  node.replaceChildren();
  node.append(document.createElement('span'), document.createTextNode(text));
  node.className = `state ${type}`;
}

function renderModels(models) {
  modelCatalog = models || [];
  const select = byId('modelSelect');
  const previous = select.value || localStorage.getItem(MODEL_STORAGE_KEY) || 'deepseek-reasoner';
  select.replaceChildren();
  for (const model of modelCatalog) {
    const option = document.createElement('option');
    option.value = model.id;
    option.disabled = !model.available;
    option.textContent = `${model.displayName}${model.recommended ? ' — рекомендуется' : ''}${model.available ? '' : ' — недоступно'}`;
    select.append(option);
  }
  const preferred = modelCatalog.find(model => model.id === previous && model.available)
    || modelCatalog.find(model => model.recommended && model.available)
    || modelCatalog.find(model => model.available);
  if (preferred) select.value = preferred.id;
  updateModelDescription();
}

function updateModelDescription() {
  const selected = modelCatalog.find(model => model.id === byId('modelSelect').value);
  byId('modelDescription').textContent = selected ? selected.description : 'Нет доступных режимов.';
  if (selected) localStorage.setItem(MODEL_STORAGE_KEY, selected.id);
}

function updateLaunchAvailability() {
  const ready = Boolean(serviceStatus?.auth?.valid);
  const hasValidFolder = folderValidation === 'selected';
  for (const key of ['claude', 'opencode']) {
    const button = document.querySelector(`[data-action="${key}"]`);
    button.disabled = !ready || !serviceStatus?.agents?.[key] || !hasValidFolder;
  }
}

function setFolderState(type, message) {
  folderValidation = type;
  const input = byId('workingDirectory');
  const state = byId('folderState');
  const description = byId('folderDescription');
  const labels = {
    empty: 'Не выбрана',
    loading: 'Проверка',
    selected: 'Выбрана',
    invalid: 'Недоступна',
    error: 'Ошибка',
  };
  state.textContent = labels[type] || 'Не выбрана';
  state.className = `folder-state ${type}`;
  input.setAttribute('aria-invalid', String(type === 'invalid' || type === 'error'));
  input.title = input.value;
  description.textContent = message;
  description.className = `field-help${type === 'invalid' || type === 'error' ? ' error' : type === 'selected' ? ' success' : ''}`;
  updateLaunchAvailability();
}

function render(status) {
  serviceStatus = status;
  renderModels(status.models);
  byId('modelSelect').disabled = false;
  byId('workingDirectory').disabled = false;
  byId('chooseFolder').disabled = false;
  byId('authButton').disabled = false;
  const ready = status.auth.valid;
  const apiBadge = byId('apiBadge');
  apiBadge.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  apiBadge.append(dot, document.createTextNode(ready ? 'API готов' : 'Нужен вход'));
  apiBadge.className = `status-pill ${ready ? 'ready' : 'error'}`;
  setState(byId('authState'), ready ? 'Подключено' : status.auth.present ? 'Файл повреждён' : 'Не подключено', ready ? 'ready' : 'error');
  byId('doctorButton').disabled = !ready;
  for (const [key, label] of [['claude', 'Claude Code'], ['opencode', 'OpenCode']]) {
    const node = byId(`${key}Availability`);
    node.textContent = status.agents[key] ? `${label} установлен` : `${label} не найден`;
    node.className = `availability ${status.agents[key] ? 'ok' : 'no'}`;
  }
  updateLaunchAvailability();
}

async function bootstrap() {
  const response = await fetch('/api/setup/bootstrap');
  if (!response.ok) throw new Error('Не удалось получить состояние панели.');
  const data = await response.json();
  setupToken = data.token;
  render(data.status);
  if (!folderInitialized) {
    folderInitialized = true;
    const savedDirectory = localStorage.getItem(FOLDER_STORAGE_KEY)?.trim() || '';
    byId('workingDirectory').value = savedDirectory;
    if (savedDirectory) await validateWorkingDirectory({ quiet: true });
    else setFolderState('empty', 'Выберите папку: без подтверждённого пути CLI не запустится.');
  }
}

async function action(name, options = {}) {
  const response = await fetch('/api/setup/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-setup-token': setupToken },
    body: JSON.stringify({
      action: name,
      model: byId('modelSelect').value,
      workingDirectory: options.workingDirectory ?? byId('workingDirectory').value,
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.message || 'Действие завершилось с ошибкой.');
  return data;
}

async function validateWorkingDirectory({ quiet = false } = {}) {
  const input = byId('workingDirectory');
  const requested = input.value.trim();
  const requestSequence = ++folderValidationSequence;
  if (!requested) {
    localStorage.removeItem(FOLDER_STORAGE_KEY);
    setFolderState('empty', 'Выберите папку: без подтверждённого пути CLI не запустится.');
    return false;
  }
  setFolderState('loading', 'Проверяем существование каталога и доступ…');
  try {
    const result = await action('validate-folder', { workingDirectory: requested });
    if (requestSequence !== folderValidationSequence) return false;
    input.value = result.path;
    input.title = result.path;
    localStorage.setItem(FOLDER_STORAGE_KEY, result.path);
    setFolderState('selected', 'Папка проверена. Новый CLI-процесс будет запущен с этим cwd.');
    if (!quiet) toast('Рабочая папка проверена.');
    return true;
  } catch (error) {
    if (requestSequence !== folderValidationSequence) return false;
    localStorage.removeItem(FOLDER_STORAGE_KEY);
    setFolderState('invalid', error.message);
    if (!quiet) toast(error.message, true);
    return false;
  }
}

function renderBrowserListing(listing) {
  browserDirectory = listing;
  const rootSelect = byId('folderRoot');
  const previousRoot = rootSelect.value;
  rootSelect.replaceChildren();
  for (const root of listing.roots) {
    const option = document.createElement('option');
    option.value = root;
    option.textContent = root;
    rootSelect.append(option);
  }
  const currentRoot = listing.roots.find(root => listing.currentPath.toLowerCase().startsWith(root.toLowerCase()));
  if (currentRoot) rootSelect.value = currentRoot;
  else if (previousRoot && listing.roots.includes(previousRoot)) rootSelect.value = previousRoot;

  const pathNode = byId('folderCurrentPath');
  pathNode.textContent = listing.currentPath;
  pathNode.title = listing.currentPath;
  byId('folderUp').disabled = !listing.parentPath;
  const list = byId('folderList');
  list.replaceChildren();
  list.setAttribute('aria-busy', 'false');
  if (!listing.directories.length) {
    const empty = document.createElement('div');
    empty.className = 'folder-list-message';
    empty.textContent = 'В этой папке нет вложенных каталогов.';
    list.append(empty);
  } else {
    for (const directory of listing.directories) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'folder-entry';
      button.dataset.path = directory.path;
      const icon = document.createElement('span');
      icon.className = 'folder-entry-icon';
      icon.textContent = '▱';
      const name = document.createElement('span');
      name.className = 'folder-entry-name';
      name.textContent = directory.name;
      name.title = directory.name;
      const arrow = document.createElement('span');
      arrow.className = 'folder-entry-arrow';
      arrow.textContent = '›';
      button.append(icon, name, arrow);
      button.addEventListener('click', () => loadBrowserDirectory(directory.path));
      list.append(button);
    }
  }
  byId('folderBrowserState').textContent = listing.truncated
    ? 'Показаны первые 500 папок. Уточните путь вручную при необходимости.'
    : `${listing.directories.length} ${listing.directories.length === 1 ? 'папка' : 'папок'} внутри.`;
  byId('folderBrowserState').className = 'browser-state';
}

async function loadBrowserDirectory(directory = '') {
  const list = byId('folderList');
  list.setAttribute('aria-busy', 'true');
  list.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'folder-list-message';
  loading.textContent = 'Загрузка папок…';
  list.append(loading);
  byId('folderBrowserState').textContent = 'Проверяем доступ к каталогу…';
  byId('folderBrowserState').className = 'browser-state';
  byId('selectCurrentFolder').disabled = true;
  try {
    const listing = await action('browse-folders', { workingDirectory: directory });
    renderBrowserListing(listing);
    byId('selectCurrentFolder').disabled = false;
  } catch (error) {
    browserDirectory = null;
    list.setAttribute('aria-busy', 'false');
    loading.textContent = 'Каталог недоступен.';
    byId('folderBrowserState').textContent = error.message;
    byId('folderBrowserState').className = 'browser-state error';
  }
}

async function openFolderBrowser() {
  const dialog = byId('folderDialog');
  if (!dialog.open) dialog.showModal();
  const start = folderValidation === 'selected' ? byId('workingDirectory').value : '';
  await loadBrowserDirectory(start);
}

byId('authButton').addEventListener('click', async () => {
  try {
    const result = await action('auth');
    toast(result.message);
    await bootstrap();
  } catch (error) { toast(error.message, true); }
});

byId('doctorButton').addEventListener('click', async () => {
  const button = byId('doctorButton');
  button.disabled = true;
  setState(byId('doctorState'), 'Проверка…', 'waiting');
  try {
    const result = await action('doctor');
    byId('doctorOutput').hidden = false;
    byId('doctorOutput').textContent = result.output;
    setState(byId('doctorState'), 'Готово', 'ready');
    toast('Диагностика успешно завершена.');
  } catch (error) {
    setState(byId('doctorState'), 'Ошибка', 'error');
    toast(error.message, true);
  } finally { button.disabled = !serviceStatus?.auth?.valid; }
});

document.querySelectorAll('.launch').forEach(button => button.addEventListener('click', async () => {
  if (!await validateWorkingDirectory({ quiet: true })) {
    toast('Сначала выберите доступную рабочую папку.', true);
    return;
  }
  const buttons = [...document.querySelectorAll('.launch')];
  buttons.forEach(node => { node.disabled = true; });
  try {
    const result = await action(button.dataset.action);
    toast(result.message);
  } catch (error) {
    toast(error.message, true);
  } finally { updateLaunchAvailability(); }
}));

byId('modelSelect').addEventListener('change', updateModelDescription);

byId('workingDirectory').addEventListener('input', event => {
  ++folderValidationSequence;
  clearTimeout(folderInputTimer);
  const value = event.currentTarget.value.trim();
  localStorage.removeItem(FOLDER_STORAGE_KEY);
  if (!value) setFolderState('empty', 'Выберите папку: без подтверждённого пути CLI не запустится.');
  else {
    setFolderState('loading', 'Путь изменён — ожидается проверка…');
    folderInputTimer = setTimeout(() => validateWorkingDirectory({ quiet: true }), 650);
  }
});
byId('workingDirectory').addEventListener('blur', () => {
  clearTimeout(folderInputTimer);
  validateWorkingDirectory({ quiet: true });
});
byId('workingDirectory').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    clearTimeout(folderInputTimer);
    validateWorkingDirectory();
  }
});

byId('chooseFolder').addEventListener('click', () => openFolderBrowser().catch(error => toast(error.message, true)));
byId('folderUp').addEventListener('click', () => {
  if (browserDirectory?.parentPath) loadBrowserDirectory(browserDirectory.parentPath);
});
byId('folderRefresh').addEventListener('click', () => loadBrowserDirectory(browserDirectory?.currentPath || ''));
byId('folderRoot').addEventListener('change', event => loadBrowserDirectory(event.currentTarget.value));
byId('selectCurrentFolder').addEventListener('click', () => {
  if (!browserDirectory?.currentPath) return;
  const input = byId('workingDirectory');
  input.value = browserDirectory.currentPath;
  input.title = browserDirectory.currentPath;
  localStorage.setItem(FOLDER_STORAGE_KEY, browserDirectory.currentPath);
  ++folderValidationSequence;
  setFolderState('selected', 'Папка проверена. Новый CLI-процесс будет запущен с этим cwd.');
  byId('folderDialog').close('selected');
  toast('Рабочая папка выбрана.');
});

byId('copyUrl').addEventListener('click', async event => {
  try {
    await navigator.clipboard.writeText(event.currentTarget.dataset.value);
    toast('Адрес API скопирован.');
  } catch { toast('Не удалось скопировать адрес. Выделите его вручную.', true); }
});

bootstrap().catch(error => {
  byId('apiBadge').className = 'status-pill error';
  toast(error.message, true);
});
setInterval(() => bootstrap().catch(() => {}), 10_000);
