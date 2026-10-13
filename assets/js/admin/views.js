// Photos, About page and Settings screens.
import { h, $, toast, field, checkbox, confirmDialog, debounce, batch, shortDate, dateInputValue, fromDateInput } from './ui.js';
import { decode, blobToBase64, crop as cropCanvas, resize, fitWithin, encode, cropRect } from './imaging.js';
import { render, enhancePlan, inspect, newId } from './pipeline.js';
import { cropEditor, compareView } from './editor.js';
import { gpuAvailable, loadModel } from './upscaler.js';

const parseTags = (s) =>
  [...new Set(String(s || '').split(',').map((t) => t.trim()).filter(Boolean))].map((t) => t[0].toUpperCase() + t.slice(1));

function thumbUrl(ctx, p) {
  return ctx.store.previews.get(p.id) || new URL(p.thumb, ctx.siteUrl).href;
}

// ====================================================================== Photos

export function photosView(ctx) {
  const { store } = ctx;
  const root = h('div', {});
  const ui = { query: '', selecting: false, selected: new Set() };

  const paint = () => {
    const photos = store.photos;
    const q = ui.query.trim().toLowerCase();
    const shown = q ? photos.filter((p) => [p.title, p.caption, p.location, ...(p.tags || [])].join(' ').toLowerCase().includes(q)) : photos;
    const pending = store.pending;
    const head = h(
      'div',
      { class: 'view-head' },
      h(
        'div',
        {},
        h('h1', {}, 'Photographs'),
        h('p', {}, `${photos.length} on the site${pending ? `, with ${pending} change${pending === 1 ? '' : 's'} waiting to be published` : ''}. Drag to change the order; click a photo to edit it.`),
      ),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: '#add' }, 'Add photos'), h('a', { class: 'btn', href: '#instagram' }, 'Import from Instagram')),
    );
    if (!photos.length) {
      root.replaceChildren(
        head,
        h(
          'div',
          { class: 'empty' },
          h('h2', {}, 'No photographs yet'),
          h('p', { class: 'muted' }, 'Import your Instagram posts in one go, or add photos from your computer or phone.'),
          h('div', { class: 'row' }, h('a', { class: 'btn btn-primary', href: '#instagram' }, 'Import from Instagram'), h('a', { class: 'btn', href: '#add' }, 'Add photos')),
        ),
      );
      return;
    }
    const search = h('input', {
      class: 'input search',
      type: 'search',
      placeholder: 'Search titles, places, tags',
      value: ui.query,
      'aria-label': 'Search photographs',
      oninput: debounce((e) => {
        ui.query = e.target.value;
        paint();
        $('.search', root)?.focus();
      }, 250),
    });
    const tools = h('div', { class: 'toolbar' }, search, h('span', { class: 'grow' }));
    if (ui.selecting) {
      const n = ui.selected.size;
      const ids = [...ui.selected];
      tools.append(
        h('span', { class: 'muted' }, `${n} selected`),
        h('button', { class: 'btn btn-small', type: 'button', disabled: !n, onclick: () => (ids.forEach((id) => store.editPhoto(id, { featured: true })), toast('Marked as featured.')) }, 'Feature'),
        h('button', { class: 'btn btn-small', type: 'button', disabled: !n, onclick: () => ids.forEach((id) => store.editPhoto(id, { featured: false })) }, 'Unfeature'),
        h('button', { class: 'btn btn-small', type: 'button', disabled: !n, onclick: () => ids.forEach((id) => store.editPhoto(id, { hidden: true })) }, 'Hide'),
        h('button', { class: 'btn btn-small', type: 'button', disabled: !n, onclick: () => ids.forEach((id) => store.editPhoto(id, { hidden: false })) }, 'Show'),
        h(
          'button',
          {
            class: 'btn btn-small btn-danger',
            type: 'button',
            disabled: !n,
            onclick: async () => {
              if (await confirmDialog({ title: `Delete ${n} photo${n === 1 ? '' : 's'}?`, body: 'They are removed from the site when you publish.', confirm: 'Delete', danger: true })) {
                store.deletePhotos(ids);
                ui.selected.clear();
              }
            },
          },
          'Delete',
        ),
        h('button', { class: 'btn btn-small', type: 'button', onclick: () => ((ui.selecting = false), ui.selected.clear(), paint()) }, 'Done'),
      );
    } else {
      tools.append(
        h('button', { class: 'btn btn-small', type: 'button', onclick: () => ((ui.selecting = true), paint()) }, 'Select'),
        h('button', { class: 'btn btn-small', type: 'button', onclick: () => (store.sortByDate(), toast('Ordered by date taken, newest first. Publish to apply.')) }, 'Sort by date'),
      );
    }
    const grid = h('div', { class: 'cards' });
    for (const p of shown) grid.append(card(p));
    root.replaceChildren(head, tools, grid);
  };

  function card(p) {
    const img = h('img', { src: thumbUrl(ctx, p), alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => {
      if (p.lqip && img.src !== p.lqip) img.src = p.lqip;
    });
    const tags = h('div', { class: 'tags' });
    if (store.isNew(p.id)) tags.append(h('span', { class: 'tag tag-new' }, 'New'));
    else if (store.isEdited(p.id)) tags.append(h('span', { class: 'tag' }, 'Edited'));
    if (p.featured) tags.append(h('span', { class: 'tag' }, 'Featured'));
    if (p.hidden) tags.append(h('span', { class: 'tag' }, 'Hidden'));
    const sel = ui.selected.has(p.id);
    const el = h(
      'div',
      { class: `card${sel ? ' is-selected' : ''}`, role: 'button', tabindex: '0', draggable: ui.selecting ? 'false' : 'true', 'data-id': p.id, 'aria-label': `${p.title || 'Untitled'}${ui.selecting ? (sel ? ', selected' : '') : ', edit'}` },
      h('div', { class: 'card-img' }, img, tags, ui.selecting ? h('input', { class: 'card-check', type: 'checkbox', checked: sel, tabindex: '-1', 'aria-hidden': 'true' }) : null),
      h('span', { class: 'card-title' }, p.title || 'Untitled'),
      h('span', { class: 'card-meta' }, [p.location, shortDate(p.date)].filter(Boolean).join(', ') || '\u00a0'),
    );
    const activate = () => {
      if (ui.selecting) {
        if (ui.selected.has(p.id)) ui.selected.delete(p.id);
        else ui.selected.add(p.id);
        paint();
        $(`.card[data-id="${CSS.escape(p.id)}"]`, root)?.focus();
      } else editPhoto(ctx, p.id);
    };
    el.addEventListener('click', activate);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
    // Drag to reorder
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', p.id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('is-dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('is-dragging'));
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.classList.add('is-drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('is-drop-target'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('is-drop-target');
      const id = e.dataTransfer.getData('text/plain');
      if (!id || id === p.id) return;
      const ids = store.photos.map((q) => q.id).filter((x) => x !== id);
      ids.splice(ids.indexOf(p.id), 0, id);
      store.reorder(ids);
    });
    return el;
  }

  const onChange = () => paint();
  store.addEventListener('change', onChange);
  root.cleanup = () => store.removeEventListener('change', onChange);
  paint();
  return root;
}

