// Home page: hero print, the three ways of looking at the work, and the viewer.
import {
  h,
  siteUrl,
  loadData,
  initPage,
  startIris,
  initHeader,
  renderFooter,
  wallLabel,
  altText,
  imgSources,
  prepareDevelop,
  develop,
  reduceMotion,
  finePointer,
  scroll,
} from './core.js';
import { Lightbox } from './lightbox.js';

const gsap = window.gsap;
const $ = (s, r = document) => r.querySelector(s);

const state = {
  site: {},
  all: [],
  list: [],
  view: 'prints',
  filter: null,
  lb: null,
  table: null,
};

// ------------------------------------------------------------------ boot

boot().catch((err) => {
  console.error(err);
  showLoadError();
});

async function boot() {
  initPage();
  const nameEl = $('.hero-name');
  const { iris, first } = startIris(nameEl?.textContent.trim());
  let progress = 0.08;
  const walking = first ? iris.walk(() => progress) : null;

  let data;
  try {
    data = await loadData();
  } catch (err) {
    progress = 1;
    await walking;
    iris.open();
    throw err;
  }
  progress = 0.35;
  state.site = data.site;
  state.all = data.photos;
  state.list = data.photos;

  setName(nameEl, state.site.name || nameEl.textContent.trim());
  document.title = `${state.site.name || 'Photographs'} · Photographs`;
  const hero = setupHero();
  renderIntro();
  renderControls();
  state.lb = new Lightbox({ photos: state.list, site: state.site, sourceFor });
  state.table = new LightTable();
  renderView({ animate: false });
  renderFooter(state.site);
  initHeader({ tuckUntil: () => (nameEl.getBoundingClientRect().top + scrollY) * 0.85 });

  const fonts = document.fonts?.ready.then(() => {
    progress = Math.max(progress, 0.6);
    fitName();
    hero.layout();
  });
  await Promise.race([Promise.all([fonts, hero.ready]), wait(7000)]);
  progress = 1;
  if (walking) await walking;

  revealName(first ? 0.75 : 0.25);
  hero.reveal(first ? 0.9 : 0.35);
  iris.open({ duration: first ? 1.6 : 1.0 });
  state.lb.syncFromHash(false);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function showLoadError() {
  const stage = $('.hero-stage');
  if (!stage) return;
  stage.replaceChildren(
    h('div', { class: 'hero-empty ui' }, h('p', {}, 'The photographs could not be loaded.'), 'Check your connection and refresh the page.'),
  );
}

// ------------------------------------------------------------------ name

function setName(el, name) {
  el.setAttribute('aria-label', name);
  el.replaceChildren(
    ...name
      .trim()
      .split(/\s+/)
      .map((w) => h('span', { class: 'word', 'aria-hidden': 'true' }, ...[...w].map((c) => h('span', { class: 'glyph' }, c)))),
  );
  fitName();
}

// Size the name so it runs exactly across the measure, like a title on an exhibition wall.
function fitName() {
  const el = $('.hero-name');
  if (!el) return;
  const avail = el.getBoundingClientRect().width;
  el.classList.remove('is-stacked');
  el.style.fontSize = '100px';
  el.style.width = 'max-content';
  const whole = el.getBoundingClientRect().width;
  const widest = Math.max(...[...el.querySelectorAll('.word')].map((w) => w.getBoundingClientRect().width));
  el.style.width = '';
  let size = (avail / whole) * 100 * 0.995;
  if (size < 72 && el.querySelectorAll('.word').length > 1) {
    el.classList.add('is-stacked');
    size = (avail / widest) * 100 * 0.98;
  }
  el.style.fontSize = `${Math.min(size, 420)}px`;
}

function revealName(delay) {
  const glyphs = document.querySelectorAll('.hero-name .glyph');
  if (reduceMotion) return;
  gsap.fromTo(glyphs, { yPercent: 105 }, { yPercent: 0, duration: 1.5, ease: 'expo.out', stagger: 0.035, delay });
}

// ------------------------------------------------------------------ hero

function setupHero() {
  const stage = $('.hero-stage');
  const print = $('.hero-print');
  const label = $('.hero-label');
  const featured = state.all.filter((p) => p.featured);
  const reel = featured.length ? featured : state.all.slice(0, 6);
  let i = 0;
  let current = null;
  let timer = null;
  let visible = true;

  if (!reel.length) {
    print.remove();
    label.remove();
    stage.append(
      h(
        'div',
        { class: 'hero-empty ui' },
        h('p', {}, 'This wall is ready for prints.'),
        h('a', { href: siteUrl('admin/') }, 'Open the admin panel to add photographs'),
      ),
    );
    return { ready: Promise.resolve(), layout() {}, reveal() {} };
  }

  const box = () => {
    const p = reel[i];
    const wide = innerWidth >= 900;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight - (wide ? 0 : label.offsetHeight + 14);
    const maxW = wide ? sw * 0.66 : sw;
    let w = maxW;
    let hgt = w / p.ar;
    if (hgt > sh) {
      hgt = sh;
      w = hgt * p.ar;
    }
    return { w: Math.max(40, Math.round(w)), h: Math.max(40, Math.round(hgt)) };
  };

  const makeImg = (p, w) => {
    const img = h('img', {
      ...imgSources(p, `${Math.round((w / innerWidth) * 100)}vw`),
      alt: altText(p),
      decoding: 'async',
      fetchpriority: 'high',
    });
    return img;
  };

  const setLabel = (p) => {
    label.replaceChildren(wallLabel(p, state.site));
  };

  const layout = () => {
    const b = box();
    gsap.set(print, { width: b.w, height: b.h });
  };

  const first = reel[0];
  setLabel(first);
  layout();
  current = makeImg(first, box().w);
  prepareDevelop(current);
  print.append(current);
  print.setAttribute('data-cursor', 'View');
  print.style.cursor = 'pointer';
  print.tabIndex = 0;
  print.setAttribute('role', 'button');
  print.setAttribute('aria-label', `Open ${altText(first)}`);
  const open = () => openFrom(reel[i], current);
  print.addEventListener('click', open);
  print.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });

  const ready = current.decode().catch(() => {});

  const advance = async () => {
    if (reel.length < 2 || !visible || document.hidden || state.lb?.isOpen) return;
    i = (i + 1) % reel.length;
    const p = reel[i];
    const b = box();
    const next = makeImg(p, b.w);
    next.style.opacity = '0';
    await next.decode().catch(() => {});
    print.setAttribute('aria-label', `Open ${altText(p)}`);
    const old = current;
    current = next;
    print.append(next);
    if (reduceMotion) {
      next.style.opacity = '1';
      old.remove();
      setLabel(p);
      layout();
      return;
    }
    // The old print bleaches back to paper, the frame reshapes, the new one develops.
    const tl = gsap.timeline();
    tl.to(old, { filter: 'brightness(2.6) contrast(0.18) saturate(0)', duration: 0.9, ease: 'power2.in' })
      .to(label, { opacity: 0, duration: 0.4 }, 0.3)
      .to(print, { width: b.w, height: b.h, duration: 1.1, ease: 'expo.inOut' }, 0.7)
      .add(() => {
        old.remove();
        next.style.opacity = '1';
        prepareDevelop(next);
        develop(next, { duration: 1.9 });
        setLabel(p);
      }, 1.0)
      .to(label, { opacity: 1, duration: 0.6 }, 1.5);
  };

  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
  });
  io.observe(print);
  const interval = Math.max(4, Number(state.site.hero?.interval) || 7) * 1000;
  const startTimer = () => {
    clearInterval(timer);
    if (state.site.hero?.autoplay !== false && reel.length > 1) timer = setInterval(advance, interval);
  };

  let resizeRaf;
  addEventListener('resize', () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      fitName();
      layout();
    });
  });

  return {
    ready,
    layout,
    reveal(delay) {
      develop(current, { delay, duration: 2.2 });
      if (!reduceMotion) gsap.from(label, { opacity: 0, y: 12, duration: 1, delay: delay + 0.9, ease: 'expo.out' });
      startTimer();
    },
  };
}

