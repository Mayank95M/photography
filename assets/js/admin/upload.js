// "Add photos" and "Import from Instagram": prepare photos, process them, upload the files
// to GitHub and stage them for publishing.
import { h, $, toast, field, checkbox, confirmDialog, duration, dateInputValue, fromDateInput } from './ui.js';
import { inspect, render, describeFrame, enhancePlan, newId } from './pipeline.js';
import { blobToBase64, decode, detectBorders, pixels, UnsupportedImageError } from './imaging.js';
import { cropEditor, cropPreview, compareView } from './editor.js';
import { openArchive, splitCaption } from './instagram.js';
import { gpuAvailable, loadModel } from './upscaler.js';

/** Process one photo and stage it. Returns the staged record and render output. */
export async function stagePhoto(ctx, { info, insets, enhance, meta, at = 'start', onProgress, signal }) {
  const settings = ctx.settings();
  const out = await render(info, { insets, enhance, settings, onProgress, signal });
  onProgress?.({ stage: 'upload', fraction: 0 });
  const date = meta.date ? new Date(meta.date) : info.taken || null;
  const id = newId(date || new Date());
  const full = `photos/full/${id}.jpg`;
  const thumb = `photos/thumb/${id}.${out.thumbExt}`;
  const [fullSha, thumbSha] = await Promise.all([
    blobToBase64(out.full).then((b) => ctx.gh.createBlobBase64(b)),
    blobToBase64(out.thumb).then((b) => ctx.gh.createBlobBase64(b)),
  ]);
  const photo = {
    id,
    src: full,
    thumb,
    w: out.w,
    h: out.h,
    tw: out.tw,
    th: out.th,
    title: meta.title || '',
    caption: meta.caption || '',
    location: meta.location || '',
    date: date ? date.toISOString() : null,
    tags: meta.tags || [],
    featured: !!meta.featured,
    hidden: false,
    exif: { ...(info.exif || {}), ...(meta.exif || {}) },
    lqip: out.lqip,
    color: out.color,
    enhanced: out.enhanced,
    source: meta.source || { type: 'upload' },
    added: new Date().toISOString(),
  };
  ctx.store.addPhoto(
    photo,
    [
      { path: full, sha: fullSha },
      { path: thumb, sha: thumbSha },
    ],
    URL.createObjectURL(out.thumb),
    { at },
  );
  onProgress?.({ stage: 'done', fraction: 1 });
  return { photo, out };
}

const parseTags = (s) =>
  [...new Set(String(s || '').split(',').map((t) => t.trim()).filter(Boolean))].map((t) => t[0].toUpperCase() + t.slice(1));

function planText(info, insets, enhance, settings, gpu) {
  const w = Math.round(info.width * (1 - insets.left - insets.right));
  const hh = Math.round(info.height * (1 - insets.top - insets.bottom));
  const long = Math.max(w, hh);
  const plan = enhance ? enhancePlan(w, hh, settings) : null;
  if (plan && gpu) return `Will be enhanced from ${plan.from} px to ${plan.to} px on the long edge.`;
  if (plan && !gpu) return `${long} px on the long edge. This browser can't run the enhancement (no WebGL), so it will be published as is.`;
  if (long > (settings.longEdge || 2560)) return `Will be resized to ${settings.longEdge || 2560} px on the long edge.`;
  return `Published at ${long} px on the long edge.`;
}

// ====================================================================== Add photos

