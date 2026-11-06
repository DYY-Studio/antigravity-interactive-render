#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'interactive-render');
const PORT_FILE = path.join(DATA_DIR, 'server.json');
const SIDECAR_SCRIPT = path.join(__dirname, 'sidecars', 'render', 'main.mjs');

function httpRequestJson(port, method, reqPath, body = null, { longPoll = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== null ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': payload.length,
            }
          : {},
        timeout: longPoll ? 0 : 15000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            const parsed = text ? JSON.parse(text) : {};
            resolve({ statusCode: res.statusCode || 200, data: parsed });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    if (!longPoll) {
      req.on('timeout', () => {
        req.destroy(new Error('Request to interactive-render sidecar timed out'));
      });
    }
    if (payload) req.write(payload);
    req.end();
  });
}

async function getSidecarPort() {
  try {
    const raw = await fs.readFile(PORT_FILE, 'utf8');
    const info = JSON.parse(raw);
    if (info && typeof info.port === 'number' && info.port > 0) {
      const check = await httpRequestJson(info.port, 'GET', '/api/state');
      if (check.statusCode === 200 && check.data?.ok) {
        return info.port;
      }
    }
  } catch {
    // Sidecar not running yet
  }

  // Spawn sidecar broker in background if not started yet
  const child = spawn(process.execPath, [SIDECAR_SCRIPT, '--daemon'], {
    cwd: path.dirname(SIDECAR_SCRIPT),
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      const raw = await fs.readFile(PORT_FILE, 'utf8');
      const info = JSON.parse(raw);
      if (info?.port) {
        const check = await httpRequestJson(info.port, 'GET', '/api/state');
        if (check.statusCode === 200 && check.data?.ok) {
          return info.port;
        }
      }
    } catch {
      // Keep waiting
    }
  }
  throw new Error('Failed to connect to or start the interactive-render sidecar server');
}

const TOOLS = [
  {
    name: 'render_page',
    description:
      'Draw an interactive HTML page (`html`) or a declarative UI block program (`ui`) in the Interactive Render panel, and optionally wait for the user to choose, fill in fields, or annotate elements (`awaitAnswer: true`). ' +
      'Prefer `ui` for structured forms, choices, comparisons, tables, and charts (consistent native look across models; parser errors return `ui-not-drawn` so you can self-correct). ' +
      'Use `html` for visual mockups and custom SVG/Canvas drawings. Also saves a standalone HTML file that can be embedded in chat via `<agent-embed>`.',
    inputSchema: {
      type: 'object',
      properties: {
        ui: {
          type: 'string',
          description:
            'Declarative openui-lang program (without code fences) or JSON AST. Root is `Stack([...])`. ' +
            'Components: Stack(children), Row(children), Card(title, children), Tabs(tabs), Tab(label, children), Details(title, children), ' +
            'Text(markdown), Badge(label, tone?), Callout(markdown, tone?, title?), KeyValue(items: [{label, value}]), ' +
            'Table(columns, rows), Steps(items: [{title, markdown?, status?: "done"|"current"|"todo"|"blocked"}]), ' +
            'BarChart(labels, series: [Series(name, values)], unit?), LineChart(labels, series, unit?), ' +
            'Stat(label, value, delta?, tone?), Progress(label, value, max?), ' +
            'Choice(name, options, label?, multiple?), Input(name, label?, placeholder?, multiline?), ' +
            'DateInput(name, label?, time?, value?), Slider(name, min, max, label?, step?, value?, unit?), ' +
            'Button(label, variant?: "primary"|"secondary", value?).',
        },
        html: {
          type: 'string',
          description:
            'Self-contained HTML document (up to 200,000 chars) with inline <style> and <script>. ' +
            'Built-in classes: .oc-box, .oc-muted, .oc-table, .oc-num, .oc-badge (data-tone="success|warning|error|info"), ' +
            '.oc-dot, .oc-bar (--value, --color), .oc-field, .oc-input, .oc-switch, .oc-segmented, .oc-options, .oc-option (aria-pressed="true"), ' +
            '.oc-button (data-variant="outline|destructive"). ' +
            'Theme CSS variables on :root: --background, --foreground, --muted, --muted-foreground, --card, --card-foreground, --border, --primary, --primary-foreground, --destructive, --warning, --success, --info, --chart-1 to --chart-6, --radius, --font-sans, --font-mono. ' +
            'With `awaitAnswer: true`, wire a button click to `openchamber.submit(data, summary)` (or `antigravity.submit(data, summary)`).',
        },
        title: {
          type: 'string',
          description: 'Page title (up to 120 characters). Defaults to <title> or first heading.',
        },
        awaitAnswer: {
          type: 'boolean',
          description:
            'When true, holds the tool call open until the user submits a choice/form on the page, sends visual annotations, or clicks Continue in Chat.',
        },
        directory: {
          type: 'string',
          description: 'Optional workspace directory for resolving relative local image paths in `html`.',
        },
      },
    },
  },
  {
    name: 'request_secret',
    description:
      'Ask the user for a sensitive secret (API key, token, password) on a private masked card in the Interactive Render panel and wait for their response. ' +
      'When saved, the secret is written directly to a private 0600 local file (deleted automatically after 24 hours) and ONLY the file path is returned to you. ' +
      'The secret value never enters the chat, tool result, or LLM context. Read it inside commands via `TOKEN="$(cat <file>)" some-cli ...`; never print, echo, or log it.',
    inputSchema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'What the secret is (card title, e.g. "Cloudflare API Token", max 120 chars).',
        },
        reason: {
          type: 'string',
          description: 'What you will do with the secret and where to obtain it (max 1000 chars).',
        },
        placeholder: {
          type: 'string',
          description: 'Optional shape hint, such as "sk-ant-..." (max 80 chars).',
        },
      },
      required: ['label', 'reason'],
    },
  },
  {
    name: 'render_status',
    description:
      'List rendered pages and secret request statuses in the Interactive Render panel, inspect a specific page by `pageId`, or clear settled history.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'clear'],
          description: 'Default: "list".',
        },
        pageId: {
          type: 'string',
          description: 'Page or secret request ID for `action: "get"`.',
        },
      },
    },
  },
];

