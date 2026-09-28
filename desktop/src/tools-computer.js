const { desktopCapturer, screen, BrowserWindow } = require('electron');
const { exec } = require('child_process');
const { promisify } = require('util');
const { writeFileSync, unlinkSync, readFileSync, existsSync } = require('fs');
const { resolve } = require('path');
const { toolRegistry } = require('./tool-registry');
const execAsync = promisify(exec);

// ─── AutoHotkey Path ────────────────────────────────────────────
const AHK_EXE = resolve(
  require('os').homedir(),
  'AppData', 'Local', 'Programs', 'AutoHotkey', 'v2', 'AutoHotkey64.exe'
);

// ─── DPI Scaling ─────────────────────────────────────────────────
function getScaleFactor() {
  return screen.getPrimaryDisplay().scaleFactor || 1.0;
}

function toPhysical(x, y) {
  const s = getScaleFactor();
  return { x: Math.round(x * s), y: Math.round(y * s) };
}

// ─── AutoHotkey Runner ──────────────────────────────────────────
async function runAHK(script) {
  const tmpFile = resolve(require('os').tmpdir(), `cc_ahk_${Date.now()}_${Math.random().toString(36).slice(2)}.ahk`);
  writeFileSync(tmpFile, script, 'utf-8');
  try {
    const { stdout, stderr } = await execAsync(
      `"${AHK_EXE}" "${tmpFile}"`,
      { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
    );
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

// ─── Vision Model ────────────────────────────────────────────────
function getVisionConfig() {
  const configPaths = [
    resolve(__dirname, '..', '..', 'litellm_config.yaml'),
    resolve(require('os').homedir(), 'litellm_config.yaml'),
  ];
  for (const p of configPaths) {
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf-8');
      for (const modelName of ['MIMO-V2.5', 'qwen-vl-plus', 'qwen3-vl-plus']) {
        const regex = new RegExp(`model_name:\\s*${modelName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?model:\\s*(\\S+)[\\s\\S]*?api_key:\\s*(\\S+)`);
        const match = content.match(regex);
        if (match) return { apiKey: match[2], modelName, litellmModel: match[1] };
      }
    }
  }
  return null;
}

async function callVisionModel(base64Image, prompt) {
  const config = getVisionConfig();
  if (!config?.apiKey) throw new Error('Vision model API key not found in litellm_config.yaml');

  // Try LiteLLM proxy first
  try {
    const body = JSON.stringify({
      model: config.modelName,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } },
        ],
      }],
      max_tokens: 4000,
    });
    const res = await fetch('http://localhost:4000/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer sk-any` },
      body,
    });
    if (res.ok) {
      const data = await res.json();
      const msg = data.choices?.[0]?.message;
      return msg?.content || msg?.reasoning_content || '';
    }
  } catch {}

  // Fallback: call provider directly
  let apiUrl;
  const litellmModel = config.litellmModel || '';
  if (litellmModel.startsWith('openai/')) {
    const configPaths = [
      resolve(__dirname, '..', '..', 'litellm_config.yaml'),
      resolve(require('os').homedir(), 'litellm_config.yaml'),
    ];
    for (const p of configPaths) {
      if (existsSync(p)) {
        const content = readFileSync(p, 'utf-8');
        const regex = new RegExp(`model_name:\\s*${config.modelName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?api_base:\\s*(\\S+)`);
        const match = content.match(regex);
        if (match) { apiUrl = match[1].replace(/\/+$/, '') + '/chat/completions'; break; }
      }
    }
  }
  if (!apiUrl) apiUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

  const body = JSON.stringify({
    model: litellmModel.replace(/^openai\//, ''),
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } },
      ],
    }],
    max_tokens: 4000,
  });

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
    body,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Vision API error ${res.status}: ${err}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  return msg?.content || msg?.reasoning_content || '';
}

// ─── Screen Capture ──────────────────────────────────────────────
async function captureScreen() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.size;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
  });
  if (!sources || sources.length === 0) throw new Error('No screen sources found');
  return { base64: sources[0].thumbnail.toPNG().toString('base64'), width, height };
}

// ─── Screen region hints for vision model ────────────────────────
function getScreenRegionHint(width, height) {
  const taskbarY = height - 40;
  return `SCREEN LAYOUT (${width}x${height}):
- Desktop icons: LEFT side of screen, vertically arranged (x: 0-200, y: 20-${taskbarY - 20}). Each icon = small image + text label below.
- Taskbar: BOTTOM strip (y: ${taskbarY}-${height}). Start button (far left), pinned apps, system tray (far right), clock.
- IMPORTANT: Desktop icons ≠ taskbar icons. "QQ desktop icon" is on the LEFT, not the bottom.`;
}

