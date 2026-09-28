// ─── State ─────────────────────────────────────────────────────────
let appState = {
  apis: [],
  models: [],
  conversations: [],
  activeConversationId: null,
  activeApiId: null,
  activeModelId: null,
  workingDirectory: '',
};
let isStreaming = false;
let userScrolledUp = false; // Track if user manually scrolled up

// ─── IPC Helper (replaces fetch) ───────────────────────────────────
async function invoke(channel, data) {
  return window.cc.invoke(channel, data);
}

// ─── Toast ─────────────────────────────────────────────────────────
function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 3000);
}

// ─── Section Toggle ────────────────────────────────────────────────
function toggleSection(sectionId) {
  const el = document.getElementById(sectionId + 'List') || document.getElementById(sectionId);
  if (!el) return;
  const arrow = el.previousElementSibling?.querySelector('.toggle-arrow') ||
                el.parentElement.querySelector('.toggle-arrow');
  el.classList.toggle('collapsed');
  if (arrow) arrow.classList.toggle('collapsed');
}

// ─── Load State ────────────────────────────────────────────────────
async function loadState() {
  const data = await invoke('state:get');
  if (data.apis) appState.apis = data.apis;
  if (data.models) appState.models = data.models;
  if (data.conversations) appState.conversations = data.conversations;
  if (data.activeApiId) appState.activeApiId = data.activeApiId;
  if (data.activeModelId) appState.activeModelId = data.activeModelId;
  if (data.workingDirectory) appState.workingDirectory = data.workingDirectory;
  // Default to welcome screen on startup — don't auto-restore last conversation
  appState.activeConversationId = null;
  renderAll();
  loadTools();
}

function renderAll() {
  renderApis();
  renderModels();
  renderConversations();
  renderTopBar();
  checkSetupStatus();
  renderModelSwitcher();
}

// ─── Load Tools ────────────────────────────────────────────────────
// Friendly display names for tools (user-facing, not technical)
const toolFriendlyNames = {
  Read: '读取文件', Write: '写入文件', Edit: '编辑文件', CreateDir: '创建文件夹',
  Bash: '终端命令', PowerShell: 'PowerShell', REPL: '代码运行',
  ExportPDF: '导出PDF', ExportWord: '导出Word', ExportPPT: '导出PPT',
  WebSearch: '网页搜索', WebFetch: '网页抓取',
  MCP: 'MCP工具', McpAuth: 'MCP认证', ListMcpResources: 'MCP资源', ReadMcpResource: '读取MCP资源',
  Glob: '文件查找', Grep: '内容搜索', ListDir: '目录浏览',
  NotebookEdit: '笔记本编辑', LSP: '代码分析',
  Agent: '子代理', TeamCreate: '创建团队', TeamDelete: '解散团队',
  SendMessage: '发送消息', AskUserQuestion: '提问用户',
  TaskCreate: '创建任务', TaskList: '任务列表', TaskGet: '查看任务', TaskUpdate: '更新任务',
  TaskOutput: '任务输出', TaskStop: '停止任务',
  EnterPlanMode: '进入规划', ExitPlanMode: '退出规划',
  EnterWorktree: '创建工作区', ExitWorktree: '退出工作区',
  Workflow: '工作流', ScheduleCron: '定时任务', RemoteTrigger: '远程触发',
  TodoWrite: '待办清单',
  Config: '配置', Skill: '技能', Brief: '摘要', Sleep: '等待',
  SyntheticOutput: '格式输出', ToolSearch: '工具搜索', Tungsten: '内部调试',
};

// Display order — high-frequency tools first
const toolOrder = [
  'Read', 'Write', 'Edit', 'CreateDir', 'Bash', 'PowerShell', 'REPL',
  'ExportPDF', 'ExportWord', 'ExportPPT',
  'WebSearch', 'WebFetch',
  'MCP', 'McpAuth', 'ListMcpResources', 'ReadMcpResource',
  'Glob', 'Grep', 'ListDir',
  'NotebookEdit', 'LSP',
  'Agent', 'TeamCreate', 'TeamDelete', 'SendMessage', 'AskUserQuestion',
  'TaskCreate', 'TaskList', 'TaskGet', 'TaskUpdate', 'TaskOutput', 'TaskStop',
  'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree',
  'Workflow', 'ScheduleCron', 'RemoteTrigger', 'TodoWrite',
  'Config', 'Skill', 'Brief', 'Sleep',
  'SyntheticOutput', 'ToolSearch', 'Tungsten',
];

async function loadTools() {
  const defs = await invoke('tools:list');
  const el = document.getElementById('toolsList');
  if (defs && defs.length > 0) {
    // Sort by priority order, filter out demo tools
    const filtered = defs.filter(t => t.name !== 'HelloWorld');
    const sorted = [...filtered].sort((a, b) => {
      const ia = toolOrder.indexOf(a.name);
      const ib = toolOrder.indexOf(b.name);
      const ra = ia === -1 ? 999 : ia;
      const rb = ib === -1 ? 999 : ib;
      return ra - rb;
    });
    el.innerHTML = `<div class="tools-flow">${sorted.map(t =>
      `<div class="tool-item" title="${escHtml(toolFriendlyNames[t.name] || t.name)}\n${escHtml(t.description)}">${escHtml(toolFriendlyNames[t.name] || t.name)}</div>`
    ).join('')}</div>`;
  }
}

// ─── File Browser ──────────────────────────────────────────────────
async function loadFileBrowser(dir) {
  const el = document.getElementById('fileTree');
  const path = dir || appState.workingDirectory || '.';
  try {
    const result = await invoke('tools:execute', { name: 'ListDir', input: { path } });
    if (result.entries) {
      const sorted = result.entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      el.innerHTML = sorted.map(e => {
        const icon = e.isDir ? '📁' : '📄';
        const click = e.isDir ? `onclick="loadFileBrowser('${path}/${e.name}')" ` : `onclick="openFile('${path}/${e.name}')" `;
        return `<div class="file-item" ${click}style="cursor:pointer;padding:2px 4px;font-size:12px;border-radius:3px;">${icon} ${escHtml(e.name)}</div>`;
      }).join('');
    }
  } catch (err) {
    el.innerHTML = `<div style="color:var(--text-muted);font-size:12px;">Error loading files</div>`;
  }
}

async function openFile(filePath) {
  try {
    const result = await invoke('tools:execute', { name: 'Read', input: { file_path: filePath } });
    if (result.content) {
      // Show file content as a message
      addMessage('assistant', `**File: ${filePath}**\n\n\`\`\`\n${result.content}\n\`\`\``);
      document.getElementById('welcomeScreen').style.display = 'none';
    }
  } catch (err) {
    showToast('Failed to open file: ' + err.message, 'error');
  }
}

// ─── Check Setup Status ────────────────────────────────────────────
function checkSetupStatus() {
  const setupNotice = document.getElementById('setupNotice');
  const readyNotice = document.getElementById('readyNotice');
  const hasApi = appState.apis && appState.apis.length > 0;
  const hasModel = appState.models && appState.models.length > 0;

  if (!hasApi || !hasModel) {
    if (setupNotice) setupNotice.style.display = 'block';
    if (readyNotice) readyNotice.style.display = 'none';
  } else {
    if (setupNotice) setupNotice.style.display = 'none';
    if (readyNotice) readyNotice.style.display = 'block';
  }
}

// ─── Top Bar ───────────────────────────────────────────────────────
function renderTopBar() {
  const apiEl = document.getElementById('currentApi');
  const dirEl = document.getElementById('workingDir');

  const activeApi = appState.apis.find(a => a.id === appState.activeApiId) || appState.apis[0];

  if (activeApi) {
    apiEl.textContent = activeApi.name;
    apiEl.style.display = 'inline';
  } else {
    apiEl.textContent = '未配置 API';
    apiEl.style.display = 'inline';
    apiEl.style.color = 'var(--warning)';
  }
  if (appState.workingDirectory) {
    dirEl.textContent = appState.workingDirectory;
    dirEl.title = appState.workingDirectory;
  }
}

