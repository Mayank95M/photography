// AI resolution enhancement in the browser, on the GPU through TensorFlow.js (WebGL).
//
// Three Real-ESRGAN models (BSD-3-Clause, Xintao Wang):
//   fast  realesr-general-x4v3  SRVGGNetCompact, 1.2M weights, 4x. Quick, but smooths fine texture.
//   x2    RealESRGAN_x2plus     RRDBNet, 16.7M weights, 2x. Keeps far more real-looking detail.
//   x4    RealESRGAN_x4plus     RRDBNet, 16.7M weights, 4x. For very small sources.
// All three were trained on real-world damage (blur, noise, JPEG), so they also clean up
// Instagram's compression while adding resolution.

import { makeCanvas } from './imaging.js';

const TF_SRC = new URL('../../vendor/tf.min.js', import.meta.url);

export const MODELS = {
  fast: { dir: 'realesr-general-x4v3', kind: 'compact', scale: 4, tile: 224, pad: 12, mb: 2.4 },
  x2: { dir: 'realesrgan-x2plus', kind: 'rrdb', scale: 2, tile: 192, pad: 16, mb: 33 },
  x4: { dir: 'realesrgan-x4plus', kind: 'rrdb', scale: 4, tile: 112, pad: 12, mb: 33 },
};

// Rough work per source pixel, in GFLOP, for time estimates.
const COST = { fast: 0.0026, x2: 0.0095, x4: 0.037 };

// ---------------------------------------------------------------- TensorFlow.js

let tfLoading = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

function loadTF() {
  if (!tfLoading) {
    tfLoading = (async () => {
      if (!window.tf) await loadScript(TF_SRC);
      const tf = window.tf;
      try {
        await tf.setBackend('webgl');
      } catch {
        /* tf picks a fallback; enhancementAvailable() reports it */
      }
      await tf.ready();
      return tf;
    })().catch((err) => {
      tfLoading = null;
      throw err;
    });
  }
  return tfLoading;
}

/** True when the GPU path works. On the CPU fallback the models are far too slow to use. */
export async function enhancementAvailable() {
  try {
    const tf = await loadTF();
    return tf.getBackend() === 'webgl';
  } catch {
    return false;
  }
}

let bestCheck = null;

/**
 * Whether the Best quality models are on the site. They are installed separately, once (their
 * files are too large for GitHub's upload page), so until then Best falls back to Fast.
 * @param {{fresh?: boolean}} opts fresh: check again instead of using the last answer
 * @returns {Promise<boolean>}
 */
export function bestModelsReady({ fresh = false } = {}) {
  if (!bestCheck || fresh) {
    bestCheck = Promise.all(
      ['x2', 'x4'].map(async (name) => {
        try {
          const url = new URL(`../../models/${MODELS[name].dir}/model.json`, import.meta.url);
          url.searchParams.set('check', String(Date.now())); // past any cached "not found"
          const res = await fetch(url, { cache: 'no-store' });
          if (!res.ok) return false;
          const m = await res.json();
          return Array.isArray(m.shards) && m.shards.length > 0;
        } catch {
          return false;
        }
      }),
    ).then((ok) => ok.every(Boolean));
  }
  return bestCheck;
}

/** Quick check (no downloads) for showing hints before anything is loaded. */
export async function gpuAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- weights

let halfTable;
function halfToFloat(u16) {
  if (!halfTable) {
    halfTable = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) {
      const s = h & 0x8000 ? -1 : 1;
      const e = (h >> 10) & 0x1f;
      const f = h & 0x3ff;
      if (e === 0) halfTable[h] = s * 2 ** -14 * (f / 1024);
      else if (e === 31) halfTable[h] = f ? NaN : s * Infinity;
      else halfTable[h] = s * 2 ** (e - 15) * (1 + f / 1024);
    }
  }
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) out[i] = halfTable[u16[i]];
  return out;
}

