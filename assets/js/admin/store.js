// What the admin is editing: the published state of the site (read from GitHub) plus a list
// of changes waiting to be published. Changes are kept as operations and replayed onto the
// latest published state when you publish, so edits made elsewhere in the meantime are kept.

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = clone(v);
    }
  }
  return target;
}

export function applyPhotoOps(base, ops) {
  let list = clone(base) || [];
  for (const op of ops) {
    if (op.type === 'add') {
      if (!list.some((p) => p.id === op.photo.id)) {
        if (op.at === 'end') list.push(clone(op.photo));
        else list.unshift(clone(op.photo));
      }
    } else if (op.type === 'delete') {
      list = list.filter((p) => p.id !== op.id);
    } else if (op.type === 'edit') {
      const p = list.find((q) => q.id === op.id);
      if (p) deepMerge(p, op.fields);
    } else if (op.type === 'order') {
      const pos = new Map(op.ids.map((id, i) => [id, i]));
      list = [...list].sort((a, b) => (pos.get(a.id) ?? 1e9 + list.indexOf(a)) - (pos.get(b.id) ?? 1e9 + list.indexOf(b)));
    }
  }
  return list;
}

export function applySiteOps(base, ops) {
  const site = clone(base) || {};
  for (const op of ops) if (op.type === 'site') deepMerge(site, op.fields);
  return site;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

export class Store extends EventTarget {
  constructor(gh, { siteUrl }) {
    super();
    this.gh = gh;
    this.siteUrl = siteUrl; // absolute URL of the published site root
    this.key = `pf-admin-pending:${gh.owner}/${gh.repo}@${gh.branch}`;
    this.previews = new Map();
    try {
      this.ops = JSON.parse(localStorage.getItem(this.key) || '[]');
    } catch {
      this.ops = [];
    }
  }

  async load() {
    const head = await this.gh.head();
    const [photos, site] = await Promise.all([this.gh.readJSON('data/photos.json', head.commit), this.gh.readJSON('data/site.json', head.commit)]);
    this.base = { head, photos, site };
    this.recompute();
  }

  recompute() {
    this.photos = applyPhotoOps(this.base.photos.photos || [], this.ops);
    this.site = applySiteOps(this.base.site, this.ops);
    this.dispatchEvent(new Event('change'));
  }

  save() {
    try {
      localStorage.setItem(this.key, JSON.stringify(this.ops));
    } catch {
      /* storage full: changes still live in memory until publish */
    }
    this.recompute();
  }

  isNew(id) {
    return this.ops.some((o) => o.type === 'add' && o.photo.id === id);
  }

  isEdited(id) {
    return this.ops.some((o) => o.type === 'edit' && o.id === id);
  }

  // ------------------------------------------------------------ changes

  addPhoto(photo, files, previewUrl, { at = 'start' } = {}) {
    this.ops.push({ type: 'add', photo, files, at });
    if (previewUrl) this.previews.set(photo.id, previewUrl);
    this.save();
  }

  /** Newest first, by the date each photograph was taken. */
  sortByDate() {
    const time = (p) => (p.date ? new Date(p.date).getTime() : 0);
    this.reorder([...this.photos].sort((a, b) => time(b) - time(a)).map((p) => p.id));
  }

  deletePhotos(ids) {
    for (const id of ids) {
      const added = this.ops.findIndex((o) => o.type === 'add' && o.photo.id === id);
      if (added >= 0) {
        this.ops.splice(added, 1);
        this.ops = this.ops.filter((o) => !(o.type === 'edit' && o.id === id));
      } else {
        this.ops = this.ops.filter((o) => !(o.type === 'edit' && o.id === id));
        this.ops.push({ type: 'delete', id });
      }
    }
    this.save();
  }

  editPhoto(id, fields) {
    const added = this.ops.find((o) => o.type === 'add' && o.photo.id === id);
    if (added) deepMerge(added.photo, fields);
    else {
      const existing = this.ops.find((o) => o.type === 'edit' && o.id === id);
      if (existing) deepMerge(existing.fields, fields);
      else this.ops.push({ type: 'edit', id, fields: clone(fields) });
    }
    this.save();
  }

  /** Replace a photo's image files (after enhancing it later, for example). */
  replaceFiles(id, fields, files, oldPaths) {
    const added = this.ops.find((o) => o.type === 'add' && o.photo.id === id);
    if (added) {
      deepMerge(added.photo, fields);
      added.files = files;
    } else {
      this.ops.push({ type: 'edit', id, fields: clone(fields), files, remove: oldPaths });
    }
    this.save();
  }

  reorder(ids) {
    this.ops = this.ops.filter((o) => o.type !== 'order');
    this.ops.push({ type: 'order', ids });
    this.save();
  }

  editSite(fields, files = [], remove = []) {
    this.ops.push({ type: 'site', fields: clone(fields), files, remove });
    this.compactSite();
    this.save();
  }

  compactSite() {
    const siteOps = this.ops.filter((o) => o.type === 'site');
    if (siteOps.length < 2) return;
    const merged = { type: 'site', fields: {}, files: [], remove: [] };
    for (const o of siteOps) {
      deepMerge(merged.fields, o.fields);
      merged.files.push(...(o.files || []));
      merged.remove.push(...(o.remove || []));
    }
    this.ops = this.ops.filter((o) => o.type !== 'site');
    this.ops.push(merged);
  }

  discard() {
    this.ops = [];
    this.save();
  }

  get pending() {
    return this.ops.length;
  }

  summary() {
    const s = { added: 0, deleted: 0, edited: new Set(), reordered: false, site: false };
    for (const o of this.ops) {
      if (o.type === 'add') s.added++;
      else if (o.type === 'delete') s.deleted++;
      else if (o.type === 'edit') s.edited.add(o.id);
      else if (o.type === 'order') s.reordered = true;
      else if (o.type === 'site') s.site = true;
    }
    const parts = [];
    if (s.added) parts.push(`${s.added} photo${s.added === 1 ? '' : 's'} added`);
    if (s.deleted) parts.push(`${s.deleted} deleted`);
    if (s.edited.size) parts.push(`${s.edited.size} edited`);
    if (s.reordered) parts.push('new order');
    if (s.site) parts.push('site details updated');
    return { ...s, edited: s.edited.size, text: parts.join(', ') };
  }

  // ------------------------------------------------------------ publish

  async publish(onStatus = () => {}) {
    const ops = clone(this.ops);
    if (!ops.length) return null;
    const message = `Update photographs: ${this.summary().text}`;
    const now = new Date().toISOString();
    let final;
    const result = await this.gh.commit(message, async (head) => {
      onStatus('Reading the latest version');
      const [photosJson, siteJson, existing] = await Promise.all([
        this.gh.readJSON('data/photos.json', head.commit),
        this.gh.readJSON('data/site.json', head.commit),
        this.gh.paths(head.tree),
      ]);
      const photos = applyPhotoOps(photosJson.photos || [], ops);
      const site = applySiteOps(siteJson, ops);
      const adding = new Map();
      const removing = new Set();
      for (const o of ops) for (const f of o.files || []) adding.set(f.path, f.sha);
      for (const o of ops) {
        if (o.type === 'delete') {
          const rec = (photosJson.photos || []).find((p) => p.id === o.id);
          if (rec) [rec.src, rec.thumb].forEach((p) => p && removing.add(p));
        }
        for (const p of o.remove || []) removing.add(p);
      }
      // Never delete a file that something still uses.
      const inUse = new Set(photos.flatMap((p) => [p.src, p.thumb]));
      const portrait = site.about?.portrait;
      if (portrait) [portrait.src, portrait.small].forEach((p) => p && inUse.add(p));
      const entries = [];
      for (const [path, sha] of adding) entries.push({ path, sha });
      for (const path of removing) if (!adding.has(path) && !inUse.has(path) && existing.has(path)) entries.push({ path, sha: null });
      entries.push({ path: 'data/photos.json', content: `${JSON.stringify({ version: 1, updated: now, photos }, null, 1)}\n` });
      entries.push({ path: 'data/site.json', content: `${JSON.stringify(site, null, 2)}\n` });
      if (!existing.has('.nojekyll')) entries.push({ path: '.nojekyll', content: '' });
      onStatus('Updating page titles and previews');
      entries.push(...(await this.metaEntries(head, site, photos)));
      final = { photos, site };
      onStatus('Saving to GitHub');
      return entries;
    });
    this.ops = [];
    try {
      localStorage.removeItem(this.key);
    } catch {
      /* ignore */
    }
    this.base = {
      head: { commit: result.commit },
      photos: { version: 1, updated: now, photos: final.photos },
      site: final.site,
    };
    this.recompute();
    return { ...result, updated: now };
  }

  /** Keep the static <title> and link-preview tags in the HTML in step with the settings. */
  async metaEntries(head, site, photos) {
    const out = [];
    const name = site.name || 'Photographs';
    const visible = photos.filter((p) => !p.hidden);
    const cover = visible.find((p) => p.featured) || visible[0];
    const image = cover ? new URL(cover.src, this.siteUrl).href : '';
    const description = site.description || `Photographs by ${name}.`;
    const pages = [
      { path: 'index.html', title: `${name} · Photographs`, description, url: this.siteUrl, type: 'website', image },
      {
        path: 'about/index.html',
        title: `About ${name}`,
        description: site.about?.intro || `About the photographer ${name}.`,
        url: new URL('about/', this.siteUrl).href,
        type: 'profile',
        image: site.about?.portrait?.src ? new URL(site.about.portrait.src, this.siteUrl).href : image,
      },
    ];
    for (const p of pages) {
      let html;
      try {
        html = await this.gh.readText(p.path, head.commit);
      } catch {
        continue;
      }
      const block = [
        '<!-- META:START -->',
        `<title>${esc(p.title)}</title>`,
        `<meta name="description" content="${esc(p.description)}">`,
        `<meta property="og:type" content="${p.type}">`,
        `<meta property="og:title" content="${esc(p.title)}">`,
        `<meta property="og:description" content="${esc(p.description)}">`,
        `<meta property="og:url" content="${esc(p.url)}">`,
        p.image ? `<meta property="og:image" content="${esc(p.image)}">` : '',
        '<meta name="twitter:card" content="summary_large_image">',
        '<!-- META:END -->',
      ]
        .filter(Boolean)
        .join('\n');
      let next = html.replace(/<!-- META:START -->[\s\S]*?<!-- META:END -->/, block);
      // Static fallbacks for the name, used before the page script runs.
      next = next.replace(/(<a class="brand"[^>]*>)[^<]*(<\/a>)/, `$1${esc(name)}$2`);
      next = next.replace(/(<h1 class="(?:hero|about)-name"[^>]*>)[^<]*(<\/h1>)/, `$1${esc(name)}$2`);
      if (next !== html) out.push({ path: p.path, content: next });
    }
    // Tell the 404 page where the site root is, so its styles and links resolve from any path.
    try {
      const notFound = await this.gh.readText('404.html', head.commit);
      const root = new URL(this.siteUrl).pathname;
      const next = notFound.replace(/data-root="[^"]*"/, `data-root="${esc(root)}"`);
      if (next !== notFound) out.push({ path: '404.html', content: next });
    } catch {
      /* no 404 page */
    }
    return out;
  }
}
