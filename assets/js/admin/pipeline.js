// Turns a photo file into the files the site publishes:
// border removed → resolution enhanced (optional) → full-size JPEG + light thumbnail + placeholder.
import { decode, detectFrame, crop, cropRect, resize, fitWithin, encode, placeholder, supportsWebp, makeCanvas } from './imaging.js';
import { upscale4x, enhancementAvailable } from './upscaler.js';

const EXIFR_SRC = new URL('../../vendor/exifr-lite.umd.js', import.meta.url);
let exifrLoading;
function loadExifr() {
  if (window.exifr) return Promise.resolve(window.exifr);
  exifrLoading ||= new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = EXIFR_SRC;
    s.onload = () => resolve(window.exifr);
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
  return exifrLoading;
}

const BRANDS = {
  NIKON: 'Nikon',
  CANON: 'Canon',
  SONY: 'Sony',
  FUJIFILM: 'Fujifilm',
  OLYMPUS: 'Olympus',
  'OM DIGITAL SOLUTIONS': 'OM System',
  PANASONIC: 'Panasonic',
  APPLE: 'Apple',
  SAMSUNG: 'Samsung',
  GOOGLE: 'Google',
  XIAOMI: 'Xiaomi',
  ONEPLUS: 'OnePlus',
  LEICA: 'Leica',
  RICOH: 'Ricoh',
  PENTAX: 'Pentax',
  HASSELBLAD: 'Hasselblad',
};

/** "NIKON CORPORATION" + "NIKON D750" → "Nikon D750"; "Apple" + "iPhone 12" → "iPhone 12". */
export function cameraName(make = '', model = '') {
  let mk = String(make)
    .replace(/\s+(corporation|corp\.?|co\.?,?\s*ltd\.?|imaging|company|optical co\.?,?\s*ltd\.?)$/i, '')
    .trim();
  mk = BRANDS[mk.toUpperCase()] || mk;
  let mo = String(model).trim();
  if (mk && mo.toLowerCase().startsWith(mk.toLowerCase())) mo = mo.slice(mk.length).trim();
  if (mk === 'Apple') return mo;
  return [mk, mo].filter(Boolean).join(' ');
}

function shutterText(t) {
  if (!t) return '';
  if (t >= 1) return String(Math.round(t * 10) / 10);
  return `1/${Math.round(1 / t)}`;
}

/** Camera details worth printing on a wall label. GPS is never read. */
export async function readExif(file) {
  try {
    const exifr = await loadExifr();
    if (!exifr) return {};
    const e = await exifr.parse(file, {
      pick: ['Make', 'Model', 'LensModel', 'FocalLength', 'FNumber', 'ExposureTime', 'ISO', 'DateTimeOriginal', 'CreateDate'],
      gps: false,
    });
    if (!e) return {};
    const out = {};
    const cam = cameraName(e.Make, e.Model);
    if (cam) out.camera = cam;
    if (e.LensModel && !/^(\d|-)/.test(e.LensModel)) out.lens = String(e.LensModel).trim();
    if (e.FocalLength) out.focal = Math.round(e.FocalLength);
    if (e.FNumber) out.aperture = String(Math.round(e.FNumber * 10) / 10);
    if (e.ExposureTime) out.shutter = shutterText(e.ExposureTime);
    if (e.ISO) out.iso = Number(e.ISO);
    const taken = e.DateTimeOriginal || e.CreateDate;
    return { exif: out, taken: taken instanceof Date && !Number.isNaN(taken.getTime()) ? taken : null };
  } catch {
    return {};
  }
}

/**
 * Inspect a file before processing: decode, read camera data, detect a frame.
 * Insets are stored as fractions so they survive resizing.
 */
export async function inspect(file) {
  const bitmap = await decode(file);
  const meta = await readExif(file);
  const frame = detectFrame(bitmap);
  const W = bitmap.width;
  const H = bitmap.height;
  return {
    bitmap,
    width: W,
    height: H,
    exif: meta.exif || {},
    taken: meta.taken || null,
    frame,
    insets:
      frame.kind === 'none'
        ? { top: 0, right: 0, bottom: 0, left: 0 }
        : { top: frame.top / H, right: frame.right / W, bottom: frame.bottom / H, left: frame.left / W },
  };
}