// ─── Vision + robust JSON parse ──────────────────────────────────
async function visionAnalyze(base64, prompt) {
  const raw = await callVisionModel(base64, prompt);
  let cleaned = raw;
  cleaned = cleaned.replace(/```(?:json)?\s*\n?/g, '').replace(/```\s*$/gm, '');
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (typeof parsed === 'object' && !Array.isArray(parsed)) return { raw, parsed };
    } catch {}
  }
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return { raw, parsed: JSON.parse(arrMatch[0]) }; } catch {}
  }
  return { raw, parsed: null };
}

// ═══════════════════════════════════════════════════════════════════
//  REGISTER TOOLS — AutoHotkey-based, atomic operations
// ═══════════════════════════════════════════════════════════════════
function registerComputerTools() {

  // ── 1. ScreenCapture ─────────────────────────────────────────
  toolRegistry.register('ScreenCapture',
    'Take a screenshot of the current screen. Returns base64 PNG.',
    { type: 'object', properties: {}, required: [] },
    async () => {
      try {
        const { base64, width, height } = await captureScreen();
        return {
          image: `data:image/png;base64,${base64}`,
          mimeType: 'image/png',
          resolution: `${width}x${height}`,
        };
      } catch (err) { return { error: `ScreenCapture failed: ${err.message}` }; }
    }
  );

  // ── 2. ScreenAnalyze ─────────────────────────────────────────
  toolRegistry.register('ScreenAnalyze',
    'Screenshot + AI vision. Identifies UI elements with pixel coordinates. Returns element list with x,y positions.',
    {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'What to look for (e.g., "Find the login button", "Identify all input fields")',
        },
      },
      required: [],
    },
    async (input) => {
      try {
        const { base64, width, height } = await captureScreen();
        const regionHint = getScreenRegionHint(width, height);
        const prompt = `Analyze this ${width}x${height} screenshot.

${regionHint}

${input.prompt || 'Identify all visible interactive UI elements.'}

For each element provide:
- name, type, x (CENTER pixel), y (CENTER pixel), width, height, text, description

RULES:
- Return ONLY a JSON array, no markdown
- x,y = pixel CENTER of each element on the ${width}x${height} screen
- Be precise — coordinates are used for direct mouse clicks`;

        const { raw, parsed } = await visionAnalyze(base64, prompt);
        return { elements: parsed || raw, resolution: `${width}x${height}`, screenshot: `data:image/png;base64,${base64}`, mimeType: 'image/png' };
      } catch (err) { return { error: `ScreenAnalyze failed: ${err.message}` }; }
    }
  );

  // ── 3. MinimizeAll ───────────────────────────────────────────
  toolRegistry.register('MinimizeAll',
    'Minimize all windows to show desktop. Use before automation to clear the screen.',
    { type: 'object', properties: {}, required: [] },
    async () => {
      try {
        BrowserWindow.getAllWindows().forEach(w => w.minimize());
        await runAHK(`
#Requires AutoHotkey v2.0
Send "{LWin down}d{LWin up}"
Sleep 200
`);
        return { success: true };
      } catch (err) { return { error: `MinimizeAll failed: ${err.message}` }; }
    }
  );

  // ── 4. MouseClick ────────────────────────────────────────────
  // AHK Click is atomic: move + down + up in one command, no focus loss
  toolRegistry.register('MouseClick',
    'Move mouse to (x,y) and click. Uses AutoHotkey Click — atomic move+click, no focus loss.',
    {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X pixel coordinate (logical)' },
        y: { type: 'number', description: 'Y pixel coordinate (logical)' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default: left)' },
        double: { type: 'boolean', description: 'Double-click? (default: false)' },
      },
      required: ['x', 'y'],
    },
    async (input) => {
      const { x, y } = toPhysical(input.x, input.y);
      const btn = input.button === 'right' ? 'R' : input.button === 'middle' ? 'M' : 'L';
      const count = input.double ? '2' : '1';
      await runAHK(`
#Requires AutoHotkey v2.0
CoordMode "Pixel", "Screen"
CoordMode "Mouse", "Screen"
Click "${x}, ${y}, ${btn}, ${count}"
`);
      return { success: true, logical: { x: input.x, y: input.y }, physical: { x, y }, button: input.button || 'left', double: !!input.double };
    }
  );

  // ── 5. MouseMove ─────────────────────────────────────────────
  toolRegistry.register('MouseMove',
    'Move mouse cursor to (x,y) without clicking.',
    {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X pixel coordinate (logical)' },
        y: { type: 'number', description: 'Y pixel coordinate (logical)' },
      },
      required: ['x', 'y'],
    },
    async (input) => {
      const { x, y } = toPhysical(input.x, input.y);
      await runAHK(`
#Requires AutoHotkey v2.0
CoordMode "Mouse", "Screen"
MouseMove ${x}, ${y}
`);
      return { success: true, physical: { x, y } };
    }
  );

  // ── 6. KeyboardType ──────────────────────────────────────────
  // Click + clear + type, all in one AHK script — atomic, no focus loss
  toolRegistry.register('KeyboardType',
    'Type text or send keyboard shortcuts. Optionally click a field first with x,y. All in one atomic AutoHotkey call.',
    {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type (supports Chinese/Unicode). Uses clipboard paste for normal text.' },
        keys: { type: 'string', description: 'Key combo: "enter", "tab", "escape", "backspace", "ctrl+a", "alt+tab", "win" etc.' },
        clear: { type: 'boolean', description: 'Select all text (Home, Shift+End) and delete before typing. Use with x,y.' },
        secret: { type: 'boolean', description: 'Set true for password fields. Types each character individually instead of clipboard paste (bypasses paste-block in login forms).' },
        x: { type: 'number', description: 'X coordinate to click before typing (logical pixels).' },
        y: { type: 'number', description: 'Y coordinate to click before typing (logical pixels).' },
      },
      required: [],
    },
    async (input) => {
      if (input.text) {
        const needsClick = input.x != null && input.y != null;
        const phys = needsClick ? toPhysical(input.x, input.y) : null;

        // AHK script: click → clear → type, all atomic
        let clickLine = '';
        if (needsClick) {
          clickLine = `Click "${phys.x}, ${phys.y}"\nSleep 200`;
        }
        let clearLines = '';
        if (input.clear) {
          clearLines = `Send "{Home}"\nSleep 50\nSend "+{End}"\nSleep 50\nSend "{Backspace}"\nSleep 100`;
        }

        // Escape special chars for AHK Send
        const ahkText = input.text
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/`/g, '``')
          .replace(/\{/g, '`{')
          .replace(/\}/g, '`}');

        if (input.secret) {
          // Password fields may block paste (Ctrl+V). Use SendText to type each char literally.
          // SendText does NOT interpret special chars (!^+# etc), sends them as-is.
          const literalText = input.text
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/`/g, '``');

          await runAHK(`
#Requires AutoHotkey v2.0
CoordMode "Mouse", "Screen"
CoordMode "Pixel", "Screen"
SetKeyDelay 50, 30
${clickLine}
${clearLines}
SendText "${literalText}"
Sleep 100
`);
        } else {
          // Normal text: use clipboard paste (supports Chinese/Unicode)
          await runAHK(`
#Requires AutoHotkey v2.0
CoordMode "Mouse", "Screen"
CoordMode "Pixel", "Screen"
${clickLine}
${clearLines}
A_Clipboard := "${ahkText}"
Sleep 100
Send "^v"
Sleep 100
`);
        }
        return { success: true, text: input.text, clicked: needsClick ? { x: input.x, y: input.y } : null, cleared: !!input.clear };
      }

      if (input.keys) {
        // Map human-readable combos to AHK syntax
        let k = input.keys.trim();
        // Convert "ctrl+a" → "^a", "alt+tab" → "!{Tab}", etc.
        k = k.replace(/ctrl\+/gi, '^')
             .replace(/alt\+/gi, '!')
             .replace(/shift\+/gi, '+')
             .replace(/win\+/gi, '#');
        // Wrap known special keys in braces
        const specials = {
          'enter': '{Enter}', 'return': '{Enter}', 'tab': '{Tab}',
          'escape': '{Escape}', 'esc': '{Escape}', 'backspace': '{Backspace}',
          'delete': '{Delete}', 'del': '{Delete}', 'space': '{Space}',
          'up': '{Up}', 'down': '{Down}', 'left': '{Left}', 'right': '{Right}',
          'home': '{Home}', 'end': '{End}', 'pageup': '{PgUp}', 'pagedown': '{PgDn}',
          'f1': '{F1}', 'f2': '{F2}', 'f3': '{F3}', 'f4': '{F4}',
          'f5': '{F5}', 'f6': '{F6}', 'f7': '{F7}', 'f8': '{F8}',
          'f9': '{F9}', 'f10': '{F10}', 'f11': '{F11}', 'f12': '{F12}',
          'win': '{LWin}',
        };
        const lowerK = k.toLowerCase();
        if (specials[lowerK]) k = specials[lowerK];

        await runAHK(`
#Requires AutoHotkey v2.0
Send "${k}"
`);
        return { success: true, keys: input.keys };
      }

      return { error: 'Provide either "text" or "keys" parameter' };
    }
  );
}

module.exports = { registerComputerTools };
