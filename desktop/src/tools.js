const { exec } = require('child_process');
const { promisify } = require('util');
const { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } = require('fs');
const { resolve, isAbsolute, dirname } = require('path');
const { toolRegistry } = require('./tool-registry');
const { getState, saveState } = require('./state');

const execAsync = promisify(exec);
const { spawn } = require('child_process');

// ─── Background process management ─────────────────────────────
const bgProcesses = new Map();
let bgProcessCounter = 0;

function sanitizePath(p) {
  const state = getState();
  const resolved = isAbsolute(p) ? resolve(p) : resolve(state.workingDirectory, p);
  // Allow any local path — user needs full filesystem access
  return resolved;
}

function registerBuiltinTools() {
  toolRegistry.register('Bash', 'Execute a shell command', {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to execute' },
      timeout: { type: 'number', description: 'Timeout in seconds (default 120)' },
      run_in_background: { type: 'boolean', description: 'Set to true to run this command in the background. Use TaskOutput to read the output later.' },
    },
    required: ['command'],
  }, async (input) => {
    const state = getState();

    // Background mode
    if (input.run_in_background) {
      const taskId = `bg_${++bgProcessCounter}_${Date.now()}`;
      const child = spawn(input.command, [], {
        cwd: state.workingDirectory,
        shell: true,
        env: process.env,
      });
      const bgProc = {
        id: taskId,
        command: input.command,
        process: child,
        stdout: '',
        stderr: '',
        status: 'running',
        startedAt: Date.now(),
        exitCode: null,
      };
      child.stdout.on('data', (data) => { bgProc.stdout += data.toString(); });
      child.stderr.on('data', (data) => { bgProc.stderr += data.toString(); });
      child.on('close', (code) => {
        bgProc.status = 'completed';
        bgProc.exitCode = code;
        bgProc.finishedAt = Date.now();
      });
      child.on('error', (err) => {
        bgProc.status = 'error';
        bgProc.stderr += `\nProcess error: ${err.message}`;
        bgProc.finishedAt = Date.now();
      });
      bgProcesses.set(taskId, bgProc);
      return { task_id: taskId, status: 'running', command: input.command, message: `Command started in background with task ID: ${taskId}` };
    }

    // Foreground mode (original behavior)
    const { stdout, stderr } = await execAsync(input.command, {
      cwd: state.workingDirectory,
      timeout: (input.timeout || 120) * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr };
  });

  toolRegistry.register('Read', 'Read file contents (supports text, images, PDF, DOCX)', {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file' },
      offset: { type: 'number', description: 'Starting line number (default 0)' },
      limit: { type: 'number', description: 'Max lines to read (default 200)' },
    },
    required: ['file_path'],
  }, async (input) => {
    const filePath = input.file_path || input.path;
    if (!filePath) return { error: 'The "file_path" property is required' };
    const sp = sanitizePath(filePath);
    const ext = sp.split('.').pop().toLowerCase();

    // Image files → return base64
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'];
    if (imageExts.includes(ext)) {
      const buf = readFileSync(sp);
      const b64 = buf.toString('base64');
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' }[ext] || 'image/png';
      return { content: `[Image: ${filePath}]`, image: `data:${mime};base64,${b64}`, mimeType: mime };
    }

    // PDF files → extract text with pypdf, OCR with RapidOCR, or convert to images
    if (ext === 'pdf') {
      try {
        // Paths embedded directly in Python scripts to avoid Windows shell encoding issues with Chinese filenames
        // In Python raw strings (r"..."), backslashes are already literal, so only escape quotes
        const safePath = sp.replace(/"/g, '\\"');

        // Step 1: Try text extraction with pypdf
        let text = '';
        try {
          const pyExtract = `
import sys
sys.stdout.reconfigure(encoding='utf-8')
from pypdf import PdfReader
r = PdfReader(r"${safePath}")
for p in r.pages:
    t = p.extract_text() or ''
    print(t)
`;
          const extractPath = resolve(require('os').tmpdir(), `cc_pdf_extract_${Date.now()}.py`);
          writeFileSync(extractPath, pyExtract, 'utf-8');
          const { stdout } = await execAsync(`python "${extractPath}"`, { maxBuffer: 10 * 1024 * 1024 });
          try { require('fs').unlinkSync(extractPath); } catch {}
          text = stdout.trim();
        } catch {}

        if (text && text.length > 50) {
          return { content: text, type: 'pdf' };
        }

        // Step 2: Convert pages to images with pymupdf
        const ts = Date.now();
        const outDir = resolve(require('os').tmpdir(), `cc_pdf_pages_${ts}`);
        mkdirSync(outDir, { recursive: true });
        const safeOutDir = outDir.replace(/"/g, '\\"');

        const pyConvert = `
import sys, os
sys.stdout.reconfigure(encoding='utf-8')
import fitz
doc = fitz.open(r"${safePath}")
out_dir = r"${safeOutDir}"
max_pages = min(len(doc), 10)
for i in range(max_pages):
    page = doc[i]
    pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
    pix.save(os.path.join(out_dir, f"page_{i+1}.png"))
print(f"OK:{max_pages}")
`;
        const scriptPath = resolve(require('os').tmpdir(), `cc_pdf_convert_${ts}.py`);
        writeFileSync(scriptPath, pyConvert, 'utf-8');

        const { stdout: convOut } = await execAsync(
          `python "${scriptPath}"`,
          { maxBuffer: 50 * 1024 * 1024, timeout: 60000 }
        );
        try { require('fs').unlinkSync(scriptPath); } catch {}

        if (!convOut.includes('OK:')) {
          // Cleanup and return error
          try { require('fs').rmdirSync(outDir); } catch {}
          return { content: '[PDF: text extraction empty and image conversion failed]', type: 'pdf' };
        }

        const pageCount = parseInt(convOut.split('OK:')[1]);

        // Step 3: OCR each page image with RapidOCR
        const pyOcr = `
import sys, os, json
sys.stdout.reconfigure(encoding='utf-8')
from rapidocr_onnxruntime import RapidOCR
ocr = RapidOCR()
out_dir = r"${safeOutDir}"
page_count = ${pageCount}
results = []
for i in range(1, page_count + 1):
    img_path = os.path.join(out_dir, f"page_{i}.png")
    if os.path.exists(img_path):
        result, _ = ocr(img_path)
        page_text = ""
        if result:
            page_text = "\\n".join([line[1] for line in result])
        results.append({"page": i, "text": page_text})
    else:
        results.append({"page": i, "text": ""})
print(json.dumps(results, ensure_ascii=False))
`;
        const ocrScriptPath = resolve(require('os').tmpdir(), `cc_pdf_ocr_${ts}.py`);
        writeFileSync(ocrScriptPath, pyOcr, 'utf-8');

        let ocrText = '';
        let ocrSuccess = false;
        try {
          const { stdout: ocrOut } = await execAsync(
            `python "${ocrScriptPath}"`,
            { maxBuffer: 50 * 1024 * 1024, timeout: 120000 }
          );
          const ocrResults = JSON.parse(ocrOut.trim());
          ocrText = ocrResults
            .filter(r => r.text && r.text.trim())
            .map(r => `--- Page ${r.page} ---\n${r.text}`)
            .join('\n\n');
          ocrSuccess = ocrText.length > 20;
        } catch {}
        try { require('fs').unlinkSync(ocrScriptPath); } catch {}

        // Step 4: Collect page images as fallback for vision model
        const images = [];
        for (let i = 1; i <= pageCount; i++) {
          const imgPath = resolve(outDir, `page_${i}.png`);
          if (existsSync(imgPath)) {
            const buf = readFileSync(imgPath);
            images.push({ page: i, data: `data:image/png;base64,${buf.toString('base64')}` });
            try { require('fs').unlinkSync(imgPath); } catch {}
          }
        }
        try { require('fs').rmdirSync(outDir); } catch {}

        // If OCR succeeded, return text; otherwise return images for vision model
        if (ocrSuccess) {
          return { content: ocrText, type: 'pdf' };
        }

        return {
          content: `[Image-based PDF: ${pageCount} page(s), OCR failed, sending images to vision model]`,
          type: 'pdf',
          images,
        };
      } catch (err) {
        return { content: `[PDF extraction failed: ${err.message}]`, error: err.message };
      }
    }

    // DOCX files → extract text with Python
    if (ext === 'docx') {
      try {
        const { stdout } = await execAsync(
          `python -c "import sys; sys.stdout.reconfigure(encoding='utf-8'); import docx; d=docx.Document(sys.argv[1]); [print(p.text) for p in d.paragraphs if p.text.strip()]" "${sp}"`,
          { maxBuffer: 10 * 1024 * 1024 }
        );
        const text = stdout.trim();
        if (text) return { content: text, type: 'docx' };
        return { content: '[DOCX: no text content found]', type: 'docx' };
      } catch (err) {
        return { content: `[DOCX extraction failed: ${err.message}]`, error: err.message };
      }
    }

    // XLS/XLSX → extract with Python openpyxl
    if (ext === 'xls' || ext === 'xlsx') {
      try {
        const { stdout } = await execAsync(
          `python -c "import sys; sys.stdout.reconfigure(encoding='utf-8'); import openpyxl; wb=openpyxl.load_workbook(sys.argv[1],read_only=True); [print('\\t'.join([str(c.value or '') for c in row])) for ws in wb.worksheets for row in ws.iter_rows(max_row=200)]" "${sp}"`,
          { maxBuffer: 10 * 1024 * 1024 }
        );
        const text = stdout.trim();
        if (text) return { content: text, type: 'xlsx' };
        return { content: '[Excel: no data found]', type: 'xlsx' };
      } catch (err) {
        // Fallback: try reading as text
        try {
          const content = readFileSync(sp, 'utf-8');
          return { content: content.slice(0, 10000), type: 'xlsx', note: 'extracted as raw text' };
        } catch { return { content: `[Excel extraction failed: ${err.message}]`, error: err.message }; }
      }
    }

    // Text files → read as UTF-8
    const content = readFileSync(sp, 'utf-8');
    const lines = content.split('\n');
    const start = input.offset || 0;
    const limit = input.limit || 200;
    const slice = lines.slice(start, start + limit);
    return { content: slice.map((l, i) => `${start + i + 1}\t${l}`).join('\n'), totalLines: lines.length };
  });

  toolRegistry.register('Edit', 'Edit file by replacing text', {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file' },
      old_string: { type: 'string', description: 'Text to replace' },
      new_string: { type: 'string', description: 'Replacement text' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  }, async (input) => {
    const filePath = input.file_path || input.path;
    if (!filePath) return { error: 'The "file_path" property is required' };
    const sp = sanitizePath(filePath);
    const content = readFileSync(sp, 'utf-8');
    if (!content.includes(input.old_string)) return { error: 'old_string not found in file' };
    writeFileSync(sp, content.replace(input.old_string, input.new_string));
    return { success: true, message: 'File edited successfully' };
  });

  toolRegistry.register('Write', 'Write or create a file', {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file' },
      content: { type: 'string', description: 'File content' },
    },
    required: ['file_path', 'content'],
  }, async (input) => {
    const filePath = input.file_path !== undefined ? input.file_path : input.path;
    if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
      return { error: 'The "file_path" property must be a non-empty string' };
    }
    const sp = sanitizePath(filePath);
    const dir = dirname(sp);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(sp, input.content || '', 'utf-8');
    return { success: true, message: `Written ${(input.content || '').length} bytes to ${sp}`, path: sp };
  });

  toolRegistry.register('Glob', 'Find files matching a glob pattern', {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern like "**/*.ts"' },
    },
    required: ['pattern'],
  }, async (input) => {
    const state = getState();
    const pattern = input.pattern;
    const cmd = process.platform === 'win32'
      ? `dir /b /s "${pattern.replace(/\//g, '\\\\')}" 2>nul || ver>nul`
      : `find . -path "${pattern}" -type f 2>/dev/null | head -100`;
    const { stdout } = await execAsync(cmd, { cwd: state.workingDirectory, maxBuffer: 10 * 1024 * 1024 });
    const files = stdout.split('\n').filter(Boolean).map(f => f.replace(/^\.\//, '')).slice(0, 100);
    return { files, total: files.length };
  });

  toolRegistry.register('Grep', 'Search file contents with regex', {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern' },
      path: { type: 'string', description: 'File or directory to search in' },
      glob: { type: 'string', description: 'File extension filter' },
    },
    required: ['pattern'],
  }, async (input) => {
    const state = getState();
    const { pattern, path, glob } = input;
    let cmd = process.platform === 'win32'
      ? `findstr /s /n /r "${pattern}" ${path || '*'} 2>nul || ver>nul`
      : `grep -rn "${pattern}" ${path || '.'} ${glob ? `--include="*.${glob}"` : ''} || true`;
    const { stdout } = await execAsync(cmd, { cwd: state.workingDirectory, maxBuffer: 10 * 1024 * 1024 });
    return { matches: stdout.split('\n').filter(Boolean).slice(0, 200) };
  });

  toolRegistry.register('ListDir', 'List directory contents', {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path (default: project root)' },
    },
    required: [],
  }, async (input) => {
    const p = sanitizePath(input.path || '.');
    const entries = readdirSync(p);
    const details = entries.map(e => {
      const s = statSync(resolve(p, e));
      return { name: e, isDir: s.isDirectory(), size: s.size, modified: s.mtime.toISOString() };
    });
    return { entries: details };
  });

  toolRegistry.register('CreateDir', 'Create a directory', {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory path' } },
    required: ['path'],
  }, async (input) => {
    const p = sanitizePath(input.path);
    mkdirSync(p, { recursive: true });
    return { success: true, message: `Directory created: ${p}` };
  });

  toolRegistry.register('WebSearch', 'Search the web for information', {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query' } },
    required: ['query'],
  }, async (input) => {
    const query = input.query;
    if (!query) return { error: 'Query is required' };

    // Detect if query is primarily Chinese
    const isChinese = /[\u4e00-\u9fff]/.test(query);

    // Anti-bot headers - rotate User-Agent
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    ];
    const ua = userAgents[Math.floor(Math.random() * userAgents.length)];

    // Helper: search Bing (accessible in China, good quality)
    async function searchBing(q) {
      try {
        const url = `https://cn.bing.com/search?q=${encodeURIComponent(q)}&count=10`;
        const res = await fetch(url, {
          headers: {
            'User-Agent': ua,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Connection': 'keep-alive',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return [];
        const html = await res.text();
        const results = [];
        // Parse Bing search results - each result is in <li class="b_algo">
        // with an <h2><a href="...">title</a></h2> and <p> snippet
        let pos = 0;
        while (results.length < 8) {
          const idx = html.indexOf('b_algo', pos);
          if (idx === -1) break;
          pos = idx + 1;
          const region = html.slice(idx, idx + 2000);
          const h2Match = region.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/);
          if (!h2Match) continue;
          const rUrl = h2Match[1];
          const title = h2Match[2].replace(/<[^>]+>/g, '').trim();
          // Find snippet in <p> after h2
          const snippetMatch = region.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
          const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';
          if (title && rUrl && !rUrl.includes('bing.com/search')) {
            results.push({ title, url: rUrl, snippet });
          }
        }
        return results;
      } catch { return []; }
    }

    // Helper: search Baidu
    async function searchBaidu(q) {
      try {
        const url = `https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=10`;
        const res = await fetch(url, {
          headers: {
            'User-Agent': ua,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Connection': 'keep-alive',
            'Referer': 'https://www.baidu.com/',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return [];
        const buffer = await res.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        // Detect charset from Content-Type header
        const ct = res.headers.get('content-type') || '';
        let charset = '';
        const ctMatch = ct.match(/charset=([^\s;]+)/i);
        if (ctMatch) charset = ctMatch[1].toLowerCase().trim();

        // If no charset from header, detect from HTML meta tags
        if (!charset) {
          const headAscii = new TextDecoder('ascii').decode(bytes.slice(0, 2048));
          const metaCharset = headAscii.match(/charset=["']?([^"'\s;>]+)/i);
          if (metaCharset) charset = metaCharset[1].toLowerCase().trim();
        }

        // Normalize charset
        if (charset === 'gb2312' || charset === 'gbk' || charset === 'gb18030') charset = 'gb18030';

        // Decode HTML - try detected charset first, then gb18030, then utf-8
        let html;
        const tryCharsets = charset ? [charset, 'gb18030', 'utf-8'] : ['gb18030', 'utf-8'];
        for (const enc of [...new Set(tryCharsets)]) {
          try {
            html = new TextDecoder(enc).decode(bytes);
            // Validate: decoded text should contain Chinese or ASCII result markers
            if (html.includes('百度') || html.includes('result') || html.includes('c-container')) break;
          } catch { continue; }
        }
        if (!html) html = new TextDecoder('utf-8').decode(bytes);

        const results = [];
        // Parse Baidu search results - each result has an h3 > a with title
        const resultRegex = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi;
        let match;
        while ((match = resultRegex.exec(html)) !== null && results.length < 8) {
          const rUrl = match[1];
          const title = match[2].replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ').trim();
          // Find snippet: look for content after this h3 within the same c-container
          const afterH3 = html.slice(match.index, match.index + 2000);
          const snippetMatch = afterH3.match(/<span[^>]*class="content-right_[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
            || afterH3.match(/<div[^>]*class="c-abstract"[^>]*>([\s\S]*?)<\/div>/i);
          const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ').trim() : '';
          if (title && rUrl && !rUrl.includes('baidu.com/s?')) {
            results.push({ title, url: rUrl, snippet });
          }
        }
        return results;
      } catch { return []; }
    }

    // Strategy: Baidu first (best Chinese results, accessible in China), Bing fallback
    let results = [];
    let engine = '';

    results = await searchBaidu(query);
    engine = 'baidu';
    // Fallback to Bing if Baidu returns too few results
    if (results.length < 3) {
      const bingResults = await searchBing(query);
      if (bingResults.length > results.length) {
        results = bingResults;
        engine = 'bing';
      }
    }

    if (results.length === 0) {
      return { query, error: 'No results found from any search engine', engine };
    }

    return {
      query,
      engine,
      total: results.length,
      results: results.map((r, i) => ({
        index: i + 1,
        title: r.title,
        url: r.url,
        snippet: r.snippet,
      })),
    };
  });

  toolRegistry.register('WebFetch', 'Fetch content from a URL', {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
    },
    required: ['url'],
  }, async (input) => {
    try {
      const res = await fetch(input.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return { error: `Failed: ${res.status} ${res.statusText}` };

      // Get raw bytes and detect encoding
      const buffer = await res.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      // Detect charset from Content-Type header
      const contentType = res.headers.get('content-type') || '';
      let charset = 'utf-8';
      const charsetMatch = contentType.match(/charset=([^\s;]+)/i);
      if (charsetMatch) {
        charset = charsetMatch[1].toLowerCase();
      }

      // If no charset in header, check HTML meta tags (first 2048 bytes)
      if (!charsetMatch) {
        const headBytes = bytes.slice(0, 2048);
        const headAscii = new TextDecoder('ascii').decode(headBytes);
        // Check <meta charset="xxx">
        const metaCharset = headAscii.match(/charset=["']?([^"'\s;>]+)/i);
        if (metaCharset) {
          charset = metaCharset[1].toLowerCase();
        } else {
          // Check <meta http-equiv="Content-Type" content="text/html; charset=xxx">
          const metaHttp = headAscii.match(/content=["'][^"']*charset=([^"'\s;]+)/i);
          if (metaHttp) {
            charset = metaHttp[1].toLowerCase();
          }
        }
      }

      // Normalize charset aliases
      if (charset === 'gb2312' || charset === 'gbk' || charset === 'gb18030') {
        charset = 'gb18030';
      }
      if (charset === 'big5') charset = 'big5';

      // Decode with detected encoding
      let text;
      try {
        text = new TextDecoder(charset).decode(bytes);
      } catch {
        // Fallback to UTF-8
        text = new TextDecoder('utf-8').decode(bytes);
      }

      const clean = text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
      return { url: input.url, encoding: charset, text: clean };
    } catch (err) {
      return { error: err.message };
    }
  });

  toolRegistry.register('TaskCreate', 'Create a task/todo item', {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Task title' },
      description: { type: 'string', description: 'Task description' },
    },
    required: ['subject'],
  }, async (input) => {
    const state = getState();
    if (!state._tasks) state._tasks = [];
    const task = { id: state._tasks.length + 1, subject: input.subject, description: input.description || '', status: 'pending', createdAt: Date.now() };
    state._tasks.push(task);
    saveState(state);
    return task;
  });

  toolRegistry.register('TaskList', 'List all tasks', {
    type: 'object', properties: {}, required: [],
  }, async () => {
    const state = getState();
    return { tasks: state._tasks || [] };
  });

  toolRegistry.register('TaskGet', 'Get a task by ID', {
    type: 'object',
    properties: { taskId: { type: 'number', description: 'Task ID' } },
    required: ['taskId'],
  }, async (input) => {
    const state = getState();
    const task = (state._tasks || []).find(t => t.id === input.taskId);
    return task || { error: 'Task not found' };
  });

  toolRegistry.register('TaskUpdate', 'Update a task', {
    type: 'object',
    properties: {
      taskId: { type: 'number', description: 'Task ID' },
      status: { type: 'string', description: 'New status' },
      subject: { type: 'string', description: 'New subject' },
      description: { type: 'string', description: 'New description' },
    },
    required: ['taskId'],
  }, async (input) => {
    const state = getState();
    const idx = (state._tasks || []).findIndex(t => t.id === input.taskId);
    if (idx === -1) return { error: 'Task not found' };
    if (input.status) state._tasks[idx].status = input.status;
    if (input.description !== undefined) state._tasks[idx].description = input.description;
    if (input.subject) state._tasks[idx].subject = input.subject;
    saveState(state);
    return state._tasks[idx];
  });

  // ─── Document Export Tools (Professional) ─────────────────────
  const desktopPath = require('os').homedir() + '/Desktop';
  const { tmpdir } = require('os');
  const generatorsDir = resolve(__dirname, '..', 'document_generators');

  function writeTempJson(data) {
    const p = resolve(tmpdir(), `cc_export_data_${Date.now()}.json`);
    writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
    return p;
  }

  toolRegistry.register('ExportPDF', 'Generate a professional PDF resume or report. For resume mode, include name/birth/gender/major/university/phone/email/location/photo_path/sections. Content uses markdown: ## sections, ### subsections, **bold**, - bullets.', {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Output file path (default: desktop)' },
      title: { type: 'string', description: 'Document title or name' },
      content: { type: 'string', description: 'Document content in markdown format (## sections, ### subsections, **bold**, - bullets, numbered lists)' },
      name: { type: 'string', description: 'Person name (resume)' },
      birth: { type: 'string', description: 'Birth date (resume), e.g. 2001.03.06' },
      gender: { type: 'string', description: 'Gender (resume)' },
      major: { type: 'string', description: 'Major/specialty (resume)' },
      university: { type: 'string', description: 'University/school (resume)' },
      graduation_year: { type: 'string', description: 'Graduation time range (resume)' },
      phone: { type: 'string', description: 'Phone number (resume)' },
      email: { type: 'string', description: 'Email (resume)' },
      location: { type: 'string', description: 'Current location (resume)' },
      type: { type: 'string', description: 'Candidate type, e.g. 应届生 (resume)' },
      position: { type: 'string', description: 'Target position (resume)' },
      photo_path: { type: 'string', description: 'Path to photo image file (resume)' },
    },
    required: ['title', 'content'],
  }, async (input) => {
    const outputPath = sanitizePath(input.file_path || `${desktopPath}\\${input.title.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_')}.pdf`);
    const dir = dirname(outputPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const data = {
      title: input.title,
      content: input.content || '',
      name: input.name || input.title,
      birth: input.birth || '',
      gender: input.gender || '',
      major: input.major || '',
      university: input.university || '',
      graduation_year: input.graduation_year || '',
      phone: input.phone || '',
      email: input.email || '',
      location: input.location || '',
      type: input.type || '',
      position: input.position || '',
      photo_path: input.photo_path || '',
    };

    const dataFile = writeTempJson(data);
    try {
      const { stdout, stderr } = await execAsync(
        `python "${resolve(generatorsDir, 'pdf_generator.py')}" "${dataFile}" "${outputPath}"`,
        { maxBuffer: 10 * 1024 * 1024, timeout: 60000 }
      );
      if (stdout.includes('OK:')) return { success: true, path: outputPath, message: `PDF exported: ${outputPath}` };
      return { error: `Export failed: ${stderr || stdout}` };
    } catch (err) {
      return { error: `Export failed: ${err.message}` };
    }
  });

  toolRegistry.register('ExportWord', 'Generate a professional Word resume or report (.docx). For resume mode, include name/birth/gender/major/university/phone/email/location/photo_path. Layout matches standard Chinese resume format.', {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Output file path (default: desktop)' },
      title: { type: 'string', description: 'Document title or name' },
      content: { type: 'string', description: 'Document content in markdown format' },
      name: { type: 'string', description: 'Person name (resume)' },
      birth: { type: 'string', description: 'Birth date (resume)' },
      gender: { type: 'string', description: 'Gender (resume)' },
      major: { type: 'string', description: 'Major/specialty (resume)' },
      university: { type: 'string', description: 'University/school (resume)' },
      graduation_year: { type: 'string', description: 'Graduation time range (resume)' },
      phone: { type: 'string', description: 'Phone number (resume)' },
      email: { type: 'string', description: 'Email (resume)' },
      location: { type: 'string', description: 'Current location (resume)' },
      type: { type: 'string', description: 'Candidate type (resume)' },
      position: { type: 'string', description: 'Target position (resume)' },
      photo_path: { type: 'string', description: 'Path to photo image file (resume)' },
    },
    required: ['title', 'content'],
  }, async (input) => {
    const outputPath = sanitizePath(input.file_path || `${desktopPath}\\${input.title.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_')}.docx`);
    const dir = dirname(outputPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const data = {
      title: input.title,
      content: input.content || '',
      name: input.name || input.title,
      birth: input.birth || '',
      gender: input.gender || '',
      major: input.major || '',
      university: input.university || '',
      graduation_year: input.graduation_year || '',
      phone: input.phone || '',
      email: input.email || '',
      location: input.location || '',
      type: input.type || '',
      position: input.position || '',
      photo_path: input.photo_path || '',
    };

    const dataFile = writeTempJson(data);
    try {
      const { stdout, stderr } = await execAsync(
        `python "${resolve(generatorsDir, 'word_generator.py')}" "${dataFile}" "${outputPath}"`,
        { maxBuffer: 10 * 1024 * 1024, timeout: 60000 }
      );
      if (stdout.includes('OK:')) return { success: true, path: outputPath, message: `Word exported: ${outputPath}` };
      return { error: `Export failed: ${stderr || stdout}` };
    } catch (err) {
      return { error: `Export failed: ${err.message}` };
    }
  });

  toolRegistry.register('ExportTemplatePDF', 'Fill an existing PDF template with content at specified coordinates. Use "fields" to define text insertion points with x/y positions, font size, color, etc.', {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Output file path (default: desktop)' },
      template_path: { type: 'string', description: 'Path to the template PDF file' },
      fields: {
        type: 'array',
        description: 'Array of text fields to insert into the template',
        items: {
          type: 'object',
          properties: {
            page: { type: 'number', description: 'Page number (0-indexed, default 0)' },
            x: { type: 'number', description: 'X position in points (72pt = 1 inch from left)' },
            y: { type: 'number', description: 'Y position in points (72pt = 1 inch from top)' },
            text: { type: 'string', description: 'Text to insert' },
            size: { type: 'number', description: 'Font size (default 10)' },
            font: { type: 'string', description: 'Font: simhei/msyh/simsun/yahei/heiti/songti (default msyh)' },
            color: { type: 'string', description: 'Color as hex #RRGGBB or array [r,g,b] 0-255 (default black)' },
            width: { type: 'number', description: 'Max width for text wrapping in points (0=single line)' },
            bold: { type: 'boolean', description: 'Use bold font (default false)' },
          },
          required: ['x', 'y', 'text'],
        },
      },
    },
    required: ['template_path', 'fields'],
  }, async (input) => {
    const outputPath = sanitizePath(input.file_path || `${desktopPath}\\filled_template_${Date.now()}.pdf`);
    const dir = dirname(outputPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const data = {
      template_path: input.template_path,
      fields: input.fields || [],
    };

    const dataFile = writeTempJson(data);
    try {
      const { stdout, stderr } = await execAsync(
        `python "${resolve(generatorsDir, 'template_pdf.py')}" "${dataFile}" "${outputPath}"`,
        { maxBuffer: 10 * 1024 * 1024, timeout: 60000 }
      );
      if (stdout.includes('OK:')) return { success: true, path: outputPath, message: `Template PDF filled: ${outputPath}` };
      return { error: `Fill failed: ${stderr || stdout}` };
    } catch (err) {
      return { error: `Fill failed: ${err.message}` };
    }
  });

  toolRegistry.register('ExportTemplateWord', 'Fill an existing Word template (.docx) by replacing {{placeholder}} markers with actual content. Placeholders work in paragraphs, runs, and table cells.', {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Output file path (default: desktop)' },
      template_path: { type: 'string', description: 'Path to the template .docx file' },
      replacements: {
        type: 'object',
        description: 'Key-value pairs to replace {{key}} placeholders. e.g. {"name": "张三", "phone": "13800138000"}',
      },
    },
    required: ['template_path', 'replacements'],
  }, async (input) => {
    const outputPath = sanitizePath(input.file_path || `${desktopPath}\\filled_template_${Date.now()}.docx`);
    const dir = dirname(outputPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const data = {
      template_path: input.template_path,
      replacements: input.replacements || {},
    };

    const dataFile = writeTempJson(data);
    try {
      const { stdout, stderr } = await execAsync(
        `python "${resolve(generatorsDir, 'template_word.py')}" "${dataFile}" "${outputPath}"`,
        { maxBuffer: 10 * 1024 * 1024, timeout: 60000 }
      );
      if (stdout.includes('OK:')) return { success: true, path: outputPath, message: `Template Word filled: ${outputPath}` };
      return { error: `Fill failed: ${stderr || stdout}` };
    } catch (err) {
      return { error: `Fill failed: ${err.message}` };
    }
  });

  toolRegistry.register('ExportTemplatePPT', 'Add slides to an existing PowerPoint template while preserving its master slides, themes, fonts, colors, and backgrounds. Supports placeholder replacement in existing slides.', {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Output file path (default: desktop)' },
      template_path: { type: 'string', description: 'Path to the existing .pptx template file' },
      slides: {
        type: 'array',
        description: 'Array of new slides to add to the template',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Slide title text' },
            content: { type: 'string', description: 'Slide content (bullet points separated by newlines)' },
            subtitle: { type: 'string', description: 'Optional subtitle text' },
            layout_index: { type: 'number', description: 'Which template slide layout to use (0=title, 1=content, etc.). Default is 1.' },
          },
          required: ['title', 'content'],
        },
      },
      replacements: {
        type: 'object',
        description: 'Optional dict of {{key}}: value to replace placeholders in existing template slides',
      },
      default_layout: {
        type: 'number',
        description: 'Default layout index for new slides (default 1)',
      },
    },
    required: ['template_path', 'slides'],
  }, async (input) => {
    const outputPath = sanitizePath(input.file_path || `${desktopPath}\\template_filled_${Date.now()}.pptx`);
    const dir = dirname(outputPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const data = {
      template_path: input.template_path,
      slides: input.slides || [],
      replacements: input.replacements || {},
      default_layout: input.default_layout || 1,
    };

    const dataFile = writeTempJson(data);
    try {
      const { stdout, stderr } = await execAsync(
        `python "${resolve(generatorsDir, 'template_ppt.py')}" "${dataFile}" "${outputPath}"`,
        { maxBuffer: 10 * 1024 * 1024, timeout: 60000 }
      );
      if (stdout.includes('OK:')) return { success: true, path: outputPath, message: `Template PPT filled: ${outputPath}` };
      return { error: `Fill failed: ${stderr || stdout}` };
    } catch (err) {
      return { error: `Fill failed: ${err.message}` };
    }
  });

  toolRegistry.register('ExportPPT', 'Generate a professional PowerPoint presentation (.pptx) with modern design, gradient backgrounds, and proper typography. Supports section dividers.', {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Output file path (default: desktop)' },
      title: { type: 'string', description: 'Presentation title' },
      subtitle: { type: 'string', description: 'Presentation subtitle' },
      slides: {
        type: 'array',
        description: 'Array of slides. Each slide has "title" and "content" (bullet points separated by newlines). Use --- prefix in title for section dividers.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Slide title (prefix with --- for section divider)' },
            content: { type: 'string', description: 'Slide content (bullet points separated by newlines)' },
            subtitle: { type: 'string', description: 'Subtitle for section divider slides' },
          },
          required: ['title', 'content'],
        },
      },
    },
    required: ['title', 'slides'],
  }, async (input) => {
    const outputPath = sanitizePath(input.file_path || `${desktopPath}\\${input.title.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_')}.pptx`);
    const dir = dirname(outputPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const data = {
      title: input.title,
      subtitle: input.subtitle || '',
      slides: input.slides || [],
    };

    const dataFile = writeTempJson(data);
    try {
      const { stdout, stderr } = await execAsync(
        `python "${resolve(generatorsDir, 'ppt_generator.py')}" "${dataFile}" "${outputPath}"`,
        { maxBuffer: 10 * 1024 * 1024, timeout: 60000 }
      );
      if (stdout.includes('OK:')) return { success: true, path: outputPath, message: `PPT exported: ${outputPath}` };
      return { error: `Export failed: ${stderr || stdout}` };
    } catch (err) {
      return { error: `Export failed: ${err.message}` };
    }
  });
}

module.exports = { registerBuiltinTools, bgProcesses, sanitizePath };
