// AI resolution enhancement in the browser.
// Runs Real-ESRGAN's realesr-general-x4v3 (SRVGGNetCompact, BSD-3-Clause) with TensorFlow.js
// on the GPU via WebGL. The network was trained on real-world degradations, so besides
// adding resolution it also cleans up JPEG blocking from Instagram's compression.

import { makeCanvas } from './imaging.js';

const MODEL_DIR = new URL('../../models/realesr-general-x4v3/', import.meta.url);
const TF_SRC = new URL('../../vendor/tf.min.js', import.meta.url);

let loading = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

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

/** Load TensorFlow.js and the model weights (about 4 MB, cached by the browser). */
export function loadModel() {
  if (!loading) {
    loading = (async () => {
      if (!window.tf) await loadScript(TF_SRC);
      const tf = window.tf;
      try {
        await tf.setBackend('webgl');
      } catch {
        /* falls through to whatever tf picks */
      }
      await tf.ready();
      const manifest = await (await fetch(new URL('model.json', MODEL_DIR))).json();
      const raw = new Uint16Array(await (await fetch(new URL('weights.bin', MODEL_DIR))).arrayBuffer());
      const t = {};
      for (const e of manifest.tensors) {
        const start = e.offset / 2;
        t[e.name] = tf.tensor(halfToFloat(raw.subarray(start, start + e.length)), e.shape, 'float32');
      }
      const layers = manifest.tensors.filter((e) => e.name.endsWith('.w')).length;
      return { tf, t, layers, scale: manifest.scale, backend: tf.getBackend() };
    })().catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

/** True once the model is loaded on the GPU. On the CPU fallback it is far too slow to use. */
export async function enhancementAvailable() {
  try {
    const m = await loadModel();
    return m.backend === 'webgl';
  } catch {
    return false;
  }
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

function forward(m, x) {
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

/** Run the raw network on float RGB data (used by tests). Returns Float32Array of size 16·h·w·3. */
export async function runRaw(rgb, w, h) {
  const m = await loadModel();
  const x = m.tf.tensor4d(rgb, [1, h, w, 3]);
  const y = forward(m, x);
  const data = await y.data();
  x.dispose();
  y.dispose();
  return data;
}

/**
 * Upscale an image 4× in overlapping tiles.
 * @param {CanvasImageSource & {width:number,height:number}} source
 * @param {{onProgress?: (fraction:number)=>void, signal?: AbortSignal}} opts
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function upscale4x(source, { onProgress, signal } = {}) {
  const m = await loadModel();
  const { tf, scale: S } = m;
  const W = source.width;
  const H = source.height;
  const tile = m.backend === 'webgl' ? 224 : 96;
  const pad = 12;

  const src = makeCanvas(W, H);
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.fillStyle = '#fff';
  sctx.fillRect(0, 0, W, H);
  sctx.drawImage(source, 0, 0);
  const pixels = sctx.getImageData(0, 0, W, H).data;

  const out = makeCanvas(W * S, H * S);
  const octx = out.getContext('2d');
  const cols = Math.ceil(W / tile);
  const rows = Math.ceil(H / tile);
  const total = cols * rows;
  let done = 0;

  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      if (signal?.aborted) throw new DOMException('Enhancement cancelled', 'AbortError');
      const x0 = tx * tile;
      const y0 = ty * tile;
      const x1 = Math.min(W, x0 + tile);
      const y1 = Math.min(H, y0 + tile);
      const px0 = Math.max(0, x0 - pad);
      const py0 = Math.max(0, y0 - pad);
      const px1 = Math.min(W, x1 + pad);
      const py1 = Math.min(H, y1 + pad);
      const pw = px1 - px0;
      const ph = py1 - py0;
      const input = new Float32Array(pw * ph * 3);
      for (let y = 0; y < ph; y++) {
        let k = ((py0 + y) * W + px0) * 4;
        let o = y * pw * 3;
        for (let x = 0; x < pw; x++, k += 4) {
          input[o++] = pixels[k] / 255;
          input[o++] = pixels[k + 1] / 255;
          input[o++] = pixels[k + 2] / 255;
        }
      }
      const xt = tf.tensor4d(input, [1, ph, pw, 3]);
      const yt = forward(m, xt);
      const tw = (x1 - x0) * S;
      const th = (y1 - y0) * S;
      const core = tf.slice(yt, [0, (y0 - py0) * S, (x0 - px0) * S, 0], [1, th, tw, 3]);
      const data = await core.data();
      xt.dispose();
      yt.dispose();
      core.dispose();
      const img = new ImageData(tw, th);
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
  return out;
}