export function addView(ctx) {
  const settings = ctx.settings();
  const opts = { removeBorders: settings.removeBorders !== false, enhance: settings.enhance !== false };
  const queue = [];
  let gpu = true;
  gpuAvailable().then((v) => (gpu = v));
  const list = h('div', { class: 'queue' });
  const actions = h('div', { class: 'row section-gap', hidden: true });
  const addBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Add to gallery');
  const clearBtn = h('button', { class: 'btn', type: 'button' }, 'Clear list');
  actions.append(addBtn, clearBtn, h('span', { class: 'muted' }, 'Photos are uploaded to GitHub as they finish, then published together.'));

  const input = h('input', { type: 'file', accept: 'image/*', multiple: true, 'aria-label': 'Choose photos' });
  const drop = h(
    'div',
    { class: 'drop' },
    h('h2', {}, 'Drop photos here'),
    h('p', { class: 'muted' }, 'or click to choose files. JPEG, PNG and WebP work everywhere; HEIC only in Safari.'),
    input,
  );
  const dragOn = (e) => {
    e.preventDefault();
    drop.classList.add('is-over');
  };
  drop.addEventListener('dragover', dragOn);
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    take([...e.dataTransfer.files]);
  });
  input.addEventListener('change', () => {
    take([...input.files]);
    input.value = '';
  });

  async function take(files) {
    const images = files.filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
    if (!images.length) {
      toast('Those files are not photos. Choose JPEG, PNG or WebP images.', { tone: 'bad' });
      return;
    }
    for (const file of images) {
      const item = { file, status: 'Reading…', meta: { title: '', location: '', tags: [], featured: false } };
      queue.push(item);
      item.el = h('div', { class: 'item' }, h('div', { class: 'item-preview' }), h('div', { class: 'item-body' }, h('div', { class: 'item-head' }, h('span', { class: 'item-name' }, file.name), h('span', { class: 'status' }, 'Reading…'))));
      list.append(item.el);
    }
    actions.hidden = false;
    for (const item of queue.filter((q) => !q.info && !q.error)) {
      try {
        item.info = await inspect(item.file);
        item.insets = opts.removeBorders && item.info.frame.confidence !== 'low' ? { ...item.info.insets } : { top: 0, right: 0, bottom: 0, left: 0 };
        item.enhance = opts.enhance;
        item.meta.date = item.info.taken ? item.info.taken.toISOString() : null;
        item.meta.title = item.file.name.replace(/\.[^.]+$/, '').replace(/^(IMG|DSC|DSCF|DSC_|PXL|P)[-_]?\d+.*$/i, '').replace(/[_-]+/g, ' ').trim();
      } catch (err) {
        item.error = err instanceof UnsupportedImageError ? err.message : `${item.file.name} couldn't be read.`;
      }
      renderItem(item);
    }
  }

  function renderItem(item) {
    const body = h('div', { class: 'item-body' });
    const preview = h('div', { class: 'item-preview' });
    const status = h('span', { class: 'status' });
    body.append(h('div', { class: 'item-head' }, h('span', { class: 'item-name' }, item.file.name), status));
    if (item.error) {
      status.textContent = item.error;
      status.className = 'status bad';
      body.append(h('div', { class: 'row' }, h('button', { class: 'btn btn-small', type: 'button', onclick: () => removeItem(item) }, 'Remove')));
      item.el.replaceChildren(preview, body);
      return;
    }
    const { info } = item;
    preview.append(cropPreview(info.bitmap, item.insets, 360));
    const f = describeFrame(info.frame);
    const trimmed = item.insets.top + item.insets.bottom + item.insets.left + item.insets.right > 0;
    status.textContent = trimmed ? `${f.text}, trimmed` : f.text;
    status.className = `status ${trimmed ? 'ok' : f.tone === 'check' ? 'check' : ''}`;
    const plan = h('p', { class: 'muted' }, planText(info, item.insets, item.enhance, ctx.settings(), gpu));
    const m = item.meta;
    const set = (k) => (e) => {
      m[k] = e.target.value;
    };
    body.append(
      plan,
      h(
        'div',
        { class: 'grid2' },
        field('Title', h('input', { class: 'input', value: m.title, oninput: set('title'), placeholder: 'Untitled' })),
        field('Place', h('input', { class: 'input', value: m.location, oninput: set('location'), placeholder: 'Where it was taken' })),
        field('Date taken', h('input', { class: 'input', type: 'date', value: dateInputValue(m.date), oninput: (e) => (m.date = fromDateInput(e.target.value)) })),
        field('Tags', h('input', { class: 'input', value: m.tags.join(', '), oninput: (e) => (m.tags = parseTags(e.target.value)), placeholder: 'Mountains, Street' }), 'Separate with commas. Tags become filters on the site.'),
      ),
      h(
        'div',
        { class: 'row' },
        checkbox('Featured', m.featured, (v) => (m.featured = v)),
        checkbox('Enhance resolution', item.enhance, (v) => {
          item.enhance = v;
          plan.textContent = planText(info, item.insets, item.enhance, ctx.settings(), gpu);
        }),
      ),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'btn btn-small',
            type: 'button',
            onclick: async () => {
              const next = await cropEditor({ bitmap: info.bitmap, insets: item.insets });
              if (next) {
                item.insets = next;
                renderItem(item);
              }
            },
          },
          'Adjust crop',
        ),
        h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: () => removeItem(item) }, 'Remove from list'),
      ),
    );
    item.el.replaceChildren(preview, body);
  }

  function removeItem(item) {
    item.info?.bitmap?.close?.();
    item.el.remove();
    queue.splice(queue.indexOf(item), 1);
    if (!queue.length) actions.hidden = true;
  }

  clearBtn.addEventListener('click', () => {
    for (const item of [...queue]) if (!item.busy) removeItem(item);
  });

  addBtn.addEventListener('click', async () => {
    const todo = queue.filter((q) => q.info && !q.done && !q.busy);
    if (!todo.length) return;
    addBtn.disabled = clearBtn.disabled = true;
    ctx.busy(true);
    let added = 0;
    if (todo.some((q) => q.enhance) && gpu) {
      try {
        await loadModel();
      } catch {
        toast('The enhancement model could not be loaded, so photos will be added without it.', { tone: 'bad' });
        todo.forEach((q) => (q.enhance = false));
      }
    }
    for (const item of todo) {
      item.busy = true;
      const status = $('.status', item.el);
      const bar = h('div', { class: 'progress' }, h('i'));
      item.el.querySelector('.item-body').append(bar);
      item.el.querySelectorAll('input, button').forEach((n) => (n.disabled = true));
      try {
        const { photo, out } = await stagePhoto(ctx, {
          info: item.info,
          insets: item.insets,
          enhance: item.enhance,
          meta: item.meta,
          onProgress: ({ stage, fraction }) => {
            status.className = 'status';
            status.textContent = stage === 'enhance' ? `Enhancing… ${Math.round(fraction * 100)}%` : stage === 'upload' ? 'Uploading…' : 'Saving…';
            bar.firstChild.style.width = `${stage === 'enhance' ? fraction * 80 : stage === 'upload' ? 90 : 85}%`;
          },
        });
        item.done = true;
        added++;
        bar.remove();
        status.className = 'status ok';
        status.textContent = 'Added to the gallery. Publish to put it on the site.';
        if (out.enhanced) {
          const before = item.info.bitmap;
          const ins = item.insets;
          item.el.querySelector('.item-body').append(
            h(
              'div',
              { class: 'row' },
              h(
                'button',
                {
                  class: 'btn btn-small',
                  type: 'button',
                  onclick: async () => {
                    const after = await decode(out.full);
                    const sx = Math.round(ins.left * before.width);
                    const sy = Math.round(ins.top * before.height);
                    const sw = Math.round(before.width * (1 - ins.left - ins.right));
                    const sh = Math.round(before.height * (1 - ins.top - ins.bottom));
                    const crop = await createImageBitmap(before, sx, sy, sw, sh);
                    compareView({ before: crop, after, title: photo.title || 'Before and after' });
                  },
                },
                'Compare before and after',
              ),
            ),
          );
        }
      } catch (err) {
        console.error(err);
        item.busy = false;
        status.className = 'status bad';
        status.textContent = err.message || 'This photo could not be added.';
        bar.remove();
        item.el.querySelectorAll('input, button').forEach((n) => (n.disabled = false));
        continue;
      }
      item.busy = false;
    }
    ctx.busy(false);
    addBtn.disabled = clearBtn.disabled = false;
    if (added) {
      toast(`${added} photo${added === 1 ? '' : 's'} added. Publish to put ${added === 1 ? 'it' : 'them'} on the site.`, {
        action: { label: 'Publish now', run: () => ctx.publish() },
        timeout: 10000,
      });
    }
  });

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'view-head' },
      h(
        'div',
        {},
        h('h1', {}, 'Add photos'),
        h('p', {}, 'Borders are found and trimmed automatically, and small photos are enhanced with AI before upload. You can check and adjust each one first.'),
      ),
    ),
    h(
      'div',
      { class: 'row', style: { marginBottom: '16px', gap: '24px' } },
      checkbox('Remove borders automatically', opts.removeBorders, (v) => (opts.removeBorders = v)),
      checkbox('Enhance small photos with AI', opts.enhance, (v) => (opts.enhance = v)),
    ),
    drop,
    h('div', { class: 'section-gap' }, list),
    actions,
  );
}