function editPhoto(ctx, id) {
  const { store } = ctx;
  const p = store.photos.find((q) => q.id === id);
  if (!p) return;
  const last = document.activeElement;
  const save = batch((fields) => store.editPhoto(id, fields), 300);
  const exif = { ...(p.exif || {}) };
  const set = (k, transform = (v) => v) => (e) => save({ [k]: transform(e.target.value) });
  const setExif = (k, transform = (v) => v) => (e) => {
    exif[k] = transform(e.target.value);
    save({ exif: { [k]: exif[k] } });
  };
  const allTags = [...new Set(store.photos.flatMap((q) => q.tags || []))];
  const listId = 'tag-suggestions';
  const preview = h('img', { src: thumbUrl(ctx, p), alt: '' });
  preview.addEventListener('error', () => {
    if (p.lqip && preview.src !== p.lqip) preview.src = p.lqip;
  });

  const moveTo = (where) => {
    const ids = store.photos.map((q) => q.id).filter((x) => x !== id);
    if (where === 'start') ids.unshift(id);
    else ids.push(id);
    store.reorder(ids);
    toast(where === 'start' ? 'Moved to the front.' : 'Moved to the end.');
  };
  const long = Math.max(p.w, p.h);
  const plan = enhancePlan(p.w, p.h, ctx.settings());
  const fixBtn = h('button', { class: 'btn btn-small', type: 'button' }, plan ? 'Crop or enhance…' : 'Adjust crop…');
  fixBtn.addEventListener('click', () => reprocess(ctx, p, close));

  const body = h(
    'div',
    { class: 'drawer-body' },
    h('div', { class: 'drawer-preview' }, preview),
    h('p', { class: 'muted' }, `${p.w} × ${p.h} px${p.enhanced ? ', enhanced' : ''}${plan ? `. Small for large screens: enhancing would take it to ${plan.to} px.` : '.'}`),
    h(
      'div',
      { class: 'row' },
      fixBtn,
      h('button', { class: 'btn btn-small', type: 'button', onclick: () => moveTo('start') }, 'Move to the front'),
      h('button', { class: 'btn btn-small', type: 'button', onclick: () => moveTo('end') }, 'Move to the end'),
    ),
    field('Title', h('input', { class: 'input', value: p.title || '', oninput: set('title'), placeholder: 'Untitled' })),
    field('Caption', h('textarea', { oninput: set('caption') }, p.caption || ''), 'Shown in the viewer, under the title.'),
    h(
      'div',
      { class: 'grid2' },
      field('Place', h('input', { class: 'input', value: p.location || '', oninput: set('location') })),
      field('Date taken', h('input', { class: 'input', type: 'date', value: dateInputValue(p.date), oninput: set('date', fromDateInput) })),
    ),
    field('Tags', h('input', { class: 'input', value: (p.tags || []).join(', '), list: listId, oninput: set('tags', parseTags) }), 'Separate with commas. The most used tags become filters on the site.'),
    h('datalist', { id: listId }, ...allTags.map((t) => h('option', { value: t }))),
    checkbox('Featured', !!p.featured, (v) => store.editPhoto(id, { featured: v }), 'Shown in the slideshow at the top of the home page, and circled on the contact sheet.'),
    checkbox('Hidden', !!p.hidden, (v) => store.editPhoto(id, { hidden: v }), 'Kept in your repository but not shown on the site.'),
    h(
      'details',
      { class: 'details' },
      h('summary', {}, 'Camera details'),
      h(
        'div',
        { class: 'grid2', style: { marginTop: '12px' } },
        field('Camera', h('input', { class: 'input', value: exif.camera || '', oninput: setExif('camera') })),
        field('Lens', h('input', { class: 'input', value: exif.lens || '', oninput: setExif('lens') })),
        field('Focal length (mm)', h('input', { class: 'input', inputmode: 'decimal', value: exif.focal || '', oninput: setExif('focal', (v) => (v ? Number(v) || v : '')) })),
        field('Aperture (ƒ/)', h('input', { class: 'input', inputmode: 'decimal', value: exif.aperture || '', oninput: setExif('aperture') })),
        field('Shutter (s)', h('input', { class: 'input', value: exif.shutter || '', oninput: setExif('shutter'), placeholder: '1/250' })),
        field('ISO', h('input', { class: 'input', inputmode: 'numeric', value: exif.iso || '', oninput: setExif('iso', (v) => (v ? Number(v) || v : '')) })),
      ),
    ),
    h('p', { class: 'muted' }, `Long edge ${long} px. Added ${shortDate(p.added) || 'earlier'}.`),
  );
  const back = h('div', { class: 'drawer-back' });
  const drawer = h(
    'aside',
    { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Edit photograph' },
    h('div', { class: 'drawer-head' }, h('h2', {}, 'Edit photograph'), h('button', { class: 'btn btn-small', type: 'button', onclick: () => close() }, 'Close')),
    body,
    h(
      'div',
      { class: 'drawer-foot' },
      h(
        'button',
        {
          class: 'btn btn-danger',
          type: 'button',
          onclick: async () => {
            if (await confirmDialog({ title: 'Delete this photo?', body: 'It is removed from the site when you publish.', confirm: 'Delete', danger: true })) {
              store.deletePhotos([id]);
              close();
            }
          },
        },
        'Delete',
      ),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => close() }, 'Done'),
    ),
  );
  function close() {
    save.flush?.();
    back.remove();
    drawer.remove();
    removeEventListener('keydown', onKey);
    last?.focus?.();
  }
  const onKey = (e) => {
    if (e.key === 'Escape' && !$('.modal-back')) close();
  };
  addEventListener('keydown', onKey);
  back.addEventListener('click', close);
  document.body.append(back, drawer);
  $('input', body)?.focus();
}