export function describeFrame(frame) {
  if (!frame || frame.kind === 'none') return { text: 'No border found', tone: 'quiet' };
  const tone = frame.confidence === 'low' ? 'check' : 'ok';
  if (frame.kind === 'blurred') return { text: 'Blurred border found', tone };
  const c = frame.color || [255, 255, 255];
  const lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  const name = lum > 225 ? 'White' : lum < 40 ? 'Black' : lum > 160 ? 'Light' : 'Coloured';
  return { text: frame.confidence === 'low' ? `${name} edge, maybe a border` : `${name} border found`, tone };
}

/** Decide whether the AI enhancement should run, and to what size. */
export function enhancePlan(w, h, settings) {
  const target = settings.longEdge || 2560;
  const long = Math.max(w, h);
  if (long >= target * 0.6) return null;
  const out = Math.min(target, long * 4);
  return { from: long, to: Math.round(out) };
}

const MAX_UPSCALE_PIXELS = (navigator.deviceMemory && navigator.deviceMemory <= 4) || /Mobi/i.test(navigator.userAgent) ? 12e6 : 30e6;

/**
 * Produce the publishable files.
 * @param {{bitmap: ImageBitmap, width:number, height:number}} src
 * @param {{insets:{top:number,right:number,bottom:number,left:number}, enhance:boolean, settings:object}} opts
 */
export async function render(src, { insets, enhance, settings, onProgress = () => {}, signal } = {}) {
  const W = src.width;
  const H = src.height;
  const rect = cropRect(W, H, {
    top: Math.round((insets?.top || 0) * H),
    right: Math.round((insets?.right || 0) * W),
    bottom: Math.round((insets?.bottom || 0) * H),
    left: Math.round((insets?.left || 0) * W),
  });
  let canvas = crop(src.bitmap, rect);
  let enhanced = false;
  const plan = enhance ? enhancePlan(canvas.width, canvas.height, settings) : null;
  if (plan && (await enhancementAvailable())) {
    // Keep the 4× intermediate inside a memory budget.
    const pixels = canvas.width * canvas.height * 16;
    if (pixels > MAX_UPSCALE_PIXELS) {
      const s = Math.sqrt(MAX_UPSCALE_PIXELS / pixels);
      canvas = resize(canvas, canvas.width * s, canvas.height * s);
    }
    onProgress({ stage: 'enhance', fraction: 0 });
    const big = await upscale4x(canvas, { signal, onProgress: (f) => onProgress({ stage: 'enhance', fraction: f }) });
    const [tw, th] = fitWithin(big.width, big.height, plan.to);
    canvas = resize(big, tw, th);
    if (canvas !== big) big.width = big.height = 0; // free the large intermediate
    enhanced = true;
  } else {
    const [tw, th] = fitWithin(canvas.width, canvas.height, settings.longEdge || 2560);
    if (tw !== canvas.width) canvas = resize(canvas, tw, th);
  }
  onProgress({ stage: 'encode', fraction: 1 });
  const full = await encode(flatten(canvas), 'image/jpeg', settings.quality || 0.9);
  const [tw, th] = fitWithin(canvas.width, canvas.height, 1200);
  const small = resize(canvas, tw, th);
  const webp = supportsWebp();
  const thumb = await encode(flatten(small), webp ? 'image/webp' : 'image/jpeg', 0.8);
  const ph = placeholder(small);
  const out = { full, thumb, thumbExt: webp ? 'webp' : 'jpg', w: canvas.width, h: canvas.height, tw: small.width, th: small.height, ...ph, enhanced };
  canvas.width = canvas.height = 0;
  return out;
}

// JPEG has no transparency: put transparent pixels on white instead of black.
function flatten(canvas) {
  const c = makeCanvas(canvas.width, canvas.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, 0, 0);
  return c;
}

export function newId(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const stamp = d.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 6);
  return `${stamp}-${rand}`;
}
