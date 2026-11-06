import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
import { buildUiStandaloneBodyHtml, parseUiProgram } from './ui_blocks.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GEMINI_DIR = process.env.ANTIGRAVITY_GEMINI_DIR || path.join(os.homedir(), '.gemini');
export const DATA_DIR = path.join(GEMINI_DIR, 'antigravity', 'interactive-render');
const SECRETS_DIR = path.join(DATA_DIR, 'secrets');
const PAGES_DIR = path.join(DATA_DIR, 'pages');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
export const PORT_FILE = path.join(DATA_DIR, 'server.json');

const PANEL_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self' 'unsafe-inline' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; frame-src 'self' about: data: blob: http://127.0.0.1:* http://localhost:*; connect-src 'self' http://127.0.0.1:* http://localhost:*;",
};

const secretVault = createSecretFiles({ directory: SECRETS_DIR });

const state = {
  theme: 'dark',
  activeId: null,
  items: [],
};

const sseClients = new Set();
const waitingResolvers = new Map();

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
    items: state.items.map((item) => {
      const renderedDoc =
        item.kind === 'html' && item.html
          ? buildHtmlRenderDocument(item.html, {
              appearance: state.theme,
              answerState: {
                waiting: item.status === 'waiting',
                answer: item.answerData ?? null,
              },
              pageId: item.id,
              apiBaseUrl: `http://127.0.0.1:${serverPort}`,
            })
          : null;
      const validSecretFile =
        item.kind === 'secret' && item.secretFile && existsSync(item.secretFile)
          ? item.secretFile
          : null;
      return {
        id: item.id,
        kind: item.kind,
        title: item.title,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        awaitAnswer: item.awaitAnswer,
        status: item.status,
        summary: item.summary ?? null,
        answerData:
          item.kind === 'secret'
            ? validSecretFile
              ? { status: 'saved', file: validSecretFile }
              : null
            : (item.answerData ?? null),
        secretFile: validSecretFile,
        annotations: item.annotations ?? [],
        html: item.html ?? null,
        renderedDoc,
        uiSource: item.uiSource ?? null,
        uiAst: item.uiAst ?? null,
        uiErrors: item.uiErrors ?? null,
        embedPath: item.embedPath ?? null,
        secretMeta: item.secretMeta ?? null,
      };
    }),
  };
}

async function saveStateToDisk() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
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
      const secretFiles = await fs.readdir(SECRETS_DIR).catch(() => []);
      const singleSecretPath =
        secretFiles.length === 1 ? path.join(SECRETS_DIR, secretFiles[0]) : null;
      state.items = parsed.items.map((item) => {
        const next = {
          ...item,
          status: item.status === 'waiting' ? 'cancelled' : item.status,
        };
        if (next.kind === 'secret' && next.status === 'answered' && !next.secretFile && singleSecretPath) {
          next.secretFile = singleSecretPath;
        }
        return next;
      });
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
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

async function writeStandaloneEmbedPage(item, serverPort) {
  let rawBody = null;
  if (item.kind === 'html' && item.html) {
    rawBody = item.html;
  } else if (item.kind === 'ui' && item.uiAst) {
    rawBody = buildUiStandaloneBodyHtml(item.uiAst, item.title);
  }
  if (!rawBody) return null;
  await fs.mkdir(PAGES_DIR, { recursive: true });
  const filePath = path.join(PAGES_DIR, `${item.id}.html`);
  const doc = buildHtmlRenderDocument(rawBody, {
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

export async function startBrokerServer() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(PAGES_DIR, { recursive: true });
  await loadStateFromDisk();
  await secretVault.sweep().catch(() => {});

  setInterval(() => {
    void secretVault.sweep().catch(() => {});
  }, 60 * 60 * 1000).unref();

  let serverPort = 0;

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
      if (req.method === 'GET' && pathname === '/favicon.ico') {
        const svg = await fs.readFile(path.join(__dirname, '..', '..', 'assets', 'logo.svg'), 'utf8').catch(() => '');
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'max-age=86400' });
        res.end(svg);
        return;
      }
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

      if (req.method === 'GET' && pathname.startsWith('/api/pages/')) {
        const id = pathname.slice('/api/pages/'.length).replace(/\.html$/i, '');
        const item = state.items.find((i) => i.id === id);
        const rawBody =
          item?.kind === 'html'
            ? item.html
            : item?.kind === 'ui' && item.uiAst
              ? buildUiStandaloneBodyHtml(item.uiAst, item.title)
              : null;
        if (!item || !rawBody) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Page not found');
          return;
        }
        const doc = buildHtmlRenderDocument(rawBody, {
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

      if (req.method === 'GET' && pathname === '/api/state') {
        sendJson(res, 200, { ok: true, ...publicState(serverPort) });
        return;
      }

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

      if (req.method === 'POST' && pathname === '/api/clear') {
        state.items = state.items.filter((i) => i.status === 'waiting');
        state.activeId = state.items[0]?.id || null;
        void saveStateToDisk();
        broadcast('state', publicState(serverPort));
        sendJson(res, 200, { ok: true, ...publicState(serverPort) });
        return;
      }

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
            embedPath: null,
          };
          const embedPath = await writeStandaloneEmbedPage(item, serverPort).catch(() => null);
          item.embedPath = embedPath;
          addItem(item, serverPort);

          if (!awaitAnswer) {
            sendJson(res, 200, {
              ok: true,
              data: { id, shown: true, title, embedPath, note: SHOWN_NOTE },
            });
            return;
          }

          const answerResult = await waitForItemResolution(id, req);
          sendJson(res, 200, { ok: true, data: { ...answerResult, embedPath } });
          return;
        }

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

      if (req.method === 'POST' && pathname === '/api/render/answer') {
        const body = await readJsonBody(req);
        const pageId = typeof body.pageId === 'string' ? body.pageId.trim() : '';
        const item =
          (pageId && state.items.find((i) => i.id === pageId)) ||
          state.items.find((i) => i.status === 'waiting' && i.kind !== 'secret');
        if (!item) {
          sendJson(res, 404, { ok: false, error: 'No matching page found' });
          return;
        }

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
          const orphanFile = settledValue?.answer?.file;
          if (orphanFile) {
            await secretVault.remove(orphanFile).catch(() => {});
          }
        });
        sendJson(res, 200, { ok: true, data: result });
        return;
      }

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
            secretFile: file,
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
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      serverPort = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
    server.on('error', reject);
  });

  const info = { port: serverPort, pid: process.pid, updatedAt: Date.now() };
  await fs.writeFile(PORT_FILE, JSON.stringify(info, null, 2), 'utf8');
  return info;
}

