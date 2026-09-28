const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, unlinkSync, rmSync } = require('fs');
const { resolve, isAbsolute, dirname, basename, join, extname } = require('path');
const { homedir, tmpdir } = require('os');
const { toolRegistry, executeTool } = require('./tool-registry');
const { getState, saveState, genId } = require('./state');
const { runToolLoop } = require('./chat');
const { bgProcesses, sanitizePath } = require('./tools');

const execAsync = promisify(exec);

// ─── Litellm config parser ─────────────────────────────────────
function getLitellmModels() {
  const configPath = resolve(__dirname, '..', 'litellm_config.yaml');
  if (!existsSync(configPath)) return [];
  try {
    const yaml = readFileSync(configPath, 'utf-8');
    const models = [];
    const modelBlocks = yaml.split(/- model_name:/).slice(1);
    for (const block of modelBlocks) {
      const nameMatch = block.match(/^(\S+)/);
      const name = nameMatch ? nameMatch[1] : '';
      const descMatch = block.match(/description:\s*"([^"]+)"/);
      const capsMatch = block.match(/capabilities:\s*\[([^\]]+)\]/);
      const statusMatch = block.match(/status:\s*"(\S+)"/);
      const noteMatch = block.match(/note:\s*"([^"]+)"/);
      models.push({
        model_name: name,
        description: descMatch ? descMatch[1] : '',
        capabilities: capsMatch ? capsMatch[1].split(',').map(s => s.trim().replace(/"/g, '')) : [],
        status: statusMatch ? statusMatch[1] : 'unknown',
        note: noteMatch ? noteMatch[1] : '',
      });
    }
    return models;
  } catch { return []; }
}

// Auto-select model based on task type
function selectModelForTask(taskDescription) {
  const models = getLitellmModels();
  const available = models.filter(m => m.status === 'available');
  if (!available.length) return null;

  const task = taskDescription.toLowerCase();

  // Vision/image tasks → qwen-vl-plus
  if (/\b(图片|图像|照片|视觉|识别|ocr|截图|png|jpg|image|picture|vision)\b/.test(task)) {
    const vlModel = available.find(m => m.capabilities.includes('vision'));
    if (vlModel) return vlModel.model_name;
  }

  // Default: mimo-pro
  const primary = available.find(m => m.model_name === 'mimo-pro');
  return primary ? primary.model_name : available[0].model_name;
}

// ─── Sub-agent process management ───────────────────────────────
const agentProcesses = new Map();
let agentIdCounter = 0;

// ─── Team management ────────────────────────────────────────────
let currentTeam = null;

// ─── Plan mode state ────────────────────────────────────────────
let planMode = false;
let planContent = '';

// ─── Worktree state ─────────────────────────────────────────────
let currentWorktree = null;

// ─── Cron jobs ──────────────────────────────────────────────────
const cronJobs = new Map();

