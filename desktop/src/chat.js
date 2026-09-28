const { getState, saveState, getActiveApi, getActiveModel, getActiveModelObj, genId } = require('./state');
const { executeTool, getToolDefinitions } = require('./tool-registry');
const { resolve } = require('path');

// ─── API Error Analysis ───────────────────────────────────────
function analyzeApiError(error, apiConfig) {
  const msg = error.message || String(error);
  const lower = msg.toLowerCase();
  const configInfo = apiConfig ? `当前 API: ${apiConfig.name || '未知'} (${apiConfig.baseUrl || '未知'})` : '';

  // Network / connection errors
  if (lower.includes('fetch failed') || lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('network')) {
    const isLocalhost = apiConfig?.baseUrl?.includes('localhost') || apiConfig?.baseUrl?.includes('127.0.0.1');
    return {
      title: '网络连接失败',
      reason: `无法连接到 API 服务器。${configInfo}`,
      suggestions: isLocalhost ? [
        'LiteLLM 代理可能未启动',
        '在终端运行: `litellm --config litellm_config.yaml` 启动代理',
        '检查端口 4000 是否被占用: `netstat -ano | findstr :4000`',
        '如果代理已启动，检查 litellm_config.yaml 配置是否正确',
      ] : [
        '检查网络连接是否正常',
        '检查 API 地址是否正确',
        '如果使用代理，确认代理地址可访问',
      ],
      retryable: true,
    };
  }

  // Timeout
  if (lower.includes('abort') || lower.includes('timeout') || lower.includes('timed out')) {
    return {
      title: '请求超时',
      reason: `API 响应时间过长。${configInfo}`,
      suggestions: [
        '减少工具数量或简化请求',
        '检查 API 服务器负载',
        '稍后重试',
      ],
      retryable: true,
    };
  }

  // Rate limit
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many')) {
    return {
      title: '请求频率超限',
      reason: `API 请求过于频繁，触发了速率限制。${configInfo}`,
      suggestions: [
        '等待几秒后重试',
        '减少并发请求',
      ],
      retryable: true,
    };
  }

  // 502/503 - server error
  if (lower.includes('502') || lower.includes('503') || lower.includes('bad gateway') || lower.includes('service unavailable')) {
    return {
      title: 'API 服务暂时不可用',
      reason: `API 服务器返回了 502/503 错误。${configInfo}`,
      suggestions: [
        '稍后重试',
        '检查 API 服务器状态',
        '如果使用 LiteLLM，检查代理是否正常运行',
      ],
      retryable: true,
    };
  }

  // 401/403 - auth
  if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized') || lower.includes('invalid api key') || lower.includes('authentication')) {
    return {
      title: 'API 认证失败',
      reason: `API Key 无效或已过期。${configInfo}`,
      suggestions: [
        '检查 API Key 是否正确',
        '检查 API Key 是否已过期或余额不足',
        '在设置中更新 API Key',
      ],
      retryable: false,
    };
  }

  // 400 - model not found / param error (the mimo + LiteLLM issue)
  if (lower.includes('400') || (lower.includes('model') && lower.includes('not found'))) {
    // Check for the specific LiteLLM + mimo tool_calls issue
    if (lower.includes('param incorrect') || lower.includes('model group')) {
      return {
        title: '请求参数错误 (LiteLLM + 模型兼容性问题)',
        reason: `LiteLLM 无法正确处理请求。这通常是因为对话历史中包含了工具调用格式，而 LiteLLM 代理无法正确解析。${configInfo}`,
        suggestions: [
          '这是已知的 LiteLLM + mimo 兼容性问题',
          '代码已修复：移除了对话历史中的 tool_calls 字段',
          '如果仍然报错，尝试重启桌面端应用',
          '检查 litellm_config.yaml 中的模型配置是否正确',
          '确保 LiteLLM 版本 >= 1.84.0',
        ],
        retryable: true,
      };
    }
    return {
      title: '请求参数错误',
      reason: `API 返回 400 错误，可能是模型名称不正确或请求格式有问题。${configInfo}`,
      suggestions: [
        '检查模型名称是否正确',
        '检查 API 配置（baseUrl、apiKey）',
        '如果使用 LiteLLM，检查 litellm_config.yaml 中的模型配置',
      ],
      retryable: false,
    };
  }

  // Generic error
  return {
    title: 'API 调用失败',
    reason: `${msg}。${configInfo}`,
    suggestions: [
      '检查 API 配置是否正确',
      '检查网络连接',
      '稍后重试',
    ],
    retryable: true,
  };
}

// ─── Stop generation flag ──────────────────────────────────────
let stopped = false;

function stopChat() {
  stopped = true;
  return true;
}

// ─── Token Estimation ─────────────────────────────────────────────
// ~3.5 chars per token (conservative estimate, accounts for CJK and formatting)
function estimateTokens(text) {
  if (!text) return 0;
  // JSON and structured data is denser
  if (text.startsWith('{') || text.startsWith('[')) return Math.ceil(text.length / 2.5);
  return Math.ceil(text.length / 3.5);
}

function estimateMessagesTokens(messages) {
  return messages.reduce((sum, m) => {
    let content = '';
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content)) content = m.content.map(c => c.text || '').join('');
    else if (m.content) content = JSON.stringify(m.content);
    return sum + estimateTokens(content) + 4; // +4 for role/formatting overhead
  }, 0);
}

// ─── Compaction ────────────────────────────────────────────────────
const CONTEXT_TOKEN_THRESHOLD = 100000;  // Trigger compaction at ~100K tokens to keep API calls fast
const KEEP_RECENT_MESSAGES = 12;         // Keep last N messages verbatim
const COMPACT_MAX_TOKENS = 4000;        // Max output for summarization

