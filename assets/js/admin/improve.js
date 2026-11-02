// "Improve quality": re-process photographs already on the site so they hold up on large
// screens. Titles, captions, dates and order are kept; only the image files are replaced.
// The best source is used for each photo: an original (from the Instagram archive or a file you
// add), a version enlarged in another app, or else the copy already on the site.
import { h, toast, confirmDialog, duration } from './ui.js';
import { decode, pixels, detectBorders, blobToBase64, encode, crop as cropCanvas, cropRect } from './imaging.js';
import { render, inspect, newId, stageText } from './pipeline.js';
import { chooseModel, estimateSeconds, enhancementAvailable } from './upscaler.js';
import { openArchive, loadZip } from './instagram.js';
import { signature, bestMatch, matchByName } from './match.js';
import { compareView, cropEditor } from './editor.js';
import { installBox, installZip, isUpdateZip } from './sitefiles.js';

const ZERO = { top: 0, right: 0, bottom: 0, left: 0 };
const isZip = (f) => /\.zip$/i.test(f.name) || /zip/.test(f.type);
const isImage = (f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|tiff?|heic|heif|avif)$/i.test(f.name);

function seedOf(id) {
  let s = 2166136261;
  for (const c of id) s = Math.imul(s ^ c.charCodeAt(0), 16777619);
  return s >>> 0;
}

function cropImageData(img, b) {
  const w = img.width - b.left - b.right;
  const hh = img.height - b.top - b.bottom;
  const out = new ImageData(Math.max(1, w), Math.max(1, hh));
  for (let y = 0; y < hh; y++) {
    const start = ((y + b.top) * img.width + b.left) * 4;
    out.data.set(img.data.subarray(start, start + w * 4), y * w * 4);
  }
  return out;
}

async function fingerprint(blob, { borders }) {
  const bmp = await decode(blob);
  const { imageData } = pixels(bmp, 512);
  const size = { w: bmp.width, h: bmp.height };
  bmp.close?.();
  let img = imageData;
  if (borders) {
    const b = detectBorders(img);
    if (b.kind !== 'none' && b.confidence !== 'low') img = cropImageData(img, b);
  }
  return { sig: signature(img), ...size };
}

