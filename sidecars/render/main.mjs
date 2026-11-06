import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ANSWERED_NOTE,
  buildHtmlRenderDocument,
  extractPageTitleFromHtml,
  inlineAndDescribeLocalImages,
  RENDER_PAGE_CLOSED_IN_CHAT_NOTE,
  RENDER_PAGE_MAX_ANSWER_DATA_LENGTH,
  RENDER_PAGE_MAX_HTML_LENGTH,
  RENDER_PAGE_MAX_SUMMARY_LENGTH,
  RENDER_PAGE_MAX_TITLE_LENGTH,
  SHOWN_NOTE,
  UI_NOT_DRAWN_NOTE,
} from './html_render.mjs';
import {
  createSecretFiles,
  DECLINED_NOTE,
  SAVED_NOTE,
  SECRET_CLOSED_NOTE,
  SECRET_MAX_VALUE_LENGTH,
  validateSecretRequestInput,
} from './secret_vault.mjs';
import { parseUiProgram } from './ui_blocks.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'interactive-render');
const SECRETS_DIR = path.join(DATA_DIR, 'secrets');
const PAGES_DIR = path.join(DATA_DIR, 'pages');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PORT_FILE = path.join(DATA_DIR, 'server.json');

const secretVault = createSecretFiles({ directory: SECRETS_DIR });

/**
 * In-memory state of rendered pages and secret requests.
 * Note: secret values are NEVER stored in items — only `{ status, label, reason }`
 * for UI status display.
 */
const state = {
  theme: 'dark',
  activeId: null,
  items: [], // max 50 items, newest first
};

const sseClients = new Set();
const waitingResolvers = new Map(); // id -> { resolve, reject, kind, cleanup }

function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

function publicState(serverPort) {
  return {
    theme: state.theme,
    activeId: state.activeId,
    serverPort,
    waitingCount: state.items.filter((i) => i.status === 'waiting').length,
    items: state.items.map((item) => ({
      id: item.id,
      kind: item.kind, // 'html' | 'ui' | 'secret'
      title: item.title,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      awaitAnswer: item.awaitAnswer,
      status: item.status, // 'shown' | 'waiting' | 'answered' | 'declined' | 'cancelled' | 'error'
      summary: item.summary ?? null,
      answerData: item.kind === 'secret' ? null : (item.answerData ?? null),
      annotations: item.annotations ?? [],
      html: item.html ?? null,
      uiSource: item.uiSource ?? null,
      uiAst: item.uiAst ?? null,
      uiErrors: item.uiErrors ?? null,
      embedPath: item.embedPath ?? null,
      secretMeta: item.secretMeta ?? null,
    })),
  };
}

async function saveStateToDisk() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    // Persist settled items (waiting items become 'cancelled' on server restart)
    const serializable = {
      theme: state.theme,
      activeId: state.activeId,
      items: state.items.slice(0, 40).map((item) => ({
        ...item,
        status: item.status === 'waiting' ? 'cancelled' : item.status,
      })),
    };
    const tmp = `${STATE_FILE}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(serializable, null, 2), 'utf8');
    await fs.rename(tmp, STATE_FILE);
  } catch {
    // Non-fatal
  }
}

async function loadStateFromDisk() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.items)) {
      state.theme = parsed.theme === 'light' ? 'light' : 'dark';
      state.items = parsed.items.map((item) => ({
        ...item,
        status: item.status === 'waiting' ? 'cancelled' : item.status,
      }));
      state.activeId = parsed.activeId || state.items[0]?.id || null;
    }
  } catch {
    // Empty initial state
  }
}

function addItem(item, serverPort) {
  state.items.unshift(item);
  if (state.items.length > 50) {
    state.items.length = 50;
  }
  state.activeId = item.id;
  void saveStateToDisk();
  broadcast('state', publicState(serverPort));
}

function updateItem(id, patch, serverPort) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return null;
  Object.assign(item, patch, { updatedAt: Date.now() });
  void saveStateToDisk();
  broadcast('state', publicState(serverPort));
  return item;
}

function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

async function writeStandaloneEmbedPage(item, serverPort) {
  if (item.kind !== 'html' || !item.html) return null;
  await fs.mkdir(PAGES_DIR, { recursive: true });
  const filePath = path.join(PAGES_DIR, `${item.id}.html`);
  const doc = buildHtmlRenderDocument(item.html, {
    appearance: state.theme,
    answerState: {
      waiting: item.status === 'waiting',
      answer: item.answerData ?? null,
    },
    pageId: item.id,
    apiBaseUrl: `http://127.0.0.1:${serverPort}`,
  });
  await fs.writeFile(filePath, doc, 'utf8');
  return filePath;
}