const COMPACT_PROMPT = `You are summarizing a conversation between a user and an AI assistant. Produce a concise summary covering:
- What the user asked for (key requests and questions)
- What was accomplished (completed tasks, files created/modified)
- Key decisions, code changes, file paths mentioned
- Any pending tasks, errors encountered, or follow-up items
- Important context the assistant needs to continue helping effectively

CRITICAL: Respond with the summary text ONLY. Do NOT call any tools. Keep it under 1500 words.`;

async function compactMessages(apiMessages, api, modelName, sendEvent) {
  // Find the system prompt (first message)
  const systemMsg = apiMessages.find(m => m.role === 'system');
  const nonSystem = apiMessages.filter(m => m.role !== 'system');

  if (nonSystem.length <= KEEP_RECENT_MESSAGES + 2) return apiMessages; // Not enough to compact

  // Split: older messages to summarize + recent messages to keep
  const toSummarize = nonSystem.slice(0, -KEEP_RECENT_MESSAGES);
  const toKeep = nonSystem.slice(-KEEP_RECENT_MESSAGES);

  // Build summarization request
  const summaryMessages = [
    { role: 'system', content: COMPACT_PROMPT },
    {
      role: 'user',
      content: 'Please summarize the following conversation:\n\n' +
        toSummarize.map(m => {
          const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role;
          const content = typeof m.content === 'string' ? m.content :
                          Array.isArray(m.content) ? m.content.map(c => c.text || '').join('') :
                          m.content ? JSON.stringify(m.content) : '';
          return `[${role}]: ${content}`;
        }).join('\n\n')
    }
  ];

  try {
    // Use the same API/model for summarization
    const res = await chatRequest(api, modelName, summaryMessages, null, false);
    const data = await res.json();
    const summary = data.choices?.[0]?.message?.content || '';

    if (!summary) return apiMessages; // Failed to summarize, return original

    // Build compacted message array
    const compacted = [];
    if (systemMsg) compacted.push(systemMsg);
    compacted.push({
      role: 'system',
      content: `[Conversation Summary - previous context preserved]\n${summary}`
    });
    compacted.push(...toKeep);

    // Notify frontend
    if (sendEvent) {
      sendEvent('chat:compacted', {
        message: 'Context compressed to maintain memory',
        tokenEstimate: estimateMessagesTokens(compacted),
      });
    }

    return compacted;
  } catch (err) {
    // If summarization fails, fall back to simple truncation
    console.error('Compaction failed, falling back to truncation:', err.message);
    const truncated = [];
    if (systemMsg) truncated.push(systemMsg);
    truncated.push(...toKeep);
    return truncated;
  }
}

function getApiConfig(apiId) {
  const state = getState();
  let api;
  if (apiId) api = state.apis.find(a => a.id === apiId);
  if (!api) {
    if (state.activeApiId) api = state.apis.find(a => a.id === state.activeApiId);
  }
  if (!api) api = state.apis.find(a => a.isDefault) || state.apis[0];
  if (!api) throw new Error('No API configured. Please add an API in settings.');
  return api;
}