/** Re-crop and/or enhance a photo that is already on the site. */
async function reprocess(ctx, p, closeDrawer) {
  const url = ctx.store.previews.get(p.id) && ctx.store.isNew(p.id) ? null : new URL(p.src, ctx.siteUrl).href;
  if (!url) {
    toast('Publish this photo first, then you can crop or enhance it again.');
    return;
  }
  let file;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    file = await res.blob();
  } catch {
    toast("The published image couldn't be loaded. If you just published it, wait a minute and try again.", { tone: 'bad' });
    return;
  }
  const info = await inspect(file);
  const insets = await cropEditor({ bitmap: info.bitmap, insets: info.frame.kind === 'none' ? { top: 0, right: 0, bottom: 0, left: 0 } : info.insets, title: 'Crop, then save a new version' });
  if (!insets) return;
  const settings = ctx.settings();
  const w = info.width * (1 - insets.left - insets.right);
  const hh = info.height * (1 - insets.top - insets.bottom);
  let enhance = false;
  if (enhancePlan(w, hh, settings) && (await gpuAvailable())) {
    enhance = await confirmDialog({
      title: 'Enhance the resolution too?',
      body: `The photo is ${Math.round(Math.max(w, hh))} px on its long edge. Enhancing takes it to ${enhancePlan(w, hh, settings).to} px. This takes a little while.`,
      confirm: 'Enhance',
    });
  }
  closeDrawer();
  const note = toast(enhance ? 'Enhancing… keep this tab open.' : 'Saving the new version…', { timeout: 0 });
  ctx.busy(true);
  try {
    if (enhance) await loadModel();
    const out = await render(info, {
      insets,
      enhance,
      settings,
      onProgress: ({ stage, fraction }) => {
        note.firstChild.textContent = stage === 'enhance' ? `Enhancing… ${Math.round(fraction * 100)}%` : 'Saving the new version…';
      },
    });
    const id = newId(p.date ? new Date(p.date) : new Date());
    const full = `photos/full/${id}.jpg`;
    const thumb = `photos/thumb/${id}.${out.thumbExt}`;
    const [a, b] = await Promise.all([blobToBase64(out.full).then((x) => ctx.gh.createBlobBase64(x)), blobToBase64(out.thumb).then((x) => ctx.gh.createBlobBase64(x))]);
    ctx.store.previews.set(p.id, URL.createObjectURL(out.thumb));
    ctx.store.replaceFiles(
      p.id,
      { src: full, thumb, w: out.w, h: out.h, tw: out.tw, th: out.th, lqip: out.lqip, color: out.color, enhanced: out.enhanced || p.enhanced || false },
      [
        { path: full, sha: a },
        { path: thumb, sha: b },
      ],
      [p.src, p.thumb],
    );
    note.remove();
    toast('New version saved. Publish to put it on the site.', {
      action: out.enhanced
        ? {
            label: 'Compare',
            run: async () => {
              const r = cropRect(info.width, info.height, {
                top: Math.round(insets.top * info.height),
                right: Math.round(insets.right * info.width),
                bottom: Math.round(insets.bottom * info.height),
                left: Math.round(insets.left * info.width),
              });
              compareView({ before: cropCanvas(info.bitmap, r), after: await decode(out.full) });
            },
          }
        : null,
      timeout: 12000,
    });
  } catch (err) {
    console.error(err);
    note.remove();
    toast(err.message || 'The new version could not be saved.', { tone: 'bad' });
  } finally {
    ctx.busy(false);
  }
}