// ------------------------------------------------------------------ intro + controls

function yearRange(list) {
  const years = list.map((p) => (p.date ? new Date(p.date).getUTCFullYear() : null)).filter((y) => y && !Number.isNaN(y));
  if (!years.length) return '';
  const a = Math.min(...years);
  const b = Math.max(...years);
  return a === b ? String(a) : `${a}–${b}`;
}

function renderIntro() {
  const s = state.site;
  const range = yearRange(state.all);
  const statement = s.statement?.trim() || `Photographs by ${s.name || 'the photographer'}${range ? `, ${range}` : ''}.`;
  $('.statement').textContent = statement;
  $('.count').textContent = state.all.length === 1 ? '1 photograph' : `${state.all.length} photographs`;
  if (!state.all.length) {
    $('.controls').hidden = true;
    $('.count').hidden = true;
  }
}

function renderControls() {
  const views = $('.views');
  const tabs = [
    ['prints', 'Prints'],
    ['sheet', 'Contact sheet'],
    ['table', 'Light table'],
  ];
  let saved = null;
  try {
    saved = localStorage.getItem('pf-view');
  } catch {
    /* ignore */
  }
  state.view = ['prints', 'sheet'].includes(saved) ? saved : state.site.defaultView === 'sheet' ? 'sheet' : 'prints';
  views.replaceChildren(
    ...tabs.map(([id, label]) =>
      h(
        'button',
        {
          class: 'view-tab',
          type: 'button',
          role: 'tab',
          'aria-selected': String(id === state.view),
          'data-view': id,
          onclick: () => selectView(id),
        },
        label,
      ),
    ),
  );

  // Filters: tags if there are any, otherwise years when there are a few of them.
  const filters = $('.filters');
  const tagCounts = new Map();
  for (const p of state.all) for (const t of p.tags || []) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  let options = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 9).map(([t]) => ({ key: `tag:${t}`, label: t }));
  if (!options.length) {
    const years = [...new Set(state.all.map((p) => (p.date ? new Date(p.date).getUTCFullYear() : null)).filter(Boolean))].sort((a, b) => b - a);
    if (years.length >= 3) options = years.map((y) => ({ key: `year:${y}`, label: String(y) }));
  }
  if (!options.length) {
    filters.remove();
    return;
  }
  const make = (key, label) =>
    h(
      'button',
      { class: 'filter', type: 'button', 'aria-pressed': String(state.filter === key), 'data-key': key ?? '', onclick: () => setFilter(key) },
      label,
    );
  filters.replaceChildren(make(null, 'All'), ...options.map((o) => make(o.key, o.label)));

  // Paint the strip of paper behind the fixed header once the controls stick.
  const controls = $('.controls');
  const sentinel = h('div', { 'aria-hidden': 'true', style: { height: '1px' } });
  controls.before(sentinel);
  const headerH = () => document.querySelector('.site-header')?.offsetHeight || 64;
  new IntersectionObserver(
    ([e]) => {
      const edge = e.rootBounds ? e.rootBounds.top : headerH();
      controls.classList.toggle('is-stuck', !e.isIntersecting && e.boundingClientRect.top <= edge);
    },
    { rootMargin: `-${headerH()}px 0px 0px 0px` },
  ).observe(sentinel);
}