// ─── Model Switcher (dropdown in topbar) ───────────────────────────
function renderModelSwitcher() {
  const sel = document.getElementById('modelSwitcher');
  sel.innerHTML = appState.models.map(m =>
    `<option value="${m.id}" ${m.id === appState.activeModelId ? 'selected' : ''}>${escHtml(m.name)}</option>`
  ).join('');
}

async function quickSwitchModel(id) {
  appState.activeModelId = id;
  const modelData = appState.models.find(m => m.id === id);
  appState.models = appState.models.map(m => ({ ...m, isDefault: m.id === id }));
  await invoke('state:update', {
    activeModelId: id,
    models: appState.models,
  });
  renderModels();
  showToast('Model switched to ' + (modelData?.name || id));
}

// ─── APIs ──────────────────────────────────────────────────────────
function renderApis() {
  const list = document.getElementById('apisList');
  list.innerHTML = appState.apis.map(a => `
    <div class="api-item ${a.id === appState.activeApiId ? 'active' : ''}" onclick="setActiveApi('${a.id}')">
      <span class="api-name">${escHtml(a.name)}</span>
      ${a.isDefault ? '<span class="api-default-badge">DEFAULT</span>' : ''}
      <span class="api-delete" onclick="event.stopPropagation(); deleteApi('${a.id}')" title="Delete">✕</span>
    </div>
  `).join('');
}

async function setActiveApi(id) {
  appState.activeApiId = id;
  appState.apis = appState.apis.map(a => ({ ...a, isDefault: a.id === id }));
  await invoke('state:update', {
    activeApiId: id,
    apis: appState.apis,
  });
  renderAll();
  showToast('API switched');
}

function showApiForm(editId) {
  document.getElementById('apiModal').style.display = 'flex';
  document.getElementById('apiModalTitle').textContent = editId ? 'Edit API Config' : 'Add API Config';
  document.getElementById('apiEditId').value = editId || '';

  if (editId) {
    const a = appState.apis.find(x => x.id === editId);
    if (a) {
      document.getElementById('apiName').value = a.name;
      document.getElementById('apiBaseUrl').value = a.baseUrl;
      document.getElementById('apiKey').value = '';
      document.getElementById('apiIsDefault').checked = a.isDefault;
    }
  } else {
    document.getElementById('apiName').value = '';
    document.getElementById('apiBaseUrl').value = '';
    document.getElementById('apiKey').value = '';
    document.getElementById('apiIsDefault').checked = false;
  }
}

function hideApiForm() {
  document.getElementById('apiModal').style.display = 'none';
}

function genId() {
  return Math.random().toString(36).slice(2, 14);
}

async function saveApi() {
  const id = document.getElementById('apiEditId').value || undefined;
  const name = document.getElementById('apiName').value.trim();
  const baseUrl = document.getElementById('apiBaseUrl').value.trim();
  const apiKey = document.getElementById('apiKey').value.trim();
  const isDefault = document.getElementById('apiIsDefault').checked;

  if (!name || !baseUrl) {
    showToast('Name and Base URL are required', 'error');
    return;
  }

  let apis = [...appState.apis];
  if (id && apis.find(a => a.id === id)) {
    apis = apis.map(a =>
      a.id === id ? { ...a, name, baseUrl, apiKey: apiKey || a.apiKey, isDefault } : a
    );
  } else {
    const newApi = { id: genId(), name, baseUrl, apiKey, isDefault };
    apis.push(newApi);
  }
  if (isDefault) {
    apis = apis.map(a => ({ ...a, isDefault: a.id === (id || apis[apis.length - 1].id) }));
    appState.activeApiId = apis.find(a => a.isDefault)?.id;
  }
  appState.apis = apis;
  await invoke('state:update', { apis, activeApiId: appState.activeApiId });
  renderAll();
  hideApiForm();
  showToast(id ? 'API updated' : 'API added');
}

async function deleteApi(id) {
  if (!confirm('Delete this API config?')) return;
  appState.apis = appState.apis.filter(a => a.id !== id);
  if (appState.activeApiId === id) {
    appState.activeApiId = appState.apis[0]?.id || null;
  }
  await invoke('state:update', { apis: appState.apis, activeApiId: appState.activeApiId });
  renderAll();
  showToast('API deleted');
}