export function improveView(ctx) {
  const { store } = ctx;
  const settings = ctx.settings();
  const st = {
    target: settings.longEdge || 2560,
    quality: store.site.processing?.enhanceQuality || 'best', // your choice; see quality()
    finish: settings.finish || 'natural',
    selected: null, // Set of ids; null until first paint picks the recommended ones
    sources: new Map(), // photo id -> { kind, label, w, h, borders, load }
    archives: [],
    unmatched: [],
    sigs: null,
    note: '',
    run: null,
    results: new Map(), // photo id -> { after: Blob, before: () => Promise<Blob>, framing }
  };
  // Best needs its models installed on the site; until then Fast is used.
  const quality = () => (st.quality === 'best' && ctx.models?.ready === false ? 'fast' : st.quality);
  const root = h('div', {});
  const grid = h('div', { class: 'cards improve-cards' });
  const runBox = h('div', {});
  const sourceNote = h('p', { class: 'muted', 'aria-live': 'polite' });
  const summary = h('p', {});
  const planLine = h('p', { class: 'muted' });
  const startBtn = h('button', { class: 'btn btn-primary', type: 'button' });
  const exportBtn = h('button', { class: 'btn', type: 'button' }, 'Download photos for a desktop app');
  let gpuOk = true;
  enhancementAvailable().then((v) => {
    gpuOk = v;
    paint();
  });

  const photos = () => store.photos;
  const longOf = (p) => Math.max(p.w || 0, p.h || 0);
  const qualityOf = (p) => p.quality || (p.enhanced ? 'fast' : null);
  const siteSource = (p) => ({
    kind: 'site',
    label: 'the copy on your site',
    w: p.w,
    h: p.h,
    borders: false,
    load: async () => {
      const res = await fetch(new URL(p.src, ctx.siteUrl));
      if (!res.ok) throw new Error(`The published image couldn't be loaded (${res.status}).`);
      return res.blob();
    },
  });

  function statusOf(p) {
    if (st.results.has(p.id)) return { key: 'done', label: 'Improved', tone: 'ok' };
    if (store.isNew(p.id)) return { key: 'new', label: 'Publish first', tone: '' };
    const q = qualityOf(p);
    if (q === 'fast') return { key: 'fast', label: 'Smoothed by the fast enhancer', tone: 'check' };
    if (q === 'x2' || q === 'x4') return { key: 'sharp', label: 'Best quality', tone: 'ok' };
    if (longOf(p) < st.target * 0.9) return { key: 'low', label: `Low resolution, ${longOf(p)} px`, tone: 'check' };
    return { key: 'sharp', label: 'Sharp', tone: 'ok' };
  }

  /** What would happen to a photo with the current sources and options. */
  function planFor(p) {
    const s = statusOf(p);
    if (s.key === 'new') return { kind: 'skip', text: 'Publish this photo first.' };
    if (s.key === 'done') return { kind: 'skip', text: 'Improved. Publish to put it on your site.' };
    const src = st.sources.get(p.id);
    if (src) {
      const long = Math.max(src.w || 1080, src.h || 1080);
      const model = long >= st.target * 0.95 ? null : chooseModel(long, st.target, quality());
      const from = src.kind === 'archive' ? 'your Instagram original' : `your file ${src.label}`;
      return model
        ? { kind: 'enhance', model, source: src, w: src.w || 1080, h: src.h || 1350, text: `${quality() === 'best' ? 'Best quality' : 'Fast'} enhancement from ${from}.` }
        : { kind: 'resize', source: src, text: `From ${from} (${long} px), no enhancement needed.` };
    }
    const q = qualityOf(p);
    if (q === 'fast' || q === 'x2' || q === 'x4' || p.finish) {
      if (st.finish === 'off' || p.finish) return { kind: 'skip', text: q === 'fast' ? 'Add your Instagram archive above to redo it with Best quality.' : 'Nothing more to do.' };
      return { kind: 'finish', source: siteSource(p), text: q === 'fast' ? 'Finishing only. Add your Instagram archive above to redo it with Best quality.' : 'Finishing only.' };
    }
    const model = chooseModel(longOf(p), st.target, quality());
    if (model) return { kind: 'enhance', model, source: siteSource(p), w: p.w, h: p.h, text: `${quality() === 'best' ? 'Best quality' : 'Fast'} enhancement of the copy on your site, ${longOf(p)} → ${st.target} px.` };
    if (st.finish !== 'off') return { kind: 'finish', source: siteSource(p), text: 'Finishing only; it already has enough pixels.' };
    return { kind: 'skip', text: 'Nothing to do.' };
  }

  const recommended = (p) => {
    const k = statusOf(p).key;
    return (k === 'low' || k === 'fast') && planFor(p).kind !== 'skip';
  };

  function secondsFor(p) {
    const plan = planFor(p);
    if (plan.kind === 'skip') return 0;
    return 4 + (plan.kind === 'enhance' ? estimateSeconds(plan.model, plan.w, plan.h) : 0);
  }

  // ---------------------------------------------------------------- painting

  function paint() {
    const list = photos();
    if (!st.selected) st.selected = new Set(list.filter(recommended).map((p) => p.id));
    for (const id of [...st.selected]) if (!list.some((p) => p.id === id)) st.selected.delete(id);

    const counts = { low: 0, fast: 0, sharp: 0, done: 0 };
    for (const p of list) counts[statusOf(p).key] = (counts[statusOf(p).key] || 0) + 1;
    const need = counts.low + counts.fast;
    summary.replaceChildren(
      need
        ? `${need} of your ${list.length} photos could look better on large screens: ${[
            counts.low ? `${counts.low} at low resolution` : '',
            counts.fast ? `${counts.fast} smoothed by the fast enhancer` : '',
          ]
            .filter(Boolean)
            .join(', ')}.`
        : `All ${list.length} photos already have enough detail for ${st.target} px.`,
    );
    sourceNote.textContent = st.note;

    const chosen = list.filter((p) => st.selected.has(p.id) && planFor(p).kind !== 'skip');
    const secs = chosen.reduce((s, p) => s + secondsFor(p), 0);
    startBtn.textContent = chosen.length ? `Improve ${chosen.length} photo${chosen.length === 1 ? '' : 's'}` : 'Improve photos';
    startBtn.disabled = !chosen.length || !!st.run;
    exportBtn.disabled = !!st.run;
    planLine.textContent = chosen.length
      ? `About ${duration(secs) || '1 min'} on this computer (a first estimate; it gets more accurate once it starts).${
          gpuOk ? '' : ' This browser can’t run the enhancement, so photos will only be finished.'
        }`
      : 'Choose photos below.';

    grid.replaceChildren(...list.map(card));
  }

  function card(p) {
    const s = statusOf(p);
    const plan = planFor(p);
    const on = st.selected.has(p.id) && plan.kind !== 'skip';
    const box = h('input', { type: 'checkbox', checked: on, disabled: plan.kind === 'skip' || !!st.run, 'aria-label': `Improve ${p.title || 'this photo'}` });
    const src = store.previews.get(p.id) || new URL(p.thumb, ctx.siteUrl).href;
    const res = st.results.get(p.id);
    const el = h(
      'div',
      { class: `card improve-card${on ? ' is-on' : ''}${s.key === 'done' ? ' is-done' : plan.kind === 'skip' ? ' is-skip' : ''}`, 'data-id': p.id },
      h('div', { class: 'card-img' }, h('img', { src, alt: '', loading: 'lazy', decoding: 'async' }), box),
      h('span', { class: 'card-title' }, p.title || 'Untitled'),
      h('span', { class: `status ${s.tone}` }, s.label),
      h('span', { class: 'card-meta plan' }, res?.framing ? 'Framing adjusted to match. Check it below.' : plan.text),
      res
        ? h(
            'div',
            { class: 'row' },
            h('button', { class: 'btn btn-small', type: 'button', onclick: (e) => (e.stopPropagation(), compare(p)) }, 'Compare'),
            res.redo ? h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: (e) => (e.stopPropagation(), redoCrop(p)) }, 'Adjust crop') : null,
          )
        : null,
    );
    const toggle = () => {
      if (plan.kind === 'skip' || st.run) return;
      if (st.selected.has(p.id)) st.selected.delete(p.id);
      else st.selected.add(p.id);
      paint();
    };
    box.addEventListener('change', toggle);
    el.addEventListener('click', (e) => {
      if (e.target === box || e.target.closest('button')) return;
      toggle();
    });
    return el;
  }

  // ---------------------------------------------------------------- sources

  async function photoSignatures(report) {
    if (st.sigs) return st.sigs;
    const list = photos().filter((p) => !store.isNew(p.id));
    const sigs = new Map();
    let done = 0;
    const queue = [...list];
    const worker = async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        try {
          const res = await fetch(new URL(p.thumb, ctx.siteUrl));
          if (res.ok) sigs.set(p.id, (await fingerprint(await res.blob(), { borders: false })).sig);
        } catch {
          /* skip photos whose thumbnail can't be read */
        }
        done++;
        report?.(`Comparing with your photos… ${done} of ${list.length}`);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    st.sigs = sigs;
    return sigs;
  }

  async function addSources(files) {
    // A site update (such as best-quality-models.zip) dropped here: install it.
    const zips = [];
    let installed = false;
    for (const f of files.filter(isZip)) {
      if (await isUpdateZip(f)) {
        installed = true;
        await installZip(ctx, f, (t) => {
          st.note = t;
          sourceNote.textContent = t;
        });
      } else zips.push(f);
    }
    const images = files.filter((f) => !isZip(f) && isImage(f));
    if (installed && !zips.length && !images.length) return;
    const notes = [];
    const say = (t) => {
      sourceNote.textContent = t;
    };
    try {
      if (zips.length) {
        say('Opening the Instagram archive…');
        const arch = await openArchive(zips, say);
        st.archives.push(arch);
        const byKey = new Map(arch.items.map((it) => [it.key, it]));
        const used = new Set();
        let n = 0;
        for (const p of photos()) {
          const it = p.source?.key && byKey.get(p.source.key);
          if (!it || st.sources.get(p.id)?.kind === 'file') continue;
          st.sources.set(p.id, { kind: 'archive', label: 'Instagram original', borders: true, load: () => arch.load(it) });
          if (statusOf(p).key !== 'sharp') st.selected?.add(p.id);
          used.add(it);
          n++;
        }
        // Photos added with Add photos carry no Instagram id: find their originals by how they look,
        // keeping the closest archive photo for each.
        const want = new Set(photos().filter((p) => !st.sources.has(p.id) && ['low', 'fast'].includes(statusOf(p).key)).map((p) => p.id));
        const rest = arch.items.filter((it) => !used.has(it) && !it.heic);
        if (want.size && rest.length) {
          const all = [...(await photoSignatures(say))].map(([id, sig]) => ({ id, sig }));
          const found = new Map();
          for (const [i, it] of rest.entries()) {
            say(`Looking through the archive for your other photos… ${i + 1} of ${rest.length}`);
            let fp;
            try {
              fp = await fingerprint(await arch.load(it), { borders: true });
            } catch {
              continue;
            }
            const m = bestMatch(fp.sig, all);
            if (!m || !want.has(m.id)) continue;
            const prev = found.get(m.id);
            if (!prev || m.distance < prev.distance) found.set(m.id, { it, fp, distance: m.distance });
          }
          for (const [id, { it, fp }] of found) {
            st.sources.set(id, { kind: 'archive', label: 'Instagram original', w: fp.w, h: fp.h, borders: true, load: () => arch.load(it) });
            st.selected?.add(id);
            n++;
          }
        }
        notes.push(n ? `Found the Instagram originals of ${n} photo${n === 1 ? '' : 's'}.` : 'None of the photos in this archive are on your site yet. Import them first.');
      }
      if (images.length) {
        let matched = 0;
        const unmatched = [];
        for (const [i, f] of images.entries()) {
          say(`Matching ${i + 1} of ${images.length}: ${f.name}`);
          let p = matchByName(f.name, photos());
          let fp = null;
          try {
            fp = await fingerprint(f, { borders: true });
          } catch {
            unmatched.push(f.name);
            continue;
          }
          if (!p) {
            const sigs = await photoSignatures(say);
            const m = bestMatch(fp.sig, [...sigs].map(([id, sig]) => ({ id, sig })));
            if (m) p = photos().find((q) => q.id === m.id);
          }
          if (!p) {
            unmatched.push(f.name);
            continue;
          }
          st.sources.set(p.id, { kind: 'file', label: f.name, w: fp.w, h: fp.h, borders: true, load: async () => f });
          st.selected?.add(p.id);
          matched++;
        }
        if (matched) notes.push(`Matched ${matched} file${matched === 1 ? '' : 's'} to your photos.`);
        if (unmatched.length) {
          notes.push(
            `${unmatched.length} file${unmatched.length === 1 ? '' : 's'} didn't match any photo on your site (${unmatched.slice(0, 3).join(', ')}${unmatched.length > 3 ? '…' : ''}). Files must show the same framing as the photo on your site; use Add photos for new ones.`,
          );
        }
      }
      if (!zips.length && !images.length) notes.push('Drop a .zip archive or photo files.');
    } catch (err) {
      console.error(err);
      notes.push(err.message || 'Those files couldn’t be read.');
    }
    st.note = notes.join(' ');
    paint();
  }

  // ---------------------------------------------------------------- framing

  /** Crop for a source image so it shows the same framing as the published photo. */
  function framingFor(info, p, borders) {
    const want = p.w / p.h;
    const cands = [];
    if (borders && info.frame.kind !== 'none') cands.push(info.insets);
    cands.push(ZERO);
    let best = null;
    for (const ins of cands) {
      const w = info.width * (1 - ins.left - ins.right);
      const hh = info.height * (1 - ins.top - ins.bottom);
      const err = Math.abs(Math.log(w / hh / want));
      if (!best || err < best.err) best = { insets: ins, err };
    }
    if (best.err <= 0.025) return { insets: best.insets, adjusted: false };
    // Different shape (an original that was cropped for Instagram): centre-crop to match.
    const ins = { ...best.insets };
    const w = info.width * (1 - ins.left - ins.right);
    const hh = info.height * (1 - ins.top - ins.bottom);
    if (w / hh > want) {
      const cut = (w - hh * want) / 2 / info.width;
      ins.left += cut;
      ins.right += cut;
    } else {
      const cut = (hh - w / want) / 2 / info.height;
      ins.top += cut;
      ins.bottom += cut;
    }
    return { insets: ins, adjusted: true };
  }

  // ---------------------------------------------------------------- running

  async function improveOne(p, plan, run, insetsOverride) {
    const blob = await plan.source.load();
    const file = blob instanceof File ? blob : new File([blob], `${p.id}.jpg`, { type: blob.type || 'image/jpeg' });
    const info = await inspect(file);
    let insets = ZERO;
    let adjusted = false;
    if (insetsOverride) insets = insetsOverride;
    else if (plan.source.kind !== 'site') ({ insets, adjusted } = framingFor(info, p, plan.source.borders));
    const opts = { ...ctx.settings(), longEdge: st.target, enhanceQuality: quality() };
    const out = await render(info, {
      insets,
      enhance: plan.kind !== 'finish',
      settings: opts,
      finish: st.finish,
      seed: seedOf(p.id),
      signal: run?.abort.signal,
      onProgress: ({ stage, fraction }) => {
        if (!run) return;
        run.stage = stageText(stage, fraction);
        refreshRun();
      },
    });
    if (run) {
      run.stage = stageText('upload');
      refreshRun();
    }
    const id = newId(p.date ? new Date(p.date) : new Date());
    const full = `photos/full/${id}.jpg`;
    const thumb = `photos/thumb/${id}.${out.thumbExt}`;
    const [a, b] = await Promise.all([blobToBase64(out.full).then((x) => ctx.gh.createBlobBase64(x)), blobToBase64(out.thumb).then((x) => ctx.gh.createBlobBase64(x))]);
    const fromSite = plan.source.kind === 'site';
    const madeWith = out.quality || (fromSite ? qualityOf(p) : null);
    const old = store.photos.find((q) => q.id === p.id) || p;
    const prevPreview = store.previews.get(p.id);
    store.previews.set(p.id, URL.createObjectURL(out.thumb));
    if (prevPreview?.startsWith('blob:')) URL.revokeObjectURL(prevPreview);
    const before = st.results.get(p.id)?.before || (async () => {
      const res = await fetch(new URL(old.src, ctx.siteUrl));
      return res.blob();
    });
    store.replaceFiles(
      p.id,
      {
        src: full,
        thumb,
        w: out.w,
        h: out.h,
        tw: out.tw,
        th: out.th,
        lqip: out.lqip,
        color: out.color,
        enhanced: !!madeWith,
        quality: madeWith,
        finish: out.finish || (fromSite ? p.finish || null : null),
        improved: new Date().toISOString(),
      },
      [
        { path: full, sha: a },
        { path: thumb, sha: b },
      ],
      [old.src, old.thumb],
    );
    info.bitmap.close?.();
    st.results.set(p.id, { after: out.full, before, framing: adjusted, redo: plan.source.kind !== 'site', plan });
  }

  async function start() {
    const list = photos().filter((p) => st.selected.has(p.id));
    const queue = list.map((p) => ({ p, plan: planFor(p) })).filter((x) => x.plan.kind !== 'skip');
    if (!queue.length) return;
    if (!gpuOk && queue.some((x) => x.plan.kind === 'enhance')) {
      const ok = await confirmDialog({
        title: 'Enhancement isn’t available in this browser',
        body: 'This browser can’t use the graphics chip, so photos will only be finished, not enhanced. Try Chrome or Edge on a computer for the full result.',
        confirm: 'Finish them anyway',
      });
      if (!ok) return;
    }
    const run = { queue, done: 0, failed: [], started: performance.now(), stop: false, paused: false, abort: new AbortController(), stage: '', current: null };
    st.run = run;
    ctx.busy(true);
    await keepAwake(true);
    paint();
    paintRun();
    for (const item of queue) {
      while (run.paused && !run.stop) await new Promise((r) => setTimeout(r, 300));
      if (run.stop) break;
      run.current = item.p;
      run.stage = 'Loading';
      refreshRun();
      try {
        await improveOne(item.p, item.plan, run);
        run.done++;
      } catch (err) {
        if (err?.name === 'AbortError') break;
        console.error(err);
        run.failed.push({ p: item.p, message: err.message || String(err) });
      }
      refreshRun();
      paintCard(item.p);
    }
    await keepAwake(false);
    ctx.busy(false);
    st.run = null;
    runBox.replaceChildren();
    paint();
    const n = run.done;
    if (n) {
      toast(`${n} photo${n === 1 ? '' : 's'} improved. Compare them below, then publish to put them on your site.`, {
        action: { label: 'Publish now', run: () => ctx.publish() },
        timeout: 15000,
      });
    }
    if (run.failed.length) toast(`${run.failed.length} couldn’t be improved: ${run.failed[0].message}`, { tone: 'bad', timeout: 12000 });
  }

  let runEls = null;
  function paintRun() {
    const run = st.run;
    runEls = {
      img: h('img', { alt: '' }),
      title: h('h2', {}),
      line: h('p', { class: 'muted', 'aria-live': 'polite' }),
      bar: h('i'),
      eta: h('p', { class: 'muted' }),
      pause: h('button', { class: 'btn', type: 'button' }, 'Pause'),
      stop: h('button', { class: 'btn btn-danger', type: 'button' }, 'Stop'),
    };
    runEls.pause.addEventListener('click', () => {
      run.paused = !run.paused;
      runEls.pause.textContent = run.paused ? 'Resume' : 'Pause';
    });
    runEls.stop.addEventListener('click', async () => {
      if (await confirmDialog({ title: 'Stop improving?', body: 'Photos already improved stay staged, ready to publish.', confirm: 'Stop', danger: true })) {
        run.stop = true;
        run.paused = false;
        run.abort.abort();
      }
    });
    runBox.replaceChildren(
      h(
        'div',
        { class: 'import-run panel section-gap' },
        h('div', { class: 'now' }, runEls.img),
        h(
          'div',
          { class: 'stack' },
          runEls.title,
          runEls.line,
          h('div', { class: 'progress big-progress' }, runEls.bar),
          runEls.eta,
          h('p', {}, 'Keep this tab open and in front. Your screen stays on while it works, and each photo is saved as soon as it’s done.'),
          h('div', { class: 'row' }, runEls.pause, runEls.stop),
        ),
      ),
    );
    refreshRun();
  }

  function refreshRun() {
    const run = st.run;
    if (!run || !runEls) return;
    const total = run.queue.length;
    const n = run.done + run.failed.length;
    runEls.title.textContent = `Improving ${Math.min(n + 1, total)} of ${total}`;
    runEls.bar.style.width = `${(n / total) * 100}%`;
    const p = run.current;
    if (p) {
      const src = store.previews.get(p.id) || new URL(p.thumb, ctx.siteUrl).href;
      if (runEls.img.dataset.id !== p.id) {
        runEls.img.src = src;
        runEls.img.dataset.id = p.id;
      }
      runEls.line.textContent = `${p.title || 'Untitled'}: ${run.stage || ''}`;
    }
    if (n >= 1) {
      const per = (performance.now() - run.started) / 1000 / n;
      runEls.eta.textContent = `About ${duration(per * (total - n)) || 'a minute'} left.`;
    }
  }

  function paintCard(p) {
    const old = grid.querySelector(`[data-id="${CSS.escape(p.id)}"]`);
    if (old) old.replaceWith(card(store.photos.find((q) => q.id === p.id) || p));
  }

  let wake = null;
  async function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator && !wake) {
        wake = await navigator.wakeLock.request('screen');
        wake.addEventListener('release', () => (wake = null));
      } else if (!on && wake) {
        await wake.release();
        wake = null;
      }
    } catch {
      /* not supported, or the tab is hidden */
    }
  }
  const onVisible = () => {
    if (st.run && document.visibilityState === 'visible') keepAwake(true);
  };
  document.addEventListener('visibilitychange', onVisible);

  // ---------------------------------------------------------------- compare and redo

  async function compare(p) {
    const res = st.results.get(p.id);
    if (!res) return;
    try {
      const [before, after] = await Promise.all([res.before().then((b) => decode(b)), decode(res.after)]);
      compareView({ before, after, title: p.title || 'Before and after' });
    } catch (err) {
      toast(err.message || 'The comparison couldn’t be shown.', { tone: 'bad' });
    }
  }

  async function redoCrop(p) {
    const res = st.results.get(p.id);
    if (!res) return;
    const blob = await res.plan.source.load();
    const info = await inspect(blob instanceof File ? blob : new File([blob], 'source.jpg', { type: blob.type || 'image/jpeg' }));
    const current = framingFor(info, p, res.plan.source.borders).insets;
    const next = await cropEditor({ bitmap: info.bitmap, insets: current, title: 'Match the framing on your site' });
    info.bitmap.close?.();
    if (!next) return;
    const note = toast('Saving the new version…', { timeout: 0 });
    ctx.busy(true);
    try {
      await improveOne(p, res.plan, null, next);
      st.results.get(p.id).framing = false;
      note.remove();
      toast('Saved. Publish to put it on your site.');
    } catch (err) {
      note.remove();
      toast(err.message || 'It couldn’t be saved.', { tone: 'bad' });
    } finally {
      ctx.busy(false);
      paintCard(p);
    }
  }

  // ---------------------------------------------------------------- desktop app export

  async function exportForApp() {
    const list = photos().filter((p) => st.selected.has(p.id));
    const usable = list.filter((p) => st.sources.has(p.id) || (!qualityOf(p) && !store.isNew(p.id)));
    if (!usable.length) {
      toast('Choose photos that have an original, or that were never enhanced. Add your Instagram archive above for the others.', { tone: 'bad' });
      return;
    }
    const zip = await loadZip().catch(() => null);
    if (!zip?.ZipWriter) {
      toast('The ZIP writer couldn’t be loaded.', { tone: 'bad' });
      return;
    }
    exportBtn.disabled = true;
    ctx.busy(true);
    const note = toast('Preparing photos…', { timeout: 0 });
    try {
      const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'), { level: 0 });
      let i = 0;
      for (const p of usable) {
        note.firstChild.textContent = `Preparing ${++i} of ${usable.length}…`;
        const src = st.sources.get(p.id) || siteSource(p);
        const blob = await src.load();
        const info = await inspect(blob instanceof File ? blob : new File([blob], 'x.jpg', { type: blob.type || 'image/jpeg' }));
        const { insets } = src.kind === 'site' ? { insets: ZERO } : framingFor(info, p, src.borders);
        const rect = cropRect(info.width, info.height, {
          top: Math.round(insets.top * info.height),
          right: Math.round(insets.right * info.width),
          bottom: Math.round(insets.bottom * info.height),
          left: Math.round(insets.left * info.width),
        });
        const canvas = cropCanvas(info.bitmap, rect);
        info.bitmap.close?.();
        const png = await encode(canvas, 'image/png');
        canvas.width = canvas.height = 0;
        await writer.add(`${p.id}.png`, new zip.BlobReader(png));
      }
      const out = await writer.close();
      const a = h('a', { href: URL.createObjectURL(out), download: 'photos-to-enhance.zip' });
      document.body.append(a);
      a.click();
      a.remove();
      note.remove();
      toast(`Downloaded ${usable.length} photo${usable.length === 1 ? '' : 's'}. Enlarge them in the app, then drop the results here.`, { timeout: 12000 });
    } catch (err) {
      console.error(err);
      note.remove();
      toast(err.message || 'The photos couldn’t be prepared.', { tone: 'bad' });
    } finally {
      ctx.busy(false);
      exportBtn.disabled = false;
    }
  }

  // ---------------------------------------------------------------- layout

  const input = h('input', { type: 'file', multiple: true, accept: '.zip,application/zip,image/*', 'aria-label': 'Add originals' });
  const drop = h(
    'div',
    { class: 'drop drop-compact' },
    h('h2', {}, 'Drop originals here'),
    h('p', { class: 'muted' }, 'Your Instagram archive (.zip), original photo files, or versions you enlarged in another app. Each is matched to its photo automatically.'),
    input,
  );
  drop.addEventListener('dragover', (e) => (e.preventDefault(), drop.classList.add('is-over')));
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    addSources([...e.dataTransfer.files]);
  });
  input.addEventListener('change', () => {
    addSources([...input.files]);
    input.value = '';
  });

  const radio = (name, value, current, label, hint, onpick) =>
    h(
      'label',
      { class: 'check' },
      h('input', { type: 'radio', name, value, checked: current === value, onchange: () => onpick(value) }),
      h('span', {}, label, hint ? h('small', {}, hint) : null),
    );
  const sizeSelect = h(
    'select',
    {
      'aria-label': 'Size',
      onchange: (e) => {
        st.target = Number(e.target.value);
        st.selected = null;
        paint();
      },
    },
    ...[
      [2560, '2560 px: laptops and most monitors'],
      [3200, '3200 px: large and high-resolution monitors'],
      [4096, '4096 px: 4K screens, slower'],
    ].map(([v, t]) => h('option', { value: String(v), selected: v === st.target ? true : null }, t)),
  );

  // One-time install of the Best quality models, shown until they are on the site.
  const bestHint = h('span', {});
  const modelsPanel = h(
    'div',
    { class: 'panel', id: 'install-best', style: { marginBottom: '28px' } },
    h('h2', {}, 'First, install Best quality (one time)'),
    h(
      'p',
      {},
      'Best quality needs two AI models on your site. Their files are too large for GitHub’s upload page, so this page uploads them for you. Drop ',
      h('b', {}, 'best-quality-models.zip'),
      ' here as it is, without unzipping it. Until then, photos are enhanced with Fast.',
    ),
    installBox(ctx, { title: 'Drop best-quality-models.zip here' }),
  );
  const paintModels = () => {
    const missing = ctx.models?.ready === false;
    modelsPanel.hidden = !missing;
    bestHint.textContent = missing
      ? 'Install it first (above). Until then, photos are enhanced with Fast.'
      : 'Real-ESRGAN full models. Natural detail; about 1–3 minutes a photo on a laptop.';
  };
  const onModels = () => {
    paintModels();
    if (!st.run) paint();
  };
  ctx.models?.addEventListener('change', onModels);
  paintModels();

  startBtn.addEventListener('click', start);
  exportBtn.addEventListener('click', exportForApp);
  const pick = (fn) => () => {
    st.selected = new Set(photos().filter(fn).map((p) => p.id));
    paint();
  };

  root.append(
    h(
      'div',
      { class: 'view-head' },
      h(
        'div',
        {},
        h('h1', {}, 'Improve quality'),
        h('p', {}, 'Re-processes photos already on your site so they stay crisp on large screens. Titles, captions, dates and order stay as they are; only the image is replaced, after you publish.'),
      ),
    ),
    modelsPanel,
    h('div', { class: 'panel' }, summary, h('p', { class: 'muted' }, 'For the best result, add the originals. Instagram photos come back from your archive at their original quality, not the copy on your site.'), drop, sourceNote),
    h(
      'div',
      { class: 'panel section-gap' },
      h('h2', {}, 'How'),
      h(
        'div',
        { class: 'grid2' },
        h(
          'div',
          { class: 'stack' },
          h('span', { class: 'field-label' }, 'Enhancement'),
          radio('iq', 'best', st.quality, 'Best quality', bestHint, (v) => ((st.quality = v), paint())),
          radio('iq', 'fast', st.quality, 'Fast', 'The small model. Seconds a photo, but smooths fine texture.', (v) => ((st.quality = v), paint())),
        ),
        h(
          'div',
          { class: 'stack' },
          h('span', { class: 'field-label' }, 'Finish'),
          radio('if', 'natural', st.finish, 'Natural', 'Restores depth and crispness, with a fine grain.', (v) => ((st.finish = v), paint())),
          radio('if', 'vivid', st.finish, 'Vivid', 'Stronger local contrast and a little more colour.', (v) => ((st.finish = v), paint())),
          radio('if', 'off', st.finish, 'Off', null, (v) => ((st.finish = v), paint())),
        ),
      ),
      h('label', { class: 'field' }, h('span', {}, 'Size'), sizeSelect),
    ),
    runBox,
    h(
      'div',
      { class: 'toolbar section-gap' },
      h('button', { class: 'btn btn-small', type: 'button', onclick: pick(recommended) }, 'Select recommended'),
      h('button', { class: 'btn btn-small', type: 'button', onclick: pick((p) => planFor(p).kind !== 'skip') }, 'Select all'),
      h('button', { class: 'btn btn-small', type: 'button', onclick: pick(() => false) }, 'Select none'),
      h('span', { class: 'grow' }),
      exportBtn,
      startBtn,
    ),
    planLine,
    grid,
    h(
      'details',
      { class: 'help section-gap' },
      h('summary', {}, 'Using a desktop app instead'),
      h(
        'ol',
        {},
        h('li', {}, 'Select the photos, then click ', h('b', {}, 'Download photos for a desktop app'), '. You get a ZIP of them with borders removed, each named after its photo.'),
        h('li', {}, 'Unzip it and enlarge the whole folder in an app such as Upscayl (free, for Windows, Mac and Linux), which runs faster on your graphics card.'),
        h('li', {}, 'Drop the enlarged files in ', h('b', {}, 'Drop originals here'), ' above. They’re matched by name, and are resized and finished for your site without being enlarged again.'),
      ),
    ),
  );

  const onChange = () => {
    if (!st.run) paint();
  };
  store.addEventListener('change', onChange);
  root.cleanup = () => {
    store.removeEventListener('change', onChange);
    ctx.models?.removeEventListener('change', onModels);
    document.removeEventListener('visibilitychange', onVisible);
    if (st.run) {
      st.run.stop = true;
      toast('Improving stopped because you left the page. Finished photos are staged.', { timeout: 9000 });
    }
    for (const a of st.archives) a.close?.();
  };
  paint();
  return root;
}