export function requestBroker(port, reqPath, method = 'GET', body = null, { longPoll = false } = {}) {
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
            resolve({ statusCode: res.statusCode || 200, data: text ? JSON.parse(text) : {} });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    if (!longPoll) {
      req.on('timeout', () => req.destroy(new Error('Request to interactive-render broker timed out')));
    }
    if (payload) req.write(payload);
    req.end();
  });
}

export async function ensureBrokerRunning() {
  try {
    if (existsSync(PORT_FILE)) {
      const info = JSON.parse(readFileSync(PORT_FILE, 'utf8'));
      if (info && typeof info.port === 'number' && info.port > 0) {
        const check = await requestBroker(info.port, '/api/state', 'GET');
        if (check.statusCode === 200 && check.data?.ok) {
          return info;
        }
      }
    }
  } catch {
    // Broker not running yet
  }

  // If this process is the daemon itself, start in-process
  if (process.argv.includes('--daemon') || !process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
    return startBrokerServer();
  }

  // Spawn detached daemon so the Broker outlives Sidecar UI restarts
  const child = spawn(process.execPath, [__filename, '--daemon'], {
    cwd: __dirname,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      if (existsSync(PORT_FILE)) {
        const info = JSON.parse(readFileSync(PORT_FILE, 'utf8'));
        if (info?.port) {
          const check = await requestBroker(info.port, '/api/state', 'GET');
          if (check.statusCode === 200 && check.data?.ok) {
            return info;
          }
        }
      }
    } catch {
      // Wait for startup
    }
  }
  return startBrokerServer();
}

const isMain = Boolean(
  process.argv[1] &&
    (process.platform === 'win32'
      ? __filename.toLowerCase() === path.resolve(process.argv[1]).toLowerCase()
      : __filename === path.resolve(process.argv[1])),
);

if (isMain && process.argv.includes('--daemon')) {
  const info = await startBrokerServer();
  console.log(JSON.stringify({ status: 'ready', port: info.port }));
  setInterval(() => {}, 60000);
} else if (isMain && process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  await ensureBrokerRunning();
  const { Response, SidecarApp } = await import('sidecar_sdk');
  const app = new SidecarApp();

  const forward = async (reqPath, method, data) => {
    const info = await ensureBrokerRunning();
    const res = await requestBroker(info.port, reqPath, method, method === 'POST' ? data || {} : null);
    return new Response(JSON.stringify(res.data), {
      status: res.statusCode || 200,
      contentType: 'application/json; charset=utf-8',
      headers: PANEL_SECURITY_HEADERS,
    });
  };

  app.page('/', () =>
    new Response(readFileSync(path.join(__dirname, 'index.html'), 'utf8'), {
      contentType: 'text/html; charset=utf-8',
      headers: PANEL_SECURITY_HEADERS,
    }),
  );

  app.page('/app.js', () =>
    new Response(readFileSync(path.join(__dirname, 'app.js'), 'utf8'), {
      contentType: 'application/javascript; charset=utf-8',
      headers: PANEL_SECURITY_HEADERS,
    }),
  );

  app.api('/api/state', (data) => forward('/api/state', 'GET', data), 'GET');
  app.api('/api/select', (data) => forward('/api/select', 'POST', data), 'POST');
  app.api('/api/clear', (data) => forward('/api/clear', 'POST', data), 'POST');
  app.api('/api/render', (data) => forward('/api/render', 'POST', data), 'POST');
  app.api('/api/render/answer', (data) => forward('/api/render/answer', 'POST', data), 'POST');
  app.api('/api/secret/request', (data) => forward('/api/secret/request', 'POST', data), 'POST');
  app.api('/api/secret/answer', (data) => forward('/api/secret/answer', 'POST', data), 'POST');

  app.run();
} else if (isMain) {
  const info = await startBrokerServer();
  console.log(JSON.stringify({ status: 'ready', port: info.port }));
  setInterval(() => {}, 60000);
}
