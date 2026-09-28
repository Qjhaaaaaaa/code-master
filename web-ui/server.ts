import { serve } from 'bun';
import { Anthropic } from '@anthropic-ai/sdk';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { resolve, relative, isAbsolute, dirname } from 'path';
import { createHash } from 'crypto';

const execAsync = promisify(exec);
const ROOT_DIR = resolve(__dirname, '..');
const PORT = parseInt(process.env.WEB_UI_PORT || '3000');

// ─── Persistent State ──────────────────────────────────────────────
const STATE_FILE = resolve(__dirname, 'state.json');

interface ApiConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  isDefault: boolean;
}

interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  maxTokens: number;
  isDefault: boolean;
  tokensUsed: number; // 已使用的 token 数
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | Array<{ type: string; text?: string; source?: any }>;
}

interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

interface AppState {
  apis: ApiConfig[];
  models: ModelConfig[];
  conversations: Conversation[];
  activeConversationId: string | null;
  activeApiId: string | null;
  activeModelId: string | null;
  workingDirectory: string;
}

function loadState(): AppState {
  if (existsSync(STATE_FILE)) {
    try {
      const data = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
      // Ensure tokensUsed exists for backward compatibility
      if (data.models) {
        data.models = data.models.map((m: any) => ({
          ...m,
          tokensUsed: m.tokensUsed || 0,
        }));
      }
      return data;
    } catch { /* ignore */ }
  }
  // Default empty state - require dynamic registration
  return {
    apis: [],
    models: [],
    conversations: [],
    activeConversationId: null,
    activeApiId: null,
    activeModelId: null,
    workingDirectory: ROOT_DIR,
  };
}

