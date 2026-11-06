const state = {
  theme: 'dark',
  activeId: null,
  serverPort: 0,
  waitingCount: 0,
  items: [],
  annotating: false,
  draftAnnotations: [], // { selector, text, rect, comment }
  uiFormState: new Map(), // itemId -> { values: {}, note: '', activeTab: {} }
};

const waitingBadge = document.getElementById('waitingBadge');
const waitingCountText = document.getElementById('waitingCountText');
const annotateBtn = document.getElementById('annotateBtn');
const copyEmbedBtn = document.getElementById('copyEmbedBtn');
const downloadBtn = document.getElementById('downloadBtn');
const themeBtn = document.getElementById('themeBtn');
const clearBtn = document.getElementById('clearBtn');
const itemStrip = document.getElementById('itemStrip');
const mainArea = document.getElementById('mainArea');
const toastEl = document.getElementById('toast');

let currentIframe = null;
let lastRenderedSignature = '';

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.style.display = 'block';
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toastEl.style.display = 'none';
  }, 2600);
}

function getActiveItem() {
  return state.items.find((i) => i.id === state.activeId) || state.items[0] || null;
}

function ensureFormState(itemId) {
  if (!state.uiFormState.has(itemId)) {
    state.uiFormState.set(itemId, { values: {}, note: '', activeTabs: {} });
  }
  return state.uiFormState.get(itemId);
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function applyTheme(theme) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', state.theme);
  themeBtn.textContent = state.theme === 'dark' ? 'Light' : 'Dark';
}

function renderTopBarAndTabs() {
  if (state.waitingCount > 0) {
    waitingBadge.style.display = 'inline-flex';
    waitingCountText.textContent = `${state.waitingCount} Waiting`;
  } else {
    waitingBadge.style.display = 'none';
  }

  const active = getActiveItem();
  const isHtml = active && active.kind === 'html';
  annotateBtn.style.display = isHtml ? 'inline-flex' : 'none';
  annotateBtn.classList.toggle('active', Boolean(isHtml && state.annotating));
  copyEmbedBtn.style.display = isHtml && active.embedPath ? 'inline-flex' : 'none';
  downloadBtn.style.display = isHtml ? 'inline-flex' : 'none';

  if (state.items.length === 0) {
    itemStrip.style.display = 'none';
    itemStrip.innerHTML = '';
    return;
  }

  itemStrip.style.display = 'flex';
  itemStrip.innerHTML = '';
  for (const item of state.items) {
    const btn = document.createElement('button');
    btn.className = `item-tab${item.id === active?.id ? ' active' : ''}${item.status === 'waiting' ? ' waiting' : ''}`;
    const tag = document.createElement('span');
    tag.className = 'kind-tag';
    tag.textContent = item.kind;
    btn.appendChild(tag);

    if (item.status === 'waiting') {
      const dot = document.createElement('span');
      dot.className = 'wait-dot';
      btn.appendChild(dot);
    }

    const label = document.createElement('span');
    label.style.overflow = 'hidden';
    label.style.textOverflow = 'ellipsis';
    label.textContent = item.title;
    btn.appendChild(label);

    btn.addEventListener('click', () => {
      state.annotating = false;
      state.draftAnnotations = [];
      void postJson('/api/select', { activeId: item.id });
    });
    itemStrip.appendChild(btn);
  }
}