async function handleToolCall(name, rawArgs = {}) {
  const args = { ...rawArgs };
  if (args.awaitAnswer === 'true') args.awaitAnswer = true;
  else if (args.awaitAnswer === 'false') args.awaitAnswer = false;

  const port = await getSidecarPort();

  if (name === 'render_page') {
    const waiting = args.awaitAnswer === true;
    const res = await httpRequestJson(port, 'POST', '/api/render', args, { longPoll: waiting });
    if (!res.data?.ok) {
      throw new Error(res.data?.error || `render_page failed (HTTP ${res.statusCode})`);
    }
    return {
      ...res.data.data,
      panelLink: '[Render](sidecar://interactive-render/render/)',
    };
  }

  if (name === 'request_secret') {
    const res = await httpRequestJson(port, 'POST', '/api/secret/request', args, { longPoll: true });
    if (!res.data?.ok) {
      throw new Error(res.data?.error || `request_secret failed (HTTP ${res.statusCode})`);
    }
    return {
      ...res.data.data,
      panelLink: '[Render](sidecar://interactive-render/render/)',
    };
  }

  if (name === 'render_status') {
    const action = args.action || 'list';
    if (action === 'clear') {
      const res = await httpRequestJson(port, 'POST', '/api/clear', {});
      return { cleared: true, waitingCount: res.data?.waitingCount ?? 0 };
    }
    const res = await httpRequestJson(port, 'GET', '/api/state');
    const items = res.data?.items || [];
    if (action === 'get' && args.pageId) {
      const found = items.find((i) => i.id === args.pageId);
      if (!found) throw new Error(`Item not found: ${args.pageId}`);
      return found;
    }
    return {
      activeId: res.data?.activeId ?? null,
      waitingCount: res.data?.waitingCount ?? 0,
      items: items.map((i) => ({
        id: i.id,
        kind: i.kind,
        title: i.title,
        status: i.status,
        summary: i.summary,
        answerData: i.answerData,
        annotations: i.annotations,
        embedPath: i.embedPath,
        updatedAt: i.updatedAt,
      })),
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

// Stdio JSON-RPC 2.0 Transport (supports both Content-Length framing and newline-delimited JSON)
let useContentLength = false;
let buffer = Buffer.alloc(0);

function sendRpcMessage(msg) {
  const json = JSON.stringify(msg);
  if (useContentLength) {
    const byteLen = Buffer.byteLength(json, 'utf8');
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

async function dispatchRpc(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;

  if (method === 'notifications/initialized' || id === undefined) {
    return;
  }

  try {
    if (method === 'initialize') {
      sendRpcMessage({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'interactive-render', version: '1.0.0' },
        },
      });
      return;
    }

    if (method === 'ping') {
      sendRpcMessage({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    if (method === 'tools/list') {
      sendRpcMessage({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const result = await handleToolCall(toolName, toolArgs);
        sendRpcMessage({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          },
        });
      } catch (toolErr) {
        sendRpcMessage({
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: toolErr instanceof Error ? toolErr.message : String(toolErr) }),
              },
            ],
          },
        });
      }
      return;
    }

    sendRpcMessage({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  } catch (err) {
    sendRpcMessage({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
    });
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length > 0) {
    const headerMatch = /^Content-Length:\s*(\d+)\r?\n\r?\n/i.exec(buffer.toString('utf8', 0, Math.min(buffer.length, 200)));
    if (headerMatch) {
      useContentLength = true;
      const headerBytes = Buffer.byteLength(headerMatch[0], 'utf8');
      const bodyLen = Number(headerMatch[1]);
      if (buffer.length < headerBytes + bodyLen) break;
      const bodyStr = buffer.toString('utf8', headerBytes, headerBytes + bodyLen);
      buffer = buffer.subarray(headerBytes + bodyLen);
      try {
        void dispatchRpc(JSON.parse(bodyStr));
      } catch {
        // Ignore malformed frame
      }
      continue;
    }

    const nlIndex = buffer.indexOf(0x0a);
    if (nlIndex === -1) break;
    const line = buffer.toString('utf8', 0, nlIndex).trim();
    buffer = buffer.subarray(nlIndex + 1);
    if (!line) continue;
    try {
      void dispatchRpc(JSON.parse(line));
    } catch {
      // Ignore malformed line
    }
  }
});
