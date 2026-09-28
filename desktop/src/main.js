const { app, BrowserWindow, ipcMain } = require('electron');
const { join, resolve, basename } = require('path');
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('fs');
const { spawn, execSync } = require('child_process');
const { getState, updateState } = require('./state');
const { executeTool, getToolDefinitions, loadPlugins } = require('./tool-registry');
const { registerBuiltinTools } = require('./tools');
const { registerExtendedTools } = require('./tools-extended');
// const { registerComputerTools } = require('./tools-computer'); // 暂时关闭桌面自动化
const { sendChat, streamChat, stopChat } = require('./chat');

let mainWindow = null;

// Check if a port is in use by trying to connect (reliable cross-platform)
function isPortInUse(port) {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'CC Master',
  });

  mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

function registerHandlers() {
  ipcMain.handle('state:get', () => getState());
  ipcMain.handle('state:update', (_, updates) => updateState(updates));
  ipcMain.handle('tools:list', () => getToolDefinitions());
  ipcMain.handle('tools:execute', async (_, { name, input }) => executeTool(name, input));
  ipcMain.handle('chat:send', async (_, { messages, model, apiId }) => sendChat(messages, model, apiId));
  ipcMain.handle('file:saveUpload', (_, { fileName, dataUrl }) => {
    const uploadsDir = join(resolve(__dirname, '..'), 'uploads');
    if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
    const base64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
    const filePath = join(uploadsDir, Date.now() + '_' + fileName);
    writeFileSync(filePath, Buffer.from(base64, 'base64'));
    return { success: true, path: filePath };
  });
  ipcMain.handle('chat:stop', () => {
    return stopChat();
  });

  ipcMain.handle('chat:answerQuestion', (_, answers) => {
    const { resolveAskUserQuestion } = require('./chat');
    return resolveAskUserQuestion(answers);
  });

  ipcMain.handle('chat:stream', async (_, { messages, model, apiId }) => {
    if (!mainWindow) return;
    try {
      await streamChat(messages, model, apiId, (event, data) => {
        mainWindow.webContents.send(event, data);
      });
      return { success: true };
    } catch (err) {
      mainWindow.webContents.send('chat:error', { error: err.message });
      return { success: false, error: err.message };
    }
  });

  // Test API connection
  ipcMain.handle('api:test', async (_, { baseUrl, apiKey }) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      let base = baseUrl.replace(/\/+$/, '');
      if (!base.endsWith('/v1')) base += '/v1';
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'test',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.choices) return { success: true, message: 'Connection OK, API key valid' };
      if (res.status === 401 || res.status === 403) return { success: false, message: 'Invalid API key' };
      if (res.status === 400 || res.status === 422) {
        const errMsg = (data.error?.message || '').toLowerCase();
        if (errMsg.includes('api key') || errMsg.includes('unauthorized') || errMsg.includes('invalid api')) return { success: false, message: 'Invalid API key' };
        return { success: true, message: 'Connection OK (model not found, but key is valid)' };
      }
      if (res.status === 404) return { success: false, message: 'API endpoint not found (404). Check Base URL.' };
      return { success: false, message: `HTTP ${res.status}: ${data.error?.message || res.statusText}` };
    } catch (err) {
      return { success: false, message: err.name === 'AbortError' ? 'Timeout (10s)' : err.message };
    }
  });

  // Read LiteLLM config file
  ipcMain.handle('litellm:readConfig', () => {
    const LITELLM_CONFIG = resolve(__dirname, '..', '..', 'litellm_config.yaml');
    const configPaths = [LITELLM_CONFIG, join(require('os').homedir(), 'litellm_config.yaml')];
    for (const configPath of configPaths) {
      if (existsSync(configPath)) {
        try {
          const content = readFileSync(configPath, 'utf-8');
          const models = [];
          const modelRegex = /model_name:\s*(\S+)/g;
          let match;
          while ((match = modelRegex.exec(content)) !== null) models.push(match[1]);
          const portMatch = content.match(/port:\s*(\d+)/);
          const port = portMatch ? parseInt(portMatch[1]) : 4000;
          return { success: true, path: configPath, models, port };
        } catch (err) { return { success: false, message: err.message }; }
      }
    }
    return { success: false, message: 'litellm_config.yaml not found' };
  });

  // LiteLLM status check (called by frontend to show status indicator)
  ipcMain.handle('litellm:status', async () => {
    const ready = await isPortInUse(4000);
    return { running: ready, ready };
  });

  // Add a new model to litellm_config.yaml
  ipcMain.handle('litellm:addModel', (_, { name, provider, apiKey, apiBase }) => {
    const LITELLM_CONFIG = resolve(__dirname, '..', '..', 'litellm_config.yaml');
    try {
      let content = readFileSync(LITELLM_CONFIG, 'utf-8');
      if (content.includes(`model_name: ${name}`)) return { success: false, message: `Model "${name}" already exists in config` };
      const providerModel = `${provider}/${name}`;
      const newEntry = `\n  - model_name: ${name}\n    litellm_params:\n      model: ${providerModel}\n${apiBase ? `      api_base: ${apiBase}\n` : ''}      api_key: ${apiKey}`;
      const settingsIdx = content.indexOf('litellm_settings:');
      if (settingsIdx === -1) {
        content = content.trimEnd() + newEntry + '\n';
      } else {
        content = content.slice(0, settingsIdx).trimEnd() + newEntry + '\n\n' + content.slice(settingsIdx);
      }
      writeFileSync(LITELLM_CONFIG, content);
      const homeConfig = join(require('os').homedir(), 'litellm_config.yaml');
      if (existsSync(homeConfig)) writeFileSync(homeConfig, content);
      return { success: true, message: `Model "${name}" added to config` };
    } catch (err) { return { success: false, message: err.message }; }
  });

  // Remove a model from litellm_config.yaml
  ipcMain.handle('litellm:removeModel', (_, { name }) => {
    const LITELLM_CONFIG = resolve(__dirname, '..', '..', 'litellm_config.yaml');
    try {
      let content = readFileSync(LITELLM_CONFIG, 'utf-8');
      const modelBlockRegex = new RegExp(`\\n\\s*- model_name: ${name}\\n[\\s\\S]*?(?=\\n\\s*- model_name:|\\n\\w|$)`, 'g');
      content = content.replace(modelBlockRegex, '');
      writeFileSync(LITELLM_CONFIG, content);
      const homeConfig = join(require('os').homedir(), 'litellm_config.yaml');
      if (existsSync(homeConfig)) writeFileSync(homeConfig, content);
      return { success: true, message: `Model "${name}" removed from config` };
    } catch (err) { return { success: false, message: err.message }; }
  });
}

app.whenReady().then(() => {
  registerHandlers();
  registerBuiltinTools();
  registerExtendedTools();
  // registerComputerTools(); // 暂时关闭桌面自动化，需要时取消注释
  loadPlugins();
  createWindow();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
