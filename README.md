# CC Master — 本地 AI 编程助手（二次开发）

> 基于既有 Agent CLI 内核完成本地化与二次开发：**自研 Electron 桌面端、Web 界面、额外52 个工具的桌面端工具系统、文档生成引擎与多模型接入层**，提供命令行（TUI）、Web、桌面端三种交互方式。

![CC Master 预览](cc-master-preview.png)

## 项目定位

本项目为**二次开发**，各部分职责明确：

| 部分 | 性质 | 说明 |
|------|------|------|
| 命令行内核（`src/`） | 基于既有 Agent 框架源码 | 完成本地化修复与行为定制：提示词工程、工具参数调优、搜索策略增强 |
| 桌面端（`desktop/`） | **自研** | Electron 应用：52 个工具系统、SSE 流式对话引擎、Markdown 渲染、文档生成、多 Agent |
| Web 界面（`web-ui/`） | **自研** | Web 图形界面（端口 3000） |
| 多模型接入 | **自研** | LiteLLM 代理 + 直连厂商 API 双模式，运行时切换 |

## 项目总览

| 目录 | 是什么 | 启动方式 |
|------|--------|---------|
| `CC/`（根目录） | 命令行主体（TUI） | `bun run start` |
| `web-ui/` | Web 图形界面 | 双击 `web-ui/start.bat` |
| `desktop/` | 桌面端（Electron）⭐ | 双击 `CC-Desktop.bat` / `CC-Desktop.vbs` |

命令行主体与 Web 通过 LiteLLM 代理（默认端口 4000）统一接入多模型（阿里云 / 小米 MiMo / DeepSeek 等）；桌面端同时支持代理与直连厂商 API 两种模式。

## 启动脚本说明

| 文件 | 作用 |
|------|------|
| `CC-Desktop.bat` | ⭐ **双击启动桌面端**：自动检查并拉起 LiteLLM 代理 → 等待端口就绪（最多 30 秒）→ 启动 Electron 应用 |
| `CC-Desktop.vbs` | 以**静默方式**启动桌面端（无黑色命令行窗口，效果同 CC-Desktop.bat） |
| `start-hidden.bat` | 后台静默启动命令行主体（不显示窗口） |
| `create_shortcut.vbs` | **一键创建桌面快捷方式**：双击运行，自动在桌面生成 CC Master 快捷图标，以后双击图标即可直接启动 |
| `web-ui/start.bat` | 启动 Web 界面（默认端口 3000，自动打开浏览器） |

## 根目录文件说明

| 文件/目录 | 作用 |
|-----------|------|
| `src/` | 命令行内核源码（对话主流程 query.ts、工具引擎 QueryEngine.ts、工具定义 tools.ts、TUI 界面 main.tsx） |
| `bin/` | 命令入口（等价于 `bun run start`） |
| `desktop/` | 桌面端 Electron 应用（自研，详见下方「桌面端」） |
| `web-ui/` | Web 图形界面（自研） |
| `litellm_config.yaml` | LiteLLM 多模型代理配置（默认端口 4000，想增删模型改这里） |
| `.env` / `.env.example` | 环境变量（API Key、模型配置），复制 `.env.example` 为 `.env` 后填入密钥 |
| `package.json` / `tsconfig.json` / `bunfig.toml` | 项目配置（依赖、脚本、TypeScript、Bun） |
| `docs/` | 文档目录 |
| `stubs/` | 依赖桩（本地占位实现） |
| `runtime/` | 运行时产物（自动生成，可忽略） |
| `cc-master-preview.png` / `cc-master.ico` | 应用预览图 / 图标 |

## 使用方式

### 命令行（TUI）

```bash
# 1. 配置 .env：复制 .env.example 为 .env 并填入 API Key
# 2. （可选）若走 LiteLLM 代理，先启动：
litellm --config litellm_config.yaml --port 4000  （litellm_config.yaml需要填写具体路径，如：E:\CC\litellm_config.yaml左边只是示例)
# 3. 启动：
bun run start
```

### Web 界面

双击 `web-ui/start.bat`，浏览器自动打开 `http://localhost:3000`。

### 桌面端（Electron）⭐ 推荐

双击 `CC-Desktop.bat`（或 `CC-Desktop.vbs` 静默启动），脚本自动完成：检查/拉起 LiteLLM → 等待端口就绪 → 启动 Electron。

首次运行需安装依赖：

```bash
cd desktop
npm install                    # Node 依赖（Electron 等）
pip install -r requirements.txt  # Python 依赖（文档生成引擎、PDF 解析/OCR）
```

启动后在界面左边一栏 → 添加 API 地址和密钥（有填写指引与解释） → 添加模型，即可对话。