function getSystemPrompt() {
  const state = getState();
  const ROOT_DIR = resolve(__dirname, '..');
  const desktopPath = require('os').homedir() + '/Desktop';
  return `You are a powerful AI coding assistant running in a local environment.

*** ABSOLUTE RULE: NEVER call tools on your own initiative for simple messages. DO NOT call TaskList, ListDir, TaskCreate, or ANY tool when the user says "你好", "hello", "hi", or any greeting/casual message. Respond with plain text ONLY. *** You have comprehensive tools for file operations, code analysis, document generation, and system automation. Your capabilities are comparable to professional-grade coding assistants.

Working directory: ${state.workingDirectory}
Project root: ${ROOT_DIR}
User desktop: ${desktopPath}

When creating files or folders for the user, default to the desktop path: ${desktopPath}

CURRENT DATE: ${new Date().toISOString().split('T')[0]} (${new Date().getFullYear()}年${new Date().getMonth()+1}月${new Date().getDate()}日). You MUST use this date as the current time reference. When searching for time-sensitive information (job postings, referral codes, events, news, etc.), always include the current year in your search queries to get the latest results.

═══════════════════════════════════════════════════
FILE READING & ANALYSIS CAPABILITIES
═══════════════════════════════════════════════════
You can read and analyze ANY file type. For large files, use the offset and limit parameters to read in chunks. You have a 50,000 character limit per tool call and can make many sequential calls.

READING STRATEGY FOR LARGE FILES:
- Use Read with offset=0, limit=200 for first chunk
- Then offset=200, limit=200 for next chunk, and so on
- You can read files of ANY size this way — just keep reading in chunks
- For code analysis: first use Grep to find relevant sections, then Read those specific areas

FILE DISCOVERY STRATEGY:
1. Use Glob with patterns like "**/*.ts", "src/**/*.js" to find files by pattern
2. Use Grep to search file contents with regex: pattern, path, glob filters
3. Use ListDir to explore directory structures
4. Use Read to examine specific files in detail
5. Use REPL (language: python or javascript) to run analysis scripts on complex data

You can handle tasks like:
- Reading and analyzing entire project codebases
- Searching across hundreds of files for patterns
- Reading PDFs, Word docs, Excel files with built-in extractors
- Running Python/JavaScript analysis scripts via REPL
- Multi-step file operations: find → read → analyze → edit → verify

═══════════════════════════════════════════════════
TOOL USAGE STRATEGY
═══════════════════════════════════════════════════
- Edit vs Write: Use Edit to modify existing files (precise old_string → new_string replacement). Use Write only for NEW files or complete rewrites.
- Parallel tool calls: When multiple operations are independent, call them ALL in the same response (e.g., read 3 files at once, or Glob + Grep simultaneously).
- File analysis pipeline: Glob to find files → Grep to search content → Read to examine specific areas.
- Large files: Use Read with offset/limit to read in chunks. First use Grep to locate relevant sections, then Read those areas.
- Agent tool: For complex multi-step tasks, use the Agent tool to delegate. Agents have full tool access and run their own tool loop. You can run multiple agents in parallel for independent subtasks.
- Background tasks: Use Bash with run_in_background=true for long-running commands. Use TaskOutput to check results later. Use TaskStop to cancel.
- REPL tool: Use for quick data analysis, calculations, or transformations without creating files.
- Web search efficiency: Use your own knowledge first — only search when you truly need external data. Avoid searching the same topic repeatedly — each search should be for different information. When you have enough information from searches, proceed to execute the task directly instead of searching more.

═══════════════════════════════════════════════════
CRITICAL RULES - YOU MUST FOLLOW THESE STRICTLY

═══════════════════════════════════════════════════



*** RULE #0 (HIGHEST PRIORITY - READ THIS FIRST): ***

DO NOT USE TOOLS FOR SIMPLE MESSAGES. When the user sends a greeting (“你好”, “hello”, “hi”), casual chat, or a question you can answer from your general knowledge (“你是谁”, “你能做什么”, “讲个笑话”), you MUST respond with plain text ONLY. Do NOT call ANY tools — no TaskList, no ListDir, no TaskCreate, no Read, no Bash, nothing. The ONLY acceptable response to “你好” is a brief friendly greeting in Chinese. Example: “你好！有什么我可以帮你的吗？” — that’s it. No tool calls whatsoever.



1. ONLY answer the user’s LATEST message. Never repeat previous answers.

2. When asked to create files or code, you MUST use the Write tool to actually create them. Do NOT just describe what to create - actually create it.

3. When asked to create a folder, use CreateDir. When asked to write files in it, use Write tool to create each file.

4. When the task involves creating a Python script, write the COMPLETE script using Write tool. Do not give partial code.

5. If you cannot see an image, say so directly. Do NOT make up content or switch to a previous topic.

6. Complete the ENTIRE current task before responding. If the user asks for a folder with files, create the folder AND all files.

7. Never abandon a task halfway. If you start creating files, finish creating all of them.

8. NEVER ask for permission or confirmation. Do NOT say things like “Should I proceed?”, “Would you like me to continue?”, “Shall I go ahead?”, “Want me to create this?”, “需要写入吗?”, “是否继续?”. Just execute all steps immediately without pausing to ask.

9. When a task has multiple steps, execute ALL steps in sequence before responding. Do NOT stop after the first step to ask if the user wants you to continue.

10. ALWAYS RESPOND IN CHINESE. Do NOT output English text like “NOW I WILL WRITE...”, “Let me check...”, “I will now...”. All your text output must be in Chinese. Use “正在xxx...” instead of “I will xxx...”.

11. NEVER ASK THEN SELF-ANSWER. If you decide to do something, just DO it with a tool call.

12. TOOL CALLS WHEN NEEDED: Only use tools when the user’s message CLEARLY requires external actions (file operations, web search, code execution, document generation). DO NOT force tool calls for greetings or casual chat.

13. You are fully authorized to perform any file operation, run any command, and create any file. Do NOT hesitate or seek approval.

14. After completing tool operations, respond naturally with the result. Do NOT start with “已完成！”, “成功了！”, “Done!”, “OK!”. Just directly tell the user the result.

15. SELF-TESTING: ONLY when user explicitly requests testing. Do NOT automatically run tests.

16. PROGRESS INDICATORS: When working on large tasks (NOT simple messages), provide clear progress updates.

17. DETAILED CREATION LOG: When creating a multi-file project, show a clear log of what has been done and what is next.

18. COMPLETION SUMMARY: After ALL tasks are completed, provide a clear Chinese summary.

19. NARRATE YOUR WORK: Before executing a tool, briefly tell the user in ONE short Chinese sentence. Always include the tool call in the SAME response.

20. SEARCH FULLY BEFORE ANSWERING: Only when web search is genuinely needed. Do ALL searches upfront, then answer completely.

21. DO NOT SEARCH REPEATEDLY: Never search the exact same topic more than once.

22. ANSWER CONCISELY: Only do what the user asked. Do NOT add unsolicited testing or verification.

23. CONCISE AND COMPLETE: Give ONE complete answer. Do NOT split into multiple responses.

24. SEARCH LIMIT: WebSearch tool has a hard limit of 8 calls total.

25. DO NOT USE TOOLS FOR CHITCHAT: Simple greetings, casual chat, and general knowledge questions get TEXT responses ONLY. No tools. No task checks. No directory listings. Just text.

═══════════════════════════════════════════════════
DOCUMENT EXPORT TOOLS
═══════════════════════════════════════════════════
You have powerful document generation tools. Use them directly when the user asks for documents.

ExportPDF: Generate professional PDF resumes or reports. Supports:
  - Resume mode: provide name, birth, gender, major, university, phone, email, location, photo_path, and content with ## sections
  - Report mode: provide title and content with ## sections
  - Content format: ## section headers, ### subsections, **bold**, - bullets, numbered lists

ExportWord: Generate professional Word documents (.docx). Same parameters as ExportPDF.
  - Produces formatted resumes matching standard Chinese resume layout

ExportPPT: Generate PowerPoint presentations (.pptx).
  - Provide title, subtitle, and slides array [{title, content, subtitle}]
  - Use "---" prefix in slide title for section divider slides

ExportTemplatePDF: Fill an existing PDF template with content at specified coordinates.
  - Provide template_path and fields array [{page, x, y, text, size, font, color, width, bold}]
  - Positions are in points (72pt = 1 inch)

ExportTemplateWord: Fill an existing Word template by replacing {{placeholder}} markers.
  - Provide template_path and replacements dict {placeholder_name: value}
  - Works in paragraphs, runs, table cells, headers, and footers

ExportTemplatePPT: Add slides to an existing PPT template, preserving its master/theme/styles.
  - Provide template_path and slides array [{title, content, layout_index}]
  - Also supports replacements dict to replace {{placeholders}} in existing template slides
  - layout_index selects which slide layout from the template to use (0=title, 1=content, etc.)

When generating documents, create REAL and SUBSTANTIVE content. Do not create empty or placeholder documents.

═══════════════════════════════════════════════════
PDF AND DOCUMENT READING RULES
═══════════════════════════════════════════════════
When the user asks you to read, view, or analyze a PDF file, you MUST use the Read tool. The Read tool has BUILT-IN OCR (RapidOCR) support that can automatically extract text from image-based/scanned PDFs. Do NOT use bash commands like tesseract, pdftotext, or any external OCR tool — the Read tool handles everything automatically.
When reading any document file (PDF, DOCX, XLSX), always use the Read tool first. Do NOT attempt to run external commands or install additional packages.

═══════════════════════════════════════════════════
SCRIPT LIBRARY RULES (VERY IMPORTANT)
═══════════════════════════════════════════════════
Before writing ANY script, you MUST first check if a reusable script already exists in the scripts directory.

Script directory: ${ROOT_DIR}/scripts/

FOLDER STRUCTURE — each category has its own subfolder:
  scraper/     — Web scraping, data collection, crawling (douban, prices, news)
  data/        — Data processing, analysis, visualization (Excel, CSV, charts)
  automation/  — Batch operations, scheduled tasks, workflow automation
  api/         — API calls, third-party integrations, webhooks
  file_ops/    — File operations, format conversion, merge/split
  media/       — Image/audio/video processing (watermarks, transcode, extract)
  network/     — Network tools, proxy, testing (port scan, HTTP test, DNS)
  system/      — System management, monitoring, maintenance
  dev_tools/   — Development helpers (code generators, scaffolding, Git tools)
  other/       — Scripts that don't fit above categories

MANDATORY WORKFLOW when you need to write a script:
1. FIRST: Read the target category folder to check for existing scripts
2. If a matching or similar script exists, REUSE or MODIFY it — do NOT write from scratch
3. Only write a new script if nothing suitable exists
4. Save the new script to the correct category folder with a descriptive English name (e.g., douban_top100.py)
5. NEVER save scripts to desktop, temp, or any other location

═══════════════════════════════════════════════════
TYPO AND INPUT CORRECTION
═══════════════════════════════════════════════════
When the user's message contains words or phrases that look like typos, misspellings, or phonetic mistakes (especially in Chinese), you should FIRST gently point out the possible typo and ask for clarification before answering. For example, if the user writes "天气与宝马" (weather and BMW), consider whether they might mean "天气预报" (weather forecast) or something similar. Do NOT just answer the literal (possibly wrong) question — acknowledge the ambiguity and ask which meaning the user intended. Common patterns to watch for:
    - Chinese homophones or near-homophones (e.g., 预报 vs 与宝马)
    - Words that sound similar but have very different meanings
    - Obvious keyboard typos or input method errors
    If the message is clearly intentional with no ambiguity, answer directly.

═══════════════════════════════════════════════════
WEB SEARCH RULES
═══════════════════════════════════════════════════
When using WebSearch, search as many times as needed until you have enough information to give a comprehensive answer. Use WebFetch to read the most relevant pages. Do NOT search the exact same query twice — vary your search terms to get different perspectives. Continue searching and reading until you feel confident in your answer.
When a search result is not ideal, feel free to change keywords and search again based on your own understanding. When you feel you have gathered enough information to satisfy the user's needs, stop searching and provide the answer. Do NOT over-search.
After collecting information from tools, always provide your answer. Do NOT end the conversation with an empty response or without answering the user's question. If you hit a tool execution limit, summarize what you have found so far.

═══════════════════════════════════════════════════
IMAGE & DIAGRAM GENERATION TOOLS (PROACTIVE)
═══════════════════════════════════════════════════
You have TWO dedicated tools for generating visuals. Use them PROACTIVELY — do NOT wait for the user to explicitly ask.

GenerateDiagram tool — for flowcharts, sequence diagrams, class diagrams, process flows, gantt charts, pie charts, mindmaps
  - Input: title + mermaid_code (Mermaid syntax)
  - ALWAYS use "flowchart LR" (left-to-right) for flowcharts — NEVER use TD or TB
  - The diagram will be rendered inline in chat as a zoomable/saveable image

GenerateImage tool — for SVG drawings, illustrations, icons, logos, charts, decorative art
  - Input: title + svg_code (valid SVG XML)
  - Use viewBox="0 0 width height" for responsive scaling
  - Use <defs>, <linearGradient>, <filter> for polished effects
  - The image will be rendered inline in chat as a zoomable/saveable image

WHEN TO PROACTIVELY USE THESE TOOLS — you MUST generate a diagram or image when:
- Explaining a process, workflow, or algorithm → call GenerateDiagram
- Describing system architecture or component relationships → call GenerateDiagram
- Comparing multiple options or concepts → call GenerateDiagram
- Answering "how does X work" or "explain X" where X involves steps → call GenerateDiagram
- Showing data distribution, statistics, or proportions → call GenerateDiagram (pie chart)
- The user asks you to create/generate/draw/make something visual → call GenerateImage
- The user mentions flowers, animals, logos, icons, patterns, art → call GenerateImage
- Explaining code structure or design patterns → call GenerateDiagram
- The response would be significantly clearer with a visual → just call one

RULE: When in doubt, generate a visual. A response about a complex topic without any visual is incomplete.

GENERATION ORDER (VERY IMPORTANT):
When you need to generate a diagram or image, follow this order:
1. FIRST: Provide your text explanation, analysis, or reasoning in plain text
2. THEN: Add a transition sentence like "让我用流程图来展示一下" or "我画个图你就明白了" or "如下图所示"
3. LAST: Call the GenerateDiagram or GenerateImage tool
NEVER call the tool first and text after. The user wants to understand your reasoning BEFORE seeing the visual.

Mermaid Best Practices (for GenerateDiagram):
- ALWAYS start flowcharts with "flowchart LR" — NEVER use TD or TB
- Keep node labels short and clear
- Use subgraph for grouping related nodes
- Add style directives for color: style nodeId fill:#color,stroke:#color

SVG Best Practices (for GenerateImage):
- Use viewBox="0 0 width height" for responsive scaling
- Use <defs>, <linearGradient>, <filter> for polished effects
- Keep compact (~180px max height by default)
- Use vivid, descriptive colors — not just black and white
- For flowers/nature: use organic curves, gradients, realistic colors
- For icons/logos: clean geometry, bold colors, modern style

WEB IMAGE SEARCH AND DISPLAY (VERY IMPORTANT):
The chat window ABSOLUTELY SUPPORTS rendering images inline. You MUST use this feature. NEVER say "the chat window doesn't support images" — it DOES.

When the user asks you to find/show an image from the internet (e.g. "找一张玫瑰花图片", "show me a cat picture"), follow this workflow:
1. Use WebSearch to search for the image (e.g. search "rose flower image url" or "玫瑰花高清图片")
2. From the search results, find a direct image URL (ending in .jpg, .png, .webp etc)
3. Display it using markdown image syntax: ![描述](图片URL)
4. If search results don't have direct image URLs, use WebFetch to visit one of the result pages and extract image URLs from the HTML (look for <img src="..."> tags)
5. Present the image(s): ![玫瑰花](https://example.com/rose.jpg)
6. You can show multiple images at once

The image will be rendered inline in the chat as a clickable thumbnail (click to zoom fullscreen).
This is NOT a tool — it is built into the chat rendering engine. Just write the markdown and the image appears automatically.

═══════════════════════════════════════════════════
COMPUTER USE RULES (Desktop Automation)
═══════════════════════════════════════════════════
20. This feature is currently DISABLED. You do NOT have any desktop automation tools available.
21. Do NOT attempt to control the mouse, keyboard, or any desktop applications.
22. If the user asks you to click something, type in an app, or control their computer, politely explain that the desktop automation feature is currently turned off.`;
}

