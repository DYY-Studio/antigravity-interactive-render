/**
 * Declarative UI Block Parser & Validator (`openui-lang` call syntax + JSON AST).
 *
 * Supports OpenChamber's 22 built-in UI components:
 * Stack, Row, Card, Tabs, Tab, Details, Text, Badge, Callout, KeyValue, Table,
 * Steps, BarChart, LineChart, Series, Stat, Progress, Choice, Input, DateInput,
 * Slider, Button.
 *
 * If an agent's `ui` program has syntax or schema errors, returns `{ ok: false, errors }`
 * so the waiting tool call immediately resolves with `reason: "ui-not-drawn"` and the
 * agent can fix the program in the same turn.
 */

export const COMPONENT_SIGNATURES = {
  Stack: ['children'],
  Row: ['children'],
  Card: ['title', 'children'],
  Tabs: ['tabs'],
  Tab: ['label', 'children'],
  Details: ['title', 'children'],
  Text: ['markdown'],
  Badge: ['label', 'tone'],
  Callout: ['markdown', 'tone', 'title'],
  KeyValue: ['items'],
  Table: ['columns', 'rows'],
  Steps: ['items', 'direction'],
  BarChart: ['labels', 'series', 'unit', 'whole'],
  LineChart: ['labels', 'series', 'unit'],
  Series: ['name', 'values'],
  Stat: ['label', 'value', 'delta', 'tone'],
  Progress: ['label', 'value', 'max'],
  Choice: ['name', 'options', 'label', 'multiple'],
  Input: ['name', 'label', 'placeholder', 'multiline'],
  DateInput: ['name', 'label', 'time', 'value'],
  Slider: ['name', 'min', 'max', 'label', 'step', 'value', 'unit'],
  Button: ['label', 'variant', 'value'],
};

const VALID_TONES = new Set(['neutral', 'info', 'success', 'warning', 'error']);