function setFilter(key) {
  state.filter = key;
  document.querySelectorAll('.filter').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.key || null) === key)));
  state.list = state.all.filter((p) => {
    if (!key) return true;
    const [kind, value] = key.split(/:(.*)/s);
    if (kind === 'tag') return (p.tags || []).includes(value);
    if (kind === 'year') return p.date && String(new Date(p.date).getUTCFullYear()) === value;
    return true;
  });
  $('.count').textContent = key ? `${state.list.length} of ${state.all.length} photographs` : `${state.all.length} photographs`;
  state.lb.setPhotos(state.list);
  renderView({ animate: true });
}

function selectView(id) {
  if (id === 'table') {
    state.table.open(state.list);
    return;
  }
  state.view = id;
  try {
    localStorage.setItem('pf-view', id);
  } catch {
    /* ignore */
  }
  document.querySelectorAll('.view-tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === id)));
  renderView({ animate: true });
}

async function renderView({ animate }) {
  const host = $('.view-host');
  if (animate && !reduceMotion) await gsap.to(host, { opacity: 0, duration: 0.3 });
  teardownPrints();
  host.replaceChildren();
  if (!state.all.length) {
    // Nothing published yet: the hero already says so.
  } else if (!state.list.length) {
    host.append(h('p', { class: 'ui', style: { padding: '80px var(--gutter)', color: 'var(--graphite)' } }, 'No photographs match this filter.'));
  } else if (state.view === 'sheet') host.append(renderSheet(state.list));
  else host.append(renderPrints(state.list));
  if (animate && !reduceMotion) {
    gsap.to(host, { opacity: 1, duration: 0.5 });
    const top = host.getBoundingClientRect().top + scrollY - 140;
    if (scrollY > top) scroll.to(top, { duration: 0.8 });
  }
  window.ScrollTrigger?.refresh();
}

// ------------------------------------------------------------------ viewer wiring

function sourceFor(id) {
  if (state.table?.isOpen) return state.table.imgFor(id);
  return document.querySelector(`[data-id="${CSS.escape(id)}"] img`);
}

function openFrom(p, fromImg) {
  let i = state.list.findIndex((q) => q.id === p.id);
  if (i < 0) {
    state.lb.setPhotos(state.all);
    i = state.all.findIndex((q) => q.id === p.id);
  } else {
    state.lb.setPhotos(state.list);
  }
  state.lb.open(i, { from: fromImg });
}

// ------------------------------------------------------------------ prints (exhibition hang)

const shapeOf = (p) => (p.ar >= 1.2 ? 'land' : p.ar <= 0.85 ? 'port' : 'square');

const SINGLE = {
  land: [
    { img: [1, 9], side: [10, 3], hug: 'start' },
    { img: [4, 9], side: [1, 3], hug: 'end' },
    { img: [2, 10], side: null },
    { img: [1, 8], side: [9, 3], hug: 'start' },
  ],
  square: [
    { img: [7, 5], side: [4, 3], hug: 'end' },
    { img: [2, 5], side: [7, 3], hug: 'start' },
    { img: [5, 5], side: [10, 3], hug: 'start' },
  ],
  port: [
    { img: [7, 4], side: [4, 3], hug: 'end' },
    { img: [3, 4], side: [7, 3], hug: 'start' },
    { img: [6, 4], side: [10, 3], hug: 'start' },
  ],
};
const PAIRS = [
  { a: [1, 5], b: [7, 5], drop: 'b' },
  { a: [2, 4], b: [7, 6], drop: 'a' },
];

let printsCleanup = [];
function teardownPrints() {
  printsCleanup.forEach((f) => f());
  printsCleanup = [];
}

function planHang(list) {
  const rows = [];
  let i = 0;
  let k = 0;
  const counters = { land: 0, square: 0, port: 0, pair: 0 };
  while (i < list.length) {
    const a = list[i];
    const b = list[i + 1];
    if (b && shapeOf(a) !== 'land' && shapeOf(b) !== 'land' && k % 3 !== 2) {
      rows.push({ kind: 'pair', items: [a, b], plan: PAIRS[counters.pair++ % PAIRS.length] });
      i += 2;
    } else {
      const s = shapeOf(a);
      rows.push({ kind: 'single', items: [a], plan: SINGLE[s][counters[s]++ % SINGLE[s].length] });
      i += 1;
    }
    k++;
  }
  return rows;
}

function printFigure(p, span, { sideLabel, inset }) {
  const vw = Math.round((span / 12) * 96);
  const img = h('img', { ...imgSources(p, `(min-width: 760px) ${vw}vw, 92vw`), alt: altText(p), loading: 'lazy', decoding: 'async' });
  prepareDevelop(img);
  const frame = h(
    'button',
    {
      class: 'print-frame',
      type: 'button',
      'data-cursor': 'View',
      'aria-label': `Open ${altText(p)}`,
      style: { '--ar': p.ar.toFixed(4), backgroundColor: '#f7f7f4' },
    },
    img,
  );
  frame.addEventListener('click', () => openFrom(p, img));
  const label = wallLabel(p, state.site, { cls: sideLabel ? 'is-side' : '' });
  return h('figure', { class: `print ${inset ? `is-inset-${inset}` : ''}`.trim(), 'data-id': p.id }, frame, label);
}

function renderPrints(list) {
  const wrap = h('div', { class: 'prints' });
  const rows = planHang(list);
  const BATCH = 12;
  let rendered = 0;
  let mobileFlip = 0;

  const frames = new Set();
  const visible = new Set();
  const developIO = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        developIO.unobserve(e.target);
        const img = e.target.querySelector('img');
        if (img) develop(img);
      }
    },
    { rootMargin: '0px 0px -14% 0px', threshold: 0.12 },
  );
  const parallaxIO = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target);
        else visible.delete(e.target);
      }
    },
    { rootMargin: '15% 0px' },
  );

  const addRow = (row) => {
    const hang = h('div', { class: 'hang' });
    if (row.kind === 'pair') {
      const [a, b] = row.items;
      const { plan } = row;
      const fa = printFigure(a, plan.a[1], { inset: 'left' });
      const fb = printFigure(b, plan.b[1], { inset: 'right' });
      fa.style.gridColumn = `${plan.a[0]} / span ${plan.a[1]}`;
      fb.style.gridColumn = `${plan.b[0]} / span ${plan.b[1]}`;
      fa.style.alignSelf = 'start';
      fb.style.alignSelf = 'start';
      (plan.drop === 'a' ? fa : fb).style.marginTop = 'clamp(0px, 16vh, 220px)';
      hang.append(fa, fb);
    } else {
      const [p] = row.items;
      const { plan } = row;
      const shape = shapeOf(p);
      const inset = shape === 'land' ? null : mobileFlip++ % 2 ? 'right' : 'left';
      const fig = printFigure(p, plan.img[1], { sideLabel: !!plan.side, inset });
      fig.style.gridColumn = `${plan.img[0]} / span ${plan.img[1]}`;
      fig.style.gridRow = '1';
      hang.append(fig);
      if (plan.side) {
        const side = wallLabel(p, state.site);
        side.classList.add('print-side-label');
        side.setAttribute('aria-hidden', 'true');
        side.style.gridColumn = `${plan.side[0]} / span ${plan.side[1]}`;
        side.style.gridRow = '1';
        side.style.justifySelf = plan.hug;
        hang.append(side);
      }
    }
    wrap.append(hang);
    hang.querySelectorAll('.print-frame').forEach((f) => {
      frames.add(f);
      developIO.observe(f);
      parallaxIO.observe(f);
    });
  };

  const more = () => {
    const end = Math.min(rows.length, rendered + BATCH);
    for (; rendered < end; rendered++) addRow(rows[rendered]);
    if (rendered >= rows.length) sentinelIO.disconnect();
    else wrap.append(sentinel);
  };
  const sentinel = h('div', { 'aria-hidden': 'true' });
  const sentinelIO = new IntersectionObserver(([e]) => e.isIntersecting && more(), { rootMargin: '0px 0px 120% 0px' });
  more();
  sentinelIO.observe(sentinel);

  // Gentle parallax inside each frame, computed only for frames on screen.
  const tick = () => {
    if (reduceMotion) return;
    const vh = innerHeight;
    for (const f of visible) {
      const r = f.getBoundingClientRect();
      const t = (r.top + r.height / 2 - vh / 2) / (vh / 2 + r.height / 2);
      const img = f.firstElementChild;
      if (img) img.style.transform = `translate3d(0, ${(-t * 5.5).toFixed(2)}%, 0)`;
    }
  };
  gsap.ticker.add(tick);
  printsCleanup.push(() => {
    gsap.ticker.remove(tick);
    developIO.disconnect();
    parallaxIO.disconnect();
    sentinelIO.disconnect();
  });
  return wrap;
}