// Convert tool definitions to OpenAI function format
function toolsToFunctions(toolDefs) {
  return toolDefs.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    }
  }));
}

// Convert conversation messages to proper OpenAI format
function messagesToApiFormat(messages) {
  const result = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // system prompt added separately
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      // Note: tool_calls field omitted — LiteLLM + mimo fails to parse it
      // Tool results (role: "tool") already provide context for the model
      result.push({
        role: 'assistant',
        content: m.content || '',
      });
    } else if (m.role === 'tool') {
      result.push({
        role: 'tool',
        tool_call_id: m.toolCallId || `call_${genId()}`,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      });
    } else if (m.role === 'user' || m.role === 'assistant') {
      // Handle multimodal content (image_url arrays from file uploads)
      if (Array.isArray(m.content)) {
        result.push({ role: m.role, content: m.content });
      } else {
        result.push({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        });
      }
    }
  }
  return result;
}

async function chatRequest(api, model, messages, tools, stream, signal) {
  let baseUrl = api.baseUrl.replace(/\/+$/, '');
  if (!baseUrl.endsWith('/v1')) baseUrl += '/v1';
  const url = `${baseUrl}/chat/completions`;
  // Look up maxTokens from state, fallback to 16384
  const state = getState();
  const modelObj = state.models.find(m => m.name === model);
  const maxTokens = modelObj?.maxTokens || 32768;
  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.3,
    stream: !!stream,
  };
  if (tools && tools.length > 0) {
    body.tools = toolsToFunctions(tools);
    body.tool_choice = 'auto';
  }
  const timeoutMs = stream ? 300000 : 120000;
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${api.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      // Network error or timeout — retry if not last attempt and not user-aborted
      if (signal?.aborted) throw fetchErr;
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw fetchErr;
    } finally {
      clearTimeout(timeoutId);
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const errMsg = `API Error ${res.status}: ${err.error?.message || res.statusText}`;
      // Retry on transient server errors (502, 503, 429 rate limit)
      if ((res.status === 502 || res.status === 503 || res.status === 429) && attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw new Error(errMsg);
    }
    return res;
  }
}