async function startServer() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(PAGES_DIR, { recursive: true });
  await loadStateFromDisk();
  await secretVault.sweep().catch(() => {});

  // Sweep expired secret files every hour
  setInterval(() => {
    void secretVault.sweep().catch(() => {});
  }, 60 * 60 * 1000).unref();

  let serverPort = Number(process.env.PORT || 0);

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${serverPort}`);
    const pathname = url.pathname;

    try {
      // 1. Static UI files
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && pathname === '/app.js') {
        const js = await fs.readFile(path.join(__dirname, 'app.js'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(js);
        return;
      }

      // 2. Standalone HTML page preview route
      if (req.method === 'GET' && pathname.startsWith('/api/pages/')) {
        const id = pathname.slice('/api/pages/'.length).replace(/\.html$/i, '');
        const item = state.items.find((i) => i.id === id);
        if (!item || item.kind !== 'html') {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Page not found');
          return;
        }
        const doc = buildHtmlRenderDocument(item.html, {
          appearance: state.theme,
          answerState: {
            waiting: item.status === 'waiting',
            answer: item.answerData ?? null,
          },
          pageId: item.id,
          apiBaseUrl: `http://127.0.0.1:${serverPort}`,
        });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(doc);
        return;
      }

      // 3. SSE Stream
      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        res.write(`event: state\ndata: ${JSON.stringify(publicState(serverPort))}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      // 4. Get current state
      if (req.method === 'GET' && pathname === '/api/state') {
        sendJson(res, 200, { ok: true, ...publicState(serverPort) });
        return;
      }

      // 5. Select active item or change theme
      if (req.method === 'POST' && pathname === '/api/select') {
        const body = await readJsonBody(req);
        if (typeof body.activeId === 'string') {
          state.activeId = body.activeId;
        }
        if (body.theme === 'light' || body.theme === 'dark') {
          state.theme = body.theme;
        }
        void saveStateToDisk();
        broadcast('state', publicState(serverPort));
        sendJson(res, 200, { ok: true, ...publicState(serverPort) });
        return;
      }

      // 6. Clear settled items
      if (req.method === 'POST' && pathname === '/api/clear') {
        state.items = state.items.filter((i) => i.status === 'waiting');
        state.activeId = state.items[0]?.id || null;
        void saveStateToDisk();
        broadcast('state', publicState(serverPort));
        sendJson(res, 200, { ok: true, ...publicState(serverPort) });
        return;
      }

      // 7. Render a page (`html` or `ui`), optionally blocking for `awaitAnswer`
      if (req.method === 'POST' && pathname === '/api/render') {
        const body = await readJsonBody(req);
        const rawHtml = typeof body.html === 'string' ? body.html : '';
        const rawUi = typeof body.ui === 'string' ? body.ui : '';
        const awaitAnswer = body.awaitAnswer === true;
        const directory = typeof body.directory === 'string' ? body.directory.trim() : '';

        if (rawHtml.trim() && rawUi.trim()) {
          sendJson(res, 400, { ok: false, error: 'Provide html or ui, not both' });
          return;
        }
        if (!rawHtml.trim() && !rawUi.trim()) {
          sendJson(res, 400, {
            ok: false,
            error: 'html or ui is required: provide a self-contained HTML document or an openui-lang UI block program',
          });
          return;
        }

        const content = rawUi.trim() || rawHtml;
        if (content.length > RENDER_PAGE_MAX_HTML_LENGTH) {
          sendJson(res, 400, {
            ok: false,
            error: `Content is ${content.length} characters; the limit is ${RENDER_PAGE_MAX_HTML_LENGTH}`,
          });
          return;
        }

        const id = `page_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
        const isUi = Boolean(rawUi.trim());
        const title =
          (typeof body.title === 'string' ? body.title.trim() : '') ||
          (!isUi ? extractPageTitleFromHtml(rawHtml) : '') ||
          (isUi ? 'Interactive Decision' : 'Rendered Page');

        if (title.length > RENDER_PAGE_MAX_TITLE_LENGTH) {
          sendJson(res, 400, {
            ok: false,
            error: `title is ${title.length} characters; the limit is ${RENDER_PAGE_MAX_TITLE_LENGTH}`,
          });
          return;
        }

        if (isUi) {
          const parsedUi = parseUiProgram(rawUi);
          if (!parsedUi.ok) {
            // Record the failed UI block and return ui-not-drawn immediately so the agent can self-heal
            const errItem = {
              id,
              kind: 'ui',
              title,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              awaitAnswer,
              status: 'error',
              uiSource: rawUi,
              uiAst: null,
              uiErrors: parsedUi.errors,
            };
            addItem(errItem, serverPort);
            sendJson(res, 200, {
              ok: true,
              data: {
                id,
                title,
                answer: { answered: false, reason: 'ui-not-drawn', errors: parsedUi.errors },
                note: [UI_NOT_DRAWN_NOTE, ...parsedUi.errors].join('\n'),
              },
            });
            return;
          }

          const item = {
            id,
            kind: 'ui',
            title,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            awaitAnswer,
            status: awaitAnswer ? 'waiting' : 'shown',
            uiSource: rawUi,
            uiAst: parsedUi.ast,
            uiErrors: null,
          };
          addItem(item, serverPort);

          if (!awaitAnswer) {
            sendJson(res, 200, {
              ok: true,
              data: { id, shown: true, title, note: SHOWN_NOTE },
            });
            return;
          }

          // Wait for user's answer on the UI block
          const answerResult = await waitForItemResolution(id, req);
          sendJson(res, 200, { ok: true, data: answerResult });
          return;
        }

        // HTML page path: inline local images within 25MB budget
        const { html: inlinedHtml, hiddenReport } = await inlineAndDescribeLocalImages(rawHtml, directory);
        const item = {
          id,
          kind: 'html',
          title,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          awaitAnswer,
          status: awaitAnswer ? 'waiting' : 'shown',
          html: inlinedHtml,
          annotations: [],
          embedPath: null,
        };
        const embedPath = await writeStandaloneEmbedPage(item, serverPort).catch(() => null);
        item.embedPath = embedPath;
        addItem(item, serverPort);

        const attachHidden = (payload, baseNote) =>
          hiddenReport
            ? {
                ...payload,
                images: hiddenReport.images,
                note: `${baseNote} ${hiddenReport.note}`,
              }
            : { ...payload, note: baseNote };

        if (!awaitAnswer) {
          sendJson(res, 200, {
            ok: true,
            data: attachHidden({ id, shown: true, title, embedPath }, SHOWN_NOTE),
          });
          return;
        }

        const answerResult = await waitForItemResolution(id, req);
        await writeStandaloneEmbedPage(item, serverPort).catch(() => null);
        sendJson(res, 200, {
          ok: true,
          data: attachHidden({ ...answerResult, embedPath }, answerResult.note || ANSWERED_NOTE),
        });
        return;
      }

      // 8. Submit an answer, annotation, or skip for a rendered page
      if (req.method === 'POST' && pathname === '/api/render/answer') {
        const body = await readJsonBody(req);
        const pageId = typeof body.pageId === 'string' ? body.pageId.trim() : '';
        const item = (pageId && state.items.find((i) => i.id === pageId)) || state.items.find((i) => i.status === 'waiting' && i.kind !== 'secret');
        if (!item) {
          sendJson(res, 404, { ok: false, error: 'No matching page found' });
          return;
        }

        // Client reported UI block couldn't be drawn
        if (Array.isArray(body.notDrawn)) {
          const errors = body.notDrawn.map((e) => String(e).slice(0, 500)).slice(0, 20);
          updateItem(item.id, { status: 'error', uiErrors: errors }, serverPort);
          const pending = waitingResolvers.get(item.id);
          if (pending) {
            waitingResolvers.delete(item.id);
            pending.resolve({
              id: item.id,
              title: item.title,
              answer: { answered: false, reason: 'ui-not-drawn', errors },
              note: [UI_NOT_DRAWN_NOTE, ...errors].join('\n'),
            });
          }
          sendJson(res, 200, { ok: true, answered: false });
          return;
        }

        // User clicked "Skip / Answer in Chat"
        if (body.skipped === true) {
          const userNote = typeof body.note === 'string' ? body.note.trim() : '';
          updateItem(
            item.id,
            {
              status: 'cancelled',
              summary: userNote ? `Continued in chat: ${userNote}` : 'Continued in chat',
            },
            serverPort,
          );
          const pending = waitingResolvers.get(item.id);
          if (pending) {
            waitingResolvers.delete(item.id);
            pending.resolve({
              id: item.id,
              title: item.title,
              answer: {
                answered: false,
                reason: 'chat',
                ...(userNote ? { note: userNote } : {}),
              },
              note: RENDER_PAGE_CLOSED_IN_CHAT_NOTE,
            });
          }
          sendJson(res, 200, { ok: true, answered: false });
          return;
        }

        // User submitted visual annotations
        if (Array.isArray(body.annotations) && body.annotations.length > 0) {
          const summary =
            (typeof body.summary === 'string' && body.summary.trim()) ||
            `Annotated ${body.annotations.length} element(s) on "${item.title}"`;
          updateItem(
            item.id,
            {
              status: 'answered',
              summary,
              annotations: body.annotations,
              answerData: { annotations: body.annotations, note: body.note || null },
            },
            serverPort,
          );
          const pending = waitingResolvers.get(item.id);
          if (pending) {
            waitingResolvers.delete(item.id);
            pending.resolve({
              id: item.id,
              title: item.title,
              answer: {
                answered: true,
                summary,
                data: { annotations: body.annotations, note: body.note || null },
              },
              note: ANSWERED_NOTE,
            });
          }
          sendJson(res, 200, { ok: true, answered: true });
          return;
        }

        const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
        if (!summary) {
          sendJson(res, 400, { ok: false, error: 'summary is required: describe the choice in a few words' });
          return;
        }
        if (summary.length > RENDER_PAGE_MAX_SUMMARY_LENGTH) {
          sendJson(res, 400, {
            ok: false,
            error: `summary is ${summary.length} characters; the limit is ${RENDER_PAGE_MAX_SUMMARY_LENGTH}`,
          });
          return;
        }
        const data = body.data === undefined ? null : body.data;
        const dataJsonLen = JSON.stringify(data).length;
        if (dataJsonLen > RENDER_PAGE_MAX_ANSWER_DATA_LENGTH) {
          sendJson(res, 413, {
            ok: false,
            error: `data is ${dataJsonLen} characters as JSON; the limit is ${RENDER_PAGE_MAX_ANSWER_DATA_LENGTH}`,
          });
          return;
        }

        updateItem(
          item.id,
          {
            status: 'answered',
            summary,
            answerData: data,
          },
          serverPort,
        );
        const pending = waitingResolvers.get(item.id);
        if (pending) {
          waitingResolvers.delete(item.id);
          pending.resolve({
            id: item.id,
            title: item.title,
            answer: { answered: true, summary, data },
            note: ANSWERED_NOTE,
          });
        }
        sendJson(res, 200, { ok: true, answered: true });
        return;
      }

      // 9. Request a zero-context secret (`request_secret`)
      if (req.method === 'POST' && pathname === '/api/secret/request') {
        const body = await readJsonBody(req);
        let validated;
        try {
          validated = validateSecretRequestInput(body);
        } catch (err) {
          sendJson(res, err.statusCode || 400, { ok: false, error: err.message });
          return;
        }

        const id = `secret_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
        const item = {
          id,
          kind: 'secret',
          title: validated.label,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          awaitAnswer: true,
          status: 'waiting',
          secretMeta: {
            label: validated.label,
            reason: validated.reason,
            placeholder: validated.placeholder,
          },
        };
        addItem(item, serverPort);

        const result = await waitForItemResolution(id, req, async (settledValue) => {
          // If the request aborted right as a file was saved, remove the orphan secret file
          const orphanFile = settledValue?.answer?.file;
          if (orphanFile) {
            await secretVault.remove(orphanFile).catch(() => {});
          }
        });
        sendJson(res, 200, { ok: true, data: result });
        return;
      }

      // 10. Submit or decline a secret (`POST /api/secret/answer`)
      if (req.method === 'POST' && pathname === '/api/secret/answer') {
        const body = await readJsonBody(req);
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        const item =
          (id && state.items.find((i) => i.id === id && i.kind === 'secret')) ||
          state.items.find((i) => i.kind === 'secret' && i.status === 'waiting');

        if (!item || item.status !== 'waiting') {
          sendJson(res, 404, { ok: false, error: 'This secret request is no longer waiting' });
          return;
        }

        const pending = waitingResolvers.get(item.id);
        if (!pending) {
          updateItem(item.id, { status: 'cancelled' }, serverPort);
          sendJson(res, 404, { ok: false, error: 'This secret request is no longer waiting' });
          return;
        }

        if (body.declined === true) {
          waitingResolvers.delete(item.id);
          updateItem(item.id, { status: 'declined', summary: `Declined: ${item.title}` }, serverPort);
          pending.resolve({
            id: item.id,
            label: item.title,
            answer: { status: 'declined' },
            note: DECLINED_NOTE,
          });
          sendJson(res, 200, { ok: true, status: 'declined' });
          return;
        }

        if (body.skipped === true) {
          waitingResolvers.delete(item.id);
          updateItem(item.id, { status: 'cancelled', summary: `Continued in chat` }, serverPort);
          pending.resolve({
            id: item.id,
            label: item.title,
            answer: { answered: false, reason: 'chat' },
            note: SECRET_CLOSED_NOTE,
          });
          sendJson(res, 200, { ok: true, status: 'cancelled' });
          return;
        }

        const value = typeof body.value === 'string' ? body.value : '';
        if (!value.trim()) {
          sendJson(res, 400, { ok: false, error: 'Secret value is required' });
          return;
        }
        if (value.length > SECRET_MAX_VALUE_LENGTH) {
          sendJson(res, 413, {
            ok: false,
            error: `Secret is ${value.length} characters; the limit is ${SECRET_MAX_VALUE_LENGTH}`,
          });
          return;
        }

        const file = await secretVault.write(value);
        waitingResolvers.delete(item.id);
        updateItem(
          item.id,
          {
            status: 'answered',
            summary: `Saved ${item.title} to private 0600 file (24h TTL)`,
          },
          serverPort,
        );
        pending.resolve({
          id: item.id,
          label: item.title,
          answer: { status: 'saved', file },
          note: SAVED_NOTE,
        });
        sendJson(res, 200, { ok: true, status: 'saved' });
        return;
      }

      sendJson(res, 404, { ok: false, error: `Unknown route: ${req.method} ${pathname}` });
    } catch (err) {
      sendJson(res, err.statusCode || 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  function waitForItemResolution(id, req, onAbortCleanup) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const onClose = () => {
        if (settled) return;
        settled = true;
        waitingResolvers.delete(id);
        updateItem(id, { status: 'cancelled', summary: 'Request aborted' }, serverPort);
        const err = new Error('The request stopped waiting before the user answered');
        err.statusCode = 499;
        reject(err);
      };
      req.on('close', onClose);

      waitingResolvers.set(id, {
        resolve: async (value) => {
          if (settled) {
            if (onAbortCleanup) await onAbortCleanup(value);
            return;
          }
          settled = true;
          req.removeListener('close', onClose);
          resolve(value);
        },
        reject,
      });
    });
  }

  await new Promise((resolve, reject) => {
    server.listen(serverPort, '127.0.0.1', () => {
      const addr = server.address();
      serverPort = typeof addr === 'object' && addr ? addr.port : serverPort;
      resolve();
    });
    server.on('error', reject);
  });

  await fs.writeFile(
    PORT_FILE,
    JSON.stringify({ port: serverPort, pid: process.pid, updatedAt: Date.now() }, null, 2),
    'utf8',
  );
  console.log(JSON.stringify({ status: 'ready', port: serverPort }));
}

startServer().catch((err) => {
  console.error('[interactive-render sidecar] fatal:', err);
  process.exit(1);
});