// ------------------------------------------------------------------ contact sheet

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

// The grease-pencil overlay box is 118% x 132% of a 3:2 frame, i.e. 1.341:1. Drawing in a
// viewBox of the same proportions keeps the stroke even without non-scaling strokes, which
// would break the pathLength-based drawing animation.
const GREASE_W = 134;
const GREASE_H = 100;

/** A loop of grease pencil drawn by hand around a frame. */
function greasePath(seed) {
  const r = rng(seed * 9973 + 17);
  const start = r() * Math.PI * 2;
  const sweep = Math.PI * 2 + 0.35 + r() * 0.4;
  const steps = 46;
  const pts = [];
  for (let k = 0; k <= steps; k++) {
    const t = start + (sweep * k) / steps;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const ex = 0.62; // squarish loop, the way a pencil goes round a rectangle
    const x = Math.sign(c) * Math.abs(c) ** ex;
    const y = Math.sign(s) * Math.abs(s) ** ex;
    const wob = 1 + (r() - 0.5) * 0.03 + (k / steps) * 0.035;
    pts.push([GREASE_W / 2 + x * (GREASE_W / 2 - 4) * wob, GREASE_H / 2 + y * (GREASE_H / 2 - 5) * wob]);
  }
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let k = 1; k < pts.length - 1; k++) {
    const mx = (pts[k][0] + pts[k + 1][0]) / 2;
    const my = (pts[k][1] + pts[k + 1][1]) / 2;
    d += ` Q${pts[k][0].toFixed(1)} ${pts[k][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  return d;
}

function greaseSvg(seed, cls) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', `grease ${cls}`);
  svg.setAttribute('viewBox', `0 0 ${GREASE_W} ${GREASE_H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', greasePath(seed));
  path.setAttribute('pathLength', '1');
  svg.append(path);
  return svg;
}

function framesPerStrip() {
  const w = innerWidth;
  return w >= 1280 ? 6 : w >= 980 ? 5 : w >= 680 ? 4 : 3;
}

function initials(name = '') {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0].toUpperCase())
      .join('') || 'MM'
  );
}

