// Recognising which published photograph a file is a version of: by its name when it carries
// the photo's id or Instagram media id (desktop upscalers keep the original name as a prefix),
// otherwise by a perceptual fingerprint that survives resizing, compression and AI enhancement.
// Pure functions on RGBA pixel data, so they can be tested outside the browser.

const N = 32;
let cosTable;

function dctTable() {
  if (!cosTable) {
    cosTable = new Float64Array(N * N);
    for (let u = 0; u < N; u++) for (let x = 0; x < N; x++) cosTable[u * N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
  }
  return cosTable;
}

/** Area-average an RGBA image down to an N×N grid of luminance values. */
function gridLuma(img) {
  const { data, width: W, height: H } = img;
  const g = new Float64Array(N * N);
  const cnt = new Float64Array(N * N);
  for (let y = 0; y < H; y++) {
    const gy = Math.min(N - 1, Math.floor((y * N) / H));
    for (let x = 0; x < W; x++) {
      const gx = Math.min(N - 1, Math.floor((x * N) / W));
      const k = (y * W + x) * 4;
      g[gy * N + gx] += 0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2];
      cnt[gy * N + gx]++;
    }
  }
  for (let i = 0; i < g.length; i++) g[i] /= cnt[i] || 1;
  return g;
}

/**
 * Fingerprint of an image: 63-bit perceptual hash (low-frequency DCT signs around the median)
 * plus its aspect ratio.
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img RGBA (any size, ideally ≥ 64 px)
 */
export function signature(img) {
  const g = gridLuma(img);
  const c = dctTable();
  const coeffs = [];
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      if (u === 0 && v === 0) continue;
      let s = 0;
      for (let y = 0; y < N; y++) {
        const cy = c[u * N + y];
        for (let x = 0; x < N; x++) s += g[y * N + x] * cy * c[v * N + x];
      }
      coeffs.push(s);
    }
  }
  const sorted = [...coeffs].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const bits = new Uint8Array(coeffs.length);
  for (let i = 0; i < coeffs.length; i++) bits[i] = coeffs[i] > median ? 1 : 0;
  return { bits, ar: img.width / img.height };
}

export function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] !== b[i] ? 1 : 0;
  return d;
}

/**
 * Best match for a fingerprint among candidates [{id, sig}].
 * Accepts only a close, unambiguous match with a similar shape.
 * @returns {{id: string, distance: number} | null}
 */
export function bestMatch(sig, candidates, { maxDistance = 12, margin = 4, maxAspect = 0.06 } = {}) {
  let best = null;
  let second = Infinity;
  for (const c of candidates) {
    if (Math.abs(Math.log(sig.ar / c.sig.ar)) > maxAspect) continue;
    const d = hamming(sig.bits, c.sig.bits);
    if (!best || d < best.distance) {
      if (best) second = Math.min(second, best.distance);
      best = { id: c.id, distance: d };
    } else if (d < second) {
      second = d;
    }
  }
  if (!best || best.distance > maxDistance || second - best.distance < margin) return null;
  return best;
}

/**
 * Match a file name to a photo: by photo id (e.g. "20190715-ab12cd_upscayl_4x.png") or by
 * Instagram media id kept from the export ("17900000000000001_upscayl_4x_realesrgan-x4plus.png").
 * @param {string} name
 * @param {{id: string, source?: {type?: string, key?: string}}[]} photos
 */
export function matchByName(name, photos) {
  const stem = String(name).replace(/\.[^.]+$/, '').toLowerCase();
  for (const p of photos) if (stem === p.id.toLowerCase() || stem.startsWith(`${p.id.toLowerCase()}_`) || stem.startsWith(`${p.id.toLowerCase()}-`)) return p;
  for (const p of photos) {
    const key = p.source?.key && String(p.source.key).toLowerCase();
    if (key && (stem === key || stem.startsWith(`${key}_`) || stem.startsWith(`${key}-`) || stem.startsWith(`${key} `))) return p;
  }
  return null;
}