async function fetchBytes(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the enhancement model (${res.status}).`);
  if (!res.body || !onBytes) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.length;
    onBytes(value.length);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const loaded = new Map(); // name -> Promise<model>

/**
 * Load a model (cached by the browser after the first download).
 * Only one of the large models stays on the GPU at a time.
 * @param {'fast'|'x2'|'x4'} name
 * @param {{onProgress?: (fraction:number) => void}} opts download progress, 0..1
 */
export function loadModel(name = 'fast', { onProgress } = {}) {
  const def = MODELS[name];
  if (!def) throw new Error(`Unknown model ${name}`);
  if (!loaded.has(name)) {
    if (def.kind === 'rrdb') {
      for (const [other, p] of loaded) {
        if (other !== name && MODELS[other].kind === 'rrdb') {
          loaded.delete(other);
          p.then((m) => Object.values(m.t).forEach((t) => t.dispose())).catch(() => {});
        }
      }
    }
    const dir = new URL(`../../models/${def.dir}/`, import.meta.url);
    const p = (async () => {
      const tf = await loadTF();
      const res = await fetch(new URL('model.json', dir));
      if (!res.ok) {
        const err = new Error(
          def.kind === 'rrdb'
            ? 'The Best quality models aren’t installed on your site yet. Install them in Settings → Site files.'
            : `Could not download the enhancement model (${res.status}).`,
        );
        err.code = 'model-missing';
        throw err;
      }
      const manifest = await res.json();
      const files = manifest.shards || ['weights.bin'];
      const total = manifest.bytes || 0;
      let got = 0;
      const bufs = await Promise.all(
        files.map((f) =>
          fetchBytes(new URL(f, dir), (n) => {
            got += n;
            if (total) onProgress?.(Math.min(1, got / total));
          }),
        ),
      );
      const all = new Uint8Array(bufs.reduce((s, b) => s + b.length, 0));
      let o = 0;
      for (const b of bufs) {
        all.set(b, o);
        o += b.length;
      }
      const raw = new Uint16Array(all.buffer, 0, all.length >> 1);
      const t = {};
      for (const e of manifest.tensors) {
        const start = e.offset / 2;
        t[e.name] = tf.tensor(halfToFloat(raw.subarray(start, start + e.length)), e.shape, 'float32');
      }
      onProgress?.(1);
      const layers = manifest.tensors.filter((e) => e.name.endsWith('.w')).length;
      return { name, tf, t, def, layers, scale: manifest.scale, blocks: manifest.blocks || 23, backend: tf.getBackend() };
    })();
    p.catch(() => loaded.delete(name));
    loaded.set(name, p);
  }
  return loaded.get(name);
}

// ---------------------------------------------------------------- networks

function compactForward(m, x) {
  const { tf, t, layers, scale } = m;
  return tf.tidy(() => {
    let y = x;
    for (let i = 0; i < layers; i++) {
      const alpha = t[`conv${i}.a`];
      y = tf.fused.conv2d({
        x: y,
        filter: t[`conv${i}.w`],
        strides: 1,
        pad: 'same',
        bias: t[`conv${i}.b`],
        activation: alpha ? 'prelu' : 'linear',
        preluActivationWeights: alpha,
      });
    }
    const [, h, w] = x.shape;
    y = tf.depthToSpace(y, scale, 'NHWC');
    const base = tf.image.resizeNearestNeighbor(x, [h * scale, w * scale]);
    return tf.clipByValue(tf.add(y, base), 0, 1);
  });
}

// PyTorch pixel_unshuffle: [1,h,w,c] -> [1,h/2,w/2,4c], channel = c*4 + dy*2 + dx
function unshuffle2(tf, x) {
  const [, h, w, c] = x.shape;
  const y = tf.reshape(x, [1, h / 2, 2, w / 2, 2, c]);
  return tf.reshape(tf.transpose(y, [0, 1, 3, 5, 2, 4]), [1, h / 2, w / 2, c * 4]);
}

function rrdbForward(m, x) {
  const { tf, t, blocks } = m;
  const conv = (y, name, lrelu) =>
    tf.fused.conv2d({
      x: y,
      filter: t[`${name}.w`],
      bias: t[`${name}.b`],
      strides: 1,
      pad: 'same',
      activation: lrelu ? 'leakyrelu' : 'linear',
      leakyreluAlpha: 0.2,
    });
  const up2 = (y) => tf.image.resizeNearestNeighbor(y, [y.shape[1] * 2, y.shape[2] * 2]);

  const feat = tf.tidy(() => conv(m.scale === 2 ? unshuffle2(tf, x) : x, 'first'));
  let body = feat;
  for (let i = 0; i < blocks; i++) {
    const prev = body;
    body = tf.tidy(() => {
      let out = prev;
      for (let j = 1; j <= 3; j++) {
        const inp = out;
        // Each dense block gets its own scope so its wide concatenations are freed at once.
        out = tf.tidy(() => {
          const p = `b${i}.r${j}.`;
          const x1 = conv(inp, `${p}c1`, true);
          const x2 = conv(tf.concat([inp, x1], 3), `${p}c2`, true);
          const x3 = conv(tf.concat([inp, x1, x2], 3), `${p}c3`, true);
          const x4 = conv(tf.concat([inp, x1, x2, x3], 3), `${p}c4`, true);
          const x5 = conv(tf.concat([inp, x1, x2, x3, x4], 3), `${p}c5`, false);
          return tf.add(tf.mul(x5, 0.2), inp);
        });
      }
      return tf.add(tf.mul(out, 0.2), prev);
    });
    if (prev !== feat) prev.dispose();
  }
  const out = tf.tidy(() => {
    let f = tf.add(feat, conv(body, 'body'));
    f = conv(up2(f), 'up1', true);
    f = conv(up2(f), 'up2', true);
    return tf.clipByValue(conv(conv(f, 'hr', true), 'last'), 0, 1);
  });
  if (body !== feat) body.dispose();
  feat.dispose();
  return out;
}

function forward(m, x) {
  return m.def.kind === 'rrdb' ? rrdbForward(m, x) : compactForward(m, x);
}

/** Run a network on float RGB data without tiling (used by tests). */
export async function runRaw(name, rgb, w, h) {
  const m = await loadModel(name);
  const x = m.tf.tensor4d(rgb, [1, h, w, 3]);
  const y = forward(m, x);
  const data = await y.data();
  x.dispose();
  y.dispose();
  return data;
}

// ---------------------------------------------------------------- tiled upscaling

function mirror(i, n) {
  if (n === 1) return 0;
  const period = 2 * n - 2;
  i %= period;
  if (i < 0) i += period;
  return i < n ? i : period - i;
}

const speed = {}; // measured seconds per source pixel, per model

/**
 * Upscale an image with the chosen model, in overlapping tiles of one fixed size (so the GPU
 * programs are compiled once per session rather than once per photo).
 * @param {CanvasImageSource & {width:number,height:number}} source
 * @param {{model?: 'fast'|'x2'|'x4', onProgress?: (fraction:number)=>void, onDownload?: (fraction:number)=>void, signal?: AbortSignal}} opts
 * @returns {Promise<HTMLCanvasElement>} the image at model scale
 */
export async function upscale(source, { model = 'fast', onProgress, onDownload, signal } = {}) {
  const m = await loadModel(model, { onProgress: onDownload });
  const { tf, scale: S } = m;
  const { tile: T, pad: P } = m.def;
  const W = source.width;
  const H = source.height;

  const src = makeCanvas(W, H);
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.fillStyle = '#fff';
  sctx.fillRect(0, 0, W, H);
  sctx.drawImage(source, 0, 0);
  const pixels = sctx.getImageData(0, 0, W, H).data;
  src.width = src.height = 0;

  const out = makeCanvas(W * S, H * S);
  const octx = out.getContext('2d');
  const cols = Math.ceil(W / T);
  const rows = Math.ceil(H / T);
  const total = cols * rows;
  const N = T + 2 * P;
  const input = new Float32Array(N * N * 3);
  const xs = new Int32Array(N);
  const started = performance.now();
  let done = 0;

  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      if (signal?.aborted) throw new DOMException('Enhancement cancelled', 'AbortError');
      const x0 = tx * T;
      const y0 = ty * T;
      const vw = Math.min(T, W - x0);
      const vh = Math.min(T, H - y0);
      for (let i = 0; i < N; i++) xs[i] = mirror(x0 - P + i, W);
      let o = 0;
      for (let j = 0; j < N; j++) {
        const row = mirror(y0 - P + j, H) * W;
        for (let i = 0; i < N; i++) {
          const k = (row + xs[i]) * 4;
          input[o++] = pixels[k] / 255;
          input[o++] = pixels[k + 1] / 255;
          input[o++] = pixels[k + 2] / 255;
        }
      }
      const xt = tf.tensor4d(input, [1, N, N, 3]);
      const yt = forward(m, xt);
      const core = tf.slice(yt, [0, P * S, P * S, 0], [1, vh * S, vw * S, 3]);
      const data = await core.data();
      tf.dispose([xt, yt, core]);
      const img = new ImageData(vw * S, vh * S);
      const d = img.data;
      for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
        d[j] = data[i] * 255 + 0.5;
        d[j + 1] = data[i + 1] * 255 + 0.5;
        d[j + 2] = data[i + 2] * 255 + 0.5;
        d[j + 3] = 255;
      }
      octx.putImageData(img, x0 * S, y0 * S);
      done++;
      onProgress?.(done / total);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  // Remember the speed (skipping the first tile, which includes shader compilation).
  const secs = (performance.now() - started) / 1000;
  if (total > 1) speed[model] = secs / (W * H);
  return out;
}

/** Back-compat for older callers. */
export function upscale4x(source, opts = {}) {
  return upscale(source, { ...opts, model: 'fast' });
}

// ---------------------------------------------------------------- choosing a model

/**
 * Which model to use to take a photo from `fromLong` to `toLong` pixels on its long edge.
 * Returns null when no enhancement is needed.
 * @param {'best'|'fast'} quality
 */
export function chooseModel(fromLong, toLong, quality = 'best') {
  const f = toLong / fromLong;
  if (quality === 'fast') return f > 1.66 ? 'fast' : null;
  if (f <= 1.15) return null;
  return f <= 2.5 ? 'x2' : 'x4';
}

/** Rough seconds to enhance a w×h photo; measured speed when available, else a laptop guess. */
export function estimateSeconds(model, w, h) {
  if (!model) return 0;
  if (speed[model]) return speed[model] * w * h;
  return (COST[model] * w * h) / 120; // assume ~120 GFLOP/s through WebGL
}
