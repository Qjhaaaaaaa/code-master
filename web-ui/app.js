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
let currentAbort = null;

// ─── API Helper ────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  return res.json();
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
  const data = await api('GET', '/api/state');
  if (data.apis) appState.apis = data.apis;
  if (data.models) appState.models = data.models;
  if (data.conversations) appState.conversations = data.conversations;
  if (data.activeConversationId) appState.activeConversationId = data.activeConversationId;
  if (data.activeApiId) appState.activeApiId = data.activeApiId;
  if (data.activeModelId) appState.activeModelId = data.activeModelId;
  if (data.workingDirectory) appState.workingDirectory = data.workingDirectory;
  renderAll();
}

function renderAll() {
  renderApis();
  renderModels();
  renderConversations();
  loadTasks();
  renderTopBar();
  checkSetupStatus();
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
  const modelEl = document.getElementById('currentModel');
  const apiEl = document.getElementById('currentApi');
  const dirEl = document.getElementById('workingDir');

  const activeModel = appState.models.find(m => m.id === appState.activeModelId) || appState.models[0];
  const activeApi = appState.apis.find(a => a.id === appState.activeApiId) || appState.apis[0];

  if (activeModel) {
    modelEl.textContent = activeModel.name;
    modelEl.style.display = 'inline';
  } else {
    modelEl.textContent = '未配置模型';
    modelEl.style.display = 'inline';
    modelEl.style.color = 'var(--warning)';
  }
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
  const apiData = appState.apis.find(a => a.id === id);
  appState.apis = appState.apis.map(a => ({ ...a, isDefault: a.id === id }));
  await api('POST', '/api/apis', { id, name: apiData?.name, baseUrl: apiData?.baseUrl, apiKey: apiData?.apiKey, isDefault: true });
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

  const result = await api('POST', '/api/apis', { id, name, baseUrl, apiKey, isDefault });
  if (result.success) {
    appState.apis = result.apis;
    if (isDefault) appState.activeApiId = result.apis.find(a => a.isDefault)?.id;
    renderAll();
    hideApiForm();
    showToast(id ? 'API updated' : 'API added');
  }
}

async function deleteApi(id) {
  if (!confirm('Delete this API config?')) return;
  const result = await api('DELETE', `/api/apis/${id}`);
  if (result.success) {
    appState.apis = result.apis;
    renderAll();
    showToast('API deleted');
  }
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

  // Render model stats with token remaining (1M limit)
  const statsContainer = document.getElementById('modelStats');
  if (appState.models.length > 0) {
    statsContainer.style.display = 'block';
    statsContainer.innerHTML = appState.models.map(m => {
      const maxTokens = 1000000; // 1 million tokens
      const used = m.tokensUsed || 0;
      const remaining = maxTokens - used;
      const percentage = (used / maxTokens) * 100;

      let statusClass = 'ok';
      let statusText = `${remaining.toLocaleString()} left`;
      if (percentage >= 80) {
        statusClass = 'danger';
        statusText = `${remaining.toLocaleString()} left (${percentage.toFixed(0)}% used)`;
      } else if (percentage >= 50) {
        statusClass = 'warn';
        statusText = `${remaining.toLocaleString()} left (${percentage.toFixed(0)}% used)`;
      }

      return `
        <div class="model-stat-item" style="margin-left: 20px;">
          <div>
            <div class="model-stat-label">${m.name}</div>
            <div class="model-stat-bar">
              <div class="model-stat-bar-fill ${percentage >= 50 ? 'low' : ''}" style="width: ${Math.min(percentage, 100)}%"></div>
            </div>
          </div>
          <div class="model-stat-value model-stat-token-remaining ${statusClass}">${remaining.toLocaleString()}</div>
        </div>
      `;
    }).join('');
  } else {
    statsContainer.style.display = 'none';
  }
}

async function setActiveModel(id) {
  appState.activeModelId = id;
  const modelData = appState.models.find(m => m.id === id);
  appState.models = appState.models.map(m => ({ ...m, isDefault: m.id === id }));
  await api('POST', '/api/models', { id, name: modelData?.name, provider: modelData?.provider, maxTokens: modelData?.maxTokens, isDefault: true });
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

  const result = await api('POST', '/api/models', { id, name, provider, maxTokens, isDefault });
  if (result.success) {
    appState.models = result.models;
    if (isDefault) appState.activeModelId = result.models.find(m => m.isDefault)?.id;
    renderAll();
    hideModelForm();
    showToast(id ? 'Model updated' : 'Model added');
  }
}

async function deleteModel(id) {
  if (!confirm('Delete this model config?')) return;
  const result = await api('DELETE', `/api/models/${id}`);
  if (result.success) {
    appState.models = result.models;
    renderAll();
    showToast('Model deleted');
  }
}