// ====================================================================== About page

export function aboutView(ctx) {
  const { store } = ctx;
  const site = store.site;
  const about = site.about || {};
  const save = batch((fields) => store.editSite(fields), 400);
  const setAbout = (k) => (e) => save({ about: { [k]: e.target.value } });

  // Portrait
  const portraitBox = h('div', {});
  const paintPortrait = () => {
    const pt = store.site.about?.portrait;
    portraitBox.replaceChildren();
    if (!pt?.src) {
      portraitBox.append(h('div', { class: 'empty' }, h('h2', {}, 'No portrait yet'), h('p', { class: 'muted' }, 'Until you add one, the About page uses a featured photograph.')));
      return;
    }
    const src = store.previews.get('portrait') || new URL(pt.small || pt.src, ctx.siteUrl).href;
    const img = h('img', { src, alt: 'Your portrait' });
    const [fx, fy] = pt.focus || [0.5, 0.35];
    const dot = h('span', { class: 'focus-dot', style: { left: `${fx * 100}%`, top: `${fy * 100}%` } });
    const pick = h('div', { class: 'focus-pick', title: 'Click to set what stays in view' }, img, dot);
    pick.addEventListener('click', (e) => {
      const r = pick.getBoundingClientRect();
      const nx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const ny = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      dot.style.left = `${nx * 100}%`;
      dot.style.top = `${ny * 100}%`;
      store.editSite({ about: { portrait: { focus: [Number(nx.toFixed(3)), Number(ny.toFixed(3))] } } });
    });
    portraitBox.append(pick, h('p', { class: 'muted', style: { marginTop: '8px' } }, 'Click your face. That spot stays in view when the portrait fills screens of different shapes.'));
  };
  paintPortrait();

  const input = h('input', { type: 'file', accept: 'image/*', 'aria-label': 'Choose a portrait' });
  const drop = h('div', { class: 'drop', style: { minHeight: '150px' } }, h('h2', {}, 'Drop a portrait'), h('p', { class: 'muted' }, 'A large, sharp photo works best. It fills the whole screen.'), input);
  const status = h('p', { class: 'muted', 'aria-live': 'polite' });
  const takePortrait = async (file) => {
    if (!file) return;
    try {
      status.textContent = 'Reading…';
      const info = await inspect(file);
      const insets = await cropEditor({ bitmap: info.bitmap, insets: info.frame.confidence === 'low' ? { top: 0, right: 0, bottom: 0, left: 0 } : info.insets, title: 'Crop your portrait' });
      if (!insets) {
        status.textContent = '';
        return;
      }
      ctx.busy(true);
      const settings = { ...ctx.settings(), longEdge: 2600 };
      const w = info.width * (1 - insets.left - insets.right);
      const hh = info.height * (1 - insets.top - insets.bottom);
      const enhance = !!enhancePlan(w, hh, settings) && (await gpuAvailable());
      if (enhance) await loadModel();
      const out = await render(info, {
        insets,
        enhance,
        settings,
        onProgress: ({ stage, fraction }) => (status.textContent = stage === 'enhance' ? `Enhancing… ${Math.round(fraction * 100)}%` : 'Saving…'),
      });
      // A second, lighter size for phones.
      const fullBmp = await decode(out.full);
      const [sw, sh] = fitWithin(fullBmp.width, fullBmp.height, 1300);
      const smallBlob = await encode(resize(fullBmp, sw, sh), 'image/jpeg', 0.86);
      const id = newId(new Date());
      const big = `photos/about/portrait-${id}.jpg`;
      const small = `photos/about/portrait-${id}-small.jpg`;
      status.textContent = 'Uploading…';
      const [a, b] = await Promise.all([blobToBase64(out.full).then((x) => ctx.gh.createBlobBase64(x)), blobToBase64(smallBlob).then((x) => ctx.gh.createBlobBase64(x))]);
      const old = store.site.about?.portrait;
      store.previews.set('portrait', URL.createObjectURL(smallBlob));
      store.editSite(
        { about: { portrait: { src: big, small, w: out.w, h: out.h, sw, sh, focus: old?.focus || [0.5, 0.35], color: out.color } } },
        [
          { path: big, sha: a },
          { path: small, sha: b },
        ],
        old?.src ? [old.src, old.small].filter(Boolean) : [],
      );
      status.textContent = `Portrait ready${out.enhanced ? ' (enhanced)' : ''}. Click your face below, then publish.`;
      paintPortrait();
    } catch (err) {
      console.error(err);
      status.textContent = err.message || 'The portrait could not be used.';
    } finally {
      ctx.busy(false);
    }
  };
  input.addEventListener('change', () => takePortrait(input.files[0]));
  drop.addEventListener('dragover', (e) => (e.preventDefault(), drop.classList.add('is-over')));
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    takePortrait(e.dataTransfer.files[0]);
  });

  // Facts and links: editable rows
  const rowsEditor = (key, labels, placeholders) => {
    const box = h('div', { class: 'rows' });
    const rows = (store.site.about?.[key] || []).map((r) => ({ ...r }));
    const commit = () => store.editSite({ about: { [key]: rows.filter((r) => r[labels[0]] || r[labels[1]]) } });
    const paintRows = () => {
      box.replaceChildren(
        ...rows.map((r, i) =>
          h(
            'div',
            { class: 'pair' },
            h('input', { class: 'input', value: r[labels[0]] || '', placeholder: placeholders[0], 'aria-label': placeholders[0], oninput: (e) => ((r[labels[0]] = e.target.value), debounceCommit()) }),
            h('input', { class: 'input', value: r[labels[1]] || '', placeholder: placeholders[1], 'aria-label': placeholders[1], oninput: (e) => ((r[labels[1]] = e.target.value), debounceCommit()) }),
            h('button', { class: 'btn btn-small btn-quiet', type: 'button', 'aria-label': 'Remove row', onclick: () => (rows.splice(i, 1), commit(), paintRows()) }, 'Remove'),
          ),
        ),
        h('button', { class: 'btn btn-small', type: 'button', onclick: () => (rows.push({}), paintRows()) }, 'Add a row'),
      );
    };
    const debounceCommit = debounce(commit, 400);
    paintRows();
    return box;
  };

  return h(
    'div',
    {},
    h('div', { class: 'view-head' }, h('div', {}, h('h1', {}, 'About page'), h('p', {}, 'Your portrait opens up to fill the screen as visitors scroll, with your name around it, followed by the words below.'))),
    h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'Portrait'),
      h('div', { class: 'portrait-edit' }, portraitBox, h('div', { class: 'stack' }, drop, status, h('p', { class: 'muted' }, 'Borders are trimmed and small photos enhanced, as with your other photos.'))),
    ),
    h(
      'div',
      { class: 'panel section-gap' },
      h('h2', {}, 'Words'),
      field('Your name', h('input', { class: 'input', value: site.name || '', oninput: (e) => save({ name: e.target.value }) }), 'Set across the home page and the About page.'),
      field('Introduction', h('textarea', { oninput: setAbout('intro'), placeholder: 'One or two sentences, shown large.' }, about.intro || '')),
      field('Biography', h('textarea', { style: { minHeight: '200px' }, oninput: setAbout('bio'), placeholder: 'Leave a blank line between paragraphs.' }, about.bio || '')),
      h(
        'div',
        { class: 'grid2' },
        field('Based in', h('input', { class: 'input', value: about.location || '', oninput: setAbout('location') })),
        field('Time zone', h('input', { class: 'input', value: about.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone, oninput: setAbout('timezone') }), 'Shows your local time in the footer, e.g. Asia/Kolkata.'),
        field('Email', h('input', { class: 'input', type: 'email', value: about.email || '', oninput: setAbout('email') }), 'Shown large at the foot of every page. Leave empty to hide it.'),
        field('Instagram username', h('input', { class: 'input', value: about.instagram || '', oninput: setAbout('instagram'), placeholder: 'without the @' })),
      ),
    ),
    h('div', { class: 'panel section-gap' }, h('h2', {}, 'Facts'), h('p', { class: 'muted' }, 'Short lines beside your biography, such as “Shooting since — 2014”.'), rowsEditor('facts', ['label', 'value'], ['Label', 'Value'])),
    h('div', { class: 'panel section-gap' }, h('h2', {}, 'Links'), h('p', { class: 'muted' }, 'Shown in the footer.'), rowsEditor('links', ['label', 'url'], ['Label', 'https://…'])),
  );
}