function renderSecretCard(item) {
  const wrap = document.createElement('div');
  wrap.className = 'secret-card';

  const meta = item.secretMeta || { label: item.title, reason: '', placeholder: '' };
  const reasonP = document.createElement('p');
  reasonP.className = 'secret-reason';
  reasonP.textContent = meta.reason;
  wrap.appendChild(reasonP);

  if (item.status !== 'waiting') {
    const banner = document.createElement('div');
    banner.className = 'settled-banner';
    banner.textContent = item.summary || `Status: ${item.status}`;
    wrap.appendChild(banner);
    return wrap;
  }

  const form = document.createElement('form');
  form.className = 'secret-input-row';
  const input = document.createElement('input');
  input.type = 'password';
  input.className = 'input';
  input.placeholder = meta.placeholder || 'Paste secret token or password...';
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('data-1p-ignore', '');
  input.setAttribute('data-lpignore', 'true');
  input.setAttribute('data-bwignore', '');

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'btn';
  toggleBtn.textContent = 'Show';
  toggleBtn.addEventListener('click', () => {
    const isPwd = input.type === 'password';
    input.type = isPwd ? 'text' : 'password';
    toggleBtn.textContent = isPwd ? 'Hide' : 'Show';
  });

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = 'Save Securely';

  form.appendChild(input);
  form.appendChild(toggleBtn);
  form.appendChild(saveBtn);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const val = input.value;
    if (!val.trim()) {
      showToast('Please enter a non-empty secret value');
      return;
    }
    saveBtn.disabled = true;
    try {
      await postJson('/api/secret/answer', { id: item.id, value: val });
      input.value = '';
      showToast('Saved to 0600 file (zero context exposure)');
    } catch (err) {
      showToast(err.message);
      saveBtn.disabled = false;
    }
  });
  wrap.appendChild(form);

  const footer = document.createElement('div');
  footer.className = 'secret-footer';
  const noteSpan = document.createElement('span');
  noteSpan.textContent =
    'Written directly to a 0600 local file (auto-deleted after 24h). Only the file path is returned to the Agent.';
  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = '6px';

  const skipBtn = document.createElement('button');
  skipBtn.type = 'button';
  skipBtn.className = 'btn btn-sm';
  skipBtn.textContent = 'Answer in Chat';
  skipBtn.addEventListener('click', async () => {
    await postJson('/api/secret/answer', { id: item.id, skipped: true }).catch((e) => showToast(e.message));
  });

  const declineBtn = document.createElement('button');
  declineBtn.type = 'button';
  declineBtn.className = 'btn btn-sm btn-danger';
  declineBtn.textContent = 'Decline';
  declineBtn.addEventListener('click', async () => {
    await postJson('/api/secret/answer', { id: item.id, declined: true }).catch((e) => showToast(e.message));
  });

  actions.appendChild(skipBtn);
  actions.appendChild(declineBtn);
  footer.appendChild(noteSpan);
  footer.appendChild(actions);
  wrap.appendChild(footer);

  return wrap;
}

