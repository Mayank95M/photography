// Crop editor (for borders the detector missed or got wrong) and a before/after viewer
// for the resolution enhancement.
import { h, modal } from './ui.js';
import { detectFrame, makeCanvas } from './imaging.js';

/**
 * Let the user adjust the crop. Insets are fractions of width/height.
 * Resolves with new insets, or null if cancelled.
 */
export function cropEditor({ bitmap, insets, title = 'Adjust the crop' }) {
  return new Promise((resolve) => {
    const W = bitmap.width;
    const H = bitmap.height;
    const maxW = Math.min(900, innerWidth - 80);
    const maxH = Math.min(innerHeight * 0.6, 620);
    const s = Math.min(maxW / W, maxH / H, 1);
    const cw = Math.round(W * s);
    const ch = Math.round(H * s);
    const canvas = makeCanvas(cw * devicePixelRatio, ch * devicePixelRatio);
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    let cur = { ...insets };
    const box = h('div', { class: 'crop-box' }, ...['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'].map((d) => h('span', { class: 'crop-handle', 'data-h': d })));
    const wrap = h('div', { class: 'cropper', style: { width: `${cw}px`, height: `${ch}px` } }, canvas, box);
    const readout = h('p', { class: 'muted', 'aria-live': 'polite' });

    const paint = () => {
      box.style.left = `${cur.left * cw}px`;
      box.style.top = `${cur.top * ch}px`;
      box.style.width = `${(1 - cur.left - cur.right) * cw}px`;
      box.style.height = `${(1 - cur.top - cur.bottom) * ch}px`;
      const px = (f, d) => Math.round(f * d);
      const parts = [
        ['top', px(cur.top, H)],
        ['right', px(cur.right, W)],
        ['bottom', px(cur.bottom, H)],
        ['left', px(cur.left, W)],
      ].filter(([, v]) => v > 0);
      readout.textContent = parts.length
        ? `Trimming ${parts.map(([k, v]) => `${v} px ${k}`).join(', ')}. The photo will be ${px(1 - cur.left - cur.right, W)} × ${px(1 - cur.top - cur.bottom, H)} px before resizing.`
        : 'Nothing will be trimmed.';
    };
    paint();

    let drag = null;
    wrap.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('.crop-handle')?.dataset.h;
      if (!handle && !e.target.closest('.crop-box')) return;
      e.preventDefault();
      wrap.setPointerCapture(e.pointerId);
      drag = { handle: handle || 'move', x: e.clientX, y: e.clientY, start: { ...cur } };
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = (e.clientX - drag.x) / cw;
      const dy = (e.clientY - drag.y) / ch;
      const st = drag.start;
      const n = { ...st };
      const min = 0.08;
      const hd = drag.handle;
      if (hd === 'move') {
        const w = 1 - st.left - st.right;
        const hh = 1 - st.top - st.bottom;
        n.left = Math.min(Math.max(0, st.left + dx), 1 - w);
        n.right = 1 - w - n.left;
        n.top = Math.min(Math.max(0, st.top + dy), 1 - hh);
        n.bottom = 1 - hh - n.top;
      } else {
        if (hd.includes('n')) n.top = Math.min(Math.max(0, st.top + dy), 1 - st.bottom - min);
        if (hd.includes('s')) n.bottom = Math.min(Math.max(0, st.bottom - dy), 1 - st.top - min);
        if (hd.includes('w')) n.left = Math.min(Math.max(0, st.left + dx), 1 - st.right - min);
        if (hd.includes('e')) n.right = Math.min(Math.max(0, st.right - dx), 1 - st.left - min);
      }
      cur = n;
      paint();
    });
    const end = () => {
      drag = null;
    };
    wrap.addEventListener('pointerup', end);
    wrap.addEventListener('pointercancel', end);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      m.close();
      resolve(value);
    };
    const m = modal(
      [
        h('h2', { id: 'crop-title' }, title),
        h('p', { class: 'muted' }, 'Drag the edges or corners so only the photograph is inside the box.'),
        wrap,
        readout,
        h(
          'div',
          { class: 'row', style: { justifyContent: 'space-between' } },
          h(
            'div',
            { class: 'row' },
            h(
              'button',
              {
                class: 'btn btn-small',
                type: 'button',
                onclick: () => {
                  const f = detectFrame(bitmap);
                  cur = f.kind === 'none' ? { top: 0, right: 0, bottom: 0, left: 0 } : { top: f.top / H, right: f.right / W, bottom: f.bottom / H, left: f.left / W };
                  paint();
                },
              },
              'Detect border',
            ),
            h(
              'button',
              {
                class: 'btn btn-small',
                type: 'button',
                onclick: () => {
                  cur = { top: 0, right: 0, bottom: 0, left: 0 };
                  paint();
                },
              },
              'Keep whole image',
            ),
          ),
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'btn', type: 'button', onclick: () => finish(null) }, 'Cancel'),
            h('button', { class: 'btn btn-primary', type: 'button', onclick: () => finish(cur) }, 'Use this crop'),
          ),
        ),
      ],
      { labelledBy: 'crop-title', onClose: () => finish(null) },
    );
  });
}