// ─── Test API Connection ───────────────────────────────────────────
async function testApiConnection() {
  const baseUrl = document.getElementById('apiBaseUrl').value.trim();
  const apiKey = document.getElementById('apiKey').value.trim();
  const resultEl = document.getElementById('testApiResult');
  const btn = document.getElementById('testApiBtn');

  if (!baseUrl) {
    showToast('Please enter Base URL first', 'error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Testing...';
  resultEl.style.display = 'block';
  resultEl.style.background = 'var(--bg-hover)';
  resultEl.style.color = 'var(--text-muted)';
  resultEl.textContent = 'Connecting...';

  try {
    const result = await invoke('api:test', { baseUrl, apiKey });
    if (result.success) {
      resultEl.style.color = 'var(--success)';
      resultEl.textContent = '✓ ' + result.message;
      if (result.models && result.models.length > 0) {
        resultEl.textContent += ` (${result.models.length} models available)`;
      }
    } else {
      resultEl.style.color = 'var(--error)';
      resultEl.textContent = '✗ ' + result.message;
    }
  } catch (err) {
    resultEl.style.color = 'var(--error)';
    resultEl.textContent = '✗ ' + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test Connection';
  }
}

// ─── Import from LiteLLM ──────────────────────────────────────────
async function importFromLiteLLM() {
  const result = await invoke('litellm:readConfig');
  if (!result.success) {
    showToast(result.message, 'error');
    return;
  }

  // Add LiteLLM as API if not exists
  const baseUrl = 'http://localhost:4000';
  let apis = [...appState.apis];
  const existingApi = apis.find(a => a.baseUrl === baseUrl);
  if (!existingApi) {
    const newApi = { id: genId(), name: 'LiteLLM (localhost)', baseUrl, apiKey: 'sk-lite', isDefault: apis.length === 0 };
    apis.push(newApi);
    appState.apis = apis;
    if (apis.length === 1) appState.activeApiId = newApi.id;
  }

  // Add models from config
  let models = [...appState.models];
  for (const modelName of result.models) {
    if (!models.find(m => m.name === modelName)) {
      models.push({ id: genId(), name: modelName, provider: 'openai', maxTokens: 16384, isDefault: models.length === 0, tokensUsed: 0 });
    }
  }
  appState.models = models;
  if (!appState.activeModelId && models.length > 0) {
    appState.activeModelId = models[0].id;
  }

  await invoke('state:update', {
    apis: appState.apis,
    models: appState.models,
    activeApiId: appState.activeApiId,
    activeModelId: appState.activeModelId,
  });

  renderAll();
  showToast(`Imported ${result.models.length} models from LiteLLM config`);
}

// ─── LiteLLM Proxy Status Check (hidden, still runs in background) ──
async function checkLiteLLMStatus() {
  try {
    await invoke('litellm:status');
  } catch {}
}

// Poll litellm status every 5 seconds
setInterval(checkLiteLLMStatus, 5000);

// ─── Add Model to LiteLLM Config ───────────────────────────────────
function showLiteLLMModelForm() {
  document.getElementById('litellmModelModal').style.display = 'flex';
  document.getElementById('litellmModelName').value = '';
  document.getElementById('litellmApiBase').value = '';
  document.getElementById('litellmApiKey').value = '';
  document.getElementById('litellmModelResult').style.display = 'none';
}

function hideLiteLLMModelForm() {
  document.getElementById('litellmModelModal').style.display = 'none';
}

async function addLiteLLMModel() {
  const name = document.getElementById('litellmModelName').value.trim();
  const provider = document.getElementById('litellmProvider').value;
  const apiBase = document.getElementById('litellmApiBase').value.trim();
  const apiKey = document.getElementById('litellmApiKey').value.trim();
  const resultEl = document.getElementById('litellmModelResult');

  if (!name) {
    showToast('Model name is required', 'error');
    return;
  }
  if (!apiKey) {
    showToast('API Key is required', 'error');
    return;
  }

  resultEl.style.display = 'block';
  resultEl.style.color = 'var(--text-muted)';
  resultEl.textContent = 'Adding to config...';

  const result = await invoke('litellm:addModel', { name, provider, apiKey, apiBase });
  if (result.success) {
    resultEl.style.color = 'var(--success)';
    resultEl.textContent = '✓ ' + result.message;
    showToast(result.message);
    // Auto-import to UI models list
    await importFromLiteLLM();
    // Clear form
    document.getElementById('litellmModelName').value = '';
    document.getElementById('litellmApiKey').value = '';
    document.getElementById('litellmApiBase').value = '';
  } else {
    resultEl.style.color = 'var(--error)';
    resultEl.textContent = '✗ ' + result.message;
    showToast(result.message, 'error');
  }
}

// Listen for LiteLLM events
if (window.cc) {
  window.cc.on('litellm:ready', async () => {
    if (appState.models.length === 0) {
      await importFromLiteLLM();
    }
  });
  window.cc.on('litellm:status', () => {});
}

// ─── Models ────────────────────────────────────────────────────────
function renderModels() {
  const list = document.getElementById('modelsList');
  list.innerHTML = appState.models.map(m => `
    <div class="model-item ${m.id === appState.activeModelId ? 'active' : ''}" onclick="setActiveModel('${m.id}')">
      <span class="model-name">${escHtml(m.name)}</span>
      ${m.isDefault ? '<span class="model-default-badge">DEFAULT</span>' : ''}
      <span class="model-delete" onclick="event.stopPropagation(); deleteModel('${m.id}')" title="Delete">✕</span>
    </div>
  `).join('');

}

async function setActiveModel(id) {
  appState.activeModelId = id;
  appState.models = appState.models.map(m => ({ ...m, isDefault: m.id === id }));
  await invoke('state:update', {
    activeModelId: id,
    models: appState.models,
  });
  renderAll();
  showToast('Model switched');
}

function showModelForm(editId) {
  document.getElementById('modelModal').style.display = 'flex';
  document.getElementById('modelModalTitle').textContent = editId ? 'Edit Model Config' : 'Add Model Config';
  document.getElementById('modelEditId').value = editId || '';

  if (editId) {
    const m = appState.models.find(x => x.id === editId);
    if (m) {
      document.getElementById('modelName').value = m.name;
      document.getElementById('modelProvider').value = m.provider || 'anthropic';
      document.getElementById('modelMaxTokens').value = m.maxTokens || 8192;
      document.getElementById('modelIsDefault').checked = m.isDefault;
    }
  } else {
    document.getElementById('modelName').value = '';
    document.getElementById('modelProvider').value = 'anthropic';
    document.getElementById('modelMaxTokens').value = 8192;
    document.getElementById('modelIsDefault').checked = false;
  }
}

function hideModelForm() {
  document.getElementById('modelModal').style.display = 'none';
}

async function saveModel() {
  const id = document.getElementById('modelEditId').value || undefined;
  const name = document.getElementById('modelName').value.trim();
  const provider = document.getElementById('modelProvider').value;
  const maxTokens = parseInt(document.getElementById('modelMaxTokens').value) || 8192;
  const isDefault = document.getElementById('modelIsDefault').checked;

  if (!name) {
    showToast('Model name is required', 'error');
    return;
  }

  let models = [...appState.models];
  if (id && models.find(m => m.id === id)) {
    models = models.map(m =>
      m.id === id ? { ...m, name, provider, maxTokens, isDefault } : m
    );
  } else {
    models.push({ id: genId(), name, provider, maxTokens, isDefault, tokensUsed: 0 });
  }
  if (isDefault) {
    models = models.map(m => ({ ...m, isDefault: m.id === (id || models[models.length - 1].id) }));
    appState.activeModelId = models.find(m => m.isDefault)?.id;
  }
  appState.models = models;
  await invoke('state:update', { models, activeModelId: appState.activeModelId });
  renderAll();
  hideModelForm();
  showToast(id ? 'Model updated' : 'Model added');
}

async function deleteModel(id) {
  if (!confirm('Delete this model config?')) return;
  appState.models = appState.models.filter(m => m.id !== id);
  if (appState.activeModelId === id) {
    appState.activeModelId = appState.models[0]?.id || null;
  }
  await invoke('state:update', { models: appState.models, activeModelId: appState.activeModelId });
  renderAll();
  showToast('Model deleted');
}

// ─── Tasks ─────────────────────────────────────────────────────────
async function loadTasks() {
  const result = await invoke('tools:execute', { name: 'TaskList', input: {} });
  const el = document.getElementById('tasksList');
  if (!result.tasks || result.tasks.length === 0) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px;">No tasks</div>';
    return;
  }
  const statusIcons = { pending: '○', in_progress: '◐', completed: '●', deleted: '✕' };
  el.innerHTML = result.tasks.map(t => `
    <div class="conv-item" title="${escHtml(t.description || '')}" onclick="toggleTaskStatus(${t.id})">
      <span class="conv-title">${statusIcons[t.status] || '○'} ${escHtml(t.subject)}</span>
      <span style="font-size:10px;color:var(--text-muted)">${t.status}</span>
    </div>
  `).join('');
}

async function toggleTaskStatus(id) {
  const task = await invoke('tools:execute', { name: 'TaskGet', input: { taskId: id } });
  if (!task.error) {
    const nextStatus = task.status === 'completed' ? 'pending' : 'completed';
    await invoke('tools:execute', { name: 'TaskUpdate', input: { taskId: id, status: nextStatus } });
    await loadTasks();
  }
}

// ─── Conversations ─────────────────────────────────────────────────
function renderConversations() {
  const list = document.getElementById('conversationsList');
  const sorted = [...appState.conversations].sort((a, b) => b.updatedAt - a.updatedAt);

  if (sorted.length === 0) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px;">No conversations yet</div>';
    return;
  }

  list.innerHTML = sorted.map(c => `
    <div class="conv-item ${c.id === appState.activeConversationId ? 'active' : ''}" onclick="switchConversation('${c.id}')">
      <span class="conv-title">${escHtml(c.title || 'Untitled')}</span>
      <span class="conv-delete" onclick="event.stopPropagation(); deleteConversation('${c.id}')" title="Delete">✕</span>
    </div>
  `).join('');
}

async function switchConversation(id) {
  appState.activeConversationId = id;
  await invoke('state:update', { activeConversationId: id });
  renderConversations();
  await loadConversation(id);
}

async function loadConversation(id) {
  const conv = appState.conversations.find(c => c.id === id);
  if (!conv || !conv.messages) return;
  document.getElementById('welcomeScreen').style.display = 'none';
  const list = document.getElementById('messagesList');
  list.innerHTML = '';
  // Deduplicate consecutive assistant messages when displaying
  const deduped = [];
  for (let i = 0; i < conv.messages.length; i++) {
    const curr = conv.messages[i];
    const next = conv.messages[i + 1];
    if (curr.role === 'assistant' && next && next.role === 'assistant') continue;
    deduped.push(curr);
  }
  // Batch render all messages into a single innerHTML for instant loading
  let batchHtml = '';
  for (const msg of deduped) {
    const role = msg.role;
    const content = msg.content;
    let html;
    if (typeof content === 'string' && content.startsWith('[Used tool:')) {
      const match = content.match(/^\[Used tool: (.+?)\]\n([\s\S]*)/);
      if (match) {
        html = `<div class="message assistant"><div class="tool-header">Tool: ${escHtml(match[1])}</div>${renderMarkdown(match[2])}</div>`;
      } else {
        html = `<div class="message assistant">${renderMarkdown(content)}</div>`;
      }
    } else if (role === 'user') {
      html = `<div class="message user">${escHtml(typeof content === 'string' ? content : JSON.stringify(content))}</div>`;
    } else {
      html = `<div class="message assistant">${renderMarkdown(typeof content === 'string' ? content : JSON.stringify(content))}</div>`;
    }
    batchHtml += html;
  }
  list.innerHTML = batchHtml;
  renderPendingMermaid();
  requestAnimationFrame(() => scrollToBottom());
}