function saveState(state: AppState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let state = loadState();

// Track searched/fetched URLs per user question to avoid duplicates within one question
let currentSearchedUrls: Set<string> = new Set();

function resetSearchUrls() {
  currentSearchedUrls = new Set();
}

// ─── Helpers ───────────────────────────────────────────────────────
function genId() {
  return createHash('md5').update(Date.now().toString() + Math.random().toString()).digest('hex').slice(0, 12);
}

function getActiveApi(): ApiConfig | undefined {
  if (state.activeApiId) return state.apis.find(a => a.id === state.activeApiId);
  return state.apis.find(a => a.isDefault) || state.apis[0];
}

function getActiveModel(): string {
  if (state.activeModelId) {
    const m = state.models.find(m => m.id === state.activeModelId);
    if (m) return m.name;
  }
  const d = state.models.find(m => m.isDefault);
  return d?.name || 'qwen3.5-plus';
}

function getActiveModelObj(): ModelConfig | undefined {
  if (state.activeModelId) {
    return state.models.find(m => m.id === state.activeModelId);
  }
  return state.models.find(m => m.isDefault);
}

function getAnthropicClient(): Anthropic {
  const api = getActiveApi();
  if (!api) throw new Error('No API configured');
  return new Anthropic({
    apiKey: api.apiKey,
    baseURL: api.baseUrl,
  });
}

function sanitizePath(p: string): string {
  const resolved = isAbsolute(p) ? resolve(p) : resolve(state.workingDirectory, p);
  const workingDir = resolve(state.workingDirectory);
  // Allow paths within working directory OR project root
  if (!resolved.startsWith(workingDir) && !resolved.startsWith(ROOT_DIR)) {
    throw new Error(`Path outside allowed directories. Working dir: ${workingDir}, Project root: ${ROOT_DIR}`);
  }
  return resolved;
}

// ─── Tool Execution ────────────────────────────────────────────────
async function executeTool(toolName: string, input: any): Promise<any> {
  try {
    switch (toolName) {
      case 'Bash': {
        const { command, timeout } = input;
        const { stdout, stderr } = await execAsync(command, {
          cwd: state.workingDirectory,
          timeout: (timeout || 30) * 1000,
          maxBuffer: 10 * 1024 * 1024,
        });
        return { stdout, stderr };
      }

      case 'Read': {
        const filePath = input.file_path || input.path;
        if (!filePath) return { error: 'The "file_path" property is required' };
        const sanitizedPath = sanitizePath(filePath);
        const content = readFileSync(sanitizedPath, 'utf-8');
        const lines = content.split('\n');
        const start = input.offset || 0;
        const limit = input.limit || 200;
        const slice = lines.slice(start, start + limit);
        return { content: slice.map((l, i) => `${start + i + 1}\t${l}`).join('\n'), totalLines: lines.length };
      }

      case 'Edit': {
        const filePath = input.file_path || input.path;
        if (!filePath) return { error: 'The "file_path" property is required' };
        const sanitizedPath = sanitizePath(filePath);
        const content = readFileSync(sanitizedPath, 'utf-8');
        if (!content.includes(input.old_string)) {
          return { error: 'old_string not found in file' };
        }
        const newContent = content.replace(input.old_string, input.new_string);
        writeFileSync(sanitizedPath, newContent);
        return { success: true, message: 'File edited successfully' };
      }

      case 'Write': {
        // Support both file_path and path (for compatibility)
        const filePath = input.file_path !== undefined ? input.file_path : input.path;
        if (filePath === undefined || typeof filePath !== 'string' || filePath.trim() === '') {
          return { error: 'The "file_path" property must be a non-empty string' };
        }
        const sanitizedPath = sanitizePath(filePath);
        const dir = dirname(sanitizedPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(sanitizedPath, input.content || '', 'utf-8');
        return { success: true, message: `Written ${(input.content || '').length} bytes to ${sanitizedPath}` };
      }

      case 'Glob': {
        const pattern = input.pattern;
        const cmd = process.platform === 'win32'
          ? `dir /b /s "${pattern.replace(/\//g, '\\')}" 2>nul || true`
          : `find . -path "${pattern}" -type f 2>/dev/null | head -100 || true`;
        const { stdout } = await execAsync(cmd, { cwd: state.workingDirectory, maxBuffer: 10 * 1024 * 1024 });
        const files = stdout.split('\n').filter(Boolean).map(f => f.replace(/^\.\//, '')).slice(0, 100);
        return { files, total: files.length };
      }

      case 'Grep': {
        const { pattern, path, glob } = input;
        let cmd = `grep -rn "${pattern}"`;
        if (path) cmd += ` "${path}"`; else cmd += ` .`;
        if (glob) cmd += ` --include="*.${glob}"`;
        cmd += ' || true';
        const { stdout } = await execAsync(cmd, { cwd: state.workingDirectory, maxBuffer: 10 * 1024 * 1024 });
        return { matches: stdout.split('\n').filter(Boolean).slice(0, 200) };
      }

      case 'ListDir': {
        const p = sanitizePath(input.path || '.');
        const entries = readdirSync(p);
        const details = entries.map(e => {
          const s = statSync(resolve(p, e));
          return { name: e, isDir: s.isDirectory(), size: s.size, modified: s.mtime.toISOString() };
        });
        return { entries: details };
      }

      case 'CreateDir': {
        const p = sanitizePath(input.path);
        mkdirSync(p, { recursive: true });
        return { success: true, message: `Directory created: ${p}` };
      }

      case 'GetState': {
        return {
          apis: state.apis.map(a => ({ id: a.id, name: a.name, baseUrl: a.baseUrl, isDefault: a.isDefault })),
          models: state.models.map(m => ({ ...m, tokensUsed: m.tokensUsed || 0 })),
          conversations: state.conversations.map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
          activeConversationId: state.activeConversationId,
          activeApiId: state.activeApiId,
          activeModelId: state.activeModelId,
          workingDirectory: state.workingDirectory,
        };
      }

      case 'WebSearch': {
        const { query, allowed_domains, blocked_domains } = input;
        const params = new URLSearchParams({ query });
        if (allowed_domains?.length) params.append('allowed_domains', allowed_domains.join(','));
        if (blocked_domains?.length) params.append('blocked_domains', blocked_domains.join(','));
        const { fetch: globalFetch } = await import('undici');
        const res = await globalFetch(`https://api.exa.ai/search/web?${params.toString()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, numResults: 10 }),
        }).catch(() => ({ ok: false, statusText: 'WebSearch requires external API config' }));
        // Fallback: use a simple web search simulation via DuckDuckGo HTML scrape
        const ddgRes = await globalFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
        }).catch(() => null);
        if (ddgRes && ddgRes.ok) {
          const html = await ddgRes.text();
          const results: any[] = [];
          const linkRegex = /class="result[^"]*".*?href="([^"]+)".*?>([^<]+)<\/a>/gs;
          let m;
          while ((m = linkRegex.exec(html)) !== null && results.length < 10) {
            const url = m[1];
            // Skip URLs already searched in this question
            if (currentSearchedUrls.has(url)) continue;
            results.push({ title: m[2].replace(/<[^>]*>/g, '').trim(), url });
            currentSearchedUrls.add(url);
          }
          return { results, query, newResults: results.length, skippedDuplicates: true };
        }
        return { error: 'Web search unavailable', query };
      }

      case 'WebFetch': {
        const { url, prompt: fetchPrompt } = input;
        // Check if URL was already fetched
        if (currentSearchedUrls.has(url)) {
          return { url, warning: 'This URL was already fetched in this question. Try a different URL or search query.', alreadyFetched: true };
        }
        currentSearchedUrls.add(url);
        const { fetch: globalFetch } = await import('undici');
        const res = await globalFetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClaudeCodeWebUI/1.0)' },
          redirect: 'follow',
        });
        if (!res.ok) return { error: `Failed to fetch ${url}: ${res.status} ${res.statusText}` };
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('html')) {
          const html = await res.text();
          // Strip HTML tags for basic text extraction
          const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 10000);
          return { url, text, contentType };
        }
        const text = await res.text();
        return { url, text: text.slice(0, 10000), contentType };
      }

      case 'TaskCreate': {
        const { subject, description } = input;
        if (!subject) return { error: 'Subject is required' };
        // Store task in a simple in-memory registry (persisted via state)
        if (!state._tasks) state._tasks = [];
        const task = {
          id: state._tasks.length + 1,
          subject,
          description: description || '',
          status: 'pending',
          createdAt: Date.now(),
        };
        state._tasks.push(task);
        saveState(state);
        return task;
      }

      case 'TaskList': {
        if (!state._tasks) state._tasks = [];
        return { tasks: state._tasks };
      }

      case 'TaskGet': {
        if (!state._tasks) state._tasks = [];
        const task = state._tasks.find(t => t.id === input.taskId);
        return task || { error: 'Task not found' };
      }

      case 'TaskUpdate': {
        if (!state._tasks) state._tasks = [];
        const taskIdx = state._tasks.findIndex(t => t.id === input.taskId);
        if (taskIdx === -1) return { error: 'Task not found' };
        if (input.status) state._tasks[taskIdx].status = input.status;
        if (input.description !== undefined) state._tasks[taskIdx].description = input.description;
        if (input.subject) state._tasks[taskIdx].subject = input.subject;
        saveState(state);
        return state._tasks[taskIdx];
      }

      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

// ─── HTTP Server ───────────────────────────────────────────────────
const server = serve({
  port: PORT,
  idleTimeout: 300,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    };

    try {
      // ── Static files ──
      if (path === '/' || path === '/index.html') {
        const html = readFileSync(resolve(__dirname, 'index.html'));
        return new Response(html, { headers: { 'Content-Type': 'text/html' } });
      }
      if (path === '/style.css') {
        const css = readFileSync(resolve(__dirname, 'style.css'));
        return new Response(css, { headers: { 'Content-Type': 'text/css' } });
      }
      if (path === '/app.js') {
        const js = readFileSync(resolve(__dirname, 'app.js'));
        return new Response(js, { headers: { 'Content-Type': 'application/javascript' } });
      }

      // ── API Routes ──

      // POST /api/chat - Send message to AI
      if (path === '/api/chat' && req.method === 'POST') {
        const body = await req.json();
        const { message, conversationId } = body;

        let conv: Conversation;
        if (conversationId) {
          conv = state.conversations.find(c => c.id === conversationId)!;
          if (!conv) return new Response(JSON.stringify({ error: 'Conversation not found' }), { status: 404, headers });
        } else {
          conv = {
            id: genId(),
            title: message.slice(0, 50),
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          state.conversations.push(conv);
          state.activeConversationId = conv.id;
        }

        // Add user message
        conv.messages.push({ role: 'user', content: message });
        conv.updatedAt = Date.now();

        // Reset search URL tracking for this user question
        resetSearchUrls();

        // Build system prompt with tool definitions
        const systemPrompt = `You are a helpful AI coding assistant running in a local environment. You have access to these tools:

- **Bash**: Execute shell commands. Parameters: command (string), timeout (seconds, default 30)
- **Read**: Read file contents. Parameters: file_path, offset (line number, default 0), limit (lines, default 200)
- **Edit**: Edit file contents by replacing text. Parameters: file_path, old_string, new_string
- **Write**: Write/create files. Parameters: file_path, content
- **Glob**: Find files by pattern. Parameters: pattern (e.g. "**/*.ts"), path (optional)
- **Grep**: Search file contents. Parameters: pattern, path (optional), glob (optional file extension)
- **ListDir**: List directory contents. Parameters: path (default: project root)
- **CreateDir**: Create a directory. Parameters: path
- **WebSearch**: Search the web. Parameters: query (string)
- **WebFetch**: Fetch content from a URL. Parameters: url (string), prompt (optional)
- **TaskCreate**: Create a task. Parameters: subject (string), description (string)
- **TaskList**: List all tasks. No parameters.
- **TaskGet**: Get a task. Parameters: taskId (number)
- **TaskUpdate**: Update a task. Parameters: taskId (number), status (string), subject (string), description (string)

Working directory: ${state.workingDirectory}
Project root: ${ROOT_DIR}

When you need to use a tool, respond with a JSON block:
\`\`\`json
{"tool": "ToolName", "input": {...}}
\`\`\`

After receiving tool results, respond naturally to the user.
IMPORTANT: When the user expresses a requirement, you must use ALL of your capabilities to complete it. Exhaust every possible approach before giving up. Never give up while you still have ideas or solutions to try. However, if you must decline a request, state your refusal ONCE clearly and stop — do not repeat or rephrase it.

IMPORTANT: Only respond to the LATEST user message. Do NOT re-execute or continue tasks from previous messages in the conversation history. Previous messages are for context only — they help you understand the conversation, but you must only act on the current request.

IMPORTANT: If you can say it in one sentence, don't use three. Be concise and direct.

IMPORTANT: You MUST always reply in Chinese (中文). Never reply in English.

NOTE: When searching the web, URLs already fetched in this question will be automatically filtered out to avoid duplicates. If WebSearch returns fewer results or WebFetch says "already fetched", use different search queries or different URLs to find new content. This filter resets with each new user question.`;

        // Convert messages to Anthropic format
        let apiMessages: any[] = [];
        for (const msg of conv.messages) {
          if (msg.role === 'system') continue;
          apiMessages.push({ role: msg.role, content: msg.content });
        }

        // Trim conversation history if too long (keep last 40 messages)
        const MAX_MESSAGES = 40;
        if (apiMessages.length > MAX_MESSAGES) {
          apiMessages = apiMessages.slice(-MAX_MESSAGES);
        }

        const client = getAnthropicClient();
        const modelName = getActiveModel();

        // Multi-step tool loop (max 10 steps)
        const maxToolSteps = 10;
        const recentToolCalls: string[] = [];
        let fullText = '';

        for (let step = 0; step < maxToolSteps; step++) {
          const response = await client.messages.create({
            model: modelName,
            system: systemPrompt,
            messages: apiMessages,
            max_tokens: 8192,
            temperature: 0.3,
          });

          fullText = '';
          let hasToolUseBlock = false;
          let textBlocks = '';
          for (const block of response.content) {
            if (block.type === 'text') textBlocks += block.text;
            if (block.type === 'tool_use') hasToolUseBlock = true;
          }
          fullText = textBlocks;

          // If model produces text AND tool_use together after step 0, it's a refusal with a
          // tool call attached — return the text directly, don't execute the tool.
          if (step > 0 && hasToolUseBlock && textBlocks.trim().length > 0) {
            break;
          }

          // Check if response contains a tool call (JSON block in text for non-streaming)
          const toolMatch = fullText.match(/```json\s*\n?(\{[\s\S]*?\})\s*\n?```/);
          if (!toolMatch) {
            // No tool call — this is the final response
            conv.messages.push({ role: 'assistant', content: fullText });
            saveState(state);
            const modelObj = getActiveModelObj();
            if (modelObj && response.usage) {
              const totalTokens = (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0);
              modelObj.tokensUsed = (modelObj.tokensUsed || 0) + totalTokens;
              saveState(state);
            }
            return new Response(JSON.stringify({
              conversationId: conv.id,
              message: fullText,
              usage: response.usage,
            }), { headers });
          }

          try {
            const toolCall = JSON.parse(toolMatch[1]);
            const toolName = toolCall.tool || toolCall.name;
            const toolInput = toolCall.input || toolCall.parameters || toolCall;

            if (!toolName || toolInput.error) break;

            // Duplicate tool call detection
            const toolSig = `${toolName}:${JSON.stringify(toolInput)}`;
            if (recentToolCalls.includes(toolSig)) {
              // Force direct answer
              apiMessages.push({ role: 'assistant' as const, content: fullText });
              apiMessages.push({ role: 'user' as const, content: 'You have already performed this exact tool call. Do NOT call the same tool again. Respond to the user directly with the information you already have.' });
              continue;
            }
            recentToolCalls.push(toolSig);
            if (recentToolCalls.length > 5) recentToolCalls.shift();

            // Execute the tool
            const toolResult = await executeTool(toolName, toolInput);
            const toolResultText = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult, null, 2);

            // Add to message history for next iteration
            apiMessages.push({ role: 'assistant' as const, content: fullText });
            apiMessages.push({ role: 'user' as const, content: `Tool execution result for ${toolName}:\n${toolResultText}\n\nPlease analyze this result and respond. If you need more tool calls, include them. Otherwise give a clear response to the user.` });

            // If this was the last step, save and return
            if (step === maxToolSteps - 1) {
              conv.messages.push({ role: 'assistant', content: fullText });
              saveState(state);
              return new Response(JSON.stringify({
                conversationId: conv.id,
                message: fullText,
                toolUsed: toolName,
                toolResult: toolResultText,
              }), { headers });
            }
          } catch { break; }
        }

        // Fallback: no tool call path
        conv.messages.push({ role: 'assistant', content: fullText });
        saveState(state);
        return new Response(JSON.stringify({
          conversationId: conv.id,
          message: fullText,
        }), { headers });
      }

      // POST /api/chat/stream - Stream response with multi-step tool execution
      if (path === '/api/chat/stream' && req.method === 'POST') {
        const body = await req.json();
        const { message, conversationId } = body;

        let conv: Conversation;
        if (conversationId) {
          conv = state.conversations.find(c => c.id === conversationId)!;
        } else {
          conv = {
            id: genId(),
            title: message.slice(0, 50),
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          state.conversations.push(conv);
          state.activeConversationId = conv.id;
        }

        conv.messages.push({ role: 'user', content: message });
        conv.updatedAt = Date.now();

        // Reset search URL tracking for this user question
        resetSearchUrls();

        const client = getAnthropicClient();
        const modelName = getActiveModel();

        // Define tools for the API
        const toolDefs = [
          {
            name: 'Bash',
            description: 'Execute a shell command',
            input_schema: {
              type: 'object',
              properties: {
                command: { type: 'string', description: 'The command to execute' },
                timeout: { type: 'number', description: 'Timeout in seconds (default 30)' },
              },
              required: ['command'],
            },
          },
          {
            name: 'Read',
            description: 'Read file contents',
            input_schema: {
              type: 'object',
              properties: {
                file_path: { type: 'string', description: 'Path to the file' },
                offset: { type: 'number', description: 'Starting line number (default 0)' },
                limit: { type: 'number', description: 'Max lines to read (default 200)' },
              },
              required: ['file_path'],
            },
          },
          {
            name: 'Edit',
            description: 'Edit file by replacing text',
            input_schema: {
              type: 'object',
              properties: {
                file_path: { type: 'string', description: 'Path to the file' },
                old_string: { type: 'string', description: 'Text to replace' },
                new_string: { type: 'string', description: 'Replacement text' },
              },
              required: ['file_path', 'old_string', 'new_string'],
            },
          },
          {
            name: 'Write',
            description: 'Write or create a file',
            input_schema: {
              type: 'object',
              properties: {
                file_path: { type: 'string', description: 'Path to the file' },
                content: { type: 'string', description: 'File content' },
              },
              required: ['file_path', 'content'],
            },
          },
          {
            name: 'Glob',
            description: 'Find files matching a glob pattern',
            input_schema: {
              type: 'object',
              properties: {
                pattern: { type: 'string', description: 'Glob pattern like "**/*.ts"' },
                path: { type: 'string', description: 'Directory to search in' },
              },
              required: ['pattern'],
            },
          },
          {
            name: 'Grep',
            description: 'Search file contents with regex',
            input_schema: {
              type: 'object',
              properties: {
                pattern: { type: 'string', description: 'Regex pattern' },
                path: { type: 'string', description: 'File or directory to search in' },
                glob: { type: 'string', description: 'File extension filter' },
              },
              required: ['pattern'],
            },
          },
          {
            name: 'ListDir',
            description: 'List directory contents',
            input_schema: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Directory path (default: project root)' },
              },
              required: [],
            },
          },
          {
            name: 'CreateDir',
            description: 'Create a directory',
            input_schema: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Directory path' },
              },
              required: ['path'],
            },
          },
          {
            name: 'WebSearch',
            description: 'Search the web for information',
            input_schema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query' },
              },
              required: ['query'],
            },
          },
          {
            name: 'WebFetch',
            description: 'Fetch content from a URL',
            input_schema: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'URL to fetch' },
                prompt: { type: 'string', description: 'What to extract from the page' },
              },
              required: ['url'],
            },
          },
          {
            name: 'TaskCreate',
            description: 'Create a task/todo item',
            input_schema: {
              type: 'object',
              properties: {
                subject: { type: 'string', description: 'Task title' },
                description: { type: 'string', description: 'Task description' },
              },
              required: ['subject'],
            },
          },
          {
            name: 'TaskList',
            description: 'List all tasks',
            input_schema: { type: 'object', properties: {}, required: [] },
          },
          {
            name: 'TaskGet',
            description: 'Get a task by ID',
            input_schema: {
              type: 'object',
              properties: {
                taskId: { type: 'number', description: 'Task ID' },
              },
              required: ['taskId'],
            },
          },
          {
            name: 'TaskUpdate',
            description: 'Update a task',
            input_schema: {
              type: 'object',
              properties: {
                taskId: { type: 'number', description: 'Task ID' },
                status: { type: 'string', description: 'New status (pending, in_progress, completed, deleted)' },
                subject: { type: 'string', description: 'New subject' },
                description: { type: 'string', description: 'New description' },
              },
              required: ['taskId'],
            },
          },
        ];

        const systemPrompt = `You are a helpful AI coding assistant running in a local environment. You have access to tools for file and command operations.

Working directory: ${state.workingDirectory}
Project root: ${ROOT_DIR}

Use tools when needed to read files, run commands, search code, or edit files. Always explain what you're doing. Be concise.

IMPORTANT: When the user expresses a requirement, you must use ALL of your capabilities to complete it. Exhaust every possible approach before giving up. Never give up while you still have ideas or solutions to try. However, if you must decline a request, state your refusal ONCE clearly and stop — do not repeat or rephrase it.

IMPORTANT: Only respond to the LATEST user message. Do NOT re-execute or continue tasks from previous messages in the conversation history. Previous messages are for context only — they help you understand the conversation, but you must only act on the current request.

IMPORTANT: If you can say it in one sentence, don't use three. Be concise and direct.

IMPORTANT: You MUST always reply in Chinese (中文). Never reply in English.

NOTE: When searching the web, URLs already fetched in this question will be automatically filtered out to avoid duplicates. If WebSearch returns fewer results or WebFetch says "already fetched", use different search queries or different URLs to find new content. This filter resets with each new user question.`;

        // Build messages for API (exclude system messages)
        let apiMessages: any[] = conv.messages
          .filter(m => m.role !== 'system')
          .map(m => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          }));

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            let fullText = '';
            let allToolCalls: any[] = [];
            const maxToolSteps = 10; // Prevent infinite loops
            let toolStep = 0;
            const recentToolCalls: string[] = []; // Track recent tool calls for duplicate detection

            try {
              // Trim conversation history if too long (keep last 40 messages)
              const MAX_MESSAGES = 40;
              if (apiMessages.length > MAX_MESSAGES) {
                apiMessages = apiMessages.slice(-MAX_MESSAGES);
              }

              while (toolStep < maxToolSteps) {
                toolStep++;

                const response = await client.messages.create({
                  model: modelName,
                  system: systemPrompt,
                  messages: apiMessages,
                  max_tokens: 8192,
                  temperature: 0.3,
                  tools: toolDefs,
                  stream: true,
                });

                let stepText = '';
                let stepToolUses: any[] = [];

                for await (const chunk of response) {
                  if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
                    stepText += chunk.delta.text;
                  }
                  if (chunk.type === 'content_block_start' && chunk.content_block?.type === 'tool_use') {
                    stepToolUses.push({
                      id: chunk.content_block.id,
                      name: chunk.content_block.name,
                      input: chunk.content_block.input || {},
                    });
                  }
                  if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'input_json_delta' && chunk.delta?.partial_json) {
                    // Accumulate tool input JSON
                    if (!stepToolUses[stepToolUses.length - 1]) {
                      stepToolUses.push({ id: '', name: '', input: '' });
                    }
                    const lastTool = stepToolUses[stepToolUses.length - 1];
                    if (typeof lastTool.input === 'string') {
                      lastTool.input += chunk.delta.partial_json;
                    }
                  }
                }

                // After the first step, if model produces text alongside tool calls,
                // it's a refusal with an attached tool call — don't execute, just return.
                if (toolStep > 1 && stepToolUses.length > 0 && stepText.trim().length > 0) {
                  fullText += stepText;
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: stepText })}\n\n`));
                  break;
                }

                // If no tool calls, this is the final response — stream it to user
                if (stepToolUses.length === 0) {
                  fullText += stepText;
                  if (stepText) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: stepText })}\n\n`));
                  }
                  break;
                }

                // Check for duplicate tool calls to prevent loops
                const toolSignature = stepToolUses.map(t => `${t.name}:${JSON.stringify(t.input)}`).join('|');
                if (recentToolCalls.includes(toolSignature)) {
                  // Duplicate tool call detected — force model to give a direct answer
                  fullText += stepText;
                  apiMessages.push({
                    role: 'assistant',
                    content: stepText || 'I need to use a tool.',
                  });
                  apiMessages.push({
                    role: 'user',
                    content: 'You have already performed this exact tool call. Do NOT call the same tool again. Respond to the user directly with the information you already have.',
                  });
                  continue; // Let the model try again without tool calls
                }
                recentToolCalls.push(toolSignature);
                if (recentToolCalls.length > 5) recentToolCalls.shift(); // Keep last 5

                allToolCalls.push(...stepToolUses);

                // Execute each tool and add results to messages
                const assistantBlocks: any[] = [];
                const toolResults: any[] = [];

                for (const toolUse of stepToolUses) {
                  let inputObj = toolUse.input;
                  if (typeof inputObj === 'string') {
                    try { inputObj = JSON.parse(inputObj || '{}'); } catch { inputObj = {}; }
                  }

                  const result = await executeTool(toolUse.name, inputObj);
                  const resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

                  const toolId = toolUse.id || `tool_${genId()}`;
                  assistantBlocks.push({
                    type: 'tool_use',
                    id: toolId,
                    name: toolUse.name,
                    input: inputObj,
                  });

                  toolResults.push({
                    type: 'tool_result',
                    tool_use_id: toolId,
                    content: resultText,
                  });

                  // Send tool usage info to client
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ tool_used: toolUse.name, tool_result: resultText })}\n\n`));
                }

                // Add assistant message with tool_use blocks
                apiMessages.push({
                  role: 'assistant',
                  content: [...(stepText ? [{ type: 'text', text: stepText }] : []), ...assistantBlocks],
                });

                // Add tool results
                apiMessages.push({ role: 'user', content: toolResults });
              }

              // Save conversation with tool call history
              conv.messages.push({ role: 'assistant', content: fullText });
              conv.updatedAt = Date.now();
              saveState(state);

              // Track token usage for streaming (estimated from total tokens - 10% buffer)
              const modelObj = getActiveModelObj();
              if (modelObj && fullText) {
                // Rough estimate: ~250 chars per token
                const estimatedTokens = Math.ceil(fullText.length / 250);
                modelObj.tokensUsed = (modelObj.tokensUsed || 0) + estimatedTokens;
                saveState(state);
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, conversationId: conv.id, tool_calls: allToolCalls, estimated_tokens: estimatedTokens })}\n\n`));
              } else {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, conversationId: conv.id, tool_calls: allToolCalls })}\n\n`));
              }
            } catch (err: any) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: err.message })}\n\n`));
            }
            controller.close();
          },
        });

        return new Response(stream, {
          headers: {
            ...headers,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        });
      }

      // POST /api/tool - Execute a tool directly
      if (path === '/api/tool' && req.method === 'POST') {
        const body = await req.json();
        const { tool, input } = body;
        const result = await executeTool(tool, input);
        return new Response(JSON.stringify(result), { headers });
      }

      // GET /api/state - Get app state
      if (path === '/api/state' && req.method === 'GET') {
        const result = await executeTool('GetState', {});
        return new Response(JSON.stringify(result), { headers });
      }

      // POST /api/apis - Add or update API config
      if (path === '/api/apis' && req.method === 'POST') {
        const body = await req.json();
        const { id, name, baseUrl, apiKey, isDefault } = body;
        if (id && state.apis.find(a => a.id === id)) {
          // Update existing
          state.apis = state.apis.map(a =>
            a.id === id ? { ...a, name, baseUrl, apiKey: apiKey || a.apiKey, isDefault: isDefault || false } : a
          );
        } else {
          const newApi: ApiConfig = { id: genId(), name, baseUrl, apiKey, isDefault: isDefault || false };
          state.apis.push(newApi);
        }
        if (isDefault) {
          state.apis = state.apis.map(a => ({ ...a, isDefault: a.id === (id || state.apis[state.apis.length - 1].id) }));
          state.activeApiId = id || state.apis[state.apis.length - 1].id;
        }
        saveState(state);
        return new Response(JSON.stringify({ success: true, apis: state.apis }), { headers });
      }

      // DELETE /api/apis/:id - Delete API config
      if (path.startsWith('/api/apis/') && req.method === 'DELETE') {
        const id = path.split('/').pop()!;
        state.apis = state.apis.filter(a => a.id !== id);
        if (state.activeApiId === id) {
          state.activeApiId = state.apis[0]?.id || null;
        }
        saveState(state);
        return new Response(JSON.stringify({ success: true, apis: state.apis }), { headers });
      }

      // GET /api/apis - List APIs
      if (path === '/api/apis' && req.method === 'GET') {
        return new Response(JSON.stringify({
          apis: state.apis.map(a => ({ id: a.id, name: a.name, baseUrl: a.baseUrl, isDefault: a.isDefault })),
          active: state.activeApiId,
        }), { headers });
      }

      // POST /api/models - Add or update model config
      if (path === '/api/models' && req.method === 'POST') {
        const body = await req.json();
        const { id, name, provider, maxTokens, isDefault } = body;
        if (id && state.models.find(m => m.id === id)) {
          state.models = state.models.map(m =>
            m.id === id ? { ...m, name, provider, maxTokens: maxTokens || m.maxTokens, isDefault: isDefault || false } : m
          );
        } else {
          const newModel: ModelConfig = { id: genId(), name, provider: provider || 'anthropic', maxTokens: maxTokens || 8192, isDefault: isDefault || false };
          state.models.push(newModel);
        }
        if (isDefault) {
          state.models = state.models.map(m => ({ ...m, isDefault: m.id === (id || state.models[state.models.length - 1].id) }));
          state.activeModelId = id || state.models[state.models.length - 1].id;
        }
        saveState(state);
        return new Response(JSON.stringify({ success: true, models: state.models }), { headers });
      }

      // DELETE /api/models/:id - Delete model config
      if (path.startsWith('/api/models/') && req.method === 'DELETE') {
        const id = path.split('/').pop()!;
        state.models = state.models.filter(m => m.id !== id);
        if (state.activeModelId === id) {
          state.activeModelId = state.models[0]?.id || null;
        }
        saveState(state);
        return new Response(JSON.stringify({ success: true, models: state.models }), { headers });
      }

      // GET /api/models - List models
      if (path === '/api/models' && req.method === 'GET') {
        return new Response(JSON.stringify({
          models: state.models,
          active: state.activeModelId,
        }), { headers });
      }

      // GET /api/conversations - List conversations
      if (path === '/api/conversations' && req.method === 'GET') {
        return new Response(JSON.stringify({
          conversations: state.conversations.map(c => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt })),
          active: state.activeConversationId,
        }), { headers });
      }

      // GET /api/conversations/:id - Get a conversation
      if (path.startsWith('/api/conversations/') && req.method === 'GET') {
        const id = path.split('/').pop()!;
        const conv = state.conversations.find(c => c.id === id);
        if (!conv) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });
        return new Response(JSON.stringify(conv), { headers });
      }

      // DELETE /api/conversations/:id
      if (path.startsWith('/api/conversations/') && req.method === 'DELETE') {
        const id = path.split('/').pop()!;
        state.conversations = state.conversations.filter(c => c.id !== id);
        if (state.activeConversationId === id) state.activeConversationId = null;
        saveState(state);
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // POST /api/conversations/:id/activate
      if (path.startsWith('/api/conversations/') && path.endsWith('/activate') && req.method === 'POST') {
        const parts = path.split('/');
        const id = parts[parts.length - 2];
        state.activeConversationId = id;
        saveState(state);
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // POST /api/conversations/new
      if (path === '/api/conversations/new' && req.method === 'POST') {
        const conv: Conversation = { id: genId(), title: 'New Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
        state.conversations.push(conv);
        state.activeConversationId = conv.id;
        saveState(state);
        return new Response(JSON.stringify(conv), { headers });
      }

      // POST /api/settings/working-directory
      if (path === '/api/settings/working-directory' && req.method === 'POST') {
        const body = await req.json();
        const dir = resolve(body.path);
        if (existsSync(dir) && statSync(dir).isDirectory()) {
          state.workingDirectory = dir;
          saveState(state);
          return new Response(JSON.stringify({ success: true, workingDirectory: dir }), { headers });
        }
        return new Response(JSON.stringify({ error: 'Invalid directory' }), { status: 400, headers });
      }

      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });
    } catch (err: any) {
      console.error('Server error:', err);
      return new Response(JSON.stringify({ error: err.message || 'Internal error' }), { status: 500, headers });
    }
  },
});

console.log(`\n  CODE MASTER Web UI running at http://localhost:${PORT}\n`);
console.log(`  Working directory: ${state.workingDirectory}`);
console.log(`  Active API: ${state.activeApiId}`);
console.log(`  Active Model: ${state.activeModelId}`);
console.log(`  Press Ctrl+C to stop\n`);
