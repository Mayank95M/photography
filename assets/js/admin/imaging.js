// Image processing for the admin panel: decoding, border detection, cropping,
// resizing and encoding. Detection functions are pure (they take RGBA pixel data)
// so they can be tested outside the browser.

// ---------------------------------------------------------------------------
// Border detection
// ---------------------------------------------------------------------------

const SIDES = ['top', 'right', 'bottom', 'left'];

// Iterate the sampled pixels of one line, `d` lines in from `side`, inside rect.
function lineSampler(img, rect, side, d) {
  const { width: W, data } = img;
  const horizontal = side === 'top' || side === 'bottom';
  const len = horizontal ? rect.x1 - rect.x0 : rect.y1 - rect.y0;
  // Ignore 5% at each end so a neighbouring frame of a different depth does not leak in.
  const margin = Math.floor(len * 0.05);
  const start = margin;
  const end = len - margin;
  const step = Math.max(1, Math.floor((end - start) / 1200));
  let fixed;
  if (side === 'top') fixed = rect.y0 + d;
  else if (side === 'bottom') fixed = rect.y1 - 1 - d;
  else if (side === 'left') fixed = rect.x0 + d;
  else fixed = rect.x1 - 1 - d;
  return {
    count: Math.floor((end - start - 1) / step) + 1,
    forEach(fn) {
      for (let i = start; i < end; i += step) {
        const x = horizontal ? rect.x0 + i : fixed;
        const y = horizontal ? fixed : rect.y0 + i;
        const k = (y * W + x) * 4;
        fn(data[k], data[k + 1], data[k + 2]);
      }
    },
  };
}

function median(values) {
  const a = Float64Array.from(values).sort();
  return a.length ? a[a.length >> 1] : 0;
}

function percentile(values, p) {
  const a = Float64Array.from(values).sort();
  if (!a.length) return 0;
  return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];
}

function lineColor(img, rect, side, d) {
  const rs = [];
  const gs = [];
  const bs = [];
  lineSampler(img, rect, side, d).forEach((r, g, b) => {
    rs.push(r);
    gs.push(g);
    bs.push(b);
  });
  return [median(rs), median(gs), median(bs)];
}

function deviations(img, rect, side, d, ref) {
  const out = [];
  lineSampler(img, rect, side, d).forEach((r, g, b) => {
    out.push(Math.max(Math.abs(r - ref[0]), Math.abs(g - ref[1]), Math.abs(b - ref[2])));
  });
  return out;
}

function matchFraction(img, rect, side, d, ref, tol) {
  let hit = 0;
  let n = 0;
  lineSampler(img, rect, side, d).forEach((r, g, b) => {
    n++;
    if (Math.abs(r - ref[0]) <= tol && Math.abs(g - ref[1]) <= tol && Math.abs(b - ref[2]) <= tol) hit++;
  });
  return n ? hit / n : 0;
}

function sideLength(rect, side) {
  return side === 'top' || side === 'bottom' ? rect.y1 - rect.y0 : rect.x1 - rect.x0;
}

// Scan inward from one side while lines stay the colour of the outermost line.
function solidSide(img, rect, side) {
  const dim = sideLength(rect, side);
  const maxDepth = Math.floor(dim * 0.42);
  const ref = lineColor(img, rect, side, 0);
  const dev = percentile(deviations(img, rect, side, 0, ref), 0.95);
  const result = { depth: 0, soft: 0, color: ref, abrupt: false, noise: dev };
  if (dev > 20) return result; // outer line is not a flat colour
  const tol = Math.min(30, Math.max(12, dev * 3 + 10));
  // Clean lines match the frame colour almost everywhere. "Marked" lines are mostly frame
  // with a little ink on them, such as a signature or handle written on the border; we
  // step over such a band only if clean frame lines follow it.
  const maxBand = Math.max(4, Math.round(dim * 0.08));
  let lastClean = -1;
  for (let d = 0; d < maxDepth; d++) {
    const f = matchFraction(img, rect, side, d, ref, tol);
    if (f >= 0.965) lastClean = d;
    else if (f < 0.6 || d - lastClean > maxBand) break;
  }
  const d = lastClean + 1;
  if (d === 0 || d >= maxDepth) return result;
  // Lines just inside the border are often a blend of border and photo (resampling,
  // JPEG ringing). Count up to four mostly-border lines into the soft depth.
  let soft = d;
  const after = [];
  for (let k = 0; k < 6 && d + k < dim; k++) after.push(matchFraction(img, rect, side, d + k, ref, tol));
  for (let k = 0; k < 4 && k < after.length && after[k] >= 0.5; k++) soft = d + k + 1;
  // A real frame ends in a step: the photo differs sharply from the last frame line.
  // A bright sky running on from a white frame fades out instead, so the step is tiny.
  const step = lineStep(img, rect, side, d - 1, Math.min(dim - 1, d + 3));
  const abrupt = Math.min(...after.slice(0, 5)) < 0.55 && step > 10;
  return { depth: d, soft, color: ref, abrupt, noise: dev, tol, step };
}