async function newConversation() {
  // Don't create a conversation yet — just go back to welcome screen
  // The conversation will be created when the user sends their first message
  appState.activeConversationId = null;
  await invoke('state:update', { activeConversationId: null });
  renderConversations();
  document.getElementById('welcomeScreen').style.display = 'flex';
  document.getElementById('messagesList').innerHTML = '';
}

async function deleteConversation(id) {
  if (!confirm('Delete this conversation?')) return;
  appState.conversations = appState.conversations.filter(c => c.id !== id);
  if (appState.activeConversationId === id) {
    appState.activeConversationId = null;
    document.getElementById('welcomeScreen').style.display = 'flex';
    document.getElementById('messagesList').innerHTML = '';
  }
  await invoke('state:update', {
    conversations: appState.conversations,
    activeConversationId: appState.activeConversationId,
  });
  renderConversations();
}

// ─── Messages ──────────────────────────────────────────────────────
function addMessage(role, content, append = true) {
  const list = document.getElementById('messagesList');
  const div = document.createElement('div');

  if (typeof content === 'string' && content.startsWith('[Used tool:')) {
    const match = content.match(/^\[Used tool: (.+?)\]\n([\s\S]*)/);
    if (match) {
      div.className = 'message assistant';
      div.innerHTML = `<div class="tool-header">Tool: ${escHtml(match[1])}</div>${renderMarkdown(match[2])}`;
    } else {
      div.className = 'message assistant';
      div.innerHTML = renderMarkdown(content);
    }
  } else if (role === 'user') {
    div.className = 'message user';
    div.innerHTML = escHtml(typeof content === 'string' ? content : JSON.stringify(content));
  } else {
    div.className = 'message assistant';
    div.innerHTML = renderMarkdown(typeof content === 'string' ? content : JSON.stringify(content));
  }

  list.appendChild(div);
  if (append) {
    scrollToBottom();
  }
  renderPendingMermaid();
  return div;
}

// No progress text shown during tool execution — only blue ✓ badges after completion

function showToolProgress(toolName, input) {
  // Don't show any progress text during tool execution
  // Only the blue ✓ badges after completion are shown
}

function addToolResult(toolName, result) {
  const el = document.getElementById('streamingMsg');
  if (!el) return;
  // Remove progress spinner when tool completes
  const prog = el.querySelector('.tool-progress');
  if (prog) prog.remove();
  // For GenerateDiagram / GenerateImage — render the content inline
  if ((toolName === 'GenerateDiagram' || toolName === 'GenerateImage') && result && result.content) {
    const badge = document.createElement('div');
    badge.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:bold;color:#6c5ce7;background:rgba(108,92,231,0.06);padding:2px 8px;border-radius:6px;margin:4px 0;font-family:"JetBrains Mono",monospace;';
    badge.textContent = `✓ ${toolName}: ${result.title || result.message || ''}`;
    el.appendChild(badge);
    const visual = document.createElement('div');
    visual.innerHTML = renderMarkdown(result.content);
    el.appendChild(visual);
    renderPendingMermaid();
    return;
  }
  // Show compact blue badge for completed tools
  const badge = document.createElement('div');
  badge.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:bold;color:#6c5ce7;background:rgba(108,92,231,0.06);padding:2px 8px;border-radius:6px;margin:4px 0;font-family:"JetBrains Mono",monospace;';
  badge.textContent = `✓ ${toolName}`;
  el.appendChild(badge);
}

function addStreamingMessage() {
  const list = document.getElementById('messagesList');
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.id = 'streamingMsg';
  div.innerHTML = '<div class="streaming-indicator"><div class="streaming-dot"></div><div class="streaming-dot"></div><div class="streaming-dot"></div></div>';
  list.appendChild(div);
  scrollToBottom();
  return div;
}

let _streamingTimer = null;
let _pendingText = '';
function updateStreamingMessage(text) {
  _pendingText = text;
  if (_streamingTimer) return;
  _streamingTimer = requestAnimationFrame(() => {
    _streamingTimer = null;
    const el = document.getElementById('streamingMsg');
    if (el) {
      el.innerHTML = renderMarkdown(_pendingText);
      smartScrollToBottom();
    }
  });
}

function finishStreamingMessage(text) {
  const el = document.getElementById('streamingMsg');
  if (el) {
    el.id = '';
    el.innerHTML = renderMarkdown(text);
    renderPendingMermaid();
  }
}

function scrollToBottom() {
  const container = document.getElementById('chatContainer');
  container.scrollTop = container.scrollHeight;
}

function isNearBottom() {
  const container = document.getElementById('chatContainer');
  return container.scrollHeight - container.scrollTop - container.clientHeight < 40;
}

function smartScrollToBottom() {
  if (!userScrolledUp) scrollToBottom();
}

// ─── Emphasis helper ──────────────────────────────────────────
// English text → blue + Calibri (WPS default English font)
// Chinese ≤12 chars → blue highlight; >12 chars → bold black
function formatEmphasis(text) {
  const hasEnglish = /[a-zA-Z]/.test(text);
  if (hasEnglish) {
    return '<em style="color:#6c5ce7 !important;font-family:Calibri,Arial,sans-serif !important;font-style:normal !important;font-weight:bold !important;">' + text + '</em>';
  }
  const cjkLen = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  if (cjkLen <= 12) {
    return '<em style="color:#6c5ce7 !important;font-weight:600 !important;font-style:normal !important;">' + text + '</em>';
  }
  return '<strong>' + text + '</strong>';
}

