// Shared runtime for the public pages: data, theme, the aperture iris (preloader and
// page transitions), cursor, smooth scrolling, header and footer.

const gsap = window.gsap;
if (window.ScrollTrigger) gsap.registerPlugin(window.ScrollTrigger);

export const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;

const ROOT = new URL(document.documentElement.dataset.root || './', location.href);
export const siteUrl = (path) => new URL(path, ROOT).href;

// ---------------------------------------------------------------- DOM helpers

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (val === undefined || val === null || val === '') continue;
        if (prop.startsWith('--')) node.style.setProperty(prop, String(val));
        else node.style[prop] = val;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const pad2 = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- data

async function getJSON(path) {
  const res = await fetch(siteUrl(path), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
  return res.json();
}

export async function loadData() {
  const [site, library] = await Promise.all([getJSON('data/site.json'), getJSON('data/photos.json')]);
  const photos = (library.photos || []).filter((p) => !p.hidden);
  photos.forEach((p, i) => {
    p.n = i + 1;
    p.ar = p.w && p.h ? p.w / p.h : 1.5;
  });
  applyTheme(site.theme);
  if (site.protectImages !== false) {
    document.documentElement.classList.add('protect');
    document.addEventListener('contextmenu', (e) => {
      if (e.target instanceof HTMLImageElement) e.preventDefault();
    });
  }
  return { site, photos };
}

export function applyTheme(theme = 'paper') {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('pf-theme', theme);
  } catch {
    /* storage unavailable */
  }
}

// ---------------------------------------------------------------- photo text

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function photoDate(p, withMonth = false) {
  if (!p.date) return '';
  const d = new Date(p.date);
  if (Number.isNaN(d.getTime())) return '';
  return withMonth ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : String(d.getUTCFullYear());
}

export function metaLine(p, withMonth = false) {
  return [p.location, photoDate(p, withMonth)].filter(Boolean).join(', ');
}

export function techLine(p) {
  const e = p.exif || {};
  const parts = [];
  if (e.camera) parts.push(e.camera);
  if (e.lens && !(e.camera || '').includes(e.lens)) parts.push(e.lens);
  if (e.focal) parts.push(`${e.focal} mm`);
  if (e.aperture) parts.push(`ƒ/${e.aperture}`);
  if (e.shutter) parts.push(`${e.shutter} s`);
  if (e.iso) parts.push(`ISO ${e.iso}`);
  return parts.join(', ');
}

export function altText(p) {
  if (p.alt) return p.alt;
  if (p.title) return p.title;
  if (p.caption) return p.caption.slice(0, 140);
  return `Photograph ${p.n}`;
}

export function imgSources(p, sizes) {
  const thumb = siteUrl(p.thumb);
  const full = siteUrl(p.src);
  return {
    src: thumb,
    srcset: `${thumb} ${p.tw || 1200}w, ${full} ${p.w}w`,
    sizes,
  };
}

/** Wall label: number, title, place and year, camera details. */
export function wallLabel(p, site, { caption = false, cls = '' } = {}) {
  const tech = site.showCameraInfo !== false ? techLine(p) : '';
  return h(
    'figcaption',
    { class: `label ${cls}`.trim() },
    h('span', { class: 'label-num', 'aria-label': `Frame ${p.n}` }, pad2(p.n)),
    p.title ? h('cite', { class: 'label-title' }, p.title) : null,
    metaLine(p) ? h('span', { class: 'label-meta' }, metaLine(p)) : null,
    tech ? h('span', { class: 'label-tech' }, tech) : null,
    caption && p.caption ? h('p', { class: 'label-caption' }, p.caption) : null,
  );
}

// ---------------------------------------------------------------- develop effect

/** Prints start as blank photographic paper and develop into the image. */
export function prepareDevelop(img) {
  if (reduceMotion) return;
  gsap.set(img, { filter: 'brightness(2.6) contrast(0.18) saturate(0)' });
  img.dataset.develop = 'pending';
}

export async function develop(img, { delay = 0, duration = 2.1 } = {}) {
  if (reduceMotion || img.dataset.develop !== 'pending') return;
  img.dataset.develop = 'running';
  try {
    await img.decode();
  } catch {
    /* draw whatever arrived */
  }
  img.classList.add('is-developing');
  return gsap.to(img, {
    filter: 'brightness(1) contrast(1) saturate(1)',
    duration,
    delay,
    ease: 'power2.inOut',
    onComplete() {
      img.style.filter = '';
      img.classList.remove('is-developing');
      img.dataset.develop = 'done';
    },
  });
}

// ---------------------------------------------------------------- aperture iris

const BLADES = 7;
const STOPS = ['22', '16', '11', '8', '5.6', '4', '2.8', '2', '1.4'];
const SVGNS = 'http://www.w3.org/2000/svg';

