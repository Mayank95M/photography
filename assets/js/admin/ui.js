// Small DOM helpers for the admin panel.

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v; // only ever used with static strings
    else if (k === 'style' && typeof v === 'object') {
      for (const [p, val] of Object.entries(v)) {
        if (val === undefined || val === null) continue;
        if (p.startsWith('--')) node.style.setProperty(p, String(val));
        else node.style[p] = val;
      }
    } else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'value') node.value = v;
    else if (k === 'checked') node.checked = !!v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function debounce(fn, ms = 350) {
  let t = null;
  let last;
  const d = (...a) => {
    last = a;
    clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...last);
    }, ms);
  };
  d.flush = () => {
    if (t === null) return;
    clearTimeout(t);
    t = null;
    fn(...last);
  };
  return d;
}

function mergeInto(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) mergeInto(target[k], v);
    else target[k] = v;
  }
  return target;
}

/** Like debounce, but collects the partial objects passed in between calls. */
export function batch(fn, ms = 350) {
  let pending = null;
  const run = debounce(() => {
    const p = pending;
    pending = null;
    if (p) fn(p);
  }, ms);
  const b = (patch) => {
    pending = mergeInto(pending || {}, patch);
    run();
  };
  b.flush = () => run.flush();
  return b;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function dateInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

export function fromDateInput(v) {
  return v ? new Date(`${v}T00:00:00.000Z`).toISOString() : null;
}

export function duration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return `${Math.round(sec)} s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

// ---------------------------------------------------------------- toasts

export function toast(message, { tone = '', action, timeout = 6000 } = {}) {
  let host = $('.toasts');
  if (!host) {
    host = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(host);
  }
  const el = h('div', { class: `toast ${tone}` }, h('span', {}, message));
  if (action) el.append(h('button', { type: 'button', onclick: () => (action.run(), el.remove()) }, action.label));
  host.append(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}

// ---------------------------------------------------------------- modals

export function modal(content, { onClose, labelledBy } = {}) {
  const last = document.activeElement;
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelledBy }, content);
  const back = h('div', { class: 'modal-back' }, box);
  const close = () => {
    back.remove();
    removeEventListener('keydown', onKey);
    onClose?.();
    last?.focus?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  back.addEventListener('mousedown', (e) => {
    if (e.target === back) close();
  });
  addEventListener('keydown', onKey);
  document.body.append(back);
  queueMicrotask(() => box.querySelector('button, input, textarea, select, [tabindex]')?.focus());
  return { el: box, close };
}

export function confirmDialog({ title, body, confirm = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const m = modal(
      [
        h('h2', { id: 'confirm-title' }, title),
        body ? h('p', { class: 'muted' }, body) : null,
        h(
          'div',
          { class: 'row', style: { justifyContent: 'flex-end' } },
          h('button', { class: 'btn', type: 'button', onclick: () => finish(false) }, 'Cancel'),
          h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', onclick: () => finish(true) }, confirm),
        ),
      ],
      { labelledBy: 'confirm-title', onClose: () => finish(false) },
    );
  });
}

export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', {}, label), control, hint ? h('small', {}, hint) : null);
}

export function checkbox(label, checked, onchange, hint) {
  const input = h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) });
  return h('label', { class: 'check' }, input, h('span', {}, label, hint ? h('small', {}, hint) : null));
}