// ─── Markdown Renderer ─────────────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return '';
  if (typeof text !== 'string') text = JSON.stringify(text);

  // Strip <think>...</think> tags (reasoning tokens from thinking models)
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  text = text.replace(/<think>[\s\S]*/g, '');
  text = text.replace(/<\/think>/g, '');

  // Step 1: Extract COMPLETE code blocks BEFORE escaping HTML
  //   Use \uFFFD as placeholder — survives escHtml DOM roundtrip safely
  const codeBlocks = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const langLower = (lang || '').toLowerCase();
    const idx = codeBlocks.length;

    if (langLower === 'svg') {
      // Sanitize SVG: ensure it has xmlns attribute for standalone rendering
      let svgCode = code.trim();
      if (!svgCode.includes('xmlns=')) {
        svgCode = svgCode.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
      }
      const blobUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgCode);
      const id = 'svg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      codeBlocks.push(`<div class="inline-svg-container" data-svg-id="${id}" data-svg-src="${encodeURIComponent(svgCode)}"><div class="inline-svg-content" id="${id}"><img src="${blobUrl}" style="max-width:100%;max-height:160px;object-fit:contain;" alt="SVG image"></div><div class="inline-svg-actions"><button onclick="zoomInlineSvg('${id}')" title="放大查看">\u{1F50D}</button><button onclick="saveInlineSvg('${id}')" title="保存图片">\u{1F4BE}</button><button onclick="copyInlineSvg('${id}')" title="复制SVG">\u{1F4CB}</button></div></div>`);
      return '\uFFFDCODE' + idx + '\uFFFD';
    }

    if (langLower === 'mermaid') {
      const id = 'mermaid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      codeBlocks.push(`<div class="inline-mermaid-container" data-mermaid-id="${id}"><div class="inline-mermaid-content" id="${id}" data-mermaid-src="${encodeURIComponent(code)}">Loading diagram...</div><div class="inline-svg-actions"><button onclick="zoomInlineMermaid('${id}')" title="放大查看">\u{1F50D}</button><button onclick="saveInlineMermaid('${id}')" title="保存图片">\u{1F4BE}</button></div></div>`);
      return '\uFFFDCODE' + idx + '\uFFFD';
    }

    if (langLower === 'plantuml') {
      const id = 'plantuml_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      codeBlocks.push(`<div class="inline-mermaid-container" data-mermaid-id="${id}"><div class="inline-mermaid-content" id="${id}" data-mermaid-src="${encodeURIComponent(code)}">Loading diagram...</div><div class="inline-svg-actions"><button onclick="zoomInlineMermaid('${id}')" title="放大查看">\u{1F50D}</button><button onclick="saveInlineMermaid('${id}')" title="保存图片">\u{1F4BE}</button></div></div>`);
      return '\uFFFDCODE' + idx + '\uFFFD';
    }

    // Regular code blocks — escape HTML inside
    codeBlocks.push('<pre><code>' + escHtml(code) + '</code></pre>');
    return '\uFFFDCODE' + idx + '\uFFFD';
  });

  // Step 2: Handle INCOMPLETE code blocks during streaming
  //   For SVG/mermaid: show "generating" animation instead of raw code
  //   For other blocks: strip entirely
  text = text.replace(/```(svg|mermaid)\n?([\s\S]*)$/i, (_, lang, partial) => {
    const langLower = lang.toLowerCase();
    if (langLower === 'svg') {
      const id = 'svg_gen_' + Date.now();
      codeBlocks.push(`<div class="inline-svg-container generating"><div class="inline-svg-content" style="display:flex;align-items:center;justify-content:center;height:120px;gap:10px;color:var(--accent);"><div class="streaming-indicator"><div class="streaming-dot"></div><div class="streaming-dot"></div><div class="streaming-dot"></div></div><span style="font-size:13px;color:var(--text-muted);">Generating SVG...</span></div></div>`);
      return '\uFFFDCODE' + (codeBlocks.length - 1) + '\uFFFD';
    }
    if (langLower === 'mermaid') {
      codeBlocks.push(`<div class="inline-mermaid-container generating"><div class="inline-mermaid-content" style="display:flex;align-items:center;justify-content:center;height:120px;gap:10px;color:var(--accent);flex-direction:column;"><div class="streaming-indicator"><div class="streaming-dot"></div><div class="streaming-dot"></div><div class="streaming-dot"></div></div><span style="font-size:13px;color:var(--text-muted);">我给你画个流程图作为参考...</span></div></div>`);
      return '\uFFFDCODE' + (codeBlocks.length - 1) + '\uFFFD';
    }
    return '';
  });
  // Strip any other incomplete code blocks
  text = text.replace(/```[\w]*\n?[\s\S]*$/, '');

  // Escape the remaining text (non-code-block parts)
  let html = escHtml(text);

  // Step 3: Parse markdown tables
  html = html.replace(/^(\|.+\|)\n(\|[\s\-:|]+\|)\n((?:\|.+\|\n?)+)/gm, function(_, headerLine, sepLine, bodyLines) {
    // Split by | and strip leading/trailing empty strings from edges, but keep interior empty cells
    function parseCells(line) {
      const parts = line.split('|');
      // Remove first and last empty string from edge pipes: "| a | b |" → ["", " a ", " b ", ""]
      if (parts.length > 0 && parts[0].trim() === '') parts.shift();
      if (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop();
      return parts.map(c => c.trim());
    }
    const headers = parseCells(headerLine);
    const aligns = parseCells(sepLine).map(c => {
      if (c.startsWith(':') && c.endsWith(':')) return 'center';
      if (c.endsWith(':')) return 'right';
      return 'left';
    });
    const rows = bodyLines.trim().split('\n').map(line => parseCells(line));
    let table = '<table><thead><tr>';
    headers.forEach((h, i) => {
      table += '<th style="text-align:' + (aligns[i] || 'left') + '">' + h + '</th>';
    });
    table += '</tr></thead><tbody>';
    rows.forEach(row => {
      table += '<tr>';
      row.forEach((cell, i) => {
        table += '<td style="text-align:' + (aligns[i] || 'left') + '">' + cell + '</td>';
      });
      table += '</tr>';
    });
    table += '</tbody></table>';
    return '<div style="overflow-x:auto;max-width:100%;-webkit-overflow-scrolling:touch;">' + table + '</div>';
  });

  // Step 4: Restore code blocks (replace \uFFFD placeholders)
  html = html.replace(/\uFFFDCODE(\d+)\uFFFD/g, (_, i) => codeBlocks[parseInt(i)]);

  // Step 5: Inline code, bold, emphasis
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold (**text**) → apply emphasis logic (most LLMs use ** for emphasis)
  html = html.replace(/\*\*(.+?)\*\*/g, (_, t) => formatEmphasis(t));
  // Single emphasis (*text*) → same logic
  html = html.replace(/\*([^*]+)\*/g, (_, t) => formatEmphasis(t));

  // Step 6: Headings & rules
  html = html.replace(/^-{3,}$|^\*{3,}$|^_{3,}$/gm, '');
  // Headings: process from longest to shortest to avoid partial matches
  html = html.replace(/^####\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
  // Blockquotes: replace > with styled div (escHtml converts > to &gt;)
  html = html.replace(/^&gt;\s*(.+)$/gm, '<div style="border-left:3px solid #6c5ce7;padding:8px 12px;margin:6px 0;background:rgba(108,92,231,0.06);border-radius:0 6px 6px 0;font-size:14px;">$1</div>');

  // Step 7: Lists
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li class="num-list">$1</li>');
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/^[·•]\s*(.+)$/gm, '<li class="dot-list">$1</li>');
  html = html.replace(/(<li[^>]*>.*<\/li>\s*\n?)+/g, function(match) {
    return '<ul>' + match.replace(/\n/g, '') + '</ul>';
  });

  // Step 8: Images — markdown ![alt](url) syntax
  html = html.replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, (_, alt, url) => {
    return `<div class="inline-image-container"><img src="${url}" alt="${escHtml(alt)}" class="inline-image" loading="lazy" onclick="showLightbox('<img src=&quot;${url}&quot; style=&quot;max-width:90vw;max-height:85vh;object-fit:contain;&quot;>')"><div class="img-error" style="display:none;">Image load failed</div></div>`;
  });

  // Step 9: Standalone image URLs (jpg/jpeg/png/gif/webp/bmp)
  //   Only match bare URLs NOT already inside src="" attribute
  html = html.replace(/(?<!src=")(https?:\/\/[^\s<>"'\]]+\.(?:jpg|jpeg|png|gif|webp|bmp|ico)(?:\?[^\s<>"'\]]*)?)/gi, (url) => {
    if (codeBlocks.some(b => b.includes(url))) return url;
    return `<div class="inline-image-container"><img src="${url}" class="inline-image" loading="lazy" onclick="showLightbox('<img src=&quot;${url}&quot; style=&quot;max-width:90vw;max-height:85vh;object-fit:contain;&quot;>')"><div class="img-error" style="display:none;">Image load failed</div></div>`;
  });

  // Step 10: Clickable URLs
  // MUST process markdown [text](url) FIRST before bare URLs, otherwise the bare URL regex
  // wraps the URL inside () and breaks the markdown link syntax
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:#6c5ce7;text-decoration:underline;cursor:pointer;font-weight:bold;">$1</a>');
  html = html.replace(/(?<!src="|href="|src=&quot;|">)(https?:\/\/[^\s<>"')\]]+)/g, (url) => {
    return `<a href="${url}" target="_blank" rel="noopener" style="color:#6c5ce7;text-decoration:underline;cursor:pointer;">${url}</a>`;
  });

  // Final: blank lines and newlines
  html = html.replace(/\n{2,}/g, '\n');
  html = html.replace(/\n/g, '<br>');

  return html;
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Send Message ──────────────────────────────────────────────────
async function sendMessage(text) {
  const input = document.getElementById('messageInput');
  const msg = text || input.value.trim();
  if (!msg || isStreaming) return;

  if (!appState.apis || appState.apis.length === 0) {
    showToast('请先配置 API', 'error');
    showApiForm();
    return;
  }
  if (!appState.models || appState.models.length === 0) {
    showToast('请先配置模型', 'error');
    showModelForm();
    return;
  }

  document.getElementById('welcomeScreen').style.display = 'none';

  // Build message with uploaded files
  let userContent = null; // null = use simple string msg, otherwise multimodal array
  let fullMsg = msg;
  let displayMsg = msg; // What the user sees in UI (no raw content)
  let historyMsg = msg; // What gets saved to history (no file content blobs)
  const images = []; // { dataUrl, name }

  if (uploadedFiles.length > 0) {
    for (const f of uploadedFiles) {
      if (f.type === 'text') {
        fullMsg += `\n\n[File: ${f.name}]\n${f.data}`;
        displayMsg += `\n\n📄 ${f.name}`;
        historyMsg += `\n\n📄 ${f.name}`;
      } else if (f.type === 'image' && f.data) {
        images.push({ dataUrl: f.data, name: f.name });
        fullMsg += `\n\n[Image: ${f.name}]`;
        displayMsg += `\n\n🖼️ ${f.name}`;
        historyMsg += `\n\n🖼️ ${f.name}`;
      } else if (f.savedPath) {
        try {
          const readResult = await invoke('tools:execute', { name: 'Read', input: { file_path: f.savedPath } });
          if (readResult && readResult.images && readResult.images.length > 0) {
            // Image-based PDF: send pages as images to vision model
            fullMsg += `\n\n[Document: ${f.name}, ${readResult.images.length} pages as images]`;
            for (const img of readResult.images) {
              images.push({ dataUrl: img.data, name: `${f.name} - page ${img.page}` });
            }
          } else if (readResult && readResult.content && !readResult.error) {
            fullMsg += `\n\n[Document: ${f.name}]\n${readResult.content}`;
          } else {
            fullMsg += `\n\n[Document: ${f.name}, saved at: ${f.savedPath}]`;
          }
        } catch {
          fullMsg += `\n\n[Document: ${f.name}, saved at: ${f.savedPath}]`;
        }
        displayMsg += `\n\n📎 ${f.name}`;
        historyMsg += `\n\n📎 ${f.name}`;
      } else {
        displayMsg += `\n\n📎 ${f.name}`;
        historyMsg += `\n\n📎 ${f.name}`;
      }
    }

    // Build multimodal content if images exist
    if (images.length > 0) {
      userContent = [];
      userContent.push({ type: 'text', text: fullMsg });
      for (const img of images) {
        userContent.push({
          type: 'image_url',
          image_url: { url: img.dataUrl },
        });
      }
    }

    uploadedFiles = [];
    renderUploadedFiles();
  }

  // Display in UI — show clean message with file icon, NOT raw content
  addMessage('user', displayMsg);
  input.value = '';
  input.style.height = 'auto';

  isStreaming = true;
  userScrolledUp = false;
  const sendBtn = document.getElementById('sendBtn');
  sendBtn.classList.add('streaming');
  sendBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';

  // Create conversation if needed (first message in a new chat)
  if (!appState.activeConversationId) {
    // Generate a title from the first user message (max 30 chars, clean summary)
    const titleText = msg.replace(/\n/g, ' ').trim();
    const title = titleText.length > 30 ? titleText.slice(0, 30) + '...' : titleText || 'New Chat';
    const conv = {
      id: genId(),
      title: title,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    appState.conversations.push(conv);
    appState.activeConversationId = conv.id;
    await invoke('state:update', {
      conversations: appState.conversations,
      activeConversationId: conv.id,
    });
    renderConversations();
  }

  // Add user message to conversation
  // fullMsg goes to API this turn (with all file content)
  // historyMsg goes to persistent history (clean references only)
  const conv = appState.conversations.find(c => c.id === appState.activeConversationId);
  if (conv) {
    conv.messages.push({ role: 'user', content: historyMsg });
    conv.updatedAt = Date.now();
  }

  try {
    addStreamingMessage();
    let fullText = '';
    let toolCallResults = [];

    // Set up stream listener
    let lastError = null;
    let backendFinalText = null;
    const deltaHandler = (data) => {
      if (data.delta) {
        fullText += data.delta;
        updateStreamingMessage(fullText);
      }
    };
    const toolStartHandler = (data) => {
      showToolProgress(data.name, data.input);
    };
    const toolHandler = (data) => {
      toolCallResults.push({ name: data.name, result: data.result });
      addToolResult(data.name, data.result);
    };
    const errorHandler = (data) => {
      lastError = data.error;
    };
    const errorAnalysisHandler = (data) => {
      // Show structured error analysis as a system message
      const suggestions = (data.suggestions || []).map(s => `  - ${s}`).join('\n');
      const msg = `**${data.title}**\n\n${data.reason}\n\n**建议：**\n${suggestions}`;
      addMessage('system', msg);
    };
    const doneHandler = (data) => {
      if (data.finalText) backendFinalText = data.finalText;
    };

    const tokenLimitHandler = (data) => {
      // Show token limit warning as a system message
      addMessage('assistant', data.message);
      if (conv) {
        conv.messages.push({ role: 'assistant', content: data.message });
      }
    };

    window.cc.on('chat:delta', deltaHandler);
    window.cc.on('chat:tool_start', toolStartHandler);
    window.cc.on('chat:tool', toolHandler);
    window.cc.on('chat:error', errorHandler);
    window.cc.on('chat:error_analysis', errorAnalysisHandler);
    window.cc.on('chat:token_limit', tokenLimitHandler);
    window.cc.on('chat:done', doneHandler);

    // AskUserQuestion modal
    const askQuestionHandler = (data) => {
      showQuestionModal(data.questions);
    };
    window.cc.on('chat:askQuestion', askQuestionHandler);

    const compactedHandler = (data) => {
      showToast('Context compressed — earlier messages summarized to preserve memory', 'success');
    };
    window.cc.on('chat:compacted', compactedHandler);

    // Build the messages to send to API - deduplicate consecutive assistant messages
    let apiMessages;
    if (conv && conv.messages.length > 1) {
      const prevMessages = conv.messages.slice(0, -1);
      // Dedup: remove consecutive assistant messages, keep only the last one
      const deduped = [];
      for (let i = 0; i < prevMessages.length; i++) {
        const curr = prevMessages[i];
        const next = prevMessages[i + 1];
        // Skip if this is an assistant message followed by another assistant message
        if (curr.role === 'assistant' && next && next.role === 'assistant') {
          continue;
        }
        deduped.push(curr);
      }
      // Send full deduped history — backend handles compaction if context is too large
      const recentHistory = deduped;
      const thisTurn = userContent
        ? { role: 'user', content: userContent }
        : { role: 'user', content: fullMsg };
      apiMessages = [...recentHistory, thisTurn];
    } else if (conv) {
      const thisTurn = userContent
        ? { role: 'user', content: userContent }
        : { role: 'user', content: fullMsg };
      apiMessages = [thisTurn];
    } else {
      apiMessages = [{ role: 'user', content: fullMsg }];
    }

    // Auto-route: if images present, use DashScope + qwen-vl-plus (vision model)
    let useModel = appState.models.find(m => m.id === appState.activeModelId)?.name;
    let useApiId = appState.activeApiId;
    if (images.length > 0) {
      const visionModel = appState.models.find(m => /vl|vision|4o/i.test(m.name));
      if (visionModel) {
        useModel = visionModel.name;
        const dashApi = appState.apis.find(a => /dashscope|aliyun/i.test(a.name) || /dashscope/i.test(a.baseUrl));
        if (dashApi) useApiId = dashApi.id;
        showToast(`使用视觉模型 ${useModel} 识别图片`, 'success');
      }
    }

    await invoke('chat:stream', {
      messages: apiMessages,
      model: useModel,
      apiId: useApiId,
    });

    // Cleanup listeners
    window.cc.off('chat:delta', deltaHandler);
    window.cc.off('chat:tool_start', toolStartHandler);
    window.cc.off('chat:tool', toolHandler);
    window.cc.off('chat:error', errorHandler);
    window.cc.off('chat:error_analysis', errorAnalysisHandler);
    window.cc.off('chat:token_limit', tokenLimitHandler);
    window.cc.off('chat:compacted', compactedHandler);
    window.cc.off('chat:done', doneHandler);
    window.cc.off('chat:askQuestion', askQuestionHandler);

    // Use backend-cleaned text if available (English reasoning stripped)
    const saveText = backendFinalText || fullText;
    finishStreamingMessage(saveText);
    if (lastError) {
      showToast(lastError, 'error');
    }
    // Save assistant response to conversation (done here instead of doneHandler to avoid race condition)
    if (conv && saveText) {
      conv.messages.push({ role: 'assistant', content: saveText });
      conv.updatedAt = Date.now();
      invoke('state:update', { conversations: appState.conversations });
    }

  } catch (err) {
    showToast(err.message, 'error');
    addMessage('assistant', `Error: ${err.message}`);
  } finally {
    isStreaming = false;
    const sendBtn = document.getElementById('sendBtn');
    sendBtn.classList.remove('streaming');
    sendBtn.textContent = 'Send';
  }
}

function sendQuickAction(text) {
  sendMessage(text);
}

// ─── File Upload ───────────────────────────────────────────────────
let uploadedFiles = [];

function toggleUploadArea() {
  const area = document.getElementById('uploadArea');
  area.style.display = area.style.display === 'none' ? 'block' : 'none';
}

function handleFileSelect(event) {
  const files = Array.from(event.target.files);
  for (const file of files) {
    processFile(file);
  }
  event.target.value = '';
  document.getElementById('uploadArea').style.display = 'none';
}

async function processFile(file) {
  const isText = file.type.startsWith('text/') || /\.(txt|md|json|csv|js|ts|py|html|css|yaml|yml|xml|log)$/i.test(file.name);
  const isImage = file.type.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|bmp|ico|svg)$/i.test(file.name);
  const isPdf = /\.pdf$/i.test(file.name);
  const isWord = /\.(doc|docx)$/i.test(file.name);
  const isExcel = /\.(xls|xlsx)$/i.test(file.name);

  // All binary files: save to disk, then auto-read content via main process
  if (isImage || isPdf || isWord || isExcel) {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const dataUrl = e.target.result;
      // Save to disk
      let savedPath = null;
      try {
        const result = await invoke('file:saveUpload', { fileName: file.name, dataUrl });
        if (result.success) savedPath = result.path;
      } catch {}

      // For images: store as vision content (multimodal)
      if (isImage) {
        uploadedFiles.push({ name: file.name, type: 'image', data: dataUrl, savedPath });
      } else {
        // For PDF/Word/Excel: save to disk and store path
        // Content will be auto-extracted when message is sent
        uploadedFiles.push({ name: file.name, type: isPdf ? 'pdf' : isWord ? 'word' : 'excel', savedPath, size: file.size });
      }
      renderUploadedFiles();
    };
    reader.readAsDataURL(file);
  } else if (isText) {
    // Text files: read content directly
    const reader = new FileReader();
    reader.onload = (e) => {
      uploadedFiles.push({ name: file.name, type: 'text', data: e.target.result });
      renderUploadedFiles();
    };
    reader.readAsText(file);
  } else {
    // Unknown: try as text
    const reader = new FileReader();
    reader.onload = (e) => {
      uploadedFiles.push({ name: file.name, type: 'file', data: e.target.result });
      renderUploadedFiles();
    };
    reader.readAsText(file);
  }
}

