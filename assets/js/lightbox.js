// Full-screen viewer. Opens from a thumbnail with a FLIP animation, keeps a shareable
// #/frame/<id> address, and supports keys, swipes and a click-to-inspect zoom.
import { h, siteUrl, altText, metaLine, techLine, pad2, reduceMotion, finePointer, scroll } from './core.js';

const gsap = window.gsap;

export class Lightbox {
  /**
   * @param {{photos: any[], site: any, sourceFor?: (id:string)=>Element|null}} opts
   */
  constructor({ photos, site, sourceFor }) {
    this.photos = photos;
    this.site = site;
    this.sourceFor = sourceFor || (() => null);
    this.index = -1;
    this.build();
    addEventListener('popstate', () => {
      if (this.ignoreNextPop) {
        this.ignoreNextPop = false;
        return;
      }
      this.syncFromHash(false);
    });
  }

  setPhotos(photos) {
    this.photos = photos;
  }

  build() {
    this.img = h('img', { class: 'lb-img', alt: '', draggable: 'false' });
    this.stage = h('div', { class: 'lb-stage', 'data-cursor': 'Inspect' }, this.img);
    this.count = h('span', { class: 'lb-count ui', 'aria-live': 'polite' });
    this.title = h('h2', { class: 'lb-title', id: 'lb-title' });
    this.meta = h('p', { class: 'lb-meta' });
    this.caption = h('p', { class: 'lb-caption' });
    this.tech = h('p', { class: 'lb-tech ui' });
    this.share = h('button', { class: 'lb-btn ui', type: 'button' }, 'Copy link');
    this.prevBtn = h('button', { class: 'lb-btn ui', type: 'button' }, 'Previous');
    this.nextBtn = h('button', { class: 'lb-btn ui', type: 'button' }, 'Next');
    this.info = h(
      'aside',
      { class: 'lb-info' },
      this.count,
      this.title,
      this.meta,
      this.caption,
      this.tech,
      h('div', { class: 'lb-actions' }, this.prevBtn, this.nextBtn, this.share),
    );
    this.closeBtn = h('button', { class: 'lb-close ui', type: 'button' }, 'Close');
    const prevZone = h('button', { class: 'lb-nav lb-prev', type: 'button', 'aria-label': 'Previous photograph', 'data-cursor': 'Previous', tabindex: '-1' });
    const nextZone = h('button', { class: 'lb-nav lb-next', type: 'button', 'aria-label': 'Next photograph', 'data-cursor': 'Next', tabindex: '-1' });
    this.stage.append(prevZone, nextZone);
    this.el = h(
      'div',
      { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'lb-title', hidden: true },
      this.stage,
      this.info,
      this.closeBtn,
    );
    document.body.append(this.el);

    this.closeBtn.addEventListener('click', () => this.close());
    this.prevBtn.addEventListener('click', () => this.go(-1));
    this.nextBtn.addEventListener('click', () => this.go(1));
    prevZone.addEventListener('click', () => this.go(-1));
    nextZone.addEventListener('click', () => this.go(1));
    this.share.addEventListener('click', () => this.copyLink());
    this.img.addEventListener('click', (e) => this.toggleZoom(e));
    this.stage.addEventListener('pointermove', (e) => this.panZoom(e));
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.bindSwipe();
  }

  get photo() {
    return this.photos[this.index];
  }

  indexOfId(id) {
    return this.photos.findIndex((p) => p.id === id);
  }