// Mean per-pixel colour difference between two lines on the same side.
function lineStep(img, rect, side, d1, d2) {
  const a = [];
  lineSampler(img, rect, side, d1).forEach((r, g, b) => a.push(r, g, b));
  let i = 0;
  let sum = 0;
  let n = 0;
  lineSampler(img, rect, side, d2).forEach((r, g, b) => {
    sum += Math.max(Math.abs(r - a[i]), Math.abs(g - a[i + 1]), Math.abs(b - a[i + 2]));
    i += 3;
    n++;
  });
  return n ? sum / n : 0;
}

function luminanceAt(data, k) {
  return 0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2];
}

// Look for a straight, full-width edge separating a smooth (blurred) margin from the photo.
function blurredSide(img, rect, side) {
  const { width: W, data } = img;
  const dim = sideLength(rect, side);
  const maxDepth = Math.floor(dim * 0.42);
  const horizontal = side === 'top' || side === 'bottom';
  const len = horizontal ? rect.x1 - rect.x0 : rect.y1 - rect.y0;
  const step = Math.max(1, Math.floor(len / 400));
  const lum = (d, i) => {
    let x;
    let y;
    if (side === 'top') [x, y] = [rect.x0 + i, rect.y0 + d];
    else if (side === 'bottom') [x, y] = [rect.x0 + i, rect.y1 - 1 - d];
    else if (side === 'left') [x, y] = [rect.x0 + d, rect.y0 + i];
    else [x, y] = [rect.x1 - 1 - d, rect.y0 + i];
    return luminanceAt(data, (y * W + x) * 4);
  };
  const texture = [];
  const edge = [];
  const straight = [];
  for (let d = 0; d < maxDepth; d++) {
    let t = 0;
    let e = 0;
    let s = 0;
    let n = 0;
    for (let i = step; i < len - step; i += step) {
      const v = lum(d, i);
      t += Math.abs(v - lum(d, i - step));
      const dv = Math.abs(v - lum(d + 1, i));
      e += dv;
      if (dv > 8) s++;
      n++;
    }
    texture.push(t / n);
    edge.push(e / n);
    straight.push(s / n);
  }
  for (let d = 3; d < maxDepth - 12; d++) {
    const before = edge.slice(0, d);
    const base = median(before);
    if (edge[d] < Math.max(6, base * 5) || straight[d] < 0.5) continue;
    const texIn = texture.slice(0, d).reduce((a, b) => a + b, 0) / d;
    const texOut = texture.slice(d + 2, d + 40).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(38, maxDepth - d - 2));
    if (texIn < texOut * 0.6) return { depth: d + 1, soft: d + 1, abrupt: true };
    break;
  }
  return { depth: 0, soft: 0, abrupt: false };
}

const sameColor = (a, b, tol = 24) => a && b && a.every((v, i) => Math.abs(v - b[i]) <= tol);

function detectInRect(img, rect) {
  const sides = {};
  for (const s of SIDES) sides[s] = solidSide(img, rect, s);
  return sides;
}

/**
 * Detect a frame (solid colour or blurred copy of the photo) added around a photo.
 * Returns pixel insets for each side plus how sure the detection is.
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img RGBA pixels
 */