function renderSheet(list) {
  const per = framesPerStrip();
  const sheet = h('div', { class: 'sheet' });
  const tag = `${initials(state.site.name)} 400`;
  for (let s = 0; s < list.length; s += per) {
    const chunk = list.slice(s, s + per);
    const strip = h('div', { class: 'strip', style: { '--frames': per } });
    const top = h('div', { class: 'rebate rebate-top', 'aria-hidden': 'true' });
    const topText = h('div', { class: 'rebate-text' });
    const frames = h('div', { class: 'frames' });
    const bottom = h('div', { class: 'rebate rebate-bottom', 'aria-hidden': 'true' });
    const bottomText = h('div', { class: 'rebate-text' });
    for (let k = 0; k < per; k++) {
      const p = chunk[k];
      const n = s + k + 1;
      topText.append(h('span', {}, k % 2 === 0 ? tag : ''));
      bottomText.append(h('span', {}, h('b', {}, `▸ ${n}`), h('i', {}, `${n}A`)));
      if (!p) {
        frames.append(h('span', { class: 'frame frame-empty', 'aria-hidden': 'true' }));
        continue;
      }
      const img = h('img', { src: siteUrl(p.thumb), alt: altText(p), loading: 'lazy', decoding: 'async', sizes: `${Math.round(100 / per)}vw` });
      img.addEventListener('load', () => img.classList.add('is-loaded'), { once: true });
      if (img.complete) img.classList.add('is-loaded');
      const frame = h(
        'button',
        {
          class: `frame${p.ar < 1 ? ' is-portrait' : ''}`,
          type: 'button',
          'data-id': p.id,
          'data-cursor': 'View',
          'aria-label': `Open frame ${p.n}: ${altText(p)}`,
          style: { background: p.ar < 1 ? '#050505' : p.color || '#050505' },
        },
        img,
        greaseSvg(n, p.featured ? 'is-select' : 'is-hover'),
      );
      frame.addEventListener('click', () => openFrom(p, img));
      frames.append(frame);
    }
    top.append(topText);
    bottom.append(bottomText);
    strip.append(top, frames, bottom);
    sheet.append(strip);
  }
  // Re-cut the strips if the window changes enough to change frames per strip.
  let lastPer = per;
  const onResize = () => {
    if (framesPerStrip() !== lastPer && state.view === 'sheet') {
      lastPer = framesPerStrip();
      renderView({ animate: false });
    }
  };
  addEventListener('resize', onResize);
  printsCleanup.push(() => removeEventListener('resize', onResize));
  return sheet;
}