function renderUploadedFiles() {
  const container = document.getElementById('uploadedFiles');
  if (uploadedFiles.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'block';
  container.innerHTML = uploadedFiles.map((f, i) => {
    const icon = f.type === 'image' ? '🖼' : f.type === 'pdf' ? '📄' : f.type === 'word' ? '📝' : f.type === 'excel' ? '📊' : '📎';
    return `<div style="display:inline-flex;align-items:center;gap:6px;background:var(--bg-hover);padding:4px 10px;border-radius:8px;margin:2px;font-size:12px;">
      ${icon} ${escHtml(f.name)}
      <span style="cursor:pointer;color:var(--error);font-weight:bold;" onclick="removeUploadedFile(${i})">x</span>
    </div>`;
  }).join('');
}

function removeUploadedFile(index) {
  uploadedFiles.splice(index, 1);
  renderUploadedFiles();
}

// ─── AskUserQuestion Modal ──────────────────────────────────────
function showQuestionModal(questions) {
  // Remove existing modal if any
  const existing = document.getElementById('questionModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'questionModal';
  modal.className = 'question-modal-overlay';

  const selectedAnswers = questions.map(() => null);

  const questionsHTML = questions.map((q, qi) => {
    const optsHTML = q.options.map((o, oi) => `
      <label class="question-option">
        <input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="q_${qi}" value="${oi}" />
        <span class="question-option-label">${o.label}</span>
        <span class="question-option-desc">${o.description}</span>
      </label>
    `).join('');
    return `
      <div class="question-group">
        <div class="question-header">${q.header || ''}</div>
        <div class="question-text">${q.question}</div>
        <div class="question-options">${optsHTML}</div>
      </div>
    `;
  }).join('');

  modal.innerHTML = `
    <div class="question-modal-content">
      <div class="question-modal-title">CC 需要您的输入</div>
      ${questionsHTML}
      <button class="question-submit-btn" id="questionSubmitBtn">提交</button>
    </div>
  `;

  document.body.appendChild(modal);

  // Focus the modal
  modal.querySelector('.question-modal-content').focus();

  // Handle submit
  document.getElementById('questionSubmitBtn').addEventListener('click', () => {
    const answers = questions.map((q, qi) => {
      if (q.multiSelect) {
        const checked = modal.querySelectorAll(`input[name="q_${qi}"]:checked`);
        return { question: q.question, selectedOptions: Array.from(checked).map(c => q.options[parseInt(c.value)].label) };
      } else {
        const checked = modal.querySelector(`input[name="q_${qi}"]:checked`);
        return { question: q.question, selectedOption: checked ? q.options[parseInt(checked.value)].label : null };
      }
    });
    modal.remove();
    invoke('chat:answerQuestion', answers);
  });
}

// Drag and drop support
document.addEventListener('DOMContentLoaded', () => {
  const chatContainer = document.getElementById('chatContainer');
  chatContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    document.getElementById('uploadArea').style.display = 'block';
    document.getElementById('uploadArea').classList.add('dragover');
  });
  chatContainer.addEventListener('dragleave', () => {
    document.getElementById('uploadArea').classList.remove('dragover');
  });
  chatContainer.addEventListener('drop', (e) => {
    e.preventDefault();
    document.getElementById('uploadArea').classList.remove('dragover');
    document.getElementById('uploadArea').style.display = 'none';
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) processFile(file);
  });
});

