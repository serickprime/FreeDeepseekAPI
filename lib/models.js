'use strict';

const MODELS = Object.freeze({
  'deepseek-chat': {
    model_type: 'default', reasoning: false, search: false, available: true,
    displayName: 'DeepSeek Chat', label: 'Быстрый режим без reasoning и поиска',
  },
  'deepseek-reasoner': {
    model_type: 'default', reasoning: true, search: false, available: true, recommended: true,
    displayName: 'DeepSeek Reasoner', label: 'Reasoning; рекомендуется для CLI-агентов и инструментов',
  },
  'deepseek-chat-search': {
    model_type: 'default', reasoning: false, search: true, available: true,
    displayName: 'DeepSeek Chat + Search', label: 'Быстрый режим со встроенным веб-поиском DeepSeek',
  },
  'deepseek-reasoner-search': {
    model_type: 'default', reasoning: true, search: true, available: true,
    displayName: 'DeepSeek Reasoner + Search', label: 'Reasoning и встроенный веб-поиск DeepSeek',
  },
  'deepseek-expert': {
    model_type: 'expert', reasoning: false, search: false, available: false,
    displayName: 'DeepSeek Expert', label: 'Текущий DeepSeek Web API возвращает пустой ответ',
  },
  'deepseek-v4-pro': {
    model_type: 'expert', reasoning: true, search: false, available: false,
    displayName: 'DeepSeek V4 Pro (alias)', label: 'Совместимый alias; текущий DeepSeek Web API возвращает пустой ответ',
  },
});

function publicModels() {
  return Object.entries(MODELS).map(([id, model]) => ({
    id,
    displayName: model.displayName,
    description: model.label,
    reasoning: model.reasoning,
    search: model.search,
    available: model.available,
    recommended: Boolean(model.recommended),
  }));
}

module.exports = { MODELS, publicModels };
