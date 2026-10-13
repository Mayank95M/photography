// About page: the portrait opens from a small window to fill the screen as you scroll,
// while the name parts around it.
import { h, siteUrl, loadData, initPage, startIris, renderFooter, altText, reduceMotion, finePointer } from './core.js';

const gsap = window.gsap;
const ScrollTrigger = window.ScrollTrigger;
const $ = (s) => document.querySelector(s);

boot().catch((err) => console.error(err));

async function boot() {
  initPage();
  const nameEl = $('.about-name');
  const { iris } = startIris(nameEl.textContent.trim());
  let data;
  try {
    data = await loadData();
  } catch (err) {
    iris.open();
    throw err;
  }
  const { site, photos } = data;
  const about = site.about || {};
  const name = site.name || nameEl.textContent.trim();
  document.title = `About ${name}`;

  nameEl.setAttribute('aria-label', name);
  const words = name.split(/\s+/);
  const half = Math.ceil(words.length / 2);
  nameEl.replaceChildren(
    h('span', { 'aria-hidden': 'true' }, words.slice(0, half).join(' ')),
    h('span', { 'aria-hidden': 'true' }, words.slice(half).join(' ') || ''),
  );

  // The portrait; until one is uploaded, borrow a featured photograph so the page still reads.
  const win = $('.portrait-window');
  const portrait = about.portrait;
  const stand = !portrait?.src && (photos.find((p) => p.featured) || photos[0]);
  let img = null;
  let ar = 0.8;
  if (portrait?.src) {
    ar = portrait.w / portrait.h;
    img = h('img', {
      src: siteUrl(portrait.src),
      srcset: portrait.small ? `${siteUrl(portrait.small)} ${portrait.sw}w, ${siteUrl(portrait.src)} ${portrait.w}w` : null,
      sizes: '100vw',
      alt: `Portrait of ${name}`,
      decoding: 'async',
      fetchpriority: 'high',
    });
    const [fx, fy] = portrait.focus || [0.5, 0.35];
    img.style.objectPosition = `${(fx * 100).toFixed(1)}% ${(fy * 100).toFixed(1)}%`;
    if (portrait.color) win.style.background = portrait.color;
  } else if (stand) {
    ar = Math.min(1, stand.ar);
    img = h('img', { src: siteUrl(stand.src), alt: altText(stand), decoding: 'async' });
  } else {
    win.append(h('div', { class: 'portrait-empty', 'aria-hidden': 'true' }));
  }
  if (img) win.append(img);

  // White copy of the name inside the window (see .is-knockout in site.css).
  const knock = nameEl.cloneNode(true);
  knock.classList.add('is-knockout');
  knock.removeAttribute('aria-label');
  knock.setAttribute('aria-hidden', 'true');
  win.append(knock);
  const syncKnock = () => {
    if (scrollY > innerHeight * 3.2) return; // the portrait has long scrolled away
    const a = nameEl.getBoundingClientRect();
    const b = win.getBoundingClientRect();
    const cs = getComputedStyle(nameEl);
    knock.style.width = `${a.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)}px`;
    knock.style.transform = `translate(${(a.left + parseFloat(cs.paddingLeft) - b.left).toFixed(1)}px, ${(a.top - b.top).toFixed(1)}px)`;
  };

  // Text
  const paras = (about.bio || '')
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const lede = (about.intro || '').trim() || paras.shift() || '';
  $('.about-lede').textContent = lede;
  $('.about-lede').hidden = !lede;
  $('.about-bio').replaceChildren(...paras.map((t) => h('p', {}, t)));
  const facts = (about.facts || []).filter((f) => f.label && f.value);
  if (about.location && !facts.some((f) => /based/i.test(f.label))) facts.unshift({ label: 'Based in', value: about.location });
  $('.facts').replaceChildren(...facts.flatMap((f) => [h('dt', { class: 'ui' }, f.label), h('dd', {}, f.value)]));
  $('.facts').hidden = !facts.length;

  renderSelected(photos);
  renderFooter(site);

  const sizeWindow = () => {
    const vw = innerWidth;
    const vh = innerHeight;
    let hh = vw >= 760 ? vh * 0.6 : Math.min(vh * 0.52, (vw * 0.66) / ar);
    let w = hh * ar;
    const maxW = vw >= 760 ? vw * 0.36 : vw * 0.66;
    if (w > maxW) {
      w = maxW;
      hh = w / ar;
    }
    return { w, h: hh };
  };
  const start = sizeWindow();
  gsap.set(win, { width: start.w, height: start.h });
  syncKnock();
  // Keep the white copy aligned when fonts arrive or the window changes size.
  const ro = new ResizeObserver(() => syncKnock());
  ro.observe(win);
  ro.observe(nameEl);

  if (img) await Promise.race([img.decode().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  await document.fonts?.ready;
  iris.open({ duration: 1.1 });

  if (reduceMotion) {
    win.style.width = '100%';
    win.style.height = '100%';
    syncKnock();
    return;
  }
  const parts = (i) => [nameEl.children[i], knock.children[i]];
  gsap.ticker.add(syncKnock);
  for (const layer of [nameEl, knock]) gsap.from(layer.children, { yPercent: 60, opacity: 0, duration: 1.4, ease: 'expo.out', stagger: 0.08, delay: 0.5 });
  if (img) gsap.from(img, { scale: 1.25, duration: 2, ease: 'expo.out', delay: 0.3 });

  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: '.about-hero',
      start: 'top top',
      end: '+=120%',
      scrub: 0.7,
      pin: true,
      invalidateOnRefresh: true,
    },
  });
  tl.fromTo(win, { width: () => sizeWindow().w, height: () => sizeWindow().h }, { width: () => innerWidth, height: () => innerHeight, ease: 'power2.inOut' }, 0)
    .to(parts(0), { xPercent: -40, opacity: 0, ease: 'power1.in' }, 0)
    .to(parts(1), { xPercent: 40, opacity: 0, ease: 'power1.in' }, 0);
  if (img) tl.fromTo(img, { scale: 1.12 }, { scale: 1, ease: 'none' }, 0);
}

function renderSelected(photos) {
  const pick = photos.filter((p) => p.featured);
  const list = (pick.length >= 3 ? pick : photos).slice(0, 10);
  const section = $('.selected');
  if (list.length < 2) return;
  section.hidden = false;
  const track = $('.selected-track');
  track.replaceChildren(
    ...list.map((p) =>
      h(
        'a',
        {
          class: 'selected-item',
          href: `../#/frame/${p.id}`,
          'data-cursor': 'View',
          style: { aspectRatio: p.ar.toFixed(4), '--ph': p.color || '' },
          'aria-label': `View ${altText(p)}`,
        },
        h('img', { src: siteUrl(p.thumb), alt: '', loading: 'lazy', decoding: 'async' }),
      ),
    ),
  );
  if (reduceMotion || !finePointer) {
    section.classList.add('is-native');
    return;
  }
  gsap.to(track, {
    x: () => Math.min(0, -(track.scrollWidth - innerWidth)),
    ease: 'none',
    scrollTrigger: {
      trigger: section,
      start: 'top bottom',
      end: 'bottom top',
      scrub: 0.6,
      invalidateOnRefresh: true,
    },
  });
  ScrollTrigger?.refresh();
}
