import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RENDER_PAGE_MAX_HTML_LENGTH = 200_000;
export const RENDER_PAGE_MAX_TITLE_LENGTH = 120;
export const RENDER_PAGE_MAX_SUMMARY_LENGTH = 500;
export const RENDER_PAGE_MAX_ANSWER_DATA_LENGTH = 16_000;
export const RENDER_PAGE_IMAGE_BUDGET_BYTES = 25 * 1024 * 1024;
export const RENDER_PAGE_SINGLE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export const SHOWN_NOTE =
  "Shown to the user in the Interactive Render panel. Don't restate the page's contents in full; highlight only what needs attention.";
export const ANSWERED_NOTE =
  'The user answered on the page. summary is their choice in words, data is the structured payload sent by the page. Continue the task from it.';
export const RENDER_PAGE_CLOSED_IN_CHAT_NOTE =
  'The user skipped answering on the page and chose to continue in chat instead.';
export const UI_NOT_DRAWN_NOTE =
  'The renderer could not draw this ui specification. Fix the errors listed below and call render_page again.';

const LOCAL_IMAGE_RE =
  /(["'`])((?:file:\/\/|\/(?!\/)|[A-Za-z]:[\\/])[^"'`<>\n]*?\.(?:png|jpe?g|gif|webp))\1|url\(\s*((?:file:\/\/|\/(?!\/)|[A-Za-z]:[\\/])[^"'`<>()\s]*?\.(?:png|jpe?g|gif|webp))\s*\)/gi;

const CHART_SERIES = {
  dark: ['#60a5fa', '#2dd4bf', '#a78bfa', '#f472b6', '#a3e635', '#fbbf24'],
  light: ['#2563eb', '#0d9488', '#7c3aed', '#db2777', '#65a30d', '#d97706'],
};

const TONES = ['success', 'warning', 'error', 'info'];

const rem = (amount) => `calc(var(--oc-rem,1rem) * ${amount})`;

export const KIT_SHARED_CSS =
  `.oc-box{box-sizing:border-box;padding:${rem(0.625)} ${rem(0.75)};border-radius:${rem(0.75)};background-color:color-mix(in srgb,var(--foreground) var(--oc-tile-tone),transparent)}` +
  '.oc-box .oc-box{background-color:color-mix(in srgb,var(--foreground) var(--oc-tile-inset-tone),transparent)}' +
  '.oc-badge{display:inline-flex;align-items:center;padding:.0625em .5em;border-radius:999px;background-color:color-mix(in srgb,var(--foreground) 6%,transparent);color:var(--muted-foreground);font-size:.8125em;font-weight:500;line-height:1.45;white-space:nowrap}' +
  '.oc-badge[data-tone]{background-color:color-mix(in srgb,var(--oc-tone) 15%,transparent);color:var(--oc-tone-text)}' +
  TONES.map((t) => `.oc-badge[data-tone=${t}]{--oc-tone:var(--oc-tone-${t});--oc-tone-text:var(--oc-${t}-text)}`).join('') +
  '.oc-dot{display:inline-block;width:.5em;height:.5em;border-radius:50%;background-color:var(--color,var(--oc-series-1));vertical-align:.1em}' +
  '.oc-track,.oc-bar{background-color:color-mix(in srgb,var(--foreground) 6%,transparent)}' +
  `.oc-bar{display:block;height:${rem(0.375)};border-radius:999px;overflow:hidden}` +
  '.oc-bar::before{content:"";display:block;width:var(--value,0%);max-width:100%;height:100%;border-radius:inherit;background-color:var(--color,var(--oc-series-1))}';

const OPTION_CSS =
  '.oc-options{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr))}' +
  '.oc-option{display:flex;flex-direction:column;justify-content:flex-start;align-items:flex-start;gap:4px;box-sizing:border-box;width:100%;padding:14px 16px;border:1px solid transparent;border-radius:var(--radius);background-color:color-mix(in srgb,var(--foreground) var(--oc-tile-tone),transparent);color:var(--foreground);font:inherit;text-align:start;cursor:pointer;transition:background-color .15s,color .15s,border-color .15s}' +
  '.oc-option:hover,.oc-option:focus-visible{background-color:color-mix(in srgb,var(--foreground) var(--oc-tile-hover-tone),transparent);outline:none}' +
  '.oc-option[aria-pressed=true]{background-color:var(--oc-selection);color:var(--oc-selection-foreground);border-color:color-mix(in srgb,var(--primary) 45%,transparent)}' +
  '.oc-button{display:inline-flex;align-items:center;justify-content:center; gap:6px;box-sizing:border-box;height:calc(var(--oc-rem) * 2);padding:0 calc(var(--oc-rem) * .75);border:1px solid var(--oc-button-border);border-radius:calc(var(--oc-rem) * .4375);background-color:var(--oc-button-bg);box-shadow:var(--oc-button-shadow);color:var(--oc-button-text);font:inherit;font-size:calc(var(--oc-rem) * .84375);line-height:1.45;font-weight:500;white-space:nowrap;cursor:pointer;transition:background-color .15s}' +
  '.oc-button:hover,.oc-button:focus-visible{background-color:var(--oc-button-hover);outline:none}.oc-button:active{background-color:var(--oc-button-active);box-shadow:none}' +
  '.oc-button:disabled{opacity:.5;cursor:default;pointer-events:none}' +
  '.oc-button[data-variant=outline]{--oc-button-bg:var(--oc-raised-bg);--oc-button-hover:color-mix(in srgb,var(--foreground) 6%,var(--oc-raised-bg));--oc-button-active:color-mix(in srgb,var(--foreground) 10%,var(--oc-raised-bg));--oc-button-border:var(--oc-edge);--oc-button-text:var(--card-foreground)}' +
  '.oc-button[data-variant=destructive]{--oc-button-bg:var(--oc-destructive-bg);--oc-button-hover:var(--oc-destructive-hover);--oc-button-active:var(--oc-destructive-active);--oc-button-border:var(--oc-destructive-border);--oc-button-text:var(--oc-destructive-text)}';

const CHEVRON =
  'linear-gradient(45deg,transparent 50%,var(--muted-foreground) 50%),linear-gradient(135deg,var(--muted-foreground) 50%,transparent 50%)';

const KIT_CSS =
  KIT_SHARED_CSS +
  '.oc-muted{color:var(--muted-foreground)}' +
  '.oc-num{font-variant-numeric:tabular-nums;text-align:end}' +
  '.oc-table{overflow-x:auto;overscroll-behavior-x:none;border:1px solid color-mix(in srgb,var(--border) 70%,transparent);border-radius:calc(var(--oc-rem) * .5);background-color:var(--card)}' +
  '.oc-table table{width:100%;border-collapse:collapse}' +
  '.oc-table th,.oc-table td{padding:.625em 1em;text-align:start;vertical-align:middle;border-bottom:1px solid color-mix(in srgb,var(--border) 40%,transparent)}' +
  '.oc-table th{font-weight:600}.oc-table td{color:color-mix(in srgb,var(--foreground) 90%,transparent)}' +
  '.oc-table tr:last-child>td{border-bottom:0}.oc-table .oc-num{text-align:end}' +
  '.oc-field{display:flex;flex-direction:column;gap:6px;min-width:0;font-size:calc(var(--oc-rem) * .8125);font-weight:500}' +
  '.oc-field .oc-muted{font-weight:400}' +
  '.oc-input{box-sizing:border-box;width:100%;min-width:0;height:calc(var(--oc-rem) * 2);margin:0;padding:0 calc(var(--oc-rem) * .625);border:1px solid var(--oc-edge);border-radius:calc(var(--oc-rem) * .4375);background-color:var(--oc-field-bg);color:var(--card-foreground);font:inherit;font-size:calc(var(--oc-rem) * .84375);font-weight:400;line-height:1.45;outline:none;transition:border-color .15s,background-color .15s}' +
  '.oc-input::placeholder{color:var(--muted-foreground)}' +
  '.oc-input:focus{border-color:var(--primary)}' +
  '.oc-input[aria-invalid=true]{border-color:var(--destructive)}' +
  '.oc-input:disabled{opacity:.5;cursor:default}' +
  'textarea.oc-input{height:auto;min-height:calc(var(--oc-rem) * 4);padding:calc(var(--oc-rem) * .5) calc(var(--oc-rem) * .625);resize:vertical}' +
  `select.oc-input{appearance:none;-webkit-appearance:none;padding-inline-end:calc(var(--oc-rem) * 1.75);background-image:${CHEVRON};background-position:calc(100% - calc(var(--oc-rem) * 1.0625)) 50%,calc(100% - calc(var(--oc-rem) * .75)) 50%;background-size:5px 5px;background-repeat:no-repeat;cursor:pointer}` +
  '.oc-switch{appearance:none;-webkit-appearance:none;position:relative;flex:none;box-sizing:border-box;width:36px;height:20px;margin:0;border:2px solid transparent;border-radius:999px;background-color:var(--border);vertical-align:middle;cursor:pointer;transition:background-color .15s}' +
  '.oc-switch::before{content:"";position:absolute;top:0;inset-inline-start:0;width:16px;height:16px;border-radius:50%;background-color:var(--muted-foreground);transition:transform .15s}' +
  '.oc-switch:checked{background-color:var(--primary)}' +
  '.oc-switch:checked::before{background-color:var(--primary-foreground);transform:translateX(16px)}' +
  '.oc-segmented{display:inline-flex;width:fit-content;max-width:100%;gap:2px;padding:2px;box-sizing:border-box;overflow-x:auto;border-radius:calc(var(--oc-rem) * .625);background-color:color-mix(in srgb,var(--foreground) 5%,transparent)}' +
  '.oc-segmented>button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:calc(var(--oc-rem) * 1.75);padding:0 calc(var(--oc-rem) * .625);border:0;border-radius:calc(var(--oc-rem) * .5);background:transparent;color:var(--muted-foreground);font:inherit;font-size:calc(var(--oc-rem) * .8125);font-weight:500;white-space:nowrap;cursor:pointer;transition:color .15s}' +
  '.oc-segmented>button:hover,.oc-segmented>button:focus-visible{color:var(--foreground);outline:none}' +
  '.oc-segmented>button[aria-pressed=true]{background-color:var(--oc-raised-bg);box-shadow:0 1px 2px rgb(0 0 0 / 0.2);color:var(--card-foreground)}';

export const BASE_CSS =
  'html{background:transparent;color:var(--foreground);font-family:var(--font-sans);font-size:var(--oc-text,14px);line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;overflow-x:auto;overscroll-behavior-x:none}' +
  'body{margin:0;padding:4px 2px}a{color:var(--primary)}code,kbd,pre,samp{font-family:var(--font-mono)}img,svg,video,canvas{max-width:100%}' +
  OPTION_CSS +
  KIT_CSS;

export function htmlRenderTheme(appearance = 'dark') {
  const dark = appearance !== 'light';
  const series = CHART_SERIES[dark ? 'dark' : 'light'];
  const variables = dark
    ? {
        '--background': '#0c0e14',
        '--foreground': '#e5e7eb',
        '--muted': '#161b26',
        '--muted-foreground': '#9ca3af',
        '--card': '#131722',
        '--card-foreground': '#f3f4f6',
        '--border': '#262d3d',
        '--primary': '#60a5fa',
        '--primary-foreground': '#090d16',
        '--destructive': '#f87171',
        '--warning': '#fbbf24',
        '--success': '#34d399',
        '--info': '#38bdf8',
        '--code-background': '#111520',
        '--code-foreground': '#e2e8f0',
        '--oc-tile-tone': '4%',
        '--oc-tile-inset-tone': '6%',
        '--oc-tile-hover-tone': '7.5%',
        '--oc-tone-success': '#34d399',
        '--oc-tone-warning': '#fbbf24',
        '--oc-tone-error': '#f87171',
        '--oc-tone-info': '#38bdf8',
        '--oc-success-text': '#6ee7b7',
        '--oc-warning-text': '#fde68a',
        '--oc-error-text': '#fca5a5',
        '--oc-info-text': '#7dd3fc',
        '--oc-button-text': '#93c5fd',
        '--oc-button-bg': 'rgba(96, 165, 250, 0.16)',
        '--oc-button-hover': 'rgba(96, 165, 250, 0.24)',
        '--oc-button-active': 'rgba(96, 165, 250, 0.32)',
        '--oc-button-border': 'rgba(96, 165, 250, 0.28)',
        '--oc-button-shadow': '0 1px 2px rgba(0,0,0,0.35)',
        '--oc-destructive-text': '#fca5a5',
        '--oc-destructive-bg': 'rgba(248, 113, 113, 0.14)',
        '--oc-destructive-hover': 'rgba(248, 113, 113, 0.22)',
        '--oc-destructive-active': 'rgba(248, 113, 113, 0.30)',
        '--oc-destructive-border': 'rgba(248, 113, 113, 0.25)',
        '--oc-selection': 'rgba(96, 165, 250, 0.20)',
        '--oc-selection-foreground': '#eff6ff',
        '--oc-edge': 'rgba(255, 255, 255, 0.14)',
        '--oc-field-bg': '#10141d',
        '--oc-raised-bg': '#181e2c',
      }
    : {
        '--background': '#ffffff',
        '--foreground': '#111827',
        '--muted': '#f3f4f6',
        '--muted-foreground': '#6b7280',
        '--card': '#f9fafb',
        '--card-foreground': '#111827',
        '--border': '#e5e7eb',
        '--primary': '#2563eb',
        '--primary-foreground': '#ffffff',
        '--destructive': '#dc2626',
        '--warning': '#d97706',
        '--success': '#059669',
        '--info': '#0284c7',
        '--code-background': '#f3f4f6',
        '--code-foreground': '#1f2937',
        '--oc-tile-tone': '4%',
        '--oc-tile-inset-tone': '6%',
        '--oc-tile-hover-tone': '7.5%',
        '--oc-tone-success': '#059669',
        '--oc-tone-warning': '#d97706',
        '--oc-tone-error': '#dc2626',
        '--oc-tone-info': '#0284c7',
        '--oc-success-text': '#065f46',
        '--oc-warning-text': '#92400e',
        '--oc-error-text': '#991b1b',
        '--oc-info-text': '#075985',
        '--oc-button-text': '#1d4ed8',
        '--oc-button-bg': 'rgba(37, 99, 235, 0.10)',
        '--oc-button-hover': 'rgba(37, 99, 235, 0.16)',
        '--oc-button-active': 'rgba(37, 99, 235, 0.22)',
        '--oc-button-border': 'rgba(37, 99, 235, 0.20)',
        '--oc-button-shadow': '0 1px 2px rgba(0,0,0,0.06)',
        '--oc-destructive-text': '#b91c1c',
        '--oc-destructive-bg': 'rgba(220, 38, 38, 0.08)',
        '--oc-destructive-hover': 'rgba(220, 38, 38, 0.14)',
        '--oc-destructive-active': 'rgba(220, 38, 38, 0.20)',
        '--oc-destructive-border': 'rgba(220, 38, 38, 0.18)',
        '--oc-selection': 'rgba(37, 99, 235, 0.14)',
        '--oc-selection-foreground': '#1e3a8a',
        '--oc-edge': 'rgba(17, 24, 39, 0.15)',
        '--oc-field-bg': '#ffffff',
        '--oc-raised-bg': '#ffffff',
      };

  series.forEach((color, idx) => {
    variables[`--chart-${idx + 1}`] = color;
    variables[`--oc-series-${idx + 1}`] = `var(--chart-${idx + 1})`;
  });
  variables['--oc-rem'] = '16px';
  variables['--oc-text'] = '14px';
  variables['--radius'] = '9px';
  variables['--font-sans'] = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  variables['--font-mono'] = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

  return { appearance: dark ? 'dark' : 'light', variables };
}

function themeCss(theme) {
  const decls = Object.entries(theme.variables)
    .map(([k, v]) => `${k}:${String(v).replace(/[;{}<>]/g, '')};`)
    .join('');
  return `:root{color-scheme:${theme.appearance};${decls}}${BASE_CSS}`;
}

/**
 * Bootstrap & answer bridge injected into `<head>` of every rendered HTML page.
 * Supports:
 * - Dynamic height measurement (`openchamber:html-render:size`)
 * - Theme live switching (`openchamber:html-render:theme`)
 * - `window.openchamber.submit(data, summary)` & `window.antigravity.submit(data, summary)`
 * - Element inspection & region annotation bridge (`openchamber:html-render:annotate`)
 * - Direct HTTP fallback when opened as a standalone `<agent-embed>` file
 */
export function buildHtmlRenderDocument(
  html,
  {
    appearance = 'dark',
    answerState = { waiting: false, answer: null },
    pageId = '',
    apiBaseUrl = '',
  } = {},
) {
  const theme = htmlRenderTheme(appearance);
  const safeStateJson = JSON.stringify({
    waiting: Boolean(answerState?.waiting),
    answer: answerState?.answer ?? null,
    pageId,
    apiBaseUrl,
  }).replace(/</g, '\\u003c');

  const bootstrapScript = `(function(){
  var styleEl = document.getElementById("oc-html-render-theme");
  var baseCss = ${JSON.stringify(BASE_CSS)};
  window.addEventListener("message", function(e){
    var d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "openchamber:html-render:theme" && d.variables) {
      var c = ":root{color-scheme:" + (d.appearance === "light" ? "light" : "dark") + ";";
      for (var k in d.variables) {
        if (/^--[a-z0-9-]+$/.test(k)) c += k + ":" + String(d.variables[k]).replace(/[;{}<>]/g, "") + ";";
      }
      if (styleEl) styleEl.textContent = c + "}" + baseCss;
    }
  });
  document.addEventListener("click", function(e){
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    try {
      var u = new URL(a.getAttribute("href"), document.baseURI);
      if (/^https?:$/.test(u.protocol)) {
        e.preventDefault();
        window.parent.postMessage({ type: "openchamber:html-render:open-link", url: u.href }, "*");
      }
    } catch (_) {}
  }, true);

  var lastH = 0;
  function reportHeight() {
    var r = document.documentElement, b = document.body;
    if (!r) return;
    var h = Math.max(r.scrollHeight, r.getBoundingClientRect().height, b ? b.scrollHeight : 0);
    h = Math.max(48, Math.min(20000, Math.ceil(h)));
    if (Math.abs(h - lastH) < 2) return;
    lastH = h;
    if (window.parent !== window) {
      window.parent.postMessage({ type: "openchamber:html-render:size", height: h, pageId: S.pageId }, "*");
    }
  }
  window.addEventListener("resize", reportHeight);
  window.addEventListener("load", reportHeight);
  document.addEventListener("DOMContentLoaded", function(){
    reportHeight();
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(reportHeight);
      ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body);
    }
  });

  // Annotation mode inside the iframe: click an element to capture its selector, text, and bounding box
  var annotating = false;
  var hoverBox = null;
  function ensureHoverBox() {
    if (hoverBox) return hoverBox;
    hoverBox = document.createElement("div");
    hoverBox.style.cssText = "position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #60a5fa;background:rgba(96,165,250,0.14);border-radius:4px;display:none;transition:all 0.05s ease;";
    document.documentElement.appendChild(hoverBox);
    return hoverBox;
  }
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return "body";
    if (el.id) return "#" + el.id;
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement && parts.length < 4) {
      var tag = el.tagName.toLowerCase();
      if (el.className && typeof el.className === "string") {
        var cls = el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2).join(".");
        if (cls) tag += "." + cls;
      }
      parts.unshift(tag);
      el = el.parentElement;
    }
    return parts.join(" > ") || "body";
  }
  window.addEventListener("message", function(e){
    var d = e.data;
    if (!d || d.type !== "openchamber:html-render:annotate-mode") return;
    annotating = Boolean(d.enabled);
    document.documentElement.style.cursor = annotating ? "crosshair" : "";
    if (!annotating && hoverBox) hoverBox.style.display = "none";
  });
  document.addEventListener("mousemove", function(e){
    if (!annotating) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === hoverBox) return;
    var r = el.getBoundingClientRect();
    var box = ensureHoverBox();
    box.style.display = "block";
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
  }, true);
  document.addEventListener("click", function(e){
    if (!annotating) return;
    e.preventDefault();
    e.stopPropagation();
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    var r = el.getBoundingClientRect();
    window.parent.postMessage({
      type: "openchamber:html-render:element-picked",
      pageId: S.pageId,
      selector: cssPath(el),
      text: (el.innerText || el.textContent || "").trim().slice(0, 120),
      rect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
    }, "*");
  }, true);

  var S = JSON.parse(document.getElementById("oc-html-render-answer").textContent);
  var reqId = 0, pending = {};
  var api = {
    answer: S.answer === null ? undefined : S.answer,
    submit: function(data, summary) {
      return new Promise(function(res, rej) {
        if (!S.waiting) return rej(new Error("This page is not waiting for an answer"));
        if (navigator.userActivation && !navigator.userActivation.isActive) {
          return rej(new Error("submit works only from a user click"));
        }
        if (typeof summary !== "string" || !summary.trim()) {
          return rej(new Error("summary is required: describe the choice in a few words"));
        }
        var payload = data === undefined ? null : data;
        if (window.parent !== window) {
          var id = ++reqId;
          pending[id] = { res: res, rej: rej, data: payload };
          window.parent.postMessage({
            jsonrpc: "2.0",
            id: id,
            method: "ui/message",
            params: {
              role: "user",
              content: [{ type: "text", text: summary.trim() }],
              _meta: { "openchamber/data": payload, pageId: S.pageId }
            }
          }, "*");
        } else if (S.apiBaseUrl && S.pageId) {
          fetch(S.apiBaseUrl + "/api/render/answer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pageId: S.pageId, summary: summary.trim(), data: payload })
          }).then(function(r){ return r.json(); }).then(function(j){
            if (!j.ok) throw new Error(j.error || "Submit failed");
            S.waiting = false;
            S.answer = payload;
            api.answer = payload;
            res();
          }).catch(rej);
        } else {
          rej(new Error("No host bridge available"));
        }
      });
    }
  };
  window.openchamber = api;
  window.antigravity = api;

  window.addEventListener("message", function(e){
    var d = e.data;
    if (!d) return;
    if (d.type === "openchamber:html-render:answer-state") {
      S.waiting = d.waiting === true;
      S.answer = d.answer === undefined ? null : d.answer;
      api.answer = S.answer === null ? undefined : S.answer;
      return;
    }
    if (d.jsonrpc === "2.0" && pending[d.id]) {
      var p = pending[d.id];
      delete pending[d.id];
      if (d.error) p.rej(new Error(String(d.error.message || "The answer was not sent")));
      else {
        S.waiting = false;
        S.answer = p.data;
        api.answer = p.data;
        p.res();
      }
    }
  });
})();`;

  const headInjection = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="oc-html-render-theme">${themeCss(theme)}</style>`,
    `<script type="application/json" id="oc-html-render-answer">${safeStateJson}</script>`,
    `<script>${bootstrapScript}</script>`,
  ].join('');

  const headOpen = /<head(?:\s[^>]*)?>/i.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + headInjection + html.slice(at);
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(html);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${headInjection}</head>${html.slice(at)}`;
  }
  return `<!doctype html><html><head>${headInjection}</head><body>${html}</body></html>`;
}

export function extractPageTitleFromHtml(html) {
  if (typeof html !== 'string') return '';
  const clean = (m) =>
    (m?.[1] ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, RENDER_PAGE_MAX_TITLE_LENGTH);
  return (
    clean(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)) ||
    clean(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html))
  );
}

function resolveLocalImagePath(rawSource, directory) {
  let filePath = rawSource.trim();
  if (filePath.toLowerCase().startsWith('file://')) {
    try {
      filePath = fileURLToPath(filePath);
    } catch {
      filePath = filePath.replace(/^file:\/\//i, '');
    }
  }
  if (!path.isAbsolute(filePath) && directory) {
    filePath = path.resolve(directory, filePath);
  }
  return filePath;
}

function detectMimeFromBuffer(buf, filePath) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 6 && buf.subarray(0, 3).toString('ascii') === 'GIF') {
    return 'image/gif';
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return null;
}

/**
 * Finds local image paths referenced in `html`, checks their existence and 25MB
 * page budget, replaces valid images with inline `data:` URLs so the opaque
 * `srcdoc` iframe can render them safely, and returns hidden-image diagnostics
 * for the Agent.
 */
export async function inlineAndDescribeLocalImages(html, directory) {
  if (typeof html !== 'string' || !html) {
    return { html: '', hiddenReport: null };
  }
  const matches = [...html.matchAll(LOCAL_IMAGE_RE)];
  if (matches.length === 0) {
    return { html, hiddenReport: null };
  }
  const uniqueSources = [...new Set(matches.map((m) => m[2] ?? m[3]).filter(Boolean))];
  const replacements = new Map();
  const images = [];
  let shownBytes = 0;
  let totalBytes = 0;
  let budgetExceeded = false;

  for (const source of uniqueSources) {
    const resolved = resolveLocalImagePath(source, directory);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat || !stat.isFile()) {
      images.push({ source, status: 'missing' });
      continue;
    }
    if (stat.size > RENDER_PAGE_SINGLE_IMAGE_MAX_BYTES || stat.size <= 0) {
      images.push({ source, status: 'error' });
      continue;
    }
    totalBytes += stat.size;
    if (budgetExceeded || shownBytes + stat.size > RENDER_PAGE_IMAGE_BUDGET_BYTES) {
      budgetExceeded = true;
      images.push({ source, status: 'too-heavy', size: stat.size });
      continue;
    }
    const buf = await fs.readFile(resolved).catch(() => null);
    const mime = buf ? detectMimeFromBuffer(buf, resolved) : null;
    if (!buf || !mime) {
      images.push({ source, status: 'error' });
      continue;
    }
    shownBytes += stat.size;
    replacements.set(source, `data:${mime};base64,${buf.toString('base64')}`);
    images.push({ source, status: 'ready', size: stat.size });
  }

  let inlinedHtml = html;
  for (const [source, dataUrl] of replacements.entries()) {
    inlinedHtml = inlinedHtml.split(source).join(dataUrl);
  }

  const NOT_SHOWN_REASONS = {
    'too-heavy': 'past the 25 MB page budget',
    missing: 'file not found',
    error: 'not a readable PNG, JPEG, GIF or WebP of at most 10 MB',
  };
  const hidden = images.filter((img) => img.status !== 'ready');
  if (hidden.length === 0) {
    return { html: inlinedHtml, hiddenReport: null };
  }
  const tooHeavy = hidden.some((img) => img.status === 'too-heavy');
  const toMB = (b) => Math.round((b / (1024 * 1024)) * 10) / 10;
  return {
    html: inlinedHtml,
    hiddenReport: {
      images: {
        shown: images.length - hidden.length,
        notShown: hidden.map((img) => ({ src: img.source, reason: NOT_SHOWN_REASONS[img.status] })),
        ...(tooHeavy
          ? { weightMB: toMB(totalBytes), budgetMB: toMB(RENDER_PAGE_IMAGE_BUDGET_BYTES) }
          : {}),
      },
      note: tooHeavy
        ? 'Some local images on the page were not shown because total image weight exceeded the 25 MB page budget.'
        : 'Some local images on the page could not be loaded; see images.notShown.',
    },
  };
}