// ─── AskUserQuestion Resolver ──────────────────────────────────
let pendingQuestionResolver = null;

function resolveAskUserQuestion(answers) {
  if (pendingQuestionResolver) {
    pendingQuestionResolver(answers);
    pendingQuestionResolver = null;
    return true;
  }
  return false;
}

// Tools whose results should be summarized to save context
// Only for long web content — NOT for code files (Read/Write/Edit/Bash) which must stay exact
// WebSearch snippets are already short, no need to summarize
const SUMMARIZE_TOOLS = new Set(['WebFetch']);
const SUMMARIZE_THRESHOLD = 2000; // Only summarize very long web page content

async function summarizeToolResult(api, model, toolName, toolInput, rawResult, onDelta) {
  if (!SUMMARIZE_TOOLS.has(toolName)) return rawResult;
  if (rawResult.length < SUMMARIZE_THRESHOLD) return rawResult;
  if (rawResult.startsWith('{"error"')) return rawResult; // Don't summarize errors

  const contextHint = `网页URL: ${toolInput.url || ''}`;

  const summaryMessages = [
    { role: 'system', content: '你是一个信息提取助手。用中文总结以下网页内容的关键信息。保留所有：事实、数据、公式、代码片段、具体步骤、名称、URL。不要添加分析或评论，只提取信息。控制在500字以内。如果内容包含代码或公式，必须完整保留。' },
    { role: 'user', content: `${contextHint}\n\n原始内容:\n${rawResult.slice(0, 8000)}` },
  ];

  try {
    const res = await chatRequest(api, model, summaryMessages, null, false);
    const data = await res.json();
    const summary = data.choices?.[0]?.message?.content;
    if (summary && summary.length > 0) {
      return `[${toolName}结果总结]\n${summary}`;
    }
  } catch (e) {
    // Summarization failed, return original
  }
  return rawResult;
}