  syncFromHash(animate = true) {
    const m = location.hash.match(/^#\/frame\/([\w-]+)/);
    if (m) {
      const i = this.indexOfId(m[1]);
      if (i >= 0 && i !== this.index) this.open(i, { animate, push: false });
    } else if (this.isOpen) {
      this.close({ fromHistory: true });
    }
  }

  get isOpen() {
    return !this.el.hidden;
  }

  targetRect(p) {
    const s = this.stage.getBoundingClientRect();
    const cs = getComputedStyle(this.stage);
    const left = s.left + parseFloat(cs.paddingLeft);
    const top = s.top + parseFloat(cs.paddingTop);
    const w = s.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const hgt = s.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const ar = p.w / p.h;
    let tw = Math.min(w, p.w);
    let th = tw / ar;
    if (th > hgt) {
      th = Math.min(hgt, p.h);
      tw = th * ar;
    }
    return { left: left + (w - tw) / 2, top: top + (hgt - th) / 2, width: tw, height: th };
  }

  async open(index, { from = null, animate = true, push = true } = {}) {
    if (index < 0 || index >= this.photos.length) return;
    const wasOpen = this.isOpen;
    this.index = index;
    this.lastFocus = wasOpen ? this.lastFocus : document.activeElement;
    const p = this.photo;
    if (push) history.pushState({ frame: p.id }, '', `#/frame/${p.id}`);
    else if (wasOpen) history.replaceState(history.state, '', `#/frame/${p.id}`);
    this.pushed = push || this.pushed;
    if (!wasOpen) {
      scroll.stop();
      this.el.hidden = false;
    }
    this.render();
    this.closeBtn.focus({ preventScroll: true });
    const source = from || this.sourceFor(p.id);
    if (wasOpen || !animate || reduceMotion || !source) {
      gsap.fromTo(this.el, { opacity: wasOpen ? 1 : 0 }, { opacity: 1, duration: 0.35 });
      return;
    }
    // FLIP: fly a copy of the thumbnail to where the full image will sit.
    const r0 = source.getBoundingClientRect();
    const r1 = this.targetRect(p);
    const ghost = h('img', { class: 'lb-ghost', src: source.currentSrc || source.src || siteUrl(p.thumb), alt: '' });
    Object.assign(ghost.style, { left: `${r0.left}px`, top: `${r0.top}px`, width: `${r0.width}px`, height: `${r0.height}px` });
    document.body.append(ghost);
    gsap.set(this.img, { opacity: 0 });
    // Fade the page colour in (from the same colour at zero alpha, so it never passes through grey).
    const bg = getComputedStyle(document.body).backgroundColor;
    const clear = bg.replace(/^rgba?\(([^,]+),([^,]+),([^,)]+).*$/, 'rgba($1,$2,$3,0)');
    gsap.fromTo(this.el, { backgroundColor: clear }, { backgroundColor: bg, duration: 0.5 });
    gsap.fromTo(this.info, { opacity: 0, x: 24 }, { opacity: 1, x: 0, duration: 0.8, delay: 0.25, ease: 'expo.out' });
    gsap.fromTo(this.closeBtn, { opacity: 0 }, { opacity: 1, duration: 0.4, delay: 0.3 });
    await gsap.to(ghost, {
      left: r1.left,
      top: r1.top,
      width: r1.width,
      height: r1.height,
      duration: 0.9,
      ease: 'expo.inOut',
    });
    gsap.set(this.img, { opacity: 1 });
    ghost.remove();
    this.el.style.backgroundColor = '';
  }

  render() {
    const p = this.photo;
    this.resetZoom();
    const thumb = siteUrl(p.thumb);
    const full = siteUrl(p.src);
    this.img.alt = altText(p);
    this.img.width = p.w;
    this.img.height = p.h;
    if (p.lqip) this.img.style.background = `center / cover no-repeat url(${p.lqip})`;
    this.img.src = thumb;
    const hi = new Image();
    hi.decoding = 'async';
    hi.src = full;
    const want = p.id;
    hi.decode()
      .then(() => {
        if (this.photo?.id === want) this.img.src = full;
      })
      .catch(() => {});
    this.count.textContent = `${pad2(this.index + 1)} of ${pad2(this.photos.length)}`;
    this.title.textContent = p.title || `Untitled, frame ${p.n}`;
    this.meta.textContent = metaLine(p, true);
    this.caption.textContent = p.caption || '';
    this.caption.hidden = !p.caption;
    const tech = this.site.showCameraInfo !== false ? techLine(p) : '';
    this.tech.textContent = tech;
    this.tech.hidden = !tech;
    this.share.textContent = 'Copy link';
    // Warm the neighbours so stepping through feels instant.
    for (const d of [1, -1]) {
      const n = this.photos[(this.index + d + this.photos.length) % this.photos.length];
      if (n) new Image().src = siteUrl(n.thumb);
    }
  }

  go(delta) {
    if (!this.isOpen || this.photos.length < 2) return;
    const next = (this.index + delta + this.photos.length) % this.photos.length;
    if (reduceMotion) {
      this.index = next;
      history.replaceState(history.state, '', `#/frame/${this.photo.id}`);
      this.render();
      return;
    }
    const dir = Math.sign(delta);
    gsap.killTweensOf([this.img, this.info]);
    gsap.to(this.img, {
      opacity: 0,
      x: -40 * dir,
      duration: 0.28,
      ease: 'power2.in',
      onComplete: () => {
        this.index = next;
        history.replaceState(history.state, '', `#/frame/${this.photo.id}`);
        this.render();
        gsap.fromTo(this.img, { opacity: 0, x: 40 * dir }, { opacity: 1, x: 0, duration: 0.6, ease: 'expo.out' });
        gsap.fromTo(this.info.children, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.03, ease: 'expo.out' });
      },
    });
  }