// ─── Folder Creator ────────────────────────────────────────────────
let savePath = '';
// Default save path: user's Desktop
invoke('tools:execute', { name: 'Bash', input: { command: 'echo %USERPROFILE%\\Desktop' } }).then(r => {
  if (r.stdout) {
    savePath = r.stdout.trim();
    const display = document.getElementById('savePathDisplay');
    if (display) display.textContent = `Save to: ${savePath}`;
  }
}).catch(() => {});

function chooseSavePath() {
  document.getElementById('savePathModal').style.display = 'flex';
  document.getElementById('savePathInput').value = savePath || '';
}

function hideSavePathModal() {
  document.getElementById('savePathModal').style.display = 'none';
}

function setSavePath() {
  savePath = document.getElementById('savePathInput').value.trim();
  document.getElementById('savePathDisplay').textContent = savePath ? `Save to: ${savePath}` : '';
  hideSavePathModal();
  showToast(savePath ? `Save path set: ${savePath}` : 'Save path cleared');
}

async function createFolder() {
  const name = document.getElementById('folderNameInput').value.trim();
  if (!name) {
    showToast('Please enter a folder name', 'error');
    return;
  }

  const targetPath = savePath ? `${savePath}\\${name}` : name;
  try {
    const result = await invoke('tools:execute', { name: 'CreateDir', input: { path: targetPath } });
    if (result.success) {
      showToast(`Folder created: ${targetPath}`);
      document.getElementById('folderNameInput').value = '';
      loadFileBrowser();
    } else {
      showToast(result.error || 'Failed to create folder', 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// ─── Mermaid post-render ──────────────────────────────────────
async function renderPendingMermaid() {
  const pending = document.querySelectorAll('.inline-mermaid-content[data-mermaid-src]');
  for (const el of pending) {
    let src = decodeURIComponent(el.getAttribute('data-mermaid-src'));
    el.removeAttribute('data-mermaid-src');
    // Force flowchart direction: TD/TB → LR (left to right)
    src = src.replace(/flowchart\s+(TD|TB)\b/gi, 'flowchart LR');
    try {
      const { svg } = await mermaid.render(el.id + '_svg', src);
      el.innerHTML = svg;
      el.style.maxHeight = '200px';
      el.style.overflow = 'hidden';
    } catch (e) {
      el.innerHTML = `<pre style="color:var(--error);font-size:12px;">Mermaid render error: ${escHtml(e.message)}</pre>`;
    }
  }
}

// ─── SVG / Mermaid interaction helpers ────────────────────────
function zoomInlineSvg(id) {
  const container = document.querySelector(`[data-svg-id="${id}"]`);
  if (!container) return;
  const svgSrc = decodeURIComponent(container.getAttribute('data-svg-src') || '');
  showLightbox(`<img src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgSrc)}" style="max-width:90vw;max-height:85vh;">`);
}

function saveInlineSvg(id) {
  const container = document.querySelector(`[data-svg-id="${id}"]`);
  if (!container) return;
  const svgSrc = decodeURIComponent(container.getAttribute('data-svg-src') || '');
  const blob = new Blob([svgSrc], { type: 'image/svg+xml' });
  downloadBlob(blob, 'diagram_' + Date.now() + '.svg');
}

function copyInlineSvg(id) {
  const container = document.querySelector(`[data-svg-id="${id}"]`);
  if (!container) return;
  const svgSrc = decodeURIComponent(container.getAttribute('data-svg-src') || '');
  navigator.clipboard.writeText(svgSrc).then(() => showToast('SVG copied'));
}

function zoomInlineMermaid(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const svgEl = el.querySelector('svg');
  if (!svgEl) return;
  showLightbox(svgEl.outerHTML);
}

function saveInlineMermaid(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const svgEl = el.querySelector('svg');
  if (!svgEl) return;
  const blob = new Blob([svgEl.outerHTML], { type: 'image/svg+xml' });
  downloadBlob(blob, 'flowchart_' + Date.now() + '.svg');
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function showLightbox(innerHtml) {
  // Remove existing lightbox if any
  const existing = document.querySelector('.lightbox-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  const content = document.createElement('div');
  content.className = 'lightbox-content';
  content.innerHTML = innerHtml;

  const actions = document.createElement('div');
  actions.className = 'lightbox-actions';
  actions.innerHTML = `
    <button onclick="saveLightboxSvg(this)" title="Save SVG">Save SVG</button>
    <button onclick="this.closest('.lightbox-overlay').remove()" title="Close">Close</button>
  `;
  content.prepend(actions);

  overlay.appendChild(content);
  document.body.appendChild(overlay);

  // Scroll-to-zoom inside lightbox (prevent page scroll)
  let currentScale = 1;
  overlay.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    currentScale = Math.max(0.2, Math.min(5, currentScale + delta));
    const inner = content.querySelector('img') || content.querySelector('svg');
    if (inner) inner.style.transform = 'scale(' + currentScale + ')';
  }, { passive: false });

  // Right-click long-press drag to pan the lightbox content
  let dragStartX = 0, dragStartY = 0, dragging = false;
  let translateX = 0, translateY = 0;

  content.addEventListener('contextmenu', (e) => e.preventDefault());

  content.addEventListener('mousedown', (e) => {
    if (e.button !== 2) return; // right mouse button only
    e.preventDefault();
    dragging = true;
    dragStartX = e.clientX - translateX;
    dragStartY = e.clientY - translateY;
    content.style.cursor = 'grabbing';
  });

  content.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    translateX = e.clientX - dragStartX;
    translateY = e.clientY - dragStartY;
    const inner = content.querySelector('img') || content.querySelector('svg');
    if (inner) inner.style.transform = 'translate(' + translateX + 'px,' + translateY + 'px) scale(' + currentScale + ')';
  });

  content.addEventListener('mouseup', (e) => {
    if (e.button !== 2) return;
    dragging = false;
    content.style.cursor = '';
  });

  // Close on Escape
  const esc = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); } };
  document.addEventListener('keydown', esc);
}