export class Iris {
  constructor({ readout = false, name = '' } = {}) {
    this.r = 0;
    this.phi0 = Math.random() * Math.PI;
    this.el = h('div', { class: 'iris is-blocking', 'aria-hidden': 'true' });
    this.svg = document.createElementNS(SVGNS, 'svg');
    this.blades = [];
    for (let i = 0; i < BLADES; i++) {
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('class', 'blade');
      this.svg.append(p);
      this.blades.push(p);
    }
    this.el.append(this.svg);
    if (readout) {
      this.stop = h('span', { class: 'iris-fstop' }, 'ƒ/22');
      this.readout = h('div', { class: 'iris-readout' }, this.stop, name ? h('span', { class: 'iris-name ui' }, name) : null);
      this.el.append(this.readout);
    }
    document.body.append(this.el);
    this.onResize = () => this.draw();
    addEventListener('resize', this.onResize);
    this.draw();
  }

  get fullR() {
    return Math.hypot(innerWidth, innerHeight) / 2 / Math.cos(Math.PI / BLADES) + 8;
  }

  get stopR() {
    return Math.min(innerWidth, innerHeight) * 0.15;
  }

  draw() {
    const w = innerWidth;
    const hgt = innerHeight;
    const cx = w / 2;
    const cy = hgt / 2;
    const far = Math.hypot(w, hgt) * 3;
    const r = Math.max(0.01, this.r);
    const phi = this.phi0 + 1.1 * Math.min(1, r / this.fullR);
    const v = [];
    for (let j = 0; j < BLADES; j++) {
      const a = phi + (j * 2 * Math.PI) / BLADES;
      v.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    for (let i = 0; i < BLADES; i++) {
      const a = v[i];
      const b = v[(i + 1) % BLADES];
      const c = v[(i + 2) % BLADES];
      const d1 = norm(b[0] - a[0], b[1] - a[1]);
      const d2 = norm(c[0] - b[0], c[1] - b[1]);
      const e1 = [b[0] + d1[0] * far, b[1] + d1[1] * far];
      const e2 = [b[0] + d2[0] * far, b[1] + d2[1] * far];
      this.blades[i].setAttribute('d', `M${b[0].toFixed(2)} ${b[1].toFixed(2)}L${e1[0].toFixed(1)} ${e1[1].toFixed(1)}L${e2[0].toFixed(1)} ${e2[1].toFixed(1)}Z`);
    }
    if (this.readout) this.readout.style.setProperty('--iris-r', `${Math.min(r, this.stopR)}px`);
  }

  /** Show loading progress (0..1) as an aperture setting. */
  progress(p) {
    if (!this.stop) return;
    const i = Math.max(0, Math.min(STOPS.length - 1, Math.round(p * (STOPS.length - 1))));
    if (i === this.stopIndex) return;
    this.stopIndex = i;
    this.stop.textContent = `ƒ/${STOPS[i]}`;
    const target = (this.stopR * 1.4) / parseFloat(STOPS[i]);
    gsap.to(this, { r: target, duration: 0.45, ease: 'power2.out', overwrite: true, onUpdate: () => this.draw() });
  }

  /** Walk through every stop so the sequence reads even when loading is instant. */
  async walk(getProgress, minMs = 1500) {
    const start = performance.now();
    let shown = 0;
    while (shown < 1) {
      const elapsed = performance.now() - start;
      const floor = Math.min(1, elapsed / minMs);
      shown = Math.min(getProgress(), floor);
      this.progress(shown);
      if (shown >= 1) break;
      await new Promise((r) => setTimeout(r, 60));
    }
    await new Promise((r) => setTimeout(r, 380));
  }

  open({ duration = 1.5 } = {}) {
    if (reduceMotion) {
      return gsap.to(this.el, { opacity: 0, duration: 0.4, onComplete: () => this.destroy() });
    }
    if (this.readout) gsap.to(this.readout, { opacity: 0, duration: 0.3 });
    this.el.classList.remove('is-blocking');
    return gsap.to(this, {
      r: this.fullR * 1.04,
      duration,
      ease: 'expo.inOut',
      overwrite: true,
      onUpdate: () => this.draw(),
      onComplete: () => this.destroy(),
    });
  }

  close({ duration = 0.65 } = {}) {
    this.el.classList.add('is-blocking');
    if (reduceMotion) {
      this.r = 0;
      this.draw();
      return gsap.fromTo(this.el, { opacity: 0 }, { opacity: 1, duration: 0.25 });
    }
    if (this.r <= 0.01) this.r = this.fullR * 1.04;
    return gsap.to(this, { r: 0, duration, ease: 'power3.in', overwrite: true, onUpdate: () => this.draw() });
  }

  destroy() {
    removeEventListener('resize', this.onResize);
    this.el.remove();
  }
}

function norm(x, y) {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
}

// ---------------------------------------------------------------- page transitions

const SEEN = 'pf-seen';
const CLOSED = 'pf-iris-closed';

/** First visit in a session gets the full f-stop preloader; later pages a quick reveal. */
export function startIris(name) {
  let first = true;
  try {
    first = !sessionStorage.getItem(SEEN);
    sessionStorage.setItem(SEEN, '1');
    sessionStorage.removeItem(CLOSED);
  } catch {
    /* private mode */
  }
  return { iris: new Iris({ readout: first, name }), first };
}

export function initTransitions() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.target && a.target !== '_self') return;
    if (a.hasAttribute('download')) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return;
    const samePage = url.pathname === location.pathname && url.search === location.search;
    if (samePage) return; // in-page anchors and hash routes
    if (/\/admin\/?/.test(url.pathname) && !/\/admin\/?/.test(location.pathname)) return;
    e.preventDefault();
    try {
      sessionStorage.setItem(CLOSED, '1');
    } catch {
      /* ignore */
    }
    scroll.stop();
    const iris = new Iris();
    iris.r = iris.fullR * 1.04;
    iris.draw();
    Promise.resolve(iris.close()).then(() => {
      location.href = url.href;
    });
  });
  addEventListener('pageshow', (e) => {
    if (e.persisted) document.querySelectorAll('.iris').forEach((n) => n.remove());
  });
}