  async close({ fromHistory = false } = {}) {
    if (!this.isOpen || this.closing) return;
    this.closing = true;
    const p = this.photo;
    const target = p && this.sourceFor(p.id);
    if (!fromHistory && this.pushed) {
      this.pushed = false;
      this.ignoreNextPop = true;
      history.back();
    } else if (!fromHistory) {
      history.replaceState(history.state, '', location.pathname + location.search);
    }
    this.pushed = false;
    const r1 = target?.getBoundingClientRect();
    const visible = r1 && r1.bottom > 0 && r1.top < innerHeight && r1.width > 0;
    if (!reduceMotion && visible) {
      const r0 = this.img.getBoundingClientRect();
      const ghost = h('img', { class: 'lb-ghost', src: this.img.currentSrc || this.img.src, alt: '' });
      Object.assign(ghost.style, { left: `${r0.left}px`, top: `${r0.top}px`, width: `${r0.width}px`, height: `${r0.height}px` });
      document.body.append(ghost);
      gsap.set(this.img, { opacity: 0 });
      gsap.to(this.el, { opacity: 0, duration: 0.45, delay: 0.1 });
      await gsap.to(ghost, { left: r1.left, top: r1.top, width: r1.width, height: r1.height, duration: 0.75, ease: 'expo.inOut' });
      ghost.remove();
    } else {
      await gsap.to(this.el, { opacity: 0, duration: 0.3 });
    }
    this.el.hidden = true;
    gsap.set([this.el, this.img], { clearProps: 'opacity,transform' });
    this.index = -1;
    this.closing = false;
    scroll.start();
    this.lastFocus?.focus?.({ preventScroll: true });
  }

  async copyLink() {
    const url = `${location.origin}${location.pathname}#/frame/${this.photo.id}`;
    try {
      await navigator.clipboard.writeText(url);
      this.share.textContent = 'Link copied';
    } catch {
      this.share.textContent = url;
    }
  }

  onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (this.zoomed) this.resetZoom();
      else this.close();
    } else if (e.key === 'ArrowRight') this.go(1);
    else if (e.key === 'ArrowLeft') this.go(-1);
    else if (e.key === 'Tab') {
      const focusables = [...this.el.querySelectorAll('button:not([tabindex="-1"]), a[href]')].filter((n) => !n.hidden);
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  toggleZoom(e) {
    if (!finePointer) return;
    if (this.zoomed) return this.resetZoom();
    const p = this.photo;
    const rect = this.img.getBoundingClientRect();
    const scale = Math.max(1.8, Math.min(3, p.w / rect.width));
    this.zoomed = true;
    this.img.classList.add('is-zoomed');
    this.stage.dataset.cursor = 'Close up';
    this.panZoom(e);
    gsap.to(this.img, { scale, duration: 0.7, ease: 'expo.out' });
  }

  panZoom(e) {
    if (!this.zoomed) return;
    const r = this.stage.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 100;
    const y = ((e.clientY - r.top) / r.height) * 100;
    this.img.style.transformOrigin = `${x}% ${y}%`;
  }

  resetZoom() {
    if (!this.zoomed) return;
    this.zoomed = false;
    this.img.classList.remove('is-zoomed');
    this.stage.dataset.cursor = 'Inspect';
    gsap.to(this.img, { scale: 1, duration: 0.5, ease: 'expo.out' });
  }

  bindSwipe() {
    let x0 = null;
    let y0 = 0;
    this.stage.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      x0 = e.clientX;
      y0 = e.clientY;
    });
    this.stage.addEventListener('pointerup', (e) => {
      if (x0 === null) return;
      const dx = e.clientX - x0;
      const dy = e.clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) this.go(dx < 0 ? 1 : -1);
      else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) this.close();
    });
  }
}