// ─── Tasks ─────────────────────────────────────────────────────────
async function loadTasks() {
  const result = await api('POST', '/api/tool', { tool: 'TaskList', input: {} });
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
  const task = await api('POST', '/api/tool', { tool: 'TaskGet', input: { taskId: id } });
  if (!task.error) {
    const nextStatus = task.status === 'completed' ? 'pending' : 'completed';
    await api('POST', '/api/tool', { tool: 'TaskUpdate', input: { taskId: id, status: nextStatus } });
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
  await api('POST', `/api/conversations/${id}/activate`);
  appState.activeConversationId = id;
  renderConversations();
  await loadConversation(id);
}

async function loadConversation(id) {
  const conv = await api('GET', `/api/conversations/${id}`);
  if (conv.messages) {
    document.getElementById('welcomeScreen').style.display = 'none';
    const list = document.getElementById('messagesList');
    list.innerHTML = '';
    conv.messages.forEach(msg => {
      addMessage(msg.role, msg.content, false);
    });
    scrollToBottom();
  }
}

async function newConversation() {
  const conv = await api('POST', '/api/conversations/new');
  if (conv.id) {
    appState.conversations.push(conv);
    appState.activeConversationId = conv.id;
    renderConversations();
    document.getElementById('welcomeScreen').style.display = 'flex';
    document.getElementById('messagesList').innerHTML = '';
  }
}

async function deleteConversation(id) {
  if (!confirm('Delete this conversation?')) return;
  await api('DELETE', `/api/conversations/${id}`);
  appState.conversations = appState.conversations.filter(c => c.id !== id);
  if (appState.activeConversationId === id) {
    appState.activeConversationId = null;
    document.getElementById('welcomeScreen').style.display = 'flex';
    document.getElementById('messagesList').innerHTML = '';
  }
  renderConversations();
}

// ─── Messages ──────────────────────────────────────────────────────
function addMessage(role, content, append = true) {
  const list = document.getElementById('messagesList');
  const div = document.createElement('div');

  // Check if it's a tool result message
  if (content.startsWith('[Used tool:')) {
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
    div.innerHTML = escHtml(content);
  } else {
    div.className = 'message assistant';
    div.innerHTML = renderMarkdown(content);
  }

  if (append) {
    list.appendChild(div);
    scrollToBottom();
  }
  return div;
}

function addToolResult(toolName, result) {
  const list = document.getElementById('messagesList');
  const div = document.createElement('div');
  div.className = 'message tool-result';
  const resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  div.innerHTML = `<div class="tool-header">Tool: ${escHtml(toolName)} — Result</div><pre><code>${escHtml(resultText)}</code></pre>`;
  list.appendChild(div);
  scrollToBottom();
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

function updateStreamingMessage(text) {
  const el = document.getElementById('streamingMsg');
  if (el) {
    el.innerHTML = renderMarkdown(text);
    scrollToBottom();
  }
}

function finishStreamingMessage(text) {
  const el = document.getElementById('streamingMsg');
  if (el) {
    el.id = '';
    el.innerHTML = renderMarkdown(text);
  }
}

function scrollToBottom() {
  const container = document.getElementById('chatContainer');
  container.scrollTop = container.scrollHeight;
}

// ─── Markdown Renderer (simple) ────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return '';
  let html = escHtml(text);

  // Code blocks
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  // Line breaks
  html = html.replace(/\n/g, '<br>');

  return html;
}

function escHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Send Message ──────────────────────────────────────────────────
async function sendMessage(text) {
  const input = document.getElementById('messageInput');
  const msg = text || input.value.trim();
  if (!msg || isStreaming) return;

  // 检查是否已配置 API 和 Model
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

  // Hide welcome, show input message
  document.getElementById('welcomeScreen').style.display = 'none';
  addMessage('user', msg);
  input.value = '';
  input.style.height = 'auto';

  // Disable send
  isStreaming = true;
  document.getElementById('sendBtn').disabled = true;

  try {
    // Use streaming
    const convId = appState.activeConversationId;
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, conversationId: convId }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Request failed');
    }

    addStreamingMessage();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.delta) {
              fullText += data.delta;
              updateStreamingMessage(fullText);
            }
            if (data.tool_used) {
              // Show tool usage during streaming
              const toolText = `\n\n\`\`\`tool: ${data.tool_used}\n${data.tool_result || ''}\n\`\`\`\n\n`;
              fullText += toolText;
              updateStreamingMessage(fullText);
            }
            if (data.done) {
              if (data.conversationId && !appState.activeConversationId) {
                appState.activeConversationId = data.conversationId;
                appState.conversations.push({
                  id: data.conversationId,
                  title: msg.slice(0, 50),
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                });
                renderConversations();
              }
              finishStreamingMessage(fullText);
            }
            if (data.error) {
              finishStreamingMessage(`Error: ${data.error}`);
              showToast(data.error, 'error');
            }
          } catch { /* skip parse errors */ }
        }
      }
    }
  } catch (err) {
    showToast(err.message, 'error');
    addMessage('assistant', `Error: ${err.message}`);
  } finally {
    isStreaming = false;
    document.getElementById('sendBtn').disabled = false;
  }
}

function sendQuickAction(text) {
  if (!appState.activeConversationId) {
    newConversation().then(() => sendMessage(text));
  } else {
    sendMessage(text);
  }
}

// ─── Event Listeners ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadState();

  // Send button
  document.getElementById('sendBtn').addEventListener('click', () => sendMessage());

  // Enter to send
  const input = document.getElementById('messageInput');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 100) + 'px';
  });

  // New chat
  document.getElementById('newChatBtn').addEventListener('click', newConversation);

  // Sidebar toggle
  document.getElementById('sidebarToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
  });
});