function stripFencesAndTags(source) {
  let text = String(source ?? '').trim();
  const tagMatch = /^<openui(?:-lang)?>([\s\S]*?)<\/openui(?:-lang)?>$/i.exec(text);
  if (tagMatch) text = tagMatch[1].trim();
  const fenceMatch = /^```(?:openui(?:-lang)?|json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  if (fenceMatch) text = fenceMatch[1].trim();
  return text;
}

/**
 * Tokenizer & recursive-descent parser for `openui-lang` expressions:
 * Supports:
 * - Variable assignments: `root = Stack([...])`, `s1 = Series("CPU", [10, 20])`
 * - Direct root call: `Stack([...])`
 * - Positional arguments and named `key: value` arguments
 * - Strings, numbers, booleans, null, arrays `[...]`, objects `{...}`, and component calls `Name(...)`
 */
function tokenizeUiLang(input) {
  const tokens = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '/' && input[i + 1] === '/') {
      while (i < len && input[i] !== '\n') i++;
      continue;
    }
    if (ch === '#' && (i === 0 || input[i - 1] === '\n')) {
      while (i < len && input[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && input[i + 1] === '*') {
      i += 2;
      while (i < len && !(input[i] === '*' && input[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if ('()[],:{}=;'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let str = '';
      i++;
      while (i < len && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < len) {
          const next = input[i + 1];
          if (next === 'n') str += '\n';
          else if (next === 't') str += '\t';
          else if (next === 'r') str += '\r';
          else str += next;
          i += 2;
        } else {
          str += input[i++];
        }
      }
      if (i >= len) {
        throw new Error(`Unterminated string literal starting near position ${i}`);
      }
      i++; // closing quote
      tokens.push({ type: 'string', value: str, pos: i });
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let numStr = '';
      if (ch === '-') numStr += input[i++];
      while (i < len && ((input[i] >= '0' && input[i] <= '9') || input[i] === '.')) {
        numStr += input[i++];
      }
      const num = Number(numStr);
      if (!Number.isFinite(num)) {
        throw new Error(`Invalid number "${numStr}" at position ${i}`);
      }
      tokens.push({ type: 'number', value: num, pos: i });
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let id = '';
      while (i < len && /[A-Za-z0-9_$-]/.test(input[i])) {
        id += input[i++];
      }
      tokens.push({ type: 'ident', value: id, pos: i });
      continue;
    }
    throw new Error(`Unexpected character "${ch}" at position ${i}`);
  }
  return tokens;
}

function buildElementNode(typeName, positionalArgs, namedArgs, errors) {
  const sig = COMPONENT_SIGNATURES[typeName];
  if (!sig) {
    errors.push(
      `Unknown component "${typeName}". Supported components: ${Object.keys(COMPONENT_SIGNATURES).join(', ')}`,
    );
    return { type: 'element', typeName, props: {} };
  }
  if (positionalArgs.length > sig.length) {
    errors.push(`${typeName} takes at most ${sig.length} argument(s) (${sig.join(', ')}), got ${positionalArgs.length}`);
  }
  const props = {};
  positionalArgs.slice(0, sig.length).forEach((val, idx) => {
    if (val !== undefined) props[sig[idx]] = val;
  });
  for (const [k, v] of Object.entries(namedArgs)) {
    if (!sig.includes(k)) {
      errors.push(`${typeName} does not have a parameter named "${k}". Valid parameters: ${sig.join(', ')}`);
    } else {
      props[k] = v;
    }
  }
  return { type: 'element', typeName, props };
}

function normalizeJsonAst(node, errors) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((item) => normalizeJsonAst(item, errors));

  const typeName = node.typeName || (typeof node.type === 'string' && node.type !== 'element' ? node.type : null);
  if (typeName) {
    if (!COMPONENT_SIGNATURES[typeName]) {
      errors.push(
        `Unknown component "${typeName}". Supported components: ${Object.keys(COMPONENT_SIGNATURES).join(', ')}`,
      );
    }
    const rawProps = node.props && typeof node.props === 'object' ? { ...node.props } : { ...node };
    delete rawProps.type;
    delete rawProps.typeName;
    delete rawProps.props;
    const normalizedProps = {};
    for (const [k, v] of Object.entries(rawProps)) {
      normalizedProps[k] = normalizeJsonAst(v, errors);
    }
    return { type: 'element', typeName, props: normalizedProps };
  }
  const copy = {};
  for (const [k, v] of Object.entries(node)) {
    copy[k] = normalizeJsonAst(v, errors);
  }
  return copy;
}

function validateElementTree(node, errors, isRoot = false) {
  if (!node || typeof node !== 'object' || node.type !== 'element') {
    if (isRoot) errors.push('Root node must be a component element (prefer Stack([...]))');
    return;
  }
  const { typeName, props = {} } = node;
  if (!COMPONENT_SIGNATURES[typeName]) return;

  if (isRoot && typeName !== 'Stack') {
    // Wrap non-Stack root automatically in a Stack or allow it if valid, wait:
    // Let's allow Stack/Card/Tabs at root by wrapping in Stack if needed, or validate children.
  }

  switch (typeName) {
    case 'Stack':
    case 'Row': {
      if (!Array.isArray(props.children)) {
        errors.push(`${typeName} requires a children array, e.g. ${typeName}([...])`);
      } else {
        props.children.forEach((child) => validateElementTree(child, errors, false));
      }
      break;
    }
    case 'Card':
    case 'Details': {
      if (typeof props.title !== 'string') {
        errors.push(`${typeName} requires a string title as first argument (use "" for no title)`);
      }
      if (!Array.isArray(props.children)) {
        errors.push(`${typeName} requires a children array as second argument`);
      } else {
        props.children.forEach((child) => validateElementTree(child, errors, false));
      }
      break;
    }
    case 'Tabs': {
      if (!Array.isArray(props.tabs) || props.tabs.length === 0) {
        errors.push('Tabs requires a non-empty array of Tab(...) elements');
      } else {
        props.tabs.forEach((t) => {
          if (!t || t.typeName !== 'Tab') errors.push('Every child of Tabs([...]) must be a Tab(label, children)');
          else validateElementTree(t, errors, false);
        });
      }
      break;
    }
    case 'Tab': {
      if (typeof props.label !== 'string' || !props.label.trim()) {
        errors.push('Tab requires a non-empty string label');
      }
      if (!Array.isArray(props.children)) {
        errors.push('Tab requires a children array as second argument');
      } else {
        props.children.forEach((child) => validateElementTree(child, errors, false));
      }
      break;
    }
    case 'Text': {
      if (typeof props.markdown !== 'string') {
        errors.push('Text requires a markdown string');
      }
      break;
    }
    case 'Badge': {
      if (typeof props.label !== 'string') errors.push('Badge requires a string label');
      if (props.tone !== undefined && !VALID_TONES.has(props.tone)) {
        errors.push(`Badge tone must be one of: ${[...VALID_TONES].join(', ')}`);
      }
      break;
    }
    case 'Callout': {
      if (typeof props.markdown !== 'string') errors.push('Callout requires a markdown string');
      break;
    }
    case 'KeyValue': {
      if (!Array.isArray(props.items)) {
        errors.push('KeyValue requires an items array of { label, value }');
      }
      break;
    }
    case 'Table': {
      if (!Array.isArray(props.columns) || !Array.isArray(props.rows)) {
        errors.push('Table requires (columns: string[], rows: (string|number)[][])');
      }
      break;
    }
    case 'Steps': {
      if (!Array.isArray(props.items)) {
        errors.push('Steps requires an items array of { title, markdown?, status? }');
      }
      break;
    }
    case 'BarChart':
    case 'LineChart': {
      if (!Array.isArray(props.labels) || !Array.isArray(props.series)) {
        errors.push(`${typeName} requires (labels: string[], series: Series[])`);
      }
      break;
    }
    case 'Series': {
      if (typeof props.name !== 'string' || !Array.isArray(props.values)) {
        errors.push('Series requires (name: string, values: (number|null)[])');
      }
      break;
    }
    case 'Stat': {
      if (typeof props.label !== 'string' || (typeof props.value !== 'string' && typeof props.value !== 'number')) {
        errors.push('Stat requires (label: string, value: string | number)');
      }
      break;
    }
    case 'Progress': {
      if (typeof props.label !== 'string' || typeof props.value !== 'number') {
        errors.push('Progress requires (label: string, value: number)');
      }
      break;
    }
    case 'Choice': {
      if (typeof props.name !== 'string' || !props.name.trim()) {
        errors.push('Choice requires a non-empty name string as first argument');
      }
      if (!Array.isArray(props.options) || props.options.length === 0) {
        errors.push('Choice requires a non-empty options array as second argument');
      }
      break;
    }
    case 'Input': {
      if (typeof props.name !== 'string' || !props.name.trim()) {
        errors.push('Input requires a non-empty name string as first argument');
      }
      break;
    }
    case 'DateInput': {
      if (typeof props.name !== 'string' || !props.name.trim()) {
        errors.push('DateInput requires a non-empty name string as first argument');
      }
      break;
    }
    case 'Slider': {
      if (
        typeof props.name !== 'string' ||
        typeof props.min !== 'number' ||
        typeof props.max !== 'number' ||
        props.max <= props.min
      ) {
        errors.push('Slider requires (name: string, min: number, max: number) with max > min');
      }
      break;
    }
    case 'Button': {
      if (typeof props.label !== 'string' || !props.label.trim()) {
        errors.push('Button requires a non-empty label string');
      }
      break;
    }
  }
}

export function parseUiProgram(rawSource) {
  const cleaned = stripFencesAndTags(rawSource);
  if (!cleaned) {
    return { ok: false, errors: ['Empty ui program'], ast: null };
  }

  const errors = [];

  // 1. Try JSON AST if it starts with '{'
  if (cleaned.startsWith('{')) {
    try {
      const parsed = JSON.parse(cleaned);
      let ast = normalizeJsonAst(parsed, errors);
      if (ast && ast.type === 'element' && ast.typeName !== 'Stack') {
        ast = { type: 'element', typeName: 'Stack', props: { children: [ast] } };
      }
      validateElementTree(ast, errors, true);
      return { ok: errors.length === 0, errors, ast: errors.length === 0 ? ast : null };
    } catch {
      // Fall through to openui-lang parser
    }
  }

  // 2. Parse openui-lang expressions
  let tokens;
  try {
    tokens = tokenizeUiLang(cleaned);
  } catch (err) {
    return { ok: false, errors: [err.message], ast: null };
  }

  let cursor = 0;
  const env = new Map();

  const peek = (offset = 0) => tokens[cursor + offset] || null;
  const next = () => tokens[cursor++] || null;
  const matchPunct = (val) => {
    if (peek()?.type === 'punct' && peek().value === val) {
      cursor++;
      return true;
    }
    return false;
  };
  const expectPunct = (val, context) => {
    const t = next();
    if (!t || t.type !== 'punct' || t.value !== val) {
      throw new Error(`Expected "${val}" in ${context}, got ${t ? `"${t.value}"` : 'end of input'}`);
    }
  };

  function parseValue() {
    const t = peek();
    if (!t) throw new Error('Unexpected end of input while reading value');
    if (t.type === 'string' || t.type === 'number') {
      cursor++;
      return t.value;
    }
    if (t.type === 'punct' && t.value === '[') {
      cursor++;
      const arr = [];
      while (peek() && !(peek().type === 'punct' && peek().value === ']')) {
        arr.push(parseValue());
        matchPunct(',');
      }
      expectPunct(']', 'array');
      return arr;
    }
    if (t.type === 'punct' && t.value === '{') {
      cursor++;
      const obj = {};
      while (peek() && !(peek().type === 'punct' && peek().value === '}')) {
        const keyTok = next();
        if (!keyTok || (keyTok.type !== 'ident' && keyTok.type !== 'string')) {
          throw new Error(`Expected object property name, got ${keyTok ? keyTok.value : 'EOF'}`);
        }
        expectPunct(':', 'object property');
        obj[keyTok.value] = parseValue();
        matchPunct(',');
      }
      expectPunct('}', 'object');
      return obj;
    }
    if (t.type === 'ident') {
      cursor++;
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null' || t.value === 'undefined') return null;
      if (matchPunct('(')) {
        const positional = [];
        const named = {};
        while (peek() && !(peek().type === 'punct' && peek().value === ')')) {
          if (
            peek().type === 'ident' &&
            peek(1)?.type === 'punct' &&
            (peek(1).value === ':' || peek(1).value === '=')
          ) {
            const key = next().value;
            next(); // ':' or '='
            named[key] = parseValue();
          } else {
            positional.push(parseValue());
          }
          matchPunct(',');
        }
        expectPunct(')', `${t.value}(...) call`);
        return buildElementNode(t.value, positional, named, errors);
      }
      if (env.has(t.value)) {
        return env.get(t.value);
      }
      errors.push(`Undefined identifier "${t.value}". Strings must be quoted with "..."`);
      return t.value;
    }
    throw new Error(`Unexpected token "${t.value}"`);
  }

  let lastExpr = null;
  try {
    while (cursor < tokens.length) {
      if (matchPunct(';')) continue;
      if (peek()?.type === 'ident' && peek(1)?.type === 'punct' && peek(1).value === '=') {
        const varName = next().value;
        next(); // '='
        const val = parseValue();
        env.set(varName, val);
        lastExpr = val;
        matchPunct(';');
      } else {
        lastExpr = parseValue();
        matchPunct(';');
      }
    }
  } catch (err) {
    errors.push(err.message);
    return { ok: false, errors, ast: null };
  }

  let root = env.get('root') || lastExpr;
  if (root && root.type === 'element' && root.typeName !== 'Stack') {
    root = { type: 'element', typeName: 'Stack', props: { children: [root] } };
  }
  validateElementTree(root, errors, true);

  return {
    ok: errors.length === 0 && Boolean(root),
    errors,
    ast: errors.length === 0 ? root : null,
  };
}

export function buildUiStandaloneBodyHtml(uiAst, title = 'Interactive Decision') {
  const safeAstJson = JSON.stringify(uiAst || null).replace(/</g, '\\u003c');
  const safeTitle = String(title || 'Interactive Decision')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<div class="oc-surface" style="max-width:720px;margin:0 auto;">
  <div id="oc-ui-standalone" style="display:flex;flex-direction:column;gap:12px;"></div>
</div>
<script>
(() => {
  const ast = ${safeAstJson};
  const mount = document.getElementById('oc-ui-standalone');
  if (!ast || !mount) return;
  const values = {};
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  };
  function renderNode(node) {
    if (!node || typeof node !== 'object' || node.type !== 'element') return document.createDocumentFragment();
    const p = node.props || {};
    switch (node.typeName) {
      case 'Stack': {
        const d = el('div');
        d.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
        (p.children || []).forEach((c) => d.appendChild(renderNode(c)));
        return d;
      }
      case 'Row': {
        const d = el('div');
        d.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;align-items:stretch;';
        (p.children || []).forEach((c) => {
          const w = renderNode(c);
          if (w.style) w.style.flex = '1 1 180px';
          d.appendChild(w);
        });
        return d;
      }
      case 'Card': {
        const d = el('div', 'oc-box');
        d.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
        if (p.title) {
          const h = el('div', null, p.title);
          h.style.cssText = 'font-weight:600;font-size:14px;';
          d.appendChild(h);
        }
        (p.children || []).forEach((c) => d.appendChild(renderNode(c)));
        return d;
      }
      case 'Details': {
        const d = el('details', 'oc-box');
        const s = el('summary', null, p.title || 'Details');
        s.style.cssText = 'font-weight:600;cursor:pointer;';
        d.appendChild(s);
        const b = el('div');
        b.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:8px;';
        (p.children || []).forEach((c) => b.appendChild(renderNode(c)));
        d.appendChild(b);
        return d;
      }
      case 'Text':
        return el('div', null, p.markdown || '');
      case 'Badge': {
        const b = el('span', 'oc-badge', p.label || '');
        if (p.tone) b.setAttribute('data-tone', p.tone);
        return b;
      }
      case 'Callout': {
        const d = el('div', 'oc-box');
        if (p.title) {
          const t = el('div', null, p.title);
          t.style.fontWeight = '600';
          d.appendChild(t);
        }
        d.appendChild(el('div', null, p.markdown || ''));
        return d;
      }
      case 'Stat': {
        const d = el('div', 'oc-box');
        const l = el('div', null, p.label || '');
        l.style.cssText = 'font-size:12px;color:var(--muted-foreground);';
        const v = el('div', null, p.value ?? '');
        v.style.cssText = 'font-size:20px;font-weight:700;margin-top:2px;';
        d.append(l, v);
        if (p.delta) {
          const b = el('span', 'oc-badge', p.delta);
          if (p.tone) b.setAttribute('data-tone', p.tone);
          d.appendChild(b);
        }
        return d;
      }
      case 'KeyValue': {
        const d = el('div', 'oc-box');
        (p.items || []).forEach((item) => {
          const r = el('div');
          r.style.cssText = 'display:flex;justify-content:space-between;gap:12px;padding:4px 0;';
          const k = el('span', null, item.label ?? '');
          k.style.color = 'var(--muted-foreground)';
          const v = el('span', null, item.value ?? '');
          v.style.fontWeight = '500';
          r.append(k, v);
          d.appendChild(r);
        });
        return d;
      }
      case 'Table': {
        const t = el('table', 'oc-table');
        const thead = el('thead');
        const trh = el('tr');
        (p.columns || []).forEach((col) => trh.appendChild(el('th', null, col)));
        thead.appendChild(trh);
        t.appendChild(thead);
        const tbody = el('tbody');
        (p.rows || []).forEach((row) => {
          const tr = el('tr');
          (Array.isArray(row) ? row : []).forEach((cell) => tr.appendChild(el('td', null, cell ?? '')));
          tbody.appendChild(tr);
        });
        t.appendChild(tbody);
        return t;
      }
      case 'Choice': {
        const wrap = el('div', 'oc-field');
        if (p.label) wrap.appendChild(el('label', null, p.label));
        const list = el('div', 'oc-options');
        const multi = Boolean(p.multiple);
        values[p.name] = multi ? [] : '';
        (p.options || []).forEach((rawOpt) => {
          const opt = typeof rawOpt === 'string' ? { label: rawOpt } : (rawOpt || { label: '' });
          const btn = el('button', 'oc-option');
          btn.type = 'button';
          const titleSpan = el('div', null, opt.label);
          titleSpan.style.fontWeight = '500';
          btn.appendChild(titleSpan);
          if (opt.description) {
            const desc = el('div', null, opt.description);
            desc.style.cssText = 'font-size:12px;color:var(--muted-foreground);';
            btn.appendChild(desc);
          }
          btn.addEventListener('click', () => {
            if (multi) {
              const arr = Array.isArray(values[p.name]) ? values[p.name] : [];
              const idx = arr.indexOf(opt.label);
              if (idx >= 0) { arr.splice(idx, 1); btn.removeAttribute('data-selected'); }
              else { arr.push(opt.label); btn.setAttribute('data-selected', 'true'); }
            } else {
              values[p.name] = opt.label;
              list.querySelectorAll('.oc-option').forEach((o) => o.removeAttribute('data-selected'));
              btn.setAttribute('data-selected', 'true');
            }
          });
          list.appendChild(btn);
        });
        wrap.appendChild(list);
        return wrap;
      }
      case 'TextInput': {
        const wrap = el('div', 'oc-field');
        if (p.label) wrap.appendChild(el('label', null, p.label));
        const inp = el(p.multiline ? 'textarea' : 'input', 'oc-input');
        if (p.placeholder) inp.placeholder = p.placeholder;
        values[p.name] = '';
        inp.addEventListener('input', () => { values[p.name] = inp.value; });
        wrap.appendChild(inp);
        return wrap;
      }
      case 'Button': {
        const b = el('button', 'oc-button', p.label || 'Submit');
        b.type = 'button';
        if (p.tone === 'primary' || !p.tone) b.setAttribute('data-variant', 'primary');
        b.addEventListener('click', () => {
          const action = p.action || p.label || 'submit';
          if (window.openchamber && typeof window.openchamber.submit === 'function') {
            window.openchamber.submit({ action, values }, '${safeTitle}: ' + (p.label || action));
          }
        });
        return b;
      }
      default:
        return document.createDocumentFragment();
    }
  }
  mount.appendChild(renderNode(ast));
})();
</script>`;
}
