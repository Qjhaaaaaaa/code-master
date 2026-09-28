const { readdirSync, existsSync } = require('fs');
const { resolve, join } = require('path');

class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(name, description, inputSchema, handler) {
    this.tools.set(name, { name, description, inputSchema, handler });
  }

  getDefinitions() {
    return Array.from(this.tools.values()).map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  async execute(name, input) {
    const tool = this.tools.get(name);
    if (!tool) return { error: `Unknown tool: ${name}` };
    try {
      return await tool.handler(input);
    } catch (err) {
      return { error: err.message || String(err) };
    }
  }

  list() {
    return Array.from(this.tools.keys());
  }
}

const toolRegistry = new ToolRegistry();

async function executeTool(name, input) {
  return toolRegistry.execute(name, input);
}

function getToolDefinitions() {
  return toolRegistry.getDefinitions();
}

function loadPlugins() {
  const pluginsDir = resolve(__dirname, 'plugins');
  if (!existsSync(pluginsDir)) return;

  const files = readdirSync(pluginsDir).filter(f => f.endsWith('.js'));
  for (const file of files) {
    try {
      const plugin = require(join(pluginsDir, file));
      if (typeof plugin.register === 'function') {
        const { getState, saveState } = require('./state');
        plugin.register(toolRegistry, { getState, saveState });
        console.log(`Loaded plugin: ${file}`);
      }
    } catch (err) {
      console.error(`Failed to load plugin ${file}:`, err.message);
    }
  }
}

module.exports = { toolRegistry, executeTool, getToolDefinitions, loadPlugins };