// ------------------------------------------------------------------ light table

class LightTable {
  constructor() {
    this.closeBtn = h('button', { class: 'table-close ui', type: 'button' }, 'Close light table');
    this.plane = h('div', { class: 'table-plane' });
    this.el = h(
      'section',
      { class: 'table', hidden: true, 'aria-label': 'Light table', 'data-cursor': 'Drag', tabindex: '-1' },
      this.plane,
      h('div', { class: 'table-bar ui' }, h('span', { class: 'table-hint' }, finePointer ? 'Drag or scroll to move around. Click a print to view it.' : 'Drag to move around. Tap a print to view it.'), this.closeBtn),
    );
    document.body.append(this.el);
    this.cards = new Map();
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.tick = this.tick.bind(this);
    this.closeBtn.addEventListener('click', () => this.close());
    this.bind();
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open(list) {
    if (!list.length) return;
    this.list = list;
    this.layout();
    this.x = -((this.cols * this.cell) / 2 - innerWidth / 2);
    this.y = -((this.rows * this.cellH) / 2 - innerHeight / 2);
    this.vx = this.vy = 0;
    this.el.hidden = false;
    scroll.stop();
    gsap.ticker.add(this.tick);
    this.tick();
    if (!reduceMotion) {
      gsap.fromTo(this.el, { clipPath: 'circle(0% at 50% 50%)' }, { clipPath: 'circle(75% at 50% 50%)', duration: 1.1, ease: 'expo.inOut', clearProps: 'clipPath' });
      this.vx = -9; // a slow glide so it is obvious the table moves
    }
    this.el.focus({ preventScroll: true });
  }

  async close() {
    if (!this.isOpen) return;
    if (!reduceMotion) await gsap.to(this.el, { clipPath: 'circle(0% at 50% 50%)', duration: 0.8, ease: 'expo.inOut' });
    gsap.ticker.remove(this.tick);
    this.el.hidden = true;
    gsap.set(this.el, { clearProps: 'clipPath' });
    this.cards.forEach((c) => c.el.remove());
    this.cards.clear();
    scroll.start();
  }

  layout() {
    const vw = innerWidth;
    this.cell = vw < 700 ? 170 : vw < 1200 ? 250 : 300;
    this.cellH = Math.round(this.cell * 1.08);
    const n = this.list.length;
    this.cols = Math.max(4, Math.ceil(Math.sqrt(n * 1.6)));
    this.rows = Math.max(3, Math.ceil(n / this.cols));
  }

  imgFor(id) {
    for (const c of this.cards.values()) if (c.photo.id === id) return c.img;
    return null;
  }

  card(cx, cy) {
    const { cols, rows, list, cell } = this;
    const mod = (a, m) => ((a % m) + m) % m;
    const idx = (mod(cy, rows) * cols + mod(cx, cols)) % list.length;
    const p = list[idx];
    const r = rng((cx + 1000) * 7919 + (cy + 1000) * 104729);
    const maxW = cell * 0.74;
    const maxH = this.cellH * 0.74;
    let w = maxW;
    let hh = w / p.ar;
    if (hh > maxH) {
      hh = maxH;
      w = hh * p.ar;
    }
    const img = h('img', { src: siteUrl(p.thumb), alt: altText(p), decoding: 'async', draggable: 'false' });
    img.addEventListener('load', () => img.classList.add('is-loaded'), { once: true });
    const el = h('figure', { class: 'table-card', style: { width: `${w}px`, height: `${hh}px`, '--ph': p.color || '#ccc' } }, img);
    el.dataset.id = p.id;
    this.plane.append(el);
    return {
      el,
      img,
      photo: p,
      w,
      h: hh,
      ox: (r() - 0.5) * cell * 0.16,
      oy: (r() - 0.5) * this.cellH * 0.16,
      rot: (r() - 0.5) * 5,
    };
  }

  tick() {
    if (!this.dragging) {
      this.x += this.vx;
      this.y += this.vy;
      this.vx *= 0.92;
      this.vy *= 0.92;
      if (Math.abs(this.vx) < 0.01) this.vx = 0;
      if (Math.abs(this.vy) < 0.01) this.vy = 0;
    }
    const { cell, cellH } = this;
    const c0 = Math.floor(-this.x / cell) - 1;
    const c1 = Math.ceil((-this.x + innerWidth) / cell) + 1;
    const r0 = Math.floor(-this.y / cellH) - 1;
    const r1 = Math.ceil((-this.y + innerHeight) / cellH) + 1;
    const speed = Math.min(1, Math.hypot(this.vx, this.vy) / 40);
    const s = 1 - speed * 0.08;
    const seen = new Set();
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const key = `${cx},${cy}`;
        seen.add(key);
        let c = this.cards.get(key);
        if (!c) {
          c = this.card(cx, cy);
          this.cards.set(key, c);
        }
        const x = cx * cell + (cell - c.w) / 2 + c.ox + this.x;
        const y = cy * cellH + (cellH - c.h) / 2 + c.oy + this.y;
        c.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) rotate(${c.rot.toFixed(2)}deg) scale(${s.toFixed(3)})`;
      }
    }
    for (const [key, c] of this.cards) {
      if (!seen.has(key)) {
        c.el.remove();
        this.cards.delete(key);
      }
    }
  }

  bind() {
    let px = 0;
    let py = 0;
    let moved = 0;
    let downTarget = null;
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.table-bar')) return;
      this.dragging = true;
      moved = 0;
      px = e.clientX;
      py = e.clientY;
      downTarget = e.target.closest('.table-card');
      this.el.setPointerCapture(e.pointerId);
      this.el.classList.add('is-dragging');
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - px;
      const dy = e.clientY - py;
      px = e.clientX;
      py = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      this.x += dx;
      this.y += dy;
      this.vx = dx;
      this.vy = dy;
    });
    const end = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.el.classList.remove('is-dragging');
      if (moved < 6 && downTarget) {
        this.vx = this.vy = 0;
        const id = downTarget.dataset.id;
        const p = this.list.find((q) => q.id === id);
        if (p) {
          state.lb.setPhotos(this.list);
          state.lb.open(this.list.indexOf(p), { from: downTarget.querySelector('img') });
        }
      }
      downTarget = null;
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
    this.el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.vx -= e.deltaX * 0.08;
        this.vy -= e.deltaY * 0.08;
      },
      { passive: false },
    );
    this.el.addEventListener('keydown', (e) => {
      const step = 18;
      if (e.key === 'Escape' && !state.lb.isOpen) this.close();
      else if (e.key === 'ArrowLeft') this.vx += step;
      else if (e.key === 'ArrowRight') this.vx -= step;
      else if (e.key === 'ArrowUp') this.vy += step;
      else if (e.key === 'ArrowDown') this.vy -= step;
    });
    addEventListener('resize', () => {
      if (!this.isOpen) return;
      this.layout();
      this.cards.forEach((c) => c.el.remove());
      this.cards.clear();
    });
  }
}
