// Reads the archive Instagram gives you from "Export your information" (Accounts Center),
// entirely in the browser. Large archives are read in place, one file at a time.

const ZIP_SRC = new URL('../../vendor/zip.min.js', import.meta.url);

function loadZip() {
  if (window.zip) return Promise.resolve(window.zip);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = ZIP_SRC;
    s.onload = () => {
      window.zip.configure({ useWebWorkers: false });
      resolve(window.zip);
    };
    s.onerror = () => reject(new Error('Could not load the ZIP reader.'));
    document.head.appendChild(s);
  });
}

const IMAGE = /\.(jpe?g|png|webp|heic|heif)$/i;
const VIDEO = /\.(mp4|mov|m4v|webm)$/i;

/**
 * Meta's exports store text as UTF-8 bytes written out as Latin-1 escapes, so "😊" arrives
 * as "Ã°ÂŸÂ˜ÂŠ". Re-read such strings as UTF-8.
 */
export function fixText(s) {
  if (typeof s !== 'string' || !/[\u0080-ÿ]/.test(s) || /[^\u0000-ÿ]/.test(s)) return s || '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
  } catch {
    return s;
  }
}

const norm = (p) => p.replace(/\\/g, '/').replace(/^\.?\//, '');

function toDate(ts) {
  if (ts === undefined || ts === null || ts === '') return null;
  if (typeof ts === 'number') return new Date(ts > 1e12 ? ts : ts * 1000);
  const d = new Date(String(ts).replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3'));
  return Number.isNaN(d.getTime()) ? null : d;
}

function exifFrom(media) {
  const list = media?.media_metadata?.photo_metadata?.exif_data;
  if (!Array.isArray(list)) return {};
  const all = Object.assign({}, ...list);
  const out = {};
  if (all.lens_model) out.camera = fixText(String(all.lens_model)).replace(/\s+back.*$/i, '').trim();
  if (all.iso && Number(all.iso) > 0) out.iso = Number(all.iso);
  return out;
}

/**
 * Open one or more archive parts (large exports are split across several ZIPs).
 * @returns {Promise<{items: object[], stats: object, source: string, close: () => Promise<void>}>}
 */
export async function openArchive(files, onStatus = () => {}) {
  const zip = await loadZip();
  const entries = new Map();
  const readers = [];
  for (const file of files) {
    onStatus(`Reading ${file.name}…`);
    const reader = new zip.ZipReader(new zip.BlobReader(file));
    readers.push(reader);
    for (const e of await reader.getEntries()) {
      if (e.directory) continue;
      const p = norm(e.filename);
      if (p.startsWith('__MACOSX/') || p.split('/').pop().startsWith('._')) continue;
      entries.set(p, e);
    }
  }
  if (!entries.size) throw new Error('These files are empty or are not ZIP archives.');

  const byName = new Map();
  for (const [p, e] of entries) {
    const base = p.split('/').pop();
    if (!byName.has(base)) byName.set(base, []);
    byName.get(base).push([p, e]);
  }
  const resolve = (uri) => {
    const u = norm(uri || '');
    if (!u) return null;
    if (entries.has(u)) return [u, entries.get(u)];
    const cands = byName.get(u.split('/').pop()) || [];
    return cands.find(([p]) => p.endsWith(`/${u}`) || p.endsWith(u)) || cands[0] || null;
  };

  const readJSON = async (entry) => JSON.parse(await entry.getData(new zip.TextWriter()));

  // Find the post lists. Newer exports: your_instagram_activity/media/posts_1.json;
  // older: your_instagram_activity/content/posts_1.json or content/posts_1.json;
  // oldest: media.json with a "photos" array.
  const postFiles = [...entries.keys()].filter((p) => /(^|\/)posts_\d+\.json$/i.test(p));
  const rank = (p) => (/\/media\/posts_/i.test(p) ? 0 : /\/content\/posts_/i.test(p) ? 1 : 2);
  postFiles.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true }));
  const bestRank = postFiles.length ? rank(postFiles[0]) : 9;
  const chosen = postFiles.filter((p) => rank(p) === bestRank);
  const archivedFiles = [...entries.keys()].filter((p) => /(^|\/)archived_posts\.json$/i.test(p));
  const legacy = [...entries.keys()].find((p) => /(^|\/)media\.json$/i.test(p));

  const posts = [];
  const pushPost = (post, archived) => {
    const media = Array.isArray(post.media) ? post.media : post.uri ? [post] : [];
    if (!media.length) return;
    const stamps = media.map((m) => m.creation_timestamp).filter(Boolean);
    const date = toDate(post.creation_timestamp || (stamps.length ? Math.min(...stamps) : null));
    const caption = fixText(post.title || media[0].title || '');
    posts.push({ date, caption, media, archived });
  };
  for (const p of chosen) {
    onStatus('Reading your posts…');
    const json = await readJSON(entries.get(p));
    const list = Array.isArray(json) ? json : json.ig_posts || json.posts || [];
    list.forEach((post) => pushPost(post, false));
  }
  for (const p of archivedFiles) {
    const json = await readJSON(entries.get(p));
    const list = Array.isArray(json) ? json : json.ig_archived_post_media || [];
    list.forEach((post) => pushPost(post, true));
  }
  if (!posts.length && legacy) {
    const json = await readJSON(entries.get(legacy));
    for (const ph of json.photos || []) {
      posts.push({ date: toDate(ph.taken_at), caption: fixText(ph.caption || ''), media: [{ uri: ph.path }], archived: false });
    }
  }

  const items = [];
  const stats = { posts: posts.length, photos: 0, videos: 0, missing: 0, unsupported: 0 };
  let source = chosen.length ? chosen.join(', ') : legacy || '';

  for (const post of posts) {
    post.media.forEach((m, i) => {
      const uri = m.uri || '';
      if (VIDEO.test(uri)) {
        stats.videos++;
        return;
      }
      const hit = resolve(uri);
      if (!hit) {
        stats.missing++;
        return;
      }
      const [path, entry] = hit;
      if (!IMAGE.test(path)) return;
      const heic = /\.hei[cf]$/i.test(path);
      if (heic) stats.unsupported++;
      stats.photos++;
      items.push({
        key: path.split('/').pop().replace(/\.[^.]+$/, ''),
        path,
        entry,
        date: toDate(m.creation_timestamp) || post.date,
        caption: post.caption,
        index: i,
        count: post.media.length,
        archived: post.archived,
        heic,
        exif: exifFrom(m),
      });
    });
  }

  // No post list found (an HTML-format export, or a hand-made ZIP): take every image in
  // the posts folders and date it from the YYYYMM folder name.
  if (!items.length) {
    source = 'folder scan';
    for (const [path, entry] of entries) {
      if (!IMAGE.test(path)) continue;
      if (!/(^|\/)(media\/)?(posts|photos)\//i.test(path) && !/\/archived_posts\//i.test(path)) continue;
      const m = path.match(/\/(\d{4})(\d{2})\//);
      const date = m ? new Date(Date.UTC(+m[1], +m[2] - 1, 1)) : entry.lastModDate || null;
      items.push({
        key: path.split('/').pop().replace(/\.[^.]+$/, ''),
        path,
        entry,
        date,
        caption: '',
        index: 0,
        count: 1,
        archived: /archived/i.test(path),
        heic: /\.hei[cf]$/i.test(path),
        exif: {},
      });
    }
    stats.photos = items.length;
  }
  if (!items.length) {
    throw new Error(
      "No photos were found in this archive. Make sure the export includes Posts, and that you chose the ZIP Instagram emailed you rather than a folder you re-zipped.",
    );
  }

  items.sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0) || a.index - b.index);
  return {
    items,
    stats,
    source,
    async load(item) {
      const type = /\.png$/i.test(item.path) ? 'image/png' : /\.webp$/i.test(item.path) ? 'image/webp' : /\.hei[cf]$/i.test(item.path) ? 'image/heic' : 'image/jpeg';
      const blob = await item.entry.getData(new zip.BlobWriter(type));
      return new File([blob], item.path.split('/').pop(), { type });
    },
    async close() {
      await Promise.all(readers.map((r) => r.close().catch(() => {})));
    },
  };
}

/** Split an Instagram caption into a short title and the remaining text. */
export function splitCaption(text, { keepHashtags = false } = {}) {
  let t = (text || '').replace(/\r/g, '');
  if (!keepHashtags) {
    t = t.replace(/(^|\s)#[\p{L}\p{N}_]+/gu, '$1').replace(/[ \t]+\n/g, '\n');
    t = t.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
    t = t.replace(/^[.\s·•-]+$/gm, '').trim();
  }
  const lines = t.split('\n');
  let first = (lines[0] || '').trim();
  let rest = lines.slice(1).join('\n').trim();
  if (first.length > 80) {
    const cut = first.slice(0, 80);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    if (stop > 25) {
      rest = `${first.slice(stop + 2)}${rest ? `\n${rest}` : ''}`.trim();
      first = first.slice(0, stop + 1);
    } else {
      return { title: '', caption: t };
    }
  }
  return { title: first, caption: rest };
}