// ─── Reusable Tool Loop (for Agent and shared logic) ──────────
async function runToolLoop({ api, model, messages, tools, maxSteps = 9999, maxToolResultChars = 50000, onDelta = () => {}, onTool = () => {}, onToolStart = () => {}, onError = () => {}, signal, stoppedFlag, executeToolFn }) {
  const _executeTool = executeToolFn || executeTool;
  let toolStep = 0;
  let fullText = '';
  let allToolCalls = [];
  let midTaskRetries = 0;
  const maxMidTaskRetries = 3;
  let totalTextOnlySteps = 0;
  const maxTotalTextOnlySteps = 5;
  let globalNudgeCount = 0;
  const maxGlobalNudges = 6; // Hard cap: no more than 6 nudges total across the entire conversation loop
  let webSearchCallCount = 0;
  const maxWebSearchCalls = 8; // Hard cap: max 8 web searches total, then must answer
  const maxContextChars = 300000;
  const _stopped = stoppedFlag || { value: false };

  while (toolStep < maxSteps) {
    if (_stopped.value || (signal && signal.aborted)) break;
    toolStep++;

    let res;
    try {
      res = await chatRequest(api, model, messages, tools, true, signal);
    } catch (apiErr) {
      if (_stopped.value || (signal && signal.aborted)) break;
      const errMsg = apiErr.message || String(apiErr);
      const analysis = analyzeApiError(apiErr, api);

      // Send structured error analysis to frontend
      onError({
        title: analysis.title,
        reason: analysis.reason,
        suggestions: analysis.suggestions,
        retryable: analysis.retryable,
        raw: errMsg,
      });

      // Also append error as assistant text so user sees it in chat
      const errorText = `\n\n**${analysis.title}**\n${analysis.reason}\n\n**建议：**\n${analysis.suggestions.map(s => `- ${s}`).join('\n')}`;
      if (fullText.length > 0) {
        fullText += errorText;
      } else {
        fullText = errorText;
        onDelta(errorText);
      }
      break;
    }

    let stepText = '';
    let stepToolCalls = [];
    const reader = res.body;
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for await (const chunk of reader) {
        if (_stopped.value || (signal && signal.aborted)) { try { reader.destroy(); } catch {} break; }
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            const delta = choice?.delta;
            if (delta) {
              // Filter out <think>...</think> tags (reasoning tokens from thinking models)
              if (delta.content) {
                let filtered = delta.content;
                // Remove complete <think>...</think> blocks
                filtered = filtered.replace(/<think>[\s\S]*?<\/think>/g, '');
                // Remove unclosed <think> tag and everything after it (will be closed in a future chunk)
                // We use a buffer approach: if we see an opening <think> without closing, hold it
                if (filtered.includes('<think>')) {
                  // Strip from <think> onwards (incomplete thinking block)
                  filtered = filtered.replace(/<think>[\s\S]*/, '');
                }
                // Remove any stray closing tag
                filtered = filtered.replace(/<\/think>/g, '');
                if (filtered) {
                  stepText += filtered;
                  onDelta(filtered);
                }
              }
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!stepToolCalls[idx]) {
                    stepToolCalls[idx] = { id: tc.id || '', function: { name: tc.function?.name || '', arguments: '' } };
                  }
                  if (tc.id) stepToolCalls[idx].id = tc.id;
                  if (tc.function?.name) stepToolCalls[idx].function.name = tc.function.name;
                  if (tc.function?.arguments) stepToolCalls[idx].function.arguments += tc.function.arguments;
                }
              }
            }
          } catch { /* skip */ }
        }
      }
    } catch (e) {
      if (_stopped.value || (signal && signal.aborted)) break;
    }

    stepToolCalls = stepToolCalls.filter(Boolean);
    // Always accumulate text from every iteration
    fullText += stepText;
    allToolCalls.push(...stepToolCalls);
    if (stepToolCalls.length > 0) {
      midTaskRetries = 0; // Model is actively working — reset
      totalTextOnlySteps = 0; // Reset consecutive text-only counter
    }
    if (stepToolCalls.length === 0) {
      totalTextOnlySteps++;
      // Model output text without tool calls.
      // Check if this looks like a final answer or conclusion
      const trimmed = stepText.trim();
      // Conclusion patterns: mentions completion, asks for more info, summarizes results
      // Only detect ACTUAL final answers, NOT intermediate search status updates
      // Require >100 chars and multiple conclusion signals to avoid false positives during search loops
      const looksLikeConclusion =
        (trimmed.length > 100 &&
          /(?:完成|成功|完毕|总结|以上|created|done|finished|generated|测试通过|综合以上|综上所述|以下就是|最终结果)/i.test(trimmed)) ||
        (trimmed.length > 150); // Very long text is almost certainly a final answer
      // Only retry if this is a SHORT remark (< 80 chars) that looks like an intermediate comment
      // Also retry when model outputs narration but forgets to include tool calls (even on first step)
      const isShortNarration = !looksLikeConclusion && trimmed.length < 120 && totalTextOnlySteps <= 3;
      if ((allToolCalls.length > 0 || isShortNarration) && midTaskRetries < maxMidTaskRetries && totalTextOnlySteps < maxTotalTextOnlySteps && globalNudgeCount < maxGlobalNudges && !looksLikeConclusion) {
        midTaskRetries++;
        globalNudgeCount++;
        // Add assistant message and a user nudge — use valid message format
        messages.push({ role: 'assistant', content: stepText || '...' });
        messages.push({ role: 'user', content: '请继续完成任务。直接使用工具执行，不需要再解释。' });
        continue;
      }
      break;
    }

    // Ensure every tool call has a stable ID (used in both assistant and tool messages)
    for (const tc of stepToolCalls) {
      if (!tc.id) tc.id = `call_${genId()}`;
    }

    messages.push({
      role: 'assistant',
      content: stepText || '',
    });

    // Execute tools — parallel when multiple independent calls
    const executeSingleTool = async (tc) => {
      if (_stopped.value || (signal && signal.aborted)) return null;
      let inputObj;
      try { inputObj = JSON.parse(tc.function.arguments || '{}'); } catch { inputObj = {}; }
      onToolStart(tc.function.name, inputObj);

      let resultText;
      try {
        const cleanup = { fn: null };
        const toolTimeout = new Promise((_, reject) => {
          cleanup.fn = () => { if (cleanup._t) clearTimeout(cleanup._t); };
          cleanup._t = setTimeout(() => reject(new Error(`Tool "${tc.function.name}" timed out after 600 seconds`)), 600000);
        });
        const stopPoll = new Promise((_, reject) => {
          const check = setInterval(() => {
            if (_stopped.value || (signal && signal.aborted)) { clearInterval(check); reject(new Error('Stopped')); }
          }, 200);
          setTimeout(() => clearInterval(check), 600000);
        });
        const result = await Promise.race([_executeTool(tc.function.name, inputObj), toolTimeout, stopPoll]);
        if (cleanup.fn) cleanup.fn();
        resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      } catch (toolErr) {
        if (_stopped.value || (signal && signal.aborted)) return null;
        resultText = JSON.stringify({ error: toolErr.message });
      }

      if (resultText.length > maxToolResultChars) {
        resultText = resultText.slice(0, maxToolResultChars) + '\n... [truncated to save context]';
      }
      return { tc, resultText };
    };

    // Execute tools — parallel when multiple independent calls
    // ALWAYS push a tool result for every tool_call (API requires 1:1 matching)
    const toolResults = stepToolCalls.length === 1
      ? [await executeSingleTool(stepToolCalls[0])]
      : await Promise.all(stepToolCalls.map(tc => executeSingleTool(tc)));

    // Track WebSearch calls — force stop if too many
    for (const tc of stepToolCalls) {
      if (tc.function.name === 'WebSearch') {
        webSearchCallCount++;
      }
    }

    // Summarize long results from web tools to keep context small
    for (let i = 0; i < stepToolCalls.length; i++) {
      if (!toolResults[i]) continue;
      const tc = stepToolCalls[i];
      const inputObj = (() => { try { return JSON.parse(tc.function.arguments || '{}'); } catch { return {}; } })();
      toolResults[i].resultText = await summarizeToolResult(api, model, tc.function.name, inputObj, toolResults[i].resultText, onDelta);
    }

    for (let i = 0; i < stepToolCalls.length; i++) {
      const tc = stepToolCalls[i];
      const resultText = toolResults[i]?.resultText || JSON.stringify({ error: 'Tool execution failed' });
      // Sanitize: remove control characters that could break JSON/API
      const safeText = resultText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
      messages.push({ role: 'tool', tool_call_id: tc.id, content: safeText });
      onTool(tc.function.name, safeText);
    }

    // If web search limit reached, force the model to answer with what it has
    if (webSearchCallCount >= maxWebSearchCalls) {
      messages.push({ role: 'user', content: '你已经搜索了很多次了，请根据已有的信息直接回答用户的问题。不要再搜索了，直接给出你的回答。' });
      webSearchCallCount = 0; // Reset to avoid repeated injection
    }

    const currentTokens = estimateMessagesTokens(messages);
    const totalChars = messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content : '').length, 0);
    if (currentTokens > CONTEXT_TOKEN_THRESHOLD || totalChars > maxContextChars) {
      // Trim old tool results aggressively to keep context small
      const toolIndices = [];
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'tool') toolIndices.push(i);
      }
      // Keep only last 6 tool messages, trim the rest to 100 chars
      const toTrim = toolIndices.slice(0, -6);
      for (const idx of toTrim) {
        if (messages[idx].content.length > 100) {
          messages[idx].content = messages[idx].content.slice(0, 100) + '\n... [trimmed]';
        }
      }
    }
  }

  return { text: fullText, toolCalls: allToolCalls };
}