function registerExtendedTools() {

  // ═══════════════════════════════════════════════════════════════
  // AgentTool - Launch a sub-agent to handle complex tasks
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('Agent', 'Launch a new agent to handle complex, multi-step tasks autonomously. The agent runs with its own context and has full tool access.', {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'A short (3-5 word) description of the task' },
      prompt: { type: 'string', description: 'The task for the agent to perform. Be detailed and specific about what you want done.' },
      model: { type: 'string', description: 'Optional model override for this agent' },
      run_in_background: { type: 'boolean', description: 'Set to true to run this agent in the background.' },
    },
    required: ['description', 'prompt'],
  }, async (input) => {
    const state = getState();
    const api = getApiForAgent();
    if (!api) return { error: 'No API configured for agent' };

    const agentId = `agent_${++agentIdCounter}`;
    const apiMessages = [
      { role: 'system', content: `You are a sub-agent in a local coding environment. Task: ${input.description}\n\nWorking directory: ${state.workingDirectory}\n\nYou have access to all tools (Bash, Read, Write, Edit, Glob, Grep, etc.). Complete the task thoroughly.\n\n${input.prompt}` },
      { role: 'user', content: input.prompt },
    ];

    const runAgent = async () => {
      try {
        const result = await runToolLoop({
          api, model: input.model || undefined, messages: apiMessages,
          maxSteps: 30, maxToolResultChars: 30000,
          executeToolFn: executeTool,
        });
        return { agentId, description: input.description, result: result.text, toolCalls: result.toolCalls.length, status: 'completed' };
      } catch (err) {
        return { agentId, error: err.message, status: 'failed' };
      }
    };

    if (input.run_in_background) {
      const agentProc = { id: agentId, description: input.description, status: 'running', startedAt: Date.now(), result: null };
      agentProcesses.set(agentId, agentProc);
      runAgent().then(result => {
        agentProc.status = result.status;
        agentProc.result = result;
        agentProc.finishedAt = Date.now();
      });
      return { agentId, description: input.description, status: 'running', message: `Agent started in background. Use TaskOutput to check status.` };
    }

    return await runAgent();
  });

  // ═══════════════════════════════════════════════════════════════
  // SendMessageTool - Send message to another agent
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('SendMessage', 'Send a message to another agent in the team', {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Target agent name or "*" for broadcast' },
      message: { type: 'string', description: 'The message to send' },
      summary: { type: 'string', description: 'Brief summary of the message' },
    },
    required: ['to', 'message'],
  }, async (input) => {
    return {
      success: true,
      message: `Message sent to ${input.to}: ${input.summary || input.message.slice(0, 100)}`,
      to: input.to,
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // TeamCreateTool - Create a team of agents
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('TeamCreate', 'Create a team of agents to collaborate on a complex task', {
    type: 'object',
    properties: {
      team_name: { type: 'string', description: 'Name for the new team' },
      description: { type: 'string', description: 'Team description/purpose' },
      agents: {
        type: 'array',
        description: 'Array of agent definitions',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Agent name' },
            role: { type: 'string', description: 'Agent role description' },
            tools: { type: 'array', items: { type: 'string' }, description: 'Tools available to this agent' },
          },
          required: ['name', 'role'],
        },
      },
    },
    required: ['team_name', 'agents'],
  }, async (input) => {
    currentTeam = {
      name: input.team_name,
      description: input.description,
      agents: input.agents,
      createdAt: Date.now(),
    };
    return {
      success: true,
      message: `Team "${input.team_name}" created with ${input.agents.length} agents`,
      team: currentTeam,
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // TeamDeleteTool - Disband a team
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('TeamDelete', 'Disband the current team and clean up', {
    type: 'object',
    properties: {},
    required: [],
  }, async () => {
    const name = currentTeam?.name || 'unknown';
    currentTeam = null;
    return { success: true, message: `Team "${name}" disbanded` };
  });

  // ═══════════════════════════════════════════════════════════════
  // AskUserQuestionTool - Ask the user a question
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('AskUserQuestion', 'Ask the user multiple choice questions to gather information, clarify ambiguity, or make decisions', {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: 'Array of questions to ask',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question to ask' },
            header: { type: 'string', description: 'Short label (max 12 chars)' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Display text' },
                  description: { type: 'string', description: 'Explanation of what this option means' },
                },
                required: ['label', 'description'],
              },
              minItems: 2,
              maxItems: 4,
            },
            multiSelect: { type: 'boolean', description: 'Allow multiple selections' },
          },
          required: ['question', 'header', 'options', 'multiSelect'],
        },
      },
    },
    required: ['questions'],
  }, async (input) => {
    // In desktop mode, we present the questions as formatted text for the model to interpret
    const questionsText = input.questions.map((q, i) => {
      const opts = q.options.map((o, j) => `  ${j + 1}. ${o.label} - ${o.description}`).join('\n');
      return `Q${i + 1} [${q.header}]: ${q.question}\n${opts}${q.multiSelect ? ' (multi-select)' : ''}`;
    }).join('\n\n');
    return {
      questions_presented: input.questions.length,
      display: questionsText,
      message: 'Questions presented to user. The user should respond with their choices.',
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // EnterPlanModeTool - Enter planning mode
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('EnterPlanMode', 'Enter plan mode for complex tasks. In plan mode, you explore the codebase and design an implementation approach before writing code.', {
    type: 'object',
    properties: {},
    required: [],
  }, async () => {
    planMode = true;
    planContent = '';
    return {
      success: true,
      message: 'Entered plan mode. Explore the codebase, design your approach, then use ExitPlanMode when ready to implement.',
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // ExitPlanModeTool - Exit planning mode
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('ExitPlanMode', 'Exit plan mode and begin implementation. Call this when your plan is ready for user approval.', {
    type: 'object',
    properties: {
      allowedPrompts: {
        type: 'array',
        description: 'Prompt-based permissions needed to implement the plan',
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string', description: 'The tool this applies to (e.g., Bash)' },
            prompt: { type: 'string', description: 'Semantic description of the action (e.g., "run tests", "install dependencies")' },
          },
          required: ['tool', 'prompt'],
        },
      },
    },
    required: [],
  }, async (input) => {
    planMode = false;
    return {
      success: true,
      message: 'Exited plan mode. Implementation can now begin.',
      allowedPrompts: input.allowedPrompts || [],
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // EnterWorktreeTool - Create git worktree
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('EnterWorktree', 'Create an isolated git worktree for working on changes without affecting the main branch', {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Optional name for the worktree branch' },
    },
    required: [],
  }, async (input) => {
    const state = getState();
    const name = input.name || `worktree-${Date.now()}`;
    const worktreePath = join(state.workingDirectory, '.worktrees', name);
    try {
      mkdirSync(dirname(worktreePath), { recursive: true });
      await execAsync(`git worktree add "${worktreePath}" -b "${name}"`, { cwd: state.workingDirectory });
      currentWorktree = { path: worktreePath, branch: name };
      return { success: true, path: worktreePath, branch: name, message: `Worktree "${name}" created at ${worktreePath}` };
    } catch (err) {
      return { error: `Failed to create worktree: ${err.message}` };
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // ExitWorktreeTool - Exit worktree
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('ExitWorktree', 'Exit the current worktree and return to the original working directory', {
    type: 'object',
    properties: {
      action: { type: 'string', description: '"keep" leaves worktree on disk, "remove" deletes it', enum: ['keep', 'remove'] },
      discard_changes: { type: 'boolean', description: 'If true and action is "remove", force remove even with uncommitted changes' },
    },
    required: ['action'],
  }, async (input) => {
    if (!currentWorktree) return { error: 'No active worktree' };
    const wt = currentWorktree;
    if (input.action === 'remove') {
      try {
        const flags = input.discard_changes ? '--force' : '';
        await execAsync(`git worktree remove ${flags} "${wt.path}"`, { cwd: getState().workingDirectory });
        await execAsync(`git branch -D "${wt.branch}"`, { cwd: getState().workingDirectory }).catch(() => {});
      } catch (err) {
        return { error: `Failed to remove worktree: ${err.message}` };
      }
    }
    currentWorktree = null;
    return { success: true, message: `Worktree "${wt.branch}" ${input.action === 'remove' ? 'removed' : 'kept'}` };
  });

  // ═══════════════════════════════════════════════════════════════
  // PowerShellTool - Execute PowerShell commands (Windows)
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('PowerShell', 'Execute a PowerShell command (Windows only)', {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The PowerShell command to execute' },
      timeout: { type: 'number', description: 'Timeout in seconds (default 30)' },
      description: { type: 'string', description: 'Clear, concise description of what this command does in active voice' },
      run_in_background: { type: 'boolean', description: 'Set to true to run this command in the background. Use TaskOutput to read the output later.' },
    },
    required: ['command'],
  }, async (input) => {
    const state = getState();
    const timeout = (input.timeout || 30) * 1000;
    try {
      const { stdout, stderr } = await execAsync(
        `powershell -NoProfile -Command "${input.command.replace(/"/g, '\\"')}"`,
        { cwd: state.workingDirectory, timeout, maxBuffer: 10 * 1024 * 1024 }
      );
      return { stdout, stderr };
    } catch (err) {
      return { error: err.message, stdout: err.stdout || '', stderr: err.stderr || '' };
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // REPLTool - Execute code in a REPL
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('REPL', 'Execute code in a REPL (Read-Eval-Print Loop). Supports JavaScript/Node.js.', {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Code to execute' },
      language: { type: 'string', description: 'Language: "javascript" or "python"', enum: ['javascript', 'python'] },
    },
    required: ['code'],
  }, async (input) => {
    const lang = input.language || 'javascript';
    const state = getState();
    try {
      if (lang === 'javascript') {
        const { stdout, stderr } = await execAsync(
          `node -e "${input.code.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
          { cwd: state.workingDirectory, timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
        );
        return { language: 'javascript', stdout, stderr };
      } else if (lang === 'python') {
        const { stdout, stderr } = await execAsync(
          `python -c "${input.code.replace(/"/g, '\\"')}"`,
          { cwd: state.workingDirectory, timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
        );
        return { language: 'python', stdout, stderr };
      }
      return { error: `Unsupported language: ${lang}` };
    } catch (err) {
      return { error: err.message, stdout: err.stdout || '', stderr: err.stderr || '' };
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // NotebookEditTool - Edit Jupyter notebook cells
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('NotebookEdit', 'Edit cells in a Jupyter notebook (.ipynb file)', {
    type: 'object',
    properties: {
      notebook_path: { type: 'string', description: 'Absolute path to the .ipynb file' },
      cell_id: { type: 'string', description: 'ID of the cell to edit (for replace/delete) or insert after' },
      new_source: { type: 'string', description: 'New source code for the cell' },
      cell_type: { type: 'string', description: 'Cell type: "code" or "markdown"', enum: ['code', 'markdown'] },
      edit_mode: { type: 'string', description: 'Edit mode: "replace", "insert", or "delete"', enum: ['replace', 'insert', 'delete'] },
    },
    required: ['notebook_path', 'new_source'],
  }, async (input) => {
    const filePath = input.notebook_path;
    if (!filePath.endsWith('.ipynb')) return { error: 'File must be a .ipynb notebook' };
    const sp = sanitizePath(filePath);
    if (!existsSync(sp)) return { error: 'Notebook file not found' };

    const nb = JSON.parse(readFileSync(sp, 'utf-8'));
    const mode = input.edit_mode || 'replace';
    const cellType = input.cell_type || 'code';

    if (mode === 'insert') {
      const newCell = {
        cell_type: cellType,
        metadata: {},
        source: input.new_source.split('\n').map((l, i, arr) => i < arr.length - 1 ? l + '\n' : l),
      };
      if (cellType === 'code') newCell.outputs = [];
      const idx = input.cell_id
        ? nb.cells.findIndex(c => c.id === input.cell_id) + 1
        : 0;
      nb.cells.splice(idx, 0, newCell);
    } else if (mode === 'delete') {
      const idx = nb.cells.findIndex(c => c.id === input.cell_id);
      if (idx === -1) return { error: 'Cell not found' };
      nb.cells.splice(idx, 1);
    } else {
      // replace
      const idx = input.cell_id
        ? nb.cells.findIndex(c => c.id === input.cell_id)
        : 0;
      if (idx === -1) return { error: 'Cell not found' };
      nb.cells[idx].source = input.new_source.split('\n').map((l, i, arr) => i < arr.length - 1 ? l + '\n' : l);
      if (cellType && nb.cells[idx].cell_type !== cellType) {
        nb.cells[idx].cell_type = cellType;
        if (cellType === 'code') nb.cells[idx].outputs = [];
      }
    }

    writeFileSync(sp, JSON.stringify(nb, null, 1), 'utf-8');
    return { success: true, cell_type: cellType, edit_mode: mode, notebook_path: filePath };
  });

  // ═══════════════════════════════════════════════════════════════
  // LSPTool - Language Server Protocol operations
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('LSP', 'Language Server Protocol tool - provides code intelligence features like go-to-definition, find references, and diagnostics', {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'LSP action: "definitions", "references", "diagnostics", "hover", "symbols"', enum: ['definitions', 'references', 'diagnostics', 'hover', 'symbols'] },
      file_path: { type: 'string', description: 'File path' },
      position: { type: 'object', properties: { line: { type: 'number' }, character: { type: 'number' } }, description: 'Cursor position (line, character)' },
    },
    required: ['action', 'file_path'],
  }, async (input) => {
    // Simplified LSP - use language-specific tools when available
    const sp = sanitizePath(input.file_path);
    if (!existsSync(sp)) return { error: 'File not found' };
    return {
      action: input.action,
      file: input.file_path,
      message: `LSP ${input.action} for ${input.file_path}. Full LSP support requires a language server running.`,
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // SkillTool - Execute a predefined skill
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('Skill', 'Execute a predefined skill (e.g., /commit, /review-pr)', {
    type: 'object',
    properties: {
      skill: { type: 'string', description: 'The skill name to execute' },
      args: { type: 'string', description: 'Optional arguments for the skill' },
    },
    required: ['skill'],
  }, async (input) => {
    return {
      skill: input.skill,
      args: input.args,
      message: `Skill "${input.skill}" executed. In desktop mode, skills are handled as direct tool invocations.`,
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // ConfigTool - Runtime configuration
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('Config', 'Get or set runtime configuration values', {
    type: 'object',
    properties: {
      action: { type: 'string', description: '"get" or "set"', enum: ['get', 'set'] },
      key: { type: 'string', description: 'Configuration key' },
      value: { type: 'string', description: 'Value to set (for "set" action)' },
    },
    required: ['action', 'key'],
  }, async (input) => {
    const state = getState();
    if (!state._config) state._config = {};
    if (input.action === 'get') {
      return { key: input.key, value: state._config[input.key] || null };
    } else {
      state._config[input.key] = input.value;
      saveState(state);
      return { key: input.key, value: input.value, success: true };
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // TodoWriteTool - Write a todo list
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('TodoWrite', 'Write a structured todo list for the current task', {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Todo item text' },
            status: { type: 'string', description: 'Status: pending, in_progress, completed', enum: ['pending', 'in_progress', 'completed'] },
            priority: { type: 'string', description: 'Priority: high, medium, low', enum: ['high', 'medium', 'low'] },
          },
          required: ['content', 'status'],
        },
        description: 'Array of todo items',
      },
    },
    required: ['todos'],
  }, async (input) => {
    const state = getState();
    state._todos = input.todos;
    saveState(state);
    const summary = input.todos.map(t => `[${t.status === 'completed' ? 'x' : ' '}] ${t.content}`).join('\n');
    return { success: true, count: input.todos.length, summary };
  });

  // ═══════════════════════════════════════════════════════════════
  // SleepTool - Wait/delay
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('Sleep', 'Wait for a specified duration (in milliseconds)', {
    type: 'object',
    properties: {
      duration: { type: 'number', description: 'Duration to sleep in milliseconds' },
    },
    required: ['duration'],
  }, async (input) => {
    const ms = Math.min(input.duration || 1000, 30000); // Max 30s
    await new Promise(r => setTimeout(r, ms));
    return { slept: ms, message: `Slept for ${ms}ms` };
  });

  // ═══════════════════════════════════════════════════════════════
  // BriefTool - Generate a brief summary
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('Brief', 'Generate a brief summary of the current context or conversation', {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Content to summarize' },
      max_length: { type: 'number', description: 'Maximum summary length in words (default 50)' },
    },
    required: ['content'],
  }, async (input) => {
    const words = (input.content || '').split(/\s+/);
    const maxLen = input.max_length || 50;
    const summary = words.slice(0, maxLen).join(' ') + (words.length > maxLen ? '...' : '');
    return { summary, original_length: words.length };
  });

  // ═══════════════════════════════════════════════════════════════
  // TaskOutputTool - Get output from a running/completed task
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('TaskOutput', 'Retrieve output from a running or completed background task (Bash run_in_background). Use block=true to wait for completion.', {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The ID of the background task' },
      block: { type: 'boolean', description: 'Whether to wait for completion (default true)' },
      timeout: { type: 'number', description: 'Max wait time in ms (default 30000)' },
    },
    required: ['task_id'],
  }, async (input) => {
    const bgProc = bgProcesses.get(input.task_id);
    const agentProc = agentProcesses.get(input.task_id);
    const proc = bgProc || agentProc;

    if (!proc) return { error: `No task found with ID: ${input.task_id}` };

    // For background bash processes
    if (bgProc) {
      if (input.block !== false && bgProc.status === 'running') {
        const timeout = input.timeout || 30000;
        await new Promise((resolve) => {
          const start = Date.now();
          const check = setInterval(() => {
            if (bgProc.status !== 'running' || Date.now() - start > timeout) {
              clearInterval(check);
              resolve();
            }
          }, 200);
        });
      }
      return {
        task_id: input.task_id,
        command: bgProc.command,
        status: bgProc.status,
        exitCode: bgProc.exitCode,
        stdout: bgProc.stdout,
        stderr: bgProc.stderr,
        startedAt: bgProc.startedAt,
        finishedAt: bgProc.finishedAt,
      };
    }

    // For background agents
    if (agentProc) {
      if (input.block !== false && agentProc.status === 'running') {
        const timeout = input.timeout || 60000;
        await new Promise((resolve) => {
          const start = Date.now();
          const check = setInterval(() => {
            if (agentProc.status !== 'running' || Date.now() - start > timeout) {
              clearInterval(check);
              resolve();
            }
          }, 200);
        });
      }
      return {
        task_id: input.task_id,
        description: agentProc.description,
        status: agentProc.status,
        result: agentProc.result,
        startedAt: agentProc.startedAt,
        finishedAt: agentProc.finishedAt,
      };
    }

    return { error: `No task found with ID: ${input.task_id}` };
  });

  // ═══════════════════════════════════════════════════════════════
  // TaskStopTool - Stop a running background task
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('TaskStop', 'Stop a running background task by its ID', {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The ID of the background task to stop' },
    },
    required: ['task_id'],
  }, async (input) => {
    // Check background bash processes
    const bgProc = bgProcesses.get(input.task_id);
    if (bgProc) {
      if (bgProc.process && bgProc.status === 'running') {
        try { bgProc.process.kill(); } catch {}
      }
      bgProc.status = 'stopped';
      bgProc.finishedAt = Date.now();
      return { success: true, task_id: input.task_id, message: 'Background process stopped' };
    }

    // Check background agents
    const agentProc = agentProcesses.get(input.task_id);
    if (agentProc) {
      agentProc.status = 'stopped';
      agentProc.finishedAt = Date.now();
      return { success: true, task_id: input.task_id, message: 'Background agent stopped' };
    }

    return { error: `No task found with ID: ${input.task_id}` };
  });

  // ═══════════════════════════════════════════════════════════════
  // WorkflowTool - Execute a workflow
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('Workflow', 'Execute a predefined workflow of sequential steps', {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Workflow name' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string', description: 'Tool name to invoke' },
            input: { type: 'object', description: 'Input for the tool' },
            condition: { type: 'string', description: 'Optional condition to check before executing' },
          },
          required: ['tool', 'input'],
        },
        description: 'Workflow steps to execute sequentially',
      },
    },
    required: ['name', 'steps'],
  }, async (input) => {
    const results = [];
    for (const step of input.steps) {
      try {
        const result = await toolRegistry.execute(step.tool, step.input);
        results.push({ step: step.tool, result, success: !result.error });
        if (result.error) break; // Stop on error
      } catch (err) {
        results.push({ step: step.tool, error: err.message, success: false });
        break;
      }
    }
    return { workflow: input.name, steps_executed: results.length, results };
  });

  // ═══════════════════════════════════════════════════════════════
  // ScheduleCronTool - Schedule a recurring task
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('ScheduleCron', 'Schedule a recurring cron job', {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Job name' },
      schedule: { type: 'string', description: 'Cron expression (e.g., "*/5 * * * *" for every 5 minutes)' },
      command: { type: 'string', description: 'Command or tool to execute' },
    },
    required: ['name', 'schedule', 'command'],
  }, async (input) => {
    const jobId = `cron_${Date.now()}`;
    cronJobs.set(jobId, {
      id: jobId,
      name: input.name,
      schedule: input.schedule,
      command: input.command,
      createdAt: Date.now(),
      active: true,
    });
    return {
      success: true,
      job_id: jobId,
      name: input.name,
      schedule: input.schedule,
      message: `Cron job "${input.name}" scheduled with expression: ${input.schedule}`,
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // RemoteTriggerTool - Trigger a remote event
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('RemoteTrigger', 'Trigger a remote event or webhook', {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Webhook URL to trigger' },
      method: { type: 'string', description: 'HTTP method (default POST)', enum: ['GET', 'POST', 'PUT'] },
      payload: { type: 'object', description: 'Payload to send' },
    },
    required: ['url'],
  }, async (input) => {
    try {
      const res = await fetch(input.url, {
        method: input.method || 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: input.payload ? JSON.stringify(input.payload) : undefined,
      });
      const text = await res.text().catch(() => '');
      return { success: res.ok, status: res.status, response: text.slice(0, 2000) };
    } catch (err) {
      return { error: err.message };
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // SyntheticOutputTool - Return structured output
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('SyntheticOutput', 'Return structured output in a requested format', {
    type: 'object',
    properties: {
      format: { type: 'string', description: 'Output format: "json", "markdown", "text", "csv"', enum: ['json', 'markdown', 'text', 'csv'] },
      data: { type: 'object', description: 'Data to format' },
      template: { type: 'string', description: 'Optional template string' },
    },
    required: ['format', 'data'],
  }, async (input) => {
    const { format, data, template } = input;
    if (format === 'json') return { output: JSON.stringify(data, null, 2), format };
    if (format === 'markdown') {
      if (template) return { output: template.replace(/\{\{(\w+)\}\}/g, (_, k) => data[k] || ''), format };
      return { output: Object.entries(data).map(([k, v]) => `**${k}**: ${v}`).join('\n'), format };
    }
    if (format === 'csv') {
      if (Array.isArray(data)) {
        const headers = Object.keys(data[0] || {}).join(',');
        const rows = data.map(row => Object.values(row).join(',')).join('\n');
        return { output: `${headers}\n${rows}`, format };
      }
      return { output: Object.entries(data).map(([k, v]) => `${k},${v}`).join('\n'), format };
    }
    return { output: String(data), format };
  });

  // ═══════════════════════════════════════════════════════════════
  // ToolSearchTool - Search for available tools
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('ToolSearch', 'Search for available tools by name or description', {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query to match tool names or descriptions' },
    },
    required: ['query'],
  }, async (input) => {
    const query = input.query.toLowerCase();
    const allDefs = toolRegistry.getDefinitions();
    const matches = allDefs.filter(t =>
      t.name.toLowerCase().includes(query) ||
      t.description.toLowerCase().includes(query)
    );
    return {
      query: input.query,
      matches: matches.map(t => ({ name: t.name, description: t.description })),
      total: matches.length,
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // MCPTool - Model Context Protocol tool invocation
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('MCP', 'Invoke a Model Context Protocol (MCP) server tool', {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP server name' },
      tool: { type: 'string', description: 'Tool name on the MCP server' },
      arguments: { type: 'object', description: 'Arguments to pass to the tool' },
    },
    required: ['server', 'tool'],
  }, async (input) => {
    return {
      server: input.server,
      tool: input.tool,
      message: `MCP tool invocation for ${input.server}/${input.tool}. MCP servers must be configured separately.`,
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // McpAuthTool - Authenticate with MCP server
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('McpAuth', 'Authenticate with an MCP server that requires OAuth', {
    type: 'object',
    properties: {
      server_name: { type: 'string', description: 'Name of the MCP server to authenticate with' },
    },
    required: ['server_name'],
  }, async (input) => {
    return {
      server: input.server_name,
      message: `MCP authentication for ${input.server_name}. OAuth flow not available in desktop mode.`,
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // ListMcpResourcesTool - List MCP resources
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('ListMcpResources', 'List available resources from MCP servers', {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP server name (optional, lists all if omitted)' },
    },
    required: [],
  }, async (input) => {
    return {
      server: input.server || 'all',
      resources: [],
      message: 'No MCP resources available. Configure MCP servers to list their resources.',
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // ReadMcpResourceTool - Read MCP resource content
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('ReadMcpResource', 'Read the content of an MCP resource', {
    type: 'object',
    properties: {
      uri: { type: 'string', description: 'URI of the MCP resource to read' },
    },
    required: ['uri'],
  }, async (input) => {
    return { uri: input.uri, message: 'MCP resource reading requires a configured MCP server.' };
  });

  // ═══════════════════════════════════════════════════════════════
  // TungstenTool - Internal analytics/debugging
  // ═══════════════════════════════════════════════════════════════
  toolRegistry.register('Tungsten', 'Internal debugging and analytics tool', {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action to perform' },
      data: { type: 'object', description: 'Data for the action' },
    },
    required: ['action'],
  }, async (input) => {
    return { action: input.action, message: 'Tungsten internal tool - no-op in desktop mode' };
  });

  // ─── GenerateDiagram ──────────────────────────────────────────
  toolRegistry.register('GenerateDiagram', 'Generate a flowchart, sequence diagram, class diagram, or other diagram using Mermaid syntax. The diagram will be rendered inline in the chat as a visual flowchart. ALWAYS use flowchart LR (left to right) direction, never TD or TB.', {
    type: 'object',
    properties: {
      mermaid_code: { type: 'string', description: 'Mermaid diagram source code. For flowcharts, ALWAYS start with "flowchart LR" (left to right). Example: flowchart LR\n  A[Start] --> B[Process]\n  B --> C[End]' },
      description: { type: 'string', description: 'Brief description of what the diagram shows (1-2 sentences)' },
    },
    required: ['mermaid_code', 'description'],
  }, async (input) => {
    let code = input.mermaid_code.trim();
    // Force LR direction for flowcharts
    code = code.replace(/flowchart\s+(TD|TB)\b/gi, 'flowchart LR');
    return {
      success: true,
      message: input.description,
      diagram: code,
      format: 'mermaid',
      hint: 'The diagram has been generated and will be displayed inline in the chat.'
    };
  });

  // ─── GenerateImage ────────────────────────────────────────────
  toolRegistry.register('GenerateImage', 'Generate an SVG image (drawings, illustrations, icons, charts, logos). The image will be rendered inline in the chat. Use this for any visual content the user requests.', {
    type: 'object',
    properties: {
      svg_code: { type: 'string', description: 'Complete SVG source code. Use viewBox for responsive scaling. Example: <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">...</svg>' },
      description: { type: 'string', description: 'Brief description of the image (1-2 sentences)' },
    },
    required: ['svg_code', 'description'],
  }, async (input) => {
    let svg = input.svg_code.trim();
    // Ensure xmlns
    if (!svg.includes('xmlns=')) {
      svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    return {
      success: true,
      message: input.description,
      image: svg,
      format: 'svg',
      hint: 'The image has been generated and will be displayed inline in the chat.'
    };
  });
}

// ─── Helper: Get API config for sub-agents ──────────────────────
function getApiForAgent() {
  const state = getState();
  if (state.activeApiId) {
    const api = state.apis.find(a => a.id === state.activeApiId);
    if (api) return api;
  }
  return state.apis.find(a => a.isDefault) || state.apis[0] || null;
}

// ─── Helper: Call API for sub-agents ────────────────────────────
async function callApi(api, messages) {
  let baseUrl = api.baseUrl.replace(/\/+$/, '');
  if (!baseUrl.endsWith('/v1')) baseUrl += '/v1';
  const url = `${baseUrl}/chat/completions`;
  const state = getState();
  const model = state.models.find(m => m.isDefault)?.name || 'gpt-4';

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${api.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 4096,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`API Error ${res.status}: ${err.error?.message || res.statusText}`);
  }

  const data = await res.json();
  return { message: data.choices?.[0]?.message?.content || '', usage: data.usage };
}

module.exports = { registerExtendedTools };