// ---------------------------------------------------------------- smooth scroll

export const scroll = {
  lenis: null,
  locks: 0,
  init() {
    if (reduceMotion || !finePointer || !window.Lenis) return;
    this.lenis = new window.Lenis({ lerp: 0.11, wheelMultiplier: 0.95, anchors: true });
    if (window.ScrollTrigger) this.lenis.on('scroll', window.ScrollTrigger.update);
    gsap.ticker.add((t) => this.lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
  },
  // Overlays (lightbox, light table) can stack, so locking is counted.
  stop() {
    this.locks++;
    this.lenis?.stop();
    document.documentElement.style.overflow = 'hidden';
  },
  start() {
    this.locks = Math.max(0, this.locks - 1);
    if (this.locks) return;
    this.lenis?.start();
    document.documentElement.style.overflow = '';
  },
  to(target, opts = {}) {
    if (this.lenis) return this.lenis.scrollTo(target, { duration: 1.4, ...opts });
    const behavior = reduceMotion ? 'auto' : 'smooth';
    if (typeof target === 'number') window.scrollTo({ top: target, behavior });
    else (typeof target === 'string' ? document.querySelector(target) : target)?.scrollIntoView({ behavior });
  },
};

// ---------------------------------------------------------------- cursor

export function initCursor() {
  if (!finePointer || reduceMotion) return;
  const label = h('span', { class: 'cursor-label ui' });
  const node = h('div', { class: 'cursor is-hidden', 'aria-hidden': 'true' }, h('span', { class: 'cursor-ring' }), label);
  document.body.append(node);
  document.documentElement.classList.add('has-cursor');
  const xTo = gsap.quickTo(node, 'x', { duration: 0.35, ease: 'power3' });
  const yTo = gsap.quickTo(node, 'y', { duration: 0.35, ease: 'power3' });
  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    node.classList.remove('is-hidden');
    xTo(e.clientX);
    yTo(e.clientY);
  });
  document.addEventListener('pointerleave', () => node.classList.add('is-hidden'));
  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest('[data-cursor]');
    const text = t?.dataset.cursor || '';
    label.textContent = text;
    node.classList.toggle('has-label', !!text);
  });
}

// ---------------------------------------------------------------- header + footer

export function initHeader({ tuckUntil } = {}) {
  const brand = document.querySelector('.brand');
  if (!brand || !tuckUntil) return;
  const update = () => brand.classList.toggle('is-tucked', scrollY < tuckUntil());
  update();
  addEventListener('scroll', update, { passive: true });
}

export function renderFooter(site) {
  const foot = document.querySelector('.site-footer');
  if (!foot) return;
  const about = site.about || {};
  const email = about.email?.trim();
  const ig = about.instagram?.trim().replace(/^@/, '');
  foot.replaceChildren();
  if (email || ig) {
    foot.append(
      h(
        'div',
        { class: 'footer-invite' },
        h('p', { class: 'ui' }, site.footerNote || 'For prints, commissions or a conversation'),
        email
          ? h('a', { class: 'footer-link', href: `mailto:${email}` }, email)
          : h('a', { class: 'footer-link', href: `https://instagram.com/${ig}`, rel: 'noopener', target: '_blank' }, `@${ig}`),
      ),
    );
  }
  const clock = h('span');
  const tz = about.timezone || 'Asia/Kolkata';
  const city = about.location || '';
  const tick = () => {
    try {
      const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date());
      clock.textContent = city ? `It is ${time} in ${city}` : '';
    } catch {
      clock.textContent = city;
    }
  };
  tick();
  setInterval(tick, 20000);
  const links = h('span', { class: 'footer-links' });
  if (ig && email) links.append(h('a', { href: `https://instagram.com/${ig}`, rel: 'noopener', target: '_blank' }, 'Instagram'));
  for (const l of about.links || []) if (l.url && l.label) links.append(h('a', { href: l.url, rel: 'noopener', target: '_blank' }, l.label));
  const year = new Date().getFullYear();
  foot.append(
    h('div', { class: 'footer-meta ui' }, clock, links, h('span', {}, `© ${year} ${site.name || ''}`.trim())),
  );
}

export function initPage() {
  scroll.init();
  initCursor();
  initTransitions();
}