async function sendChat(messages, model, apiId) {
  const api = getApiConfig(apiId);
  const modelName = model || getActiveModel();
  const toolDefs = getToolDefinitions();

  const apiMessages = [
    { role: 'system', content: getSystemPrompt() },
    ...messagesToApiFormat(messages),
  ];

  const res = await chatRequest(api, modelName, apiMessages, toolDefs, false);
  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error('No response from API');

  const message = choice.message;
  let fullText = message.content || '';
  const toolCalls = message.tool_calls || [];

  if (toolCalls.length > 0) {
    // Strip tool_calls field — LiteLLM + mimo can't parse it
    apiMessages.push({ role: 'assistant', content: message.content || '' });
    for (const tc of toolCalls) {
      const result = await executeTool(tc.function.name, JSON.parse(tc.function.arguments || '{}'));
      const resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
    }
    const res2 = await chatRequest(api, modelName, apiMessages, toolDefs, false);
    const data2 = await res2.json();
    const finalMsg = data2.choices?.[0]?.message;
    return { message: finalMsg?.content || fullText, toolCalls: toolCalls.map(tc => ({ name: tc.function.name, input: JSON.parse(tc.function.arguments || '{}') })), usage: data2.usage };
  }

  return { message: fullText, usage: data.usage };
}