## 模型与 API 配置

- **走 LiteLLM 代理**：修改根目录 `litellm_config.yaml` 中对应模型的 `api_base` / `api_key` / `model` 参数即可，无需改动任何代码（LiteLLM 默认端口 4000）。
- **直连厂商 API（不走代理）**：启动桌面端后，在界面左侧 **API configs** 与 **Models** 栏目中自行添加 API 地址、密钥与模型即可生效，运行时配置保存于 `desktop/data/state.json`，配置框架均已搭好，无需改动代码。

## 核心功能

- **流式输出**：SSE 推送 `delta`（增量文本）/ `tool`（工具调用）/ `done`（完成）三类事件，前端打字机式即时渲染，响应实时可见。
- **Markdown 渲染**：内置解析器（无第三方依赖），支持表格、代码块、标题、列表、引用、图片（可放大）、链接、行内格式。
- **工具调用循环**：模型按需调用工具，单轮可并行调用多个，失败自动重试，最多 50 轮。
- **上下文管理**：超 10 万 token 自动压缩+完整最新12轮对话；WebFetch 结果超 2000 字符自动摘要。
- **多模型接入**：LiteLLM 代理与直连双模式，运行时切换模型。
- **多模态**：支持图片、PDF、Word、Excel 上传解析。

## 自研工具系统（52 个工具）

桌面端内置**独立于命令行内核**的完整工具系统，每个工具按「名称 + 描述 + JSON Schema + 处理函数」四要素注册，模型通过名称调用，单轮可并行调用多个。

**基础工具（20 个，`desktop/src/tools.js`）：**

| 工具 | 功能 |
|------|------|
| Bash / PowerShell | 执行 shell 命令（支持后台任务、输出读取） |
| Read / Write / Edit | 文件读写与精确编辑 |
| Glob / Grep / ListDir / CreateDir | 文件查找、内容搜索、目录操作 |
| WebSearch / WebFetch | **自研双引擎搜索**：百度优先（中文结果更优）+ Bing 兜底，解析 HTML 提取结果；WebFetch 抓取网页正文 |
| ExportPDF / ExportWord / ExportPPT | **自研文档生成引擎**：一条指令生成简历、报告、演示文稿（Python 实现，见 `document_generators/`，仍在优化） |
| ExportTemplatePDF / Word / PPT | 模板填充：PDF 按坐标插入、Word 替换 `{{占位符}}`、PPT 保留原主题追加页面 （仍在优化）|
| TaskCreate / TaskList / TaskGet / TaskUpdate | 任务管理 |

**扩展工具（32 个，`desktop/src/tools-extended.js`）：**

- **多 Agent**：Agent（子代理并行）、SendMessage、TeamCreate / TeamDelete
- **交互控制**：AskUserQuestion、EnterPlanMode / ExitPlanMode（规划模式）、TodoWrite、Brief、Sleep
- **代码能力**：REPL（JS/Python 执行）、LSP（代码智能）、NotebookEdit、EnterWorktree / ExitWorktree（Git 工作树）
- **自动化**：Workflow（工作流）、ScheduleCron（定时任务）、RemoteTrigger（Webhook）、Skill（技能）、Config、SyntheticOutput、ToolSearch、TaskOutput / TaskStop
- **MCP 协议**：MCP、McpAuth、ListMcpResources、ReadMcpResource
- **视觉生成**：GenerateDiagram（Mermaid 流程图/时序图）、GenerateImage（SVG 插画/图表）

## 桌面端（desktop/）速览

- **技术栈**：Electron + Node.js，前后端通过 IPC 通信
- **核心文件**：
  - `src/main.js` — 主进程入口，注册 IPC 频道
  - `src/chat.js` — 对话引擎：工具循环、上下文压缩、SSE 流式调用
  - `src/tools.js` / `src/tools-extended.js` — **自研工具系统：20 基础 + 32 扩展 = 52 个工具**
  - `src/providers/providers.js` — 模型提供商（OpenAI 兼容 / Anthropic 兼容 / DashScope 等）
  - `renderer/app.js` — 前端主逻辑（流式渲染、Markdown、图表）
- **文档生成引擎**（`document_generators/`）：6 个 Python 模块，支持 PDF / Word / PPT 生成与模板填充
- **扩展**：
  - `scripts/` — 脚本库（爬虫/数据处理/自动化/API 等，可自行添加）
  - `uploads/` — 上传文件存放

> 依赖说明：根目录与 `desktop/` 是两套独立项目，各有各的 `package.json` 和 `node_modules`，互不影响。桌面端必须先 `cd desktop && npm install`。