/** Draw a small preview of the bitmap with the trimmed margins shaded. */
export function cropPreview(bitmap, insets, width = 360) {
  const s = width / bitmap.width;
  const c = makeCanvas(width, Math.round(bitmap.height * s));
  const ctx = c.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, c.width, c.height);
  const { top = 0, right = 0, bottom = 0, left = 0 } = insets || {};
  if (top || right || bottom || left) {
    ctx.fillStyle = 'rgba(200, 41, 31, 0.55)';
    const W = c.width;
    const H = c.height;
    ctx.fillRect(0, 0, W, top * H);
    ctx.fillRect(0, H - bottom * H, W, bottom * H);
    ctx.fillRect(0, top * H, left * W, H - (top + bottom) * H);
    ctx.fillRect(W - right * W, top * H, right * W, H - (top + bottom) * H);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(left * W + 0.5, top * H + 0.5, W - (left + right) * W - 1, H - (top + bottom) * H - 1);
  }
  return c;
}

/**
 * Before/after view. `before` and `after` are drawable images of the same photograph at
 * different resolutions. Drag to move the divider; Zoom shows real pixels of the result.
 */
export function compareView({ before, after, title = 'Before and after' }) {
  const view = h('div', { class: 'compare' });
  const cb = h('canvas', { class: 'before' });
  const ca = h('canvas', { class: 'after' });
  const split = h('div', { class: 'split' });
  view.append(cb, ca, split, h('span', { class: 'lbl', style: { left: '10px' } }, 'Original'), h('span', { class: 'lbl', style: { right: '10px' } }, 'Enhanced'));
  const range = h('input', { type: 'range', min: '0', max: '100', value: '50', 'aria-label': 'Divider position', style: { width: '100%' } });
  const zoomBtn = h('button', { class: 'btn btn-small', type: 'button' }, 'Zoom to real pixels');
  const info = h('p', { class: 'muted' }, `Original ${before.width} × ${before.height} px. Enhanced ${after.width} × ${after.height} px.`);
  let zoom = false;
  let cx = 0.5;
  let cy = 0.5;
  const ar = after.width / after.height;
  view.style.aspectRatio = String(ar);

  const draw = () => {
    const r = view.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    for (const c of [cb, ca]) {
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
    }
    const scale = zoom ? 1 : c0(r, dpr);
    const vw = cb.width / scale;
    const vh = cb.height / scale;
    const sx = Math.min(Math.max(0, cx * after.width - vw / 2), Math.max(0, after.width - vw));
    const sy = Math.min(Math.max(0, cy * after.height - vh / 2), Math.max(0, after.height - vh));
    const ka = ca.getContext('2d');
    ka.imageSmoothingQuality = 'high';
    ka.drawImage(after, sx, sy, vw, vh, 0, 0, ca.width, ca.height);
    const kb = cb.getContext('2d');
    kb.imageSmoothingQuality = 'high';
    const f = before.width / after.width;
    kb.drawImage(before, sx * f, sy * f, vw * f, vh * f, 0, 0, cb.width, cb.height);
  };
  function c0(r, dpr) {
    return (r.width * dpr) / after.width;
  }
  const setSplit = (pct) => {
    view.style.setProperty('--split', `${pct}%`);
    range.value = String(pct);
  };
  range.addEventListener('input', () => setSplit(Number(range.value)));
  let pan = null;
  view.addEventListener('pointerdown', (e) => {
    view.setPointerCapture(e.pointerId);
    pan = { x: e.clientX, y: e.clientY, cx, cy };
    if (!zoom) {
      const r = view.getBoundingClientRect();
      setSplit(Math.round(((e.clientX - r.left) / r.width) * 100));
    }
  });
  view.addEventListener('pointermove', (e) => {
    if (!pan) return;
    const r = view.getBoundingClientRect();
    if (zoom) {
      cx = Math.min(1, Math.max(0, pan.cx - (e.clientX - pan.x) / after.width));
      cy = Math.min(1, Math.max(0, pan.cy - (e.clientY - pan.y) / after.height));
      draw();
    } else {
      setSplit(Math.round(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100))));
    }
  });
  view.addEventListener('pointerup', () => {
    pan = null;
  });
  zoomBtn.addEventListener('click', () => {
    zoom = !zoom;
    zoomBtn.textContent = zoom ? 'Fit to window' : 'Zoom to real pixels';
    view.style.cursor = zoom ? 'grab' : 'ew-resize';
    draw();
  });
  const m = modal(
    [
      h('h2', { id: 'cmp-title' }, title),
      view,
      range,
      h('div', { class: 'row', style: { justifyContent: 'space-between' } }, info, h('div', { class: 'row' }, zoomBtn, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => m.close() }, 'Done'))),
    ],
    { labelledBy: 'cmp-title' },
  );
  requestAnimationFrame(draw);
  return m;
}
