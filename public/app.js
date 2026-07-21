'use strict';

let setupToken = '';
let modelCatalog = [];
const byId = id => document.getElementById(id);

function toast(message, error = false) {
  const node = byId('toast');
  node.textContent = message;
  node.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.className = 'toast'; }, 4500);
}

function setState(node, text, type) {
  node.textContent = text;
  node.className = `state ${type}`;
}

function renderModels(models) {
  modelCatalog = models || [];
  const select = byId('modelSelect');
  const previous = select.value || localStorage.getItem('deepseek-bridge-model') || 'deepseek-reasoner';
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
  if (selected) localStorage.setItem('deepseek-bridge-model', selected.id);
}

function render(status) {
  renderModels(status.models);
  const directory = byId('workingDirectory');
  if (!directory.value) directory.value = localStorage.getItem('deepseek-bridge-folder') || status.workingDirectory || '';
  const ready = status.auth.valid;
  byId('apiBadge').textContent = ready ? 'API готов' : 'Нужен вход';
  byId('apiBadge').className = `badge ${ready ? 'ready' : 'error'}`;
  setState(byId('authState'), ready ? 'Подключено' : status.auth.present ? 'Файл повреждён' : 'Не подключено', ready ? 'ready' : 'error');
  byId('doctorButton').disabled = !ready;
  const agents = [['claude', 'Claude Code'], ['opencode', 'OpenCode']];
  for (const [key, label] of agents) {
    const node = byId(`${key}Availability`);
    node.textContent = status.agents[key] ? `${label} установлен` : `${label} не найден`;
    node.className = `availability ${status.agents[key] ? 'ok' : 'no'}`;
    document.querySelector(`[data-action="${key}"]`).disabled = !ready || !status.agents[key];
  }
}

async function bootstrap() {
  const response = await fetch('/api/setup/bootstrap');
  if (!response.ok) throw new Error('Не удалось получить состояние панели.');
  const data = await response.json();
  setupToken = data.token;
  render(data.status);
}

async function action(name) {
  const response = await fetch('/api/setup/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-setup-token': setupToken },
    body: JSON.stringify({ action: name, model: byId('modelSelect').value, workingDirectory: byId('workingDirectory').value }),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.message || 'Действие завершилось с ошибкой.');
  return data;
}

byId('authButton').addEventListener('click', async () => {
  try { const result = await action('auth'); toast(result.message); }
  catch (error) { toast(error.message, true); }
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
  } finally { button.disabled = false; }
});

document.querySelectorAll('.launch').forEach(button => button.addEventListener('click', async () => {
  try { const result = await action(button.dataset.action); toast(result.message); }
  catch (error) { toast(error.message, true); }
}));

byId('modelSelect').addEventListener('change', updateModelDescription);

byId('workingDirectory').addEventListener('change', event => {
  localStorage.setItem('deepseek-bridge-folder', event.currentTarget.value.trim());
});

byId('chooseFolder').addEventListener('click', async () => {
  const button = byId('chooseFolder');
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = 'Окно открыто…';
  toast('Системное окно выбора папки открыто поверх браузера.');
  try {
    const result = await action('choose-folder');
    if (!result.canceled && result.path) {
      byId('workingDirectory').value = result.path;
      localStorage.setItem('deepseek-bridge-folder', result.path);
      toast('Папка проекта выбрана.');
    }
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.textContent = originalText; }
});

byId('copyUrl').addEventListener('click', async event => {
  await navigator.clipboard.writeText(event.currentTarget.dataset.value);
  toast('Адрес API скопирован.');
});

bootstrap().catch(error => toast(error.message, true));
setInterval(() => bootstrap().catch(() => {}), 10_000);