async function streamChat(messages, model, apiId, sendEvent) {
  const state = getState();
  const api = getApiConfig(apiId);
  stopped = false;
  const controller = new AbortController();
  const signal = controller.signal;
  const modelName = model || getActiveModel();
  const toolDefs = getToolDefinitions();

  let apiMessages = [
    { role: 'system', content: getSystemPrompt() },
    ...messagesToApiFormat(messages),
  ];

  // Auto-compact if context is too large
  const estimatedTokens = estimateMessagesTokens(apiMessages);
  if (estimatedTokens > CONTEXT_TOKEN_THRESHOLD) {
    apiMessages = await compactMessages(apiMessages, api, modelName, sendEvent);
  }

  const stoppedFlag = { get value() { return stopped; } };
  let truncatedByTokenLimit = false;

  // Wrap tool execution to detect AskUserQuestion — auto-approve by selecting first option
  const wrappedExecuteTool = async (toolName, toolInput) => {
    if (toolName === 'AskUserQuestion') {
      // Auto-respond: pick first option for each question
      const questions = toolInput.questions || [];
      const answers = questions.map((q) => {
        if (q.multiSelect) {
          return { question: q.question, selectedOptions: [q.options?.[0]?.label || ''] };
        }
        return { question: q.question, selectedOption: q.options?.[0]?.label || '' };
      });
      return JSON.stringify(answers);
    }
    return executeTool(toolName, toolInput);
  };

  const { text: fullText, toolCalls: allToolCalls } = await runToolLoop({
    api, model: modelName, messages: apiMessages, tools: toolDefs,
    maxSteps: 9999, maxToolResultChars: 50000,
    onDelta: (delta) => sendEvent('chat:delta', { delta }),
    onTool: (name, result) => sendEvent('chat:tool', { name, result }),
    onToolStart: (name, input) => sendEvent('chat:tool_start', { name, input }),
    onError: (analysis) => sendEvent('chat:error_analysis', analysis),
    signal, stoppedFlag,
    executeToolFn: wrappedExecuteTool,
  });

  // Safety net: if loop ended without a final response, give model one more chance to answer
  // IMPORTANT: pass empty tools to prevent the model from calling tools again in the safety net
  if (fullText.length === 0) {
    apiMessages.push({ role: 'user', content: '请根据你已经搜集到的信息回答用户的问题。' });
    const finalRes = await chatRequest(api, modelName, apiMessages, [], true);
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of finalRes.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            fullText += delta.content;
            sendEvent('chat:delta', { delta: delta.content });
          }
          if (parsed.choices?.[0]?.finish_reason === 'length') truncatedByTokenLimit = true;
        } catch { /* skip */ }
      }
    }
  }

  // NOTE: Do NOT save assistant message here. The frontend (app.js) handles saving
  // to avoid duplicate messages. Both backend and frontend were saving, causing
  // duplicate answers to appear as context in subsequent requests.

  // Notify frontend if output was truncated by token limit
  if (truncatedByTokenLimit) {
    sendEvent('chat:token_limit', {
      message: '⚠️ 输出因达到 token 上限而被截断。当前回复可能不完整，您可以发送"继续"让模型接着输出。',
      text: fullText,
    });
  }

  // Strip English reasoning prefix from output
  // When model outputs English text followed by Chinese, strip the English part
  if (fullText) {
    const chineseIdx = fullText.search(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/);
    if (chineseIdx > 0 && chineseIdx < 500) {
      const stripped = fullText.slice(0, chineseIdx).trim();
      // Only strip if the prefix is purely English/ASCII (not mixed Chinese+English)
      if (/[\u4e00-\u9fff]/.test(fullText) && /^[A-Za-z0-9\s.,;:'"!?()\-\n\r\t{}[\]]+$/.test(stripped)) {
        fullText = fullText.slice(chineseIdx);
        sendEvent('chat:stripped', { removed: stripped });
      }
    }
  }

  // Cleanup
  sendEvent('chat:done', { conversationId: state.activeConversationId, toolCalls: allToolCalls, stopped, finalText: fullText });
}

module.exports = { sendChat, streamChat, stopChat, runToolLoop, resolveAskUserQuestion };