export function detectBorders(img, { extraTrim } = {}) {
  const W = img.width;
  const H = img.height;
  const full = { x0: 0, y0: 0, x1: W, y1: H };
  const none = { top: 0, right: 0, bottom: 0, left: 0, kind: 'none', confidence: 'none', color: null };
  if (W < 32 || H < 32) return none;
  const sides = detectInRect(img, full);
  const found = SIDES.filter((s) => sides[s].depth > 0);

  // Thin hits on a single side without a matching colour elsewhere are usually just
  // a bright sky or a dark shadow touching the edge, not a frame.
  const minDepth = (s) => Math.max(3, Math.round(sideLength(full, s) * 0.004));
  for (const s of found) if (sides[s].depth < minDepth(s)) sides[s].depth = sides[s].soft = 0;

  let solid = SIDES.filter((s) => sides[s].depth > 0);
  let kind = solid.length ? 'solid' : 'none';
  let notes = [];

  // All bordered sides should share one colour; drop outliers that disagree with the majority.
  if (solid.length > 1) {
    const ref = solid
      .map((s) => sides[s].color)
      .find((c, _, all) => all.filter((o) => sameColor(c, o)).length > all.length / 2);
    if (ref) {
      for (const s of solid) if (!sameColor(sides[s].color, ref)) sides[s].depth = sides[s].soft = 0;
      solid = SIDES.filter((s) => sides[s].depth > 0);
    }
  }

  const pairs = [
    ['top', 'bottom'],
    ['left', 'right'],
  ];
  // A frame added by an app is centred, so opposite sides usually match. If one side ran
  // on into a matching area of the photo (a white sky against a white frame), its edge is
  // gradual; trust the opposite, crisp side instead.
  for (const [a, b] of pairs) {
    const A = sides[a];
    const B = sides[b];
    if (!A.depth || !B.depth) continue;
    const tol = Math.max(3, Math.round(sideLength(full, a) * 0.015));
    if (Math.abs(A.depth - B.depth) <= tol) continue;
    const [big, small] = A.depth > B.depth ? [A, B] : [B, A];
    if (!big.abrupt && small.abrupt) {
      big.depth = small.depth;
      big.soft = small.soft;
      big.abrupt = true;
      notes.push('equalised');
    }
  }

  if (!solid.length) {
    // Try a blurred background on opposite sides.
    for (const [a, b] of pairs) {
      const A = blurredSide(img, full, a);
      const B = blurredSide(img, full, b);
      const tol = Math.max(4, Math.round(sideLength(full, a) * 0.02));
      if (A.depth && B.depth && Math.abs(A.depth - B.depth) <= tol) {
        sides[a] = { ...A, color: null };
        sides[b] = { ...B, color: null };
        kind = 'blurred';
      }
    }
    if (kind === 'none') return none;
  }

  const bordered = SIDES.filter((s) => sides[s].depth > 0);
  const trim = extraTrim ?? Math.max(1, Math.round(Math.max(W, H) * 0.002));
  const inset = {};
  for (const s of SIDES) inset[s] = sides[s].depth > 0 ? sides[s].soft + trim : 0;

  // Peel a second, thin frame (e.g. a black keyline inside a white mat) only if it
  // surrounds the photo on all four sides in one colour.
  if (kind === 'solid') {
    const inner = { x0: inset.left, y0: inset.top, x1: W - inset.right, y1: H - inset.bottom };
    if (inner.x1 - inner.x0 > 64 && inner.y1 - inner.y0 > 64) {
      const second = detectInRect(img, inner);
      const ok = SIDES.every((s) => {
        const r = second[s];
        return r.depth > 0 && r.abrupt && r.depth <= sideLength(inner, s) * 0.03 && sameColor(r.color, second.top.color);
      });
      if (ok) {
        for (const s of SIDES) inset[s] += second[s].soft;
        notes.push('double frame');
      }
    }
  }

  const cropW = W - inset.left - inset.right;
  const cropH = H - inset.top - inset.bottom;
  if (cropW < W * 0.3 || cropH < H * 0.3) return none;

  const hasPair = pairs.some(([a, b]) => sides[a].depth > 0 && sides[b].depth > 0);
  const allAbrupt = bordered.every((s) => sides[s].abrupt);
  let confidence;
  if (kind === 'blurred') confidence = 'medium';
  else if (hasPair && allAbrupt && !notes.includes('equalised')) confidence = 'high';
  else if (hasPair && allAbrupt) confidence = 'medium';
  else confidence = 'low';

  const color = kind === 'solid' ? sides[bordered[0]].color.map(Math.round) : null;
  return { ...inset, kind, confidence, color, notes };
}