// ====================================================================== Settings

export function settingsView(ctx) {
  const { store } = ctx;
  const s = store.site;
  const proc = { longEdge: 2560, quality: 0.9, removeBorders: true, enhance: true, ...(s.processing || {}) };
  const save = batch((fields) => store.editSite(fields), 350);
  const radio = (name, value, current, label, hint, onpick) =>
    h('label', { class: 'check' }, h('input', { type: 'radio', name, value, checked: current === value, onchange: () => onpick(value) }), h('span', {}, label, hint ? h('small', {}, hint) : null));
  const select = (value, options, onchange, label) =>
    h('select', { 'aria-label': label, onchange: (e) => onchange(e.target.value) }, ...options.map(([v, t]) => h('option', { value: String(v), selected: String(v) === String(value) ? true : null }, t)));

  return h(
    'div',
    {},
    h('div', { class: 'view-head' }, h('div', {}, h('h1', {}, 'Settings'))),
    h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'Look'),
      h(
        'div',
        { class: 'stack' },
        radio('theme', 'paper', s.theme || 'paper', 'Paper', 'Prints on a pale wall. The default.', (v) => store.editSite({ theme: v })),
        radio('theme', 'darkroom', s.theme, 'Darkroom', 'Prints on black.', (v) => store.editSite({ theme: v })),
        radio('theme', 'auto', s.theme, "Match the visitor's device", 'Paper by day, Darkroom when their phone or computer is in dark mode.', (v) => store.editSite({ theme: v })),
      ),
      field('Opening line on the home page', h('textarea', { oninput: (e) => save({ statement: e.target.value }), placeholder: 'Leave empty for “Photographs by your name, years”.' }, s.statement || '')),
      h(
        'div',
        { class: 'grid2' },
        field('Show photographs first as', select(s.defaultView || 'prints', [['prints', 'Prints'], ['sheet', 'Contact sheet']], (v) => store.editSite({ defaultView: v }), 'Default view')),
        field('Slideshow speed', select(s.hero?.interval || 7, [[5, 'Every 5 seconds'], [7, 'Every 7 seconds'], [10, 'Every 10 seconds'], [15, 'Every 15 seconds']], (v) => store.editSite({ hero: { interval: Number(v) } }), 'Slideshow speed')),
      ),
      checkbox('Play the slideshow of featured photos', s.hero?.autoplay !== false, (v) => store.editSite({ hero: { autoplay: v } })),
      checkbox('Show camera details on labels', s.showCameraInfo !== false, (v) => store.editSite({ showCameraInfo: v })),
      checkbox('Discourage saving images', s.protectImages !== false, (v) => store.editSite({ protectImages: v }), 'Stops dragging and long-press saving. It cannot stop screenshots.'),
    ),
    h(
      'div',
      { class: 'panel section-gap' },
      h('h2', {}, 'Photo processing'),
      h(
        'div',
        { class: 'grid2' },
        field(
          'Published size (long edge)',
          select(proc.longEdge, [[2048, '2048 px, smaller files'], [2560, '2560 px, recommended'], [3200, '3200 px'], [4096, '4096 px, large files']], (v) => store.editSite({ processing: { longEdge: Number(v) } }), 'Published size'),
          'Larger photos are scaled down to this; smaller ones are enhanced up to it.',
        ),
        field('JPEG quality', select(proc.quality, [[0.85, 'Good (smaller files)'], [0.9, 'High, recommended'], [0.95, 'Very high']], (v) => store.editSite({ processing: { quality: Number(v) } }), 'JPEG quality')),
      ),
      checkbox('Remove borders automatically', proc.removeBorders !== false, (v) => store.editSite({ processing: { removeBorders: v } })),
      checkbox('Enhance small photos with AI', proc.enhance !== false, (v) => store.editSite({ processing: { enhance: v } }), 'Uses the Real-ESRGAN model in your browser. Needs a computer or phone with WebGL.'),
    ),
    h(
      'div',
      { class: 'panel section-gap' },
      h('h2', {}, 'Sharing'),
      field('Description for search engines and link previews', h('textarea', { oninput: (e) => save({ description: e.target.value }) }, s.description || '')),
      field('Line above your email in the footer', h('input', { class: 'input', value: s.footerNote || '', oninput: (e) => save({ footerNote: e.target.value }) })),
      h('p', { class: 'muted' }, 'When a link to your site is shared, the preview uses your first featured photograph.'),
    ),
    h(
      'div',
      { class: 'panel section-gap' },
      h('h2', {}, 'This device'),
      h('p', { class: 'muted' }, `Connected to ${ctx.gh.owner}/${ctx.gh.repo}, branch ${ctx.gh.branch}.`),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => ctx.lock() }, 'Lock now'), h('button', { class: 'btn btn-danger', type: 'button', onclick: () => ctx.forget() }, 'Forget this device')),
    ),
  );
}