// ====================================================================== Instagram

export function instagramView(ctx) {
  const root = h('div', {});
  const state = { step: 'intro', archive: null, items: [], running: false, stop: false, paused: false };
  const opts = {
    removeBorders: ctx.settings().removeBorders !== false,
    enhance: ctx.settings().enhance !== false,
    titles: true,
    keepHashtags: false,
    archived: true,
    sort: true,
    publish: true,
  };
  const existingKeys = () => new Set(ctx.store.photos.map((p) => p.source?.type === 'instagram' && p.source.key).filter(Boolean));

  const paint = () => {
    root.replaceChildren(head(), state.step === 'intro' ? intro() : state.step === 'review' ? review() : state.step === 'run' ? run() : done());
  };

  const head = () =>
    h(
      'div',
      { class: 'view-head' },
      h(
        'div',
        {},
        h('h1', {}, 'Import from Instagram'),
        h('p', {}, 'Bring in your posts from the archive Instagram lets you download. No need to save or edit photos one by one: borders are trimmed and resolution enhanced as they come in.'),
      ),
    );

  function intro() {
    const input = h('input', { type: 'file', accept: '.zip,application/zip', multiple: true, 'aria-label': 'Choose your Instagram archive' });
    const drop = h('div', { class: 'drop' }, h('h2', {}, 'Drop your Instagram archive here'), h('p', { class: 'muted' }, 'The ZIP file (or all of its parts, if Instagram split it).'), input);
    const status = h('p', { class: 'muted', 'aria-live': 'polite' });
    const open = async (files) => {
      const zips = files.filter((f) => /\.zip$/i.test(f.name) || f.type.includes('zip'));
      if (!zips.length) {
        status.textContent = 'Choose the .zip file Instagram emailed you.';
        return;
      }
      try {
        status.textContent = 'Opening the archive…';
        state.archive = await openArchive(zips, (s) => (status.textContent = s));
        const have = existingKeys();
        state.items = state.archive.items.map((it) => ({ ...it, on: !it.heic && !have.has(it.key) && (opts.archived || !it.archived), already: have.has(it.key) }));
        state.step = 'review';
        paint();
        detectAll();
      } catch (err) {
        console.error(err);
        status.textContent = err.message || 'This archive could not be read.';
        status.className = 'error';
      }
    };
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('is-over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
      open([...e.dataTransfer.files]);
    });
    input.addEventListener('change', () => open([...input.files]));
    return h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'panel' },
        h('h2', {}, 'Get your archive from Instagram'),
        h(
          'ol',
          { class: 'steps' },
          h('li', {}, 'In the Instagram app or on instagram.com, open ', h('b', {}, 'Settings → Accounts Center → Your information and permissions → Export your information'), '.'),
          h('li', {}, 'Choose ', h('b', {}, 'Create export'), ', pick your Instagram account, then ', h('b', {}, 'Export to device'), '.'),
          h('li', {}, 'Under ', h('b', {}, 'Customise information'), ', clear everything except ', h('b', {}, 'Posts'), ' (keeping only posts makes the file much smaller).'),
          h('li', {}, 'Set ', h('b', {}, 'Date range'), ' to ', h('b', {}, 'All time'), ', ', h('b', {}, 'Format'), ' to ', h('b', {}, 'JSON'), ' and ', h('b', {}, 'Media quality'), ' to ', h('b', {}, 'High'), ', then start the export.'),
          h('li', {}, 'Instagram emails you when it is ready, usually within an hour. Download the ZIP and drop it below without unzipping it.'),
        ),
      ),
      drop,
      status,
    );
  }

  // Look for borders on every photo in the background so the review shows what will happen.
  async function detectAll() {
    for (const it of state.items) {
      if (state.step !== 'review') return;
      if (it.frame || it.heic) continue;
      try {
        const file = await state.archive.load(it);
        const bmp = await decode(file);
        const { imageData } = pixels(bmp, 900);
        const f = detectBorders(imageData);
        it.w = bmp.width;
        it.h = bmp.height;
        it.frame = f;
        it.insets =
          f.kind === 'none'
            ? { top: 0, right: 0, bottom: 0, left: 0 }
            : { top: f.top / imageData.height, right: f.right / imageData.width, bottom: f.bottom / imageData.height, left: f.left / imageData.width };
        // A small preview keeps memory low with hundreds of photos.
        const small = cropPreview(bmp, opts.removeBorders && f.confidence !== 'low' ? it.insets : null, 320);
        bmp.close?.();
        const blob = await new Promise((r) => small.toBlob(r, 'image/jpeg', 0.8));
        it.url = URL.createObjectURL(blob);
        if (it.img) it.img.src = it.url;
        it.badge?.replaceChildren(...badgeFor(it));
        it.adjustBtn && (it.adjustBtn.hidden = f.kind === 'none');
      } catch {
        it.frame = { kind: 'none', confidence: 'none' };
      }
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const badgeFor = (it) => {
    const out = [];
    if (it.already) out.push(h('span', { class: 'tag' }, 'On the site'));
    if (it.heic) out.push(h('span', { class: 'tag' }, 'HEIC, skipped'));
    if (it.adjusted) out.push(h('span', { class: 'tag' }, 'Crop set'));
    else if (it.frame && it.frame.kind !== 'none') out.push(h('span', { class: 'tag' }, it.frame.confidence === 'low' ? 'Check border' : 'Border'));
    if (it.count > 1) out.push(h('span', { class: 'tag' }, `${it.index + 1} of ${it.count}`));
    return out;
  };

  function review() {
    const items = state.items;
    const count = h('strong');
    const startBtn = h('button', { class: 'btn btn-primary', type: 'button' });
    const update = () => {
      const n = items.filter((i) => i.on).length;
      count.textContent = `${n} selected`;
      startBtn.textContent = `Import ${n} photo${n === 1 ? '' : 's'}`;
      startBtn.disabled = !n;
    };
    const years = [...new Set(items.map((i) => i.date?.getUTCFullYear()).filter(Boolean))].sort((a, b) => b - a);
    const grid = h('div', { class: 'ig-grid' });
    for (const it of items) {
      const box = h('input', { type: 'checkbox', checked: it.on, 'aria-label': 'Include this photo', disabled: it.heic });
      it.badge = h('div', { class: 'tags' }, ...badgeFor(it));
      it.img = h('img', { alt: '', src: it.url || null });
      it.adjustBtn = h('button', { class: 'btn btn-small', type: 'button', hidden: !it.frame || it.frame.kind === 'none' }, 'Adjust crop');
      it.adjustBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const file = await state.archive.load(it);
        const bmp = await decode(file);
        const next = await cropEditor({ bitmap: bmp, insets: it.insets || { top: 0, right: 0, bottom: 0, left: 0 } });
        if (next) {
          it.insets = next;
          it.adjusted = true;
          const small = cropPreview(bmp, next, 320);
          small.toBlob((b) => {
            if (it.url) URL.revokeObjectURL(it.url);
            it.url = URL.createObjectURL(b);
            it.img.src = it.url;
          }, 'image/jpeg', 0.8);
          it.badge.replaceChildren(...badgeFor(it));
        }
        bmp.close?.();
      });
      const card = h(
        'div',
        { class: `ig-card${it.on ? ' is-on' : ''}` },
        h('div', { class: 'card-img' }, it.img, it.badge),
        box,
        h('span', {}, it.date ? it.date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'No date'),
        it.caption ? h('span', { class: 'caption' }, it.caption) : null,
        it.adjustBtn,
      );
      const toggle = (v) => {
        it.on = v;
        box.checked = v;
        card.classList.toggle('is-on', v);
        update();
      };
      box.addEventListener('change', () => toggle(box.checked));
      card.addEventListener('click', (e) => {
        if (e.target === box || it.heic || e.target.closest('button')) return;
        toggle(!it.on);
      });
      it.toggle = toggle;
      grid.append(card);
    }
    const setAll = (fn) => items.forEach((i) => !i.heic && i.toggle(fn(i)));
    startBtn.addEventListener('click', () => startImport());
    update();
    const s = state.archive.stats;
    return h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'panel' },
        h(
          'p',
          {},
          `Found ${s.photos} photo${s.photos === 1 ? '' : 's'}${s.posts ? ` in ${s.posts} posts` : ''}.`,
          s.videos ? ` ${s.videos} video${s.videos === 1 ? ' was' : 's were'} skipped.` : '',
          items.some((i) => i.already) ? ` Photos already on your site are not selected.` : '',
        ),
        h(
          'div',
          { class: 'grid2' },
          checkbox('Remove borders', opts.removeBorders, (v) => (opts.removeBorders = v), 'Trims the frames you added for Instagram.'),
          checkbox('Enhance resolution with AI', opts.enhance, (v) => (opts.enhance = v), 'Slower: roughly 10 to 30 seconds a photo on a laptop.'),
          checkbox('Use the first line of each caption as the title', opts.titles, (v) => (opts.titles = v)),
          checkbox('Keep hashtags in captions', opts.keepHashtags, (v) => (opts.keepHashtags = v)),
          checkbox('Order all photos by date taken, newest first', opts.sort, (v) => (opts.sort = v)),
          checkbox('Publish when the import finishes', opts.publish, (v) => (opts.publish = v)),
        ),
      ),
      h(
        'div',
        { class: 'toolbar' },
        count,
        h('button', { class: 'btn btn-small', type: 'button', onclick: () => setAll((i) => !i.already) }, 'Select all'),
        h('button', { class: 'btn btn-small', type: 'button', onclick: () => setAll(() => false) }, 'Select none'),
        years.length > 1
          ? h(
              'select',
              {
                class: 'input',
                style: { width: 'auto' },
                'aria-label': 'Select a year',
                onchange: (e) => {
                  const y = Number(e.target.value);
                  if (y) setAll((i) => i.date?.getUTCFullYear() === y && !i.already);
                },
              },
              h('option', { value: '' }, 'Select a year…'),
              ...years.map((y) => h('option', { value: String(y) }, String(y))),
            )
          : null,
        h('span', { class: 'grow' }),
        h('button', { class: 'btn', type: 'button', onclick: () => ((state.step = 'intro'), state.archive?.close(), paint()) }, 'Choose another archive'),
        startBtn,
      ),
      grid,
    );
  }

  async function startImport() {
    const picked = state.items.filter((i) => i.on && !i.heic);
    if (!picked.length) return;
    if (opts.enhance && picked.length > 40) {
      const ok = await confirmDialog({
        title: `Enhance all ${picked.length} photos?`,
        body: `Enhancing takes about 10 to 30 seconds per photo, so this could take ${duration(picked.length * 20)}. Keep this tab open while it runs. You can also import without enhancing and enhance favourites later from the Photos page.`,
        confirm: 'Import and enhance',
      });
      if (!ok) return;
    }
    state.step = 'run';
    state.queue = picked;
    state.doneCount = 0;
    state.failed = [];
    state.started = performance.now();
    state.stop = false;
    state.paused = false;
    paint();
    ctx.busy(true);
    if (opts.enhance && (await gpuAvailable())) {
      try {
        await loadModel();
      } catch {
        opts.enhance = false;
        toast('The enhancement model could not be loaded; importing without it.', { tone: 'bad' });
      }
    }
    for (const it of picked) {
      while (state.paused && !state.stop) await new Promise((r) => setTimeout(r, 300));
      if (state.stop) break;
      state.current = it;
      refreshRun();
      try {
        const file = await state.archive.load(it);
        state.currentUrl = it.url || '';
        refreshRun();
        const info = await inspect(file);
        const zero = { top: 0, right: 0, bottom: 0, left: 0 };
        let insets = zero;
        if (opts.removeBorders) insets = it.adjusted ? it.insets : info.frame.confidence === 'low' ? zero : info.insets;
        const text = splitCaption(it.caption, { keepHashtags: opts.keepHashtags });
        const meta = {
          title: opts.titles ? text.title : '',
          caption: opts.titles ? text.caption : [text.title, text.caption].filter(Boolean).join('\n'),
          date: it.date ? it.date.toISOString() : null,
          exif: it.exif,
          source: { type: 'instagram', key: it.key },
          tags: [],
        };
        await stagePhoto(ctx, {
          info,
          insets,
          enhance: opts.enhance,
          meta,
          at: 'end',
          onProgress: ({ stage, fraction }) => {
            state.stage = stage === 'enhance' ? `Enhancing ${Math.round(fraction * 100)}%` : stage === 'upload' ? 'Uploading' : 'Saving';
            refreshRun(false);
          },
        });
        info.bitmap.close?.();
        state.doneCount++;
      } catch (err) {
        console.error(err);
        state.failed.push({ it, message: err.message });
      }
      refreshRun();
    }
    ctx.busy(false);
    if (opts.sort && state.doneCount) ctx.store.sortByDate();
    state.step = 'done';
    paint();
    if (opts.publish && state.doneCount && !state.stop) ctx.publish({ skipConfirm: true });
  }

  let runEls = null;
  function run() {
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
      state.paused = !state.paused;
      runEls.pause.textContent = state.paused ? 'Resume' : 'Pause';
    });
    runEls.stop.addEventListener('click', async () => {
      if (await confirmDialog({ title: 'Stop importing?', body: 'Photos already imported stay staged, ready to publish.', confirm: 'Stop', danger: true })) {
        state.stop = true;
        state.paused = false;
      }
    });
    refreshRun();
    return h(
      'div',
      { class: 'import-run panel' },
      h('div', { class: 'now' }, runEls.img),
      h(
        'div',
        { class: 'stack' },
        runEls.title,
        runEls.line,
        h('div', { class: 'progress big-progress' }, runEls.bar),
        runEls.eta,
        h('p', {}, 'Keep this tab open. Each photo is uploaded as soon as it is ready, so nothing is lost if you stop.'),
        h('div', { class: 'row' }, runEls.pause, runEls.stop),
      ),
    );
  }

  function refreshRun(full = true) {
    if (!runEls) return;
    const total = state.queue.length;
    const doneN = state.doneCount + state.failed.length;
    runEls.title.textContent = `Importing ${Math.min(doneN + 1, total)} of ${total}`;
    runEls.bar.style.width = `${(doneN / total) * 100}%`;
    if (full && state.currentUrl && runEls.img.src !== state.currentUrl) runEls.img.src = state.currentUrl;
    const it = state.current;
    runEls.line.textContent = it ? [it.date ? it.date.toLocaleDateString(undefined, { year: 'numeric', month: 'long' }) : '', state.stage || ''].filter(Boolean).join(': ') : '';
    const elapsed = (performance.now() - state.started) / 1000;
    if (doneN >= 2) runEls.eta.textContent = `About ${duration((elapsed / doneN) * (total - doneN))} left.`;
  }

  function done() {
    runEls = null;
    const failed = state.failed || [];
    return h(
      'div',
      { class: 'panel' },
      h('h2', {}, state.doneCount ? `${state.doneCount} photo${state.doneCount === 1 ? '' : 's'} imported` : 'Nothing was imported'),
      h('p', {}, opts.publish && state.doneCount && !state.stop ? 'Publishing them now.' : 'They are staged. Publish to put them on the site.'),
      failed.length ? h('p', { class: 'error' }, `${failed.length} could not be imported: ${failed.slice(0, 3).map((f) => f.message).join('; ')}${failed.length > 3 ? '…' : ''}`) : null,
      h(
        'div',
        { class: 'row' },
        h('a', { class: 'btn btn-primary', href: '#photos' }, 'Review photos'),
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: () => {
              const have = existingKeys();
              for (const it of state.items) {
                it.already = have.has(it.key);
                if (it.already) it.on = false;
              }
              state.step = 'review';
              paint();
              detectAll();
            },
          },
          'Back to the archive',
        ),
      ),
    );
  }

  paint();
  return root;
}
