// Finishing for screen display, applied after resizing to the published size:
// local contrast ("clarity"), output sharpening, a little vibrance, and a fine grain that keeps
// enlarged photos from looking plastic. Pure functions on RGBA pixel data, so they can be
// tested outside the browser.

export const FINISHES = {
  off: null,
  natural: { clarity: 0.22, sharpen: 0.42, vibrance: 0.07, grain: 1.0 },
  vivid: { clarity: 0.38, sharpen: 0.55, vibrance: 0.16, grain: 1.15 },
};

// Box sizes whose three passes approximate a Gaussian of the given sigma.
function boxesForGauss(sigma, n = 3) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

function boxH(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const first = src[row];
    let acc = (r + 1) * first;
    for (let j = 0; j < r; j++) acc += src[row + Math.min(j, w - 1)];
    for (let x = 0; x < w; x++) {
      acc += src[row + Math.min(x + r, w - 1)] - (x - r - 1 >= 0 ? src[row + x - r - 1] : first);
      dst[row + x] = acc * iarr;
    }
  }
}

function boxV(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let x = 0; x < w; x++) {
    const first = src[x];
    let acc = (r + 1) * first;
    for (let j = 0; j < r; j++) acc += src[Math.min(j, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      acc += src[Math.min(y + r, h - 1) * w + x] - (y - r - 1 >= 0 ? src[(y - r - 1) * w + x] : first);
      dst[y * w + x] = acc * iarr;
    }
  }
}

/** Gaussian blur (approximate) of a single-channel float image. */
export function blur(src, w, h, sigma) {
  const out = Float32Array.from(src);
  if (sigma < 0.3) return out;
  const tmp = new Float32Array(src.length);
  for (const size of boxesForGauss(sigma)) {
    const r = (size - 1) >> 1;
    if (r < 1) continue;
    boxH(out, tmp, w, h, r);
    boxV(tmp, out, w, h, r);
  }
  return out;
}

// Small deterministic random generator, so the same photo always gets the same grain.
function rng(seed) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * Finish an image in place.
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img RGBA
 * @param {'natural'|'vivid'|'off'|object} style
 * @param {{seed?: number}} opts
 */
export function finish(img, style = 'natural', { seed = 1 } = {}) {
  const p = typeof style === 'string' ? FINISHES[style] : style;
  if (!p) return img;
  const { data, width: w, height: h } = img;
  const n = w * h;
  const long = Math.max(w, h);

  // Luma on the encoded values (perceptual, like editing software).
  const L = new Float32Array(n);
  for (let i = 0, k = 0; i < n; i++, k += 4) L[i] = (0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2]) / 255;

  // Buffers are reused as we go so a 2560 px photo stays under ~90 MB of working memory.
  const delta = new Float32Array(n);
  let L1 = L;

  // 1. Clarity: lift mid-scale local contrast, mostly in the midtones, with halos capped.
  if (p.clarity) {
    const base = blur(L, w, h, Math.max(2, long / 140));
    for (let i = 0; i < n; i++) {
      const l = L[i];
      let d = l - base[i];
      if (d > 0.12) d = 0.12;
      else if (d < -0.12) d = -0.12;
      delta[i] = p.clarity * (1 - (2 * l - 1) ** 2) * d;
      base[i] = l + delta[i]; // becomes the clarified luminance
    }
    L1 = base;
  }

  // 2. Output sharpening at the final size, with a small threshold so noise isn't amplified.
  if (p.sharpen) {
    const soft = blur(L1, w, h, 0.85);
    for (let i = 0; i < n; i++) {
      let d = L1[i] - soft[i];
      const a = Math.abs(d);
      if (a < 0.004) d *= a / 0.004;
      if (d > 0.08) d = 0.08;
      else if (d < -0.08) d = -0.08;
      delta[i] += p.sharpen * d;
    }
  }
  L1 = null;

  // 3. Grain: fine, slightly soft luminance noise, strongest in the midtones.
  if (p.grain) {
    const rand = rng(seed);
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) g[i] = rand() + rand() + rand() - 1.5; // ~N(0, 0.5)
    const soft = blur(g, w, h, 0.55);
    const amp = (p.grain * 1.4) / 255 / 0.32; // soft noise has sigma ~0.32 * 0.5
    for (let i = 0; i < n; i++) {
      const l = L[i];
      delta[i] += soft[i] * amp * 4 * l * (1 - l) * 0.5;
    }
  }

  // Apply the luminance change to all channels (keeps hue), then vibrance.
  const v = p.vibrance || 0;
  for (let i = 0, k = 0; i < n; i++, k += 4) {
    let r = data[k] / 255 + delta[i];
    let gg = data[k + 1] / 255 + delta[i];
    let b = data[k + 2] / 255 + delta[i];
    if (v) {
      const mx = Math.max(r, gg, b);
      const mn = Math.min(r, gg, b);
      const sat = mx > 0 ? (mx - mn) / mx : 0;
      const y = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      const f = 1 + v * (1 - sat) * (1 - sat);
      r = y + (r - y) * f;
      gg = y + (gg - y) * f;
      b = y + (b - y) * f;
    }
    data[k] = r * 255 + 0.5;
    data[k + 1] = gg * 255 + 0.5;
    data[k + 2] = b * 255 + 0.5;
  }
  return img;
}