function renderUiNode(node, item, formState, onSubmitDecision) {
  if (!node || typeof node !== 'object' || node.type !== 'element') {
    return document.createDocumentFragment();
  }
  const { typeName, props = {} } = node;
  const waiting = item.status === 'waiting';

  switch (typeName) {
    case 'Stack': {
      const el = document.createElement('div');
      el.className = 'ui-stack';
      for (const child of props.children || []) {
        el.appendChild(renderUiNode(child, item, formState, onSubmitDecision));
      }
      return el;
    }
    case 'Row': {
      const el = document.createElement('div');
      el.className = 'ui-row';
      for (const child of props.children || []) {
        el.appendChild(renderUiNode(child, item, formState, onSubmitDecision));
      }
      return el;
    }
    case 'Card': {
      const el = document.createElement('div');
      el.className = 'ui-card';
      if (props.title) {
        const h = document.createElement('h4');
        h.className = 'ui-card-title';
        h.textContent = props.title;
        el.appendChild(h);
      }
      for (const child of props.children || []) {
        el.appendChild(renderUiNode(child, item, formState, onSubmitDecision));
      }
      return el;
    }
    case 'Details': {
      const details = document.createElement('details');
      details.className = 'ui-card';
      const summary = document.createElement('summary');
      summary.className = 'ui-card-title';
      summary.style.cursor = 'pointer';
      summary.textContent = props.title || 'Details';
      details.appendChild(summary);
      const body = document.createElement('div');
      body.className = 'ui-stack';
      body.style.marginTop = '8px';
      for (const child of props.children || []) {
        body.appendChild(renderUiNode(child, item, formState, onSubmitDecision));
      }
      details.appendChild(body);
      return details;
    }
    case 'Tabs': {
      const tabs = Array.isArray(props.tabs) ? props.tabs : [];
      const wrap = document.createElement('div');
      wrap.className = 'ui-stack';
      const tabKey = tabs.map((t) => t?.props?.label || '').join('|');
      const activeIdx = formState.activeTabs[tabKey] ?? 0;

      const strip = document.createElement('div');
      strip.style.display = 'flex';
      strip.style.gap = '4px';
      tabs.forEach((tab, idx) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `btn btn-sm${idx === activeIdx ? ' active' : ''}`;
        b.textContent = tab?.props?.label || `Tab ${idx + 1}`;
        b.addEventListener('click', () => {
          formState.activeTabs[tabKey] = idx;
          renderMainContent(true);
        });
        strip.appendChild(b);
      });
      wrap.appendChild(strip);

      const currentTab = tabs[activeIdx];
      if (currentTab) {
        const pane = document.createElement('div');
        pane.className = 'ui-card';
        for (const child of currentTab.props?.children || []) {
          pane.appendChild(renderUiNode(child, item, formState, onSubmitDecision));
        }
        wrap.appendChild(pane);
      }
      return wrap;
    }
    case 'Text': {
      const p = document.createElement('div');
      p.style.whiteSpace = 'pre-wrap';
      p.textContent = props.markdown || '';
      return p;
    }
    case 'Badge': {
      const s = document.createElement('span');
      s.className = 'ui-badge';
      if (props.tone) s.setAttribute('data-tone', props.tone);
      s.textContent = props.label || '';
      return s;
    }
    case 'Callout': {
      const c = document.createElement('div');
      c.className = 'ui-callout';
      if (props.tone) c.setAttribute('data-tone', props.tone);
      if (props.title) {
        const t = document.createElement('div');
        t.style.fontWeight = '600';
        t.style.marginBottom = '3px';
        t.textContent = props.title;
        c.appendChild(t);
      }
      const m = document.createElement('div');
      m.textContent = props.markdown || '';
      c.appendChild(m);
      return c;
    }
    case 'KeyValue': {
      const kv = document.createElement('div');
      kv.className = 'ui-kv';
      for (const row of props.items || []) {
        const r = document.createElement('div');
        r.className = 'ui-kv-row';
        const l = document.createElement('span');
        l.className = 'ui-kv-label';
        l.textContent = String(row.label ?? '');
        const v = document.createElement('span');
        v.className = 'ui-kv-val';
        v.textContent = String(row.value ?? '');
        r.appendChild(l);
        r.appendChild(v);
        kv.appendChild(r);
      }
      return kv;
    }
    case 'Table': {
      const wrap = document.createElement('div');
      wrap.className = 'ui-table-wrap';
      const tbl = document.createElement('table');
      tbl.className = 'ui-table';
      const thead = document.createElement('thead');
      const trH = document.createElement('tr');
      for (const col of props.columns || []) {
        const th = document.createElement('th');
        th.textContent = String(col);
        trH.appendChild(th);
      }
      thead.appendChild(trH);
      tbl.appendChild(thead);
      const tbody = document.createElement('tbody');
      for (const row of props.rows || []) {
        const tr = document.createElement('tr');
        for (const cell of Array.isArray(row) ? row : []) {
          const td = document.createElement('td');
          td.textContent = String(cell ?? '');
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      tbl.appendChild(tbody);
      wrap.appendChild(tbl);
      return wrap;
    }
    case 'Stat': {
      const st = document.createElement('div');
      st.className = 'ui-stat';
      const lbl = document.createElement('div');
      lbl.className = 'ui-stat-label';
      lbl.textContent = props.label || '';
      const valRow = document.createElement('div');
      valRow.style.display = 'flex';
      valRow.style.alignItems = 'baseline';
      valRow.style.gap = '6px';
      const val = document.createElement('span');
      val.className = 'ui-stat-val';
      val.textContent = String(props.value ?? '');
      valRow.appendChild(val);
      if (props.delta) {
        const b = document.createElement('span');
        b.className = 'ui-badge';
        if (props.tone) b.setAttribute('data-tone', props.tone);
        b.textContent = props.delta;
        valRow.appendChild(b);
      }
      st.appendChild(lbl);
      st.appendChild(valRow);
      return st;
    }
    case 'Progress': {
      const max = typeof props.max === 'number' && props.max > 0 ? props.max : 100;
      const pct = Math.max(0, Math.min(100, Math.round((Number(props.value || 0) / max) * 100)));
      const pr = document.createElement('div');
      pr.className = 'ui-progress';
      const top = document.createElement('div');
      top.className = 'ui-progress-top';
      const l = document.createElement('span');
      l.textContent = props.label || '';
      const r = document.createElement('span');
      r.textContent = `${pct}%`;
      top.appendChild(l);
      top.appendChild(r);
      const track = document.createElement('div');
      track.className = 'ui-progress-track';
      const fill = document.createElement('div');
      fill.className = 'ui-progress-fill';
      fill.style.width = `${pct}%`;
      track.appendChild(fill);
      pr.appendChild(top);
      pr.appendChild(track);
      return pr;
    }
    case 'Steps': {
      const wrap = document.createElement('div');
      wrap.className = 'ui-steps';
      (props.items || []).forEach((step, idx) => {
        const row = document.createElement('div');
        row.className = 'ui-step';
        if (step.status) row.setAttribute('data-status', step.status);
        const dot = document.createElement('span');
        dot.className = 'ui-step-dot';
        dot.textContent = step.status === 'done' ? '✓' : String(idx + 1);
        const body = document.createElement('div');
        const t = document.createElement('div');
        t.style.fontWeight = '600';
        t.textContent = step.title || '';
        body.appendChild(t);
        if (step.markdown) {
          const d = document.createElement('div');
          d.style.color = 'var(--text-muted)';
          d.textContent = step.markdown;
          body.appendChild(d);
        }
        row.appendChild(dot);
        row.appendChild(body);
        wrap.appendChild(row);
      });
      return wrap;
    }
    case 'BarChart':
    case 'LineChart': {
      const labels = Array.isArray(props.labels) ? props.labels : [];
      const seriesList = Array.isArray(props.series) ? props.series : [];
      const unit = props.unit ? ` ${props.unit}` : '';
      const chart = document.createElement('div');
      chart.className = 'ui-chart';
      let maxVal = 1;
      for (const s of seriesList) {
        for (const v of s?.props?.values || []) {
          if (typeof v === 'number' && v > maxVal) maxVal = v;
        }
      }
      labels.forEach((lbl, idx) => {
        const row = document.createElement('div');
        row.className = 'ui-bar-row';
        for (let sIdx = 0; sIdx < seriesList.length; sIdx++) {
          const s = seriesList[sIdx];
          const val = s?.props?.values?.[idx];
          if (val === null || val === undefined) continue;
          const hdr = document.createElement('div');
          hdr.className = 'ui-bar-header';
          const nameSpan = document.createElement('span');
          nameSpan.textContent = seriesList.length > 1 ? `${lbl} (${s.props.name})` : String(lbl);
          const valSpan = document.createElement('span');
          valSpan.style.fontWeight = '600';
          valSpan.textContent = `${val}${unit}`;
          hdr.appendChild(nameSpan);
          hdr.appendChild(valSpan);
          const track = document.createElement('div');
          track.className = 'ui-progress-track';
          const fill = document.createElement('div');
          fill.className = 'ui-progress-fill';
          fill.style.background = `var(--series-${(sIdx % 6) + 1})`;
          fill.style.width = `${Math.max(2, Math.min(100, Math.round((Number(val) / maxVal) * 100)))}%`;
          track.appendChild(fill);
          row.appendChild(hdr);
          row.appendChild(track);
        }
        chart.appendChild(row);
      });
      return chart;
    }
    case 'Choice': {
      const wrap = document.createElement('div');
      wrap.className = 'ui-choice-group';
      if (props.label) {
        const lbl = document.createElement('div');
        lbl.style.fontWeight = '500';
        lbl.textContent = props.label;
        wrap.appendChild(lbl);
      }
      const isMulti = Boolean(props.multiple);
      const currentVal = formState.values[props.name] ?? (isMulti ? [] : '');
      for (const rawOpt of props.options || []) {
        const opt = typeof rawOpt === 'string' ? { label: rawOpt } : rawOpt || { label: '' };
        const row = document.createElement('label');
        row.className = 'ui-choice-option';
        const inp = document.createElement('input');
        inp.type = isMulti ? 'checkbox' : 'radio';
        inp.name = `ui_choice_${item.id}_${props.name}`;
        inp.disabled = !waiting;
        inp.checked = isMulti ? Array.isArray(currentVal) && currentVal.includes(opt.label) : currentVal === opt.label;
        inp.addEventListener('change', () => {
          if (isMulti) {
            const prev = Array.isArray(formState.values[props.name]) ? [...formState.values[props.name]] : [];
            if (inp.checked && !prev.includes(opt.label)) prev.push(opt.label);
            if (!inp.checked) {
              const i = prev.indexOf(opt.label);
              if (i !== -1) prev.splice(i, 1);
            }
            formState.values[props.name] = prev;
          } else {
            formState.values[props.name] = opt.label;
          }
        });
        const textWrap = document.createElement('div');
        const t = document.createElement('div');
        t.style.fontWeight = '500';
        t.textContent = opt.label;
        textWrap.appendChild(t);
        if (opt.description) {
          const d = document.createElement('div');
          d.style.fontSize = '11.5px';
          d.style.color = 'var(--text-muted)';
          d.textContent = opt.description;
          textWrap.appendChild(d);
        }
        row.appendChild(inp);
        row.appendChild(textWrap);
        wrap.appendChild(row);
      }
      return wrap;
    }
    case 'Input': {
      const wrap = document.createElement('label');
      wrap.className = 'ui-choice-group';
      if (props.label) {
        const l = document.createElement('span');
        l.style.fontWeight = '500';
        l.textContent = props.label;
        wrap.appendChild(l);
      }
      const ctrl = document.createElement(props.multiline ? 'textarea' : 'input');
      ctrl.className = props.multiline ? 'textarea' : 'input';
      ctrl.placeholder = props.placeholder || '';
      ctrl.disabled = !waiting;
      ctrl.value = formState.values[props.name] ?? '';
      ctrl.addEventListener('input', () => {
        formState.values[props.name] = ctrl.value;
      });
      wrap.appendChild(ctrl);
      return wrap;
    }
    case 'DateInput': {
      const wrap = document.createElement('label');
      wrap.className = 'ui-choice-group';
      if (props.label) {
        const l = document.createElement('span');
        l.style.fontWeight = '500';
        l.textContent = props.label;
        wrap.appendChild(l);
      }
      const inp = document.createElement('input');
      inp.type = props.time ? 'datetime-local' : 'date';
      inp.className = 'input';
      inp.disabled = !waiting;
      if (formState.values[props.name] === undefined && props.value) {
        formState.values[props.name] = props.value;
      }
      inp.value = formState.values[props.name] ?? '';
      inp.addEventListener('input', () => {
        formState.values[props.name] = inp.value;
      });
      wrap.appendChild(inp);
      return wrap;
    }
    case 'Slider': {
      const wrap = document.createElement('label');
      wrap.className = 'ui-choice-group';
      if (formState.values[props.name] === undefined) {
        formState.values[props.name] = props.value ?? props.min ?? 0;
      }
      const top = document.createElement('div');
      top.style.display = 'flex';
      top.style.justifyContent = 'space-between';
      const l = document.createElement('span');
      l.style.fontWeight = '500';
      l.textContent = props.label || props.name;
      const v = document.createElement('span');
      const unit = props.unit || '';
      v.textContent = `${formState.values[props.name]}${unit}`;
      top.appendChild(l);
      top.appendChild(v);

      const inp = document.createElement('input');
      inp.type = 'range';
      inp.min = String(props.min ?? 0);
      inp.max = String(props.max ?? 100);
      if (props.step) inp.step = String(props.step);
      inp.disabled = !waiting;
      inp.value = String(formState.values[props.name]);
      inp.addEventListener('input', () => {
        formState.values[props.name] = Number(inp.value);
        v.textContent = `${inp.value}${unit}`;
      });
      wrap.appendChild(top);
      wrap.appendChild(inp);
      return wrap;
    }
    case 'Button': {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn${props.variant === 'primary' ? ' btn-primary' : ''}`;
      b.disabled = !waiting;
      b.textContent = props.label || 'Submit';
      b.addEventListener('click', () => {
        onSubmitDecision({
          button: props.label,
          value: props.value ?? props.label,
        });
      });
      return b;
    }
    default:
      return document.createDocumentFragment();
  }
}

function renderUiBlockView(item) {
  const container = document.createElement('div');
  container.className = 'ui-stack';

  if (item.uiErrors && item.uiErrors.length > 0) {
    const callout = document.createElement('div');
    callout.className = 'ui-callout';
    callout.setAttribute('data-tone', 'error');
    callout.textContent = `UI Block Errors (returned to Agent): ${item.uiErrors.join('; ')}`;
    container.appendChild(callout);
    return container;
  }

  const formState = ensureFormState(item.id);
  const submitDecision = async ({ button, value }) => {
    const note = formState.note.trim();
    const values = { ...formState.values };
    const summaryParts = [];
    if (button) summaryParts.push(button);
    for (const [k, v] of Object.entries(values)) {
      if (Array.isArray(v) && v.length) summaryParts.push(`${k}: ${v.join(', ')}`);
      else if (v !== '' && v !== null && v !== undefined && !Array.isArray(v)) summaryParts.push(`${k}: ${v}`);
    }
    if (note) summaryParts.push(`Note: ${note}`);
    const summary = summaryParts.join(' | ').slice(0, 480) || 'Submitted response';
    try {
      await postJson('/api/render/answer', {
        pageId: item.id,
        summary,
        data: {
          button: button || 'Send',
          value: value ?? null,
          values,
          ...(note ? { note } : {}),
        },
      });
      showToast('Response submitted to Agent');
    } catch (err) {
      showToast(err.message);
    }
  };

  if (item.uiAst) {
    container.appendChild(renderUiNode(item.uiAst, item, formState, submitDecision));
  }

  if (item.status === 'waiting') {
    const footer = document.createElement('div');
    footer.className = 'waiting-footer';
    const noteInput = document.createElement('input');
    noteInput.type = 'text';
    noteInput.className = 'input';
    noteInput.placeholder = 'Add a note or extra condition (optional)...';
    noteInput.value = formState.note;
    noteInput.addEventListener('input', () => {
      formState.note = noteInput.value;
    });

    const row = document.createElement('div');
    row.className = 'waiting-footer-row';
    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'btn btn-sm';
    skipBtn.textContent = 'Continue in Chat / Skip';
    skipBtn.addEventListener('click', () => {
      void postJson('/api/render/answer', {
        pageId: item.id,
        skipped: true,
        note: formState.note.trim(),
      }).catch((e) => showToast(e.message));
    });

    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'btn btn-primary';
    sendBtn.textContent = 'Send Answer';
    sendBtn.addEventListener('click', () => {
      void submitDecision({ button: 'Send', value: 'send' });
    });

    row.appendChild(skipBtn);
    row.appendChild(sendBtn);
    footer.appendChild(noteInput);
    footer.appendChild(row);
    container.appendChild(footer);
  } else if (item.summary) {
    const settled = document.createElement('div');
    settled.className = 'settled-banner';
    settled.textContent = `Answered: ${item.summary}`;
    container.appendChild(settled);
  }

  return container;
}

function renderHtmlPageView(item) {
  const container = document.createElement('div');
  container.className = 'ui-stack';

  const frameWrap = document.createElement('div');
  frameWrap.className = 'iframe-wrap';
  const iframe = document.createElement('iframe');
  iframe.className = 'render-iframe';
  iframe.setAttribute('sandbox', 'allow-scripts allow-forms');
  iframe.src = `/api/pages/${encodeURIComponent(item.id)}.html?t=${item.updatedAt}`;
  iframe.addEventListener('load', () => {
    if (state.annotating) {
      iframe.contentWindow?.postMessage({ type: 'openchamber:html-render:annotate-mode', enabled: true }, '*');
    }
  });
  currentIframe = iframe;
  frameWrap.appendChild(iframe);
  container.appendChild(frameWrap);

  // Annotation composer drawer
  if (state.annotating || state.draftAnnotations.length > 0) {
    const annBox = document.createElement('div');
    annBox.className = 'annotation-box';
    const hdr = document.createElement('div');
    hdr.style.display = 'flex';
    hdr.style.justifyContent = 'space-between';
    hdr.style.alignItems = 'center';
    const title = document.createElement('strong');
    title.textContent = `Visual Annotations (${state.draftAnnotations.length}) — Click elements in the page above`;
    hdr.appendChild(title);
    annBox.appendChild(hdr);

    state.draftAnnotations.forEach((ann, idx) => {
      const row = document.createElement('div');
      row.className = 'annotation-item';
      const meta = document.createElement('div');
      meta.className = 'annotation-meta';
      const selSpan = document.createElement('span');
      selSpan.textContent = `${ann.selector}${ann.text ? ` ("${ann.text.slice(0, 40)}")` : ''}`;
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-sm';
      delBtn.textContent = '×';
      delBtn.addEventListener('click', () => {
        state.draftAnnotations.splice(idx, 1);
        renderMainContent(true);
      });
      meta.appendChild(selSpan);
      meta.appendChild(delBtn);

      const commentInput = document.createElement('input');
      commentInput.type = 'text';
      commentInput.className = 'input';
      commentInput.placeholder = 'What should change on this element?';
      commentInput.value = ann.comment || '';
      commentInput.addEventListener('input', () => {
        ann.comment = commentInput.value;
      });
      row.appendChild(meta);
      row.appendChild(commentInput);
      annBox.appendChild(row);
    });

    if (state.draftAnnotations.length > 0) {
      const sendAnnBtn = document.createElement('button');
      sendAnnBtn.type = 'button';
      sendAnnBtn.className = 'btn btn-primary';
      sendAnnBtn.textContent = item.status === 'waiting' ? 'Send Annotations to Waiting Agent' : 'Save Annotations';
      sendAnnBtn.addEventListener('click', async () => {
        const summary = state.draftAnnotations
          .map((a) => `${a.selector}: ${a.comment || 'selected'}`)
          .join('; ')
          .slice(0, 450);
        try {
          await postJson('/api/render/answer', {
            pageId: item.id,
            summary: `Annotated: ${summary}`,
            annotations: state.draftAnnotations,
          });
          state.annotating = false;
          state.draftAnnotations = [];
          showToast('Annotations sent');
        } catch (err) {
          showToast(err.message);
        }
      });
      annBox.appendChild(sendAnnBtn);
    }
    container.appendChild(annBox);
  }

  if (item.status === 'waiting') {
    const footer = document.createElement('div');
    footer.className = 'waiting-footer';
    const formState = ensureFormState(item.id);
    const noteInput = document.createElement('input');
    noteInput.type = 'text';
    noteInput.className = 'input';
    noteInput.placeholder = 'Optional note or fallback response if not clicking inside the page...';
    noteInput.value = formState.note;
    noteInput.addEventListener('input', () => {
      formState.note = noteInput.value;
    });

    const row = document.createElement('div');
    row.className = 'waiting-footer-row';
    const hint = document.createElement('span');
    hint.style.fontSize = '11.5px';
    hint.style.color = 'var(--text-muted)';
    hint.textContent = 'Interact with the page above, or use these controls to reply directly:';

    const btnGroup = document.createElement('div');
    btnGroup.style.display = 'flex';
    btnGroup.style.gap = '6px';

    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'btn btn-sm';
    skipBtn.textContent = 'Continue in Chat';
    skipBtn.addEventListener('click', () => {
      void postJson('/api/render/answer', {
        pageId: item.id,
        skipped: true,
        note: formState.note.trim(),
      }).catch((e) => showToast(e.message));
    });

    const sendNoteBtn = document.createElement('button');
    sendNoteBtn.type = 'button';
    sendNoteBtn.className = 'btn btn-sm btn-primary';
    sendNoteBtn.textContent = 'Submit Note';
    sendNoteBtn.addEventListener('click', async () => {
      const text = formState.note.trim() || 'Confirmed page';
      await postJson('/api/render/answer', {
        pageId: item.id,
        summary: text,
        data: { note: text },
      }).catch((e) => showToast(e.message));
    });

    btnGroup.appendChild(skipBtn);
    btnGroup.appendChild(sendNoteBtn);
    row.appendChild(hint);
    row.appendChild(btnGroup);
    footer.appendChild(noteInput);
    footer.appendChild(row);
    container.appendChild(footer);
  } else if (item.summary) {
    const settled = document.createElement('div');
    settled.className = 'settled-banner';
    settled.textContent = `Answered: ${item.summary}`;
    container.appendChild(settled);
  }

  return container;
}

function renderMainContent(force = false) {
  renderTopBarAndTabs();
  const active = getActiveItem();
  const sig = active
    ? `${active.id}:${active.status}:${active.updatedAt}:${state.theme}:${state.annotating}:${state.draftAnnotations.length}`
    : 'empty';
  if (!force && sig === lastRenderedSignature) return;
  lastRenderedSignature = sig;

  mainArea.innerHTML = '';
  currentIframe = null;

  if (!active) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <h3>No Active Render or Secret Request</h3>
      <p>When the Agent calls <code>render_page</code> (HTML mockup or declarative <code>ui</code> blocks) or <code>request_secret</code>, it will appear here in real time.</p>
    `;
    mainArea.appendChild(empty);
    return;
  }

  const header = document.createElement('div');
  header.className = 'item-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'item-title-wrap';
  const titleEl = document.createElement('span');
  titleEl.className = 'item-title';
  titleEl.textContent = active.title;
  titleWrap.appendChild(titleEl);

  const badge = document.createElement('span');
  badge.className = `status-badge status-${active.status}`;
  badge.textContent =
    active.status === 'waiting'
      ? 'Waiting for your input'
      : active.status.charAt(0).toUpperCase() + active.status.slice(1);

  header.appendChild(titleWrap);
  header.appendChild(badge);
  mainArea.appendChild(header);

  if (active.kind === 'secret') {
    mainArea.appendChild(renderSecretCard(active));
  } else if (active.kind === 'ui') {
    mainArea.appendChild(renderUiBlockView(active));
  } else {
    mainArea.appendChild(renderHtmlPageView(active));
  }
}

// Listen for postMessage events from the sandboxed HTML iframe
window.addEventListener('message', async (event) => {
  const d = event.data;
  if (!d || typeof d !== 'object') return;

  if (d.type === 'openchamber:html-render:size' && currentIframe && typeof d.height === 'number') {
    currentIframe.style.height = `${Math.max(80, Math.min(20000, Math.ceil(d.height)))}px`;
    return;
  }

  if (d.type === 'openchamber:html-render:open-link' && typeof d.url === 'string') {
    window.open(d.url, '_blank', 'noopener,noreferrer');
    return;
  }

  if (d.type === 'openchamber:html-render:element-picked') {
    state.draftAnnotations.push({
      selector: d.selector || 'body',
      text: d.text || '',
      rect: d.rect || null,
      comment: '',
    });
    renderMainContent(true);
    return;
  }

  // Handle MCP Apps `ui/message` JSON-RPC submission from `openchamber.submit(data, summary)`
  if (d.jsonrpc === '2.0' && d.method === 'ui/message' && d.params) {
    const active = getActiveItem();
    const pageId = d.params?._meta?.pageId || active?.id;
    const summary = (d.params?.content || [])
      .map((c) => c?.text || '')
      .join('\n')
      .trim();
    const data = d.params?._meta?.['openchamber/data'] ?? null;

    try {
      await postJson('/api/render/answer', { pageId, summary, data });
      event.source?.postMessage({ jsonrpc: '2.0', id: d.id, result: {} }, '*');
      showToast('Submitted choice to Agent');
    } catch (err) {
      event.source?.postMessage(
        { jsonrpc: '2.0', id: d.id, error: { code: -32000, message: err.message } },
        '*',
      );
      showToast(err.message);
    }
  }
});

// Toolbar actions
annotateBtn.addEventListener('click', () => {
  state.annotating = !state.annotating;
  if (currentIframe) {
    currentIframe.contentWindow?.postMessage(
      { type: 'openchamber:html-render:annotate-mode', enabled: state.annotating },
      '*',
    );
  }
  renderMainContent(true);
});

copyEmbedBtn.addEventListener('click', async () => {
  const active = getActiveItem();
  if (!active?.embedPath) return;
  const tag = `<agent-embed src="file://${active.embedPath}"></agent-embed>`;
  await navigator.clipboard.writeText(tag).catch(() => {});
  showToast('Copied <agent-embed> tag');
});

downloadBtn.addEventListener('click', () => {
  const active = getActiveItem();
  if (!active || active.kind !== 'html') return;
  const a = document.createElement('a');
  a.href = `/api/pages/${encodeURIComponent(active.id)}.html`;
  a.download = `${(active.title || 'page').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}.html`;
  a.click();
});

themeBtn.addEventListener('click', () => {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  void postJson('/api/select', { theme: next });
});

clearBtn.addEventListener('click', () => {
  void postJson('/api/clear', {});
});

// Connect SSE stream
function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => {
    try {
      const payload = JSON.parse(e.data);
      applyTheme(payload.theme);
      state.activeId = payload.activeId;
      state.serverPort = payload.serverPort;
      state.waitingCount = payload.waitingCount || 0;
      state.items = payload.items || [];
      renderMainContent(false);
    } catch {
      // Ignore malformed frame
    }
  });
  es.onerror = () => {
    es.close();
    setTimeout(connectEvents, 1500);
  };
}

connectEvents();
