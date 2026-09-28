const { readFileSync, writeFileSync, existsSync } = require('fs');
const { resolve } = require('path');
const { createHash } = require('crypto');

const STATE_FILE = resolve(__dirname, '..', 'data', 'state.json');

let state = null;

function genId() {
  return createHash('md5').update(Date.now().toString() + Math.random().toString()).digest('hex').slice(0, 12);
}

function loadState() {
  if (existsSync(STATE_FILE)) {
    try {
      const data = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
      if (data.models) {
        data.models = data.models.map(m => ({ ...m, tokensUsed: m.tokensUsed || 0 }));
      }
      if (!data._tasks) data._tasks = [];
      return data;
    } catch { /* ignore */ }
  }
  return {
    apis: [],
    models: [],
    conversations: [],
    activeConversationId: null,
    activeApiId: null,
    activeModelId: null,
    workingDirectory: resolve(__dirname, '..'),
    _tasks: [],
  };
}

function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function getState() {
  if (!state) state = loadState();
  return state;
}

function updateState(updates) {
  if (!state) state = loadState();
  Object.assign(state, updates);
  saveState(state);
  return state;
}

function getActiveApi() {
  const s = getState();
  if (s.activeApiId) return s.apis.find(a => a.id === s.activeApiId);
  return s.apis.find(a => a.isDefault) || s.apis[0];
}

function getActiveModel() {
  const s = getState();
  if (s.activeModelId) {
    const m = s.models.find(m => m.id === s.activeModelId);
    if (m) return m.name;
  }
  const d = s.models.find(m => m.isDefault);
  return d ? d.name : 'mimo-pro';
}

function getActiveModelObj() {
  const s = getState();
  if (s.activeModelId) return s.models.find(m => m.id === s.activeModelId);
  return s.models.find(m => m.isDefault);
}

module.exports = {
  genId, loadState, saveState, getState, updateState,
  getActiveApi, getActiveModel, getActiveModelObj,
};