function saveLightboxSvg(btn) {
  const container = btn.closest('.lightbox-content');
  const svgEl = container.querySelector('svg');
  if (!svgEl) return;
  const blob = new Blob([svgEl.outerHTML], { type: 'image/svg+xml' });
  downloadBlob(blob, 'diagram_' + Date.now() + '.svg');
}

// Double-click to zoom: SVG containers
document.addEventListener('dblclick', (e) => {
  const svgContainer = e.target.closest('.inline-svg-container');
  if (svgContainer && !e.target.closest('.inline-svg-actions')) {
    const id = svgContainer.getAttribute('data-svg-id');
    if (id) zoomInlineSvg(id);
    return;
  }
  const mermaidContainer = e.target.closest('.inline-mermaid-container');
  if (mermaidContainer && !e.target.closest('.inline-svg-actions')) {
    const contentEl = mermaidContainer.querySelector('.inline-mermaid-content');
    if (contentEl && contentEl.id) zoomInlineMermaid(contentEl.id);
    return;
  }
  const imgContainer = e.target.closest('.inline-image-container');
  if (imgContainer) {
    const img = imgContainer.querySelector('img');
    if (img) showLightbox('<img src="' + img.src + '" style="max-width:90vw;max-height:85vh;object-fit:contain;">');
    return;
  }
});

// ─── Event Listeners ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadState();
  checkLiteLLMStatus();
  // Poll aggressively on startup to catch litellm coming online
  let startupPolls = 0;
  const startupPoll = setInterval(async () => {
    startupPolls++;
    await checkLiteLLMStatus();
    if (startupPolls >= 15) clearInterval(startupPoll);
  }, 1000);

  // Smart scroll: track if user scrolled up manually
  const chatContainer = document.getElementById('chatContainer');
  chatContainer.addEventListener('scroll', () => {
    if (isStreaming) {
      userScrolledUp = !isNearBottom();
    }
  });

  document.getElementById('sendBtn').addEventListener('click', () => {
    if (isStreaming) {
      invoke('chat:stop');
    } else {
      sendMessage();
    }
  });

  const input = document.getElementById('messageInput');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 100) + 'px';
  });

  document.getElementById('newChatBtn').addEventListener('click', newConversation);

  document.getElementById('sidebarToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
  });

  // Sidebar resizer - drag to resize
  const resizer = document.getElementById('sidebarResizer');
  const sidebar = document.getElementById('sidebar');
  let isResizing = false;

  resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    resizer.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const newWidth = Math.max(220, Math.min(600, e.clientX));
    sidebar.style.width = newWidth + 'px';
    document.documentElement.style.setProperty('--sidebar-width', newWidth + 'px');
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      resizer.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });

  // ─── MutationObserver: auto-render mermaid diagrams on DOM changes ──
  const mermaidObserver = new MutationObserver((mutations) => {
    let hasNew = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.classList?.contains('inline-mermaid-content') || node.querySelector?.('.inline-mermaid-content')) {
          hasNew = true; break;
        }
      }
      if (hasNew) break;
    }
    if (hasNew) renderPendingMermaid();
  });
  mermaidObserver.observe(document.getElementById('messagesList'), { childList: true, subtree: true });
});