/** Crop rectangle (x, y, w, h) for a detection result. */
export function cropRect(width, height, b) {
  return {
    x: b.left,
    y: b.top,
    w: Math.max(1, width - b.left - b.right),
    h: Math.max(1, height - b.top - b.bottom),
  };
}

// ---------------------------------------------------------------------------
// Browser helpers (canvas based)
// ---------------------------------------------------------------------------

export class UnsupportedImageError extends Error {}

/** Decode a File/Blob into an ImageBitmap, honouring EXIF orientation. */
export async function decode(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (err) {
    // Some browsers reject the options bag; try once without it.
    try {
      return await createImageBitmap(blob);
    } catch {
      const name = blob.name || 'This file';
      const heic = /\.hei[cf]$/i.test(blob.name || '') || /heic|heif/i.test(blob.type || '');
      throw new UnsupportedImageError(
        heic
          ? `${name} is a HEIC photo, which this browser can't open. Export it as JPEG first, or use Safari.`
          : `${name} couldn't be opened as an image.`,
      );
    }
  }
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function pixels(source, maxSide = Infinity) {
  const w = source.width;
  const h = source.height;
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = makeCanvas(w * s, h * s);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return { imageData: ctx.getImageData(0, 0, c.width, c.height), scale: s };
}

/** Run detection on an ImageBitmap/canvas (downsampled for very large images). */
export function detectFrame(source) {
  const { imageData, scale } = pixels(source, 2000);
  const r = detectBorders(imageData);
  if (scale === 1 || r.kind === 'none') return r;
  const up = (v) => (v ? Math.round(v / scale) + 1 : 0);
  return { ...r, top: up(r.top), right: up(r.right), bottom: up(r.bottom), left: up(r.left) };
}

export function crop(source, rect) {
  const c = makeCanvas(rect.w, rect.h);
  c.getContext('2d').drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  return c;
}

/** High quality resize. Large reductions are done in halving steps to avoid aliasing. */
export function resize(source, w, h) {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  let cur = source;
  let cw = source.width;
  let ch = source.height;
  while (cw / 2 >= w && ch / 2 >= h) {
    const c = makeCanvas(Math.round(cw / 2), Math.round(ch / 2));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, c.width, c.height);
    cur = c;
    cw = c.width;
    ch = c.height;
  }
  if (cw === w && ch === h) return cur;
  const out = makeCanvas(w, h);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, w, h);
  return out;
}

export function fitWithin(w, h, maxLong) {
  const s = Math.min(1, maxLong / Math.max(w, h));
  return [Math.round(w * s), Math.round(h * s)];
}

let webpSupport;
export function supportsWebp() {
  if (webpSupport === undefined) {
    try {
      webpSupport = makeCanvas(2, 2).toDataURL('image/webp').startsWith('data:image/webp');
    } catch {
      webpSupport = false;
    }
  }
  return webpSupport;
}

export function encode(canvas, type = 'image/jpeg', quality = 0.9) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality);
  });
}

/** Tiny blurred placeholder (data URL) and average colour for progressive loading. */
export function placeholder(source) {
  const w = 24;
  const h = Math.max(1, Math.round((w * source.height) / source.width));
  const c = resize(source, w, h);
  const data = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  let r = 0;
  let g = 0;
  let b = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  const hex = (v) => Math.round(v / n).toString(16).padStart(2, '0');
  return {
    lqip: c.toDataURL('image/jpeg', 0.55),
    color: `#${hex(r)}${hex(g)}${hex(b)}`,
  };
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}
