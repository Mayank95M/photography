// Installing site files from an update ZIP through the GitHub API, in one commit: the Best
// quality models (too large for GitHub's upload page) and later updates to the site's code.
// Only code and assets can be installed this way; photos, texts and settings are never touched.
import { h, toast, confirmDialog } from './ui.js';
import { blobToBase64 } from './imaging.js';
import { loadZip } from './instagram.js';

export const timing = { poll: 10000, max: 6 * 60 * 1000 };

const JUNK = /(^|\/)(__MACOSX\/|\._|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;
const isModelFile = (path) => /^assets\/models\/realesrgan-x[24]plus\//.test(path);
const isCode = (path) => /^(assets\/(js|css)\/|admin\/)/.test(path);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Where a file in an update ZIP goes in the site, or null if it isn't a site file.
 * "photo-site-update/assets/js/x.js" → "assets/js/x.js". Up to two wrapping folders are skipped.
 */
export function sitePath(name) {
  const segs = String(name).replace(/\\/g, '/').split('/').filter(Boolean);
  if (segs.some((s) => s === '..' || s === '.')) return null;
  for (let i = 0; i < segs.length && i <= 2; i++) {
    const rest = segs.slice(i);
    if ((rest[0] === 'assets' || rest[0] === 'admin') && rest.length > 1) return rest.join('/');
    if (rest.length === 1 && rest[0] === 'README.md' && i <= 1) return 'README.md';
  }
  return null;
}

async function entriesOf(file) {
  const zip = await loadZip();
  const reader = new zip.ZipReader(new zip.BlobReader(file));
  const entries = (await reader.getEntries()).filter((e) => !e.directory && !JUNK.test(e.filename));
  return { zip, reader, entries };
}

/** Is this a site update rather than, say, an Instagram archive? */
export async function isUpdateZip(file) {
  try {
    const { reader, entries } = await entriesOf(file);
    await reader.close().catch(() => {});
    return entries.some((e) => sitePath(e.filename)) && !entries.some((e) => /(^|\/)(posts_\d+|media)\.json$|(^|\/)media\/posts\//i.test(e.filename));
  } catch {
    return false;
  }
}

/** The files an update ZIP would install, and the ones it leaves out. */
export async function readUpdate(file) {
  const { zip, reader, entries } = await entriesOf(file);
  const files = new Map();
  const skipped = [];
  for (const e of entries) {
    const path = sitePath(e.filename);
    if (!path) skipped.push(e.filename);
    else files.set(path, { path, size: e.uncompressedSize, read: () => e.getData(new zip.BlobWriter()) });
  }
  return { files: [...files.values()], skipped, close: () => reader.close().catch(() => {}) };
}

/** Add or replace files in the repository, as one commit. */
export async function installFiles(gh, files, { message, onProgress } = {}) {
  const total = files.reduce((s, f) => s + f.size, 0);
  const shas = new Map();
  const queue = [...files];
  let sent = 0;
  onProgress?.(0, total);
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const data = await f.read();
      shas.set(f.path, await gh.createBlobBase64(await blobToBase64(data)));
      sent += f.size;
      onProgress?.(sent, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, files.length) }, worker));
  return gh.commit(message, async () => files.map((f) => ({ path: f.path, sha: shas.get(f.path) })));
}

const mb = (bytes) => (bytes < 1e6 ? '<1' : String(Math.round(bytes / 1e6)));

/**
 * Read a dropped ZIP, confirm, install, and follow up (models: wait until the site serves them).
 * @param {(text:string) => void} say status line
 * @returns {Promise<boolean>} whether files were installed
 */
export async function installZip(ctx, file, say, onInstalled) {
  if (!/\.zip$/i.test(file.name) && !/zip/.test(file.type)) {
    say('Choose the .zip file itself, without unzipping it.');
    return false;
  }
  let upd;
  try {
    say('Reading the ZIP…');
    upd = await readUpdate(file);
  } catch {
    say('This file couldn’t be read as a ZIP.');
    return false;
  }
  let busy = false;
  try {
    const { files, skipped } = upd;
    if (!files.length) {
      say('There are no site files in this ZIP. Site updates hold an “assets” folder.');
      return false;
    }
    const total = files.reduce((s, f) => s + f.size, 0);
    const onlyModels = files.every((f) => isModelFile(f.path) || f.path === 'README.md');
    const n = files.length;
    const ok = await confirmDialog({
      title: onlyModels ? 'Install the Best quality models?' : `Install ${n} file${n === 1 ? '' : 's'}?`,
      body: `${n} file${n === 1 ? '' : 's'} (${mb(total)} MB) will be added to your repository in one change, replacing any with the same name. Your photos, texts and settings aren’t touched.${
        skipped.length ? ` ${skipped.length} other file${skipped.length === 1 ? '' : 's'} in the ZIP will be left out.` : ''
      }`,
      confirm: 'Install',
    });
    if (!ok) {
      say('');
      return false;
    }
    busy = true;
    ctx.busy(true);
    await installFiles(ctx.gh, files, {
      message: onlyModels ? 'Install Best quality models' : `Update site files (${n} file${n === 1 ? '' : 's'})`,
      onProgress: (sent, all) => say(`Uploading to GitHub… ${mb(sent)} of ${mb(all)} MB. Keep this page open.`),
    });
    const models = files.some((f) => isModelFile(f.path));
    const code = files.some((f) => isCode(f.path));
    say(
      ['Installed.', models ? 'GitHub is updating your site; Best quality will be ready in about a minute.' : '', code ? 'Reload this page in a couple of minutes (Ctrl+Shift+R) to use the new version.' : '']
        .filter(Boolean)
        .join(' '),
    );
    onInstalled?.(files);
    if (models) watchModels(ctx, say);
    return true;
  } catch (err) {
    console.error(err);
    const msg = String(err.message || 'something went wrong').replace(/([^.!?])$/, '$1.');
    say(`Not installed: ${msg} Nothing on your site was changed.`);
    return false;
  } finally {
    if (busy) ctx.busy(false);
    upd.close();
  }
}

async function watchModels(ctx, say) {
  const started = Date.now();
  while (Date.now() - started < timing.max) {
    await sleep(timing.poll);
    if (await ctx.models.check(true)) {
      say('Best quality is installed and ready.');
      toast('Best quality is ready.', { timeout: 8000 });
      return;
    }
  }
  say('Installed, but your site hasn’t finished updating yet. Reload this page in a few minutes.');
}

/** A drop zone that installs an update ZIP. */
export function installBox(ctx, { title = 'Drop an update ZIP here', text, onInstalled } = {}) {
  const status = h('p', { class: 'muted install-status', 'aria-live': 'polite' });
  const input = h('input', { type: 'file', accept: '.zip,application/zip', 'aria-label': title });
  const drop = h('div', { class: 'drop drop-compact' }, h('h2', {}, title), text ? h('p', { class: 'muted' }, text) : null, input);
  let running = false;
  const go = async (file) => {
    if (!file || running) return;
    running = true;
    input.disabled = true;
    try {
      await installZip(ctx, file, (t) => (status.textContent = t), onInstalled);
    } finally {
      running = false;
      input.disabled = false;
    }
  };
  drop.addEventListener('dragover', (e) => (e.preventDefault(), drop.classList.add('is-over')));
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    go(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', () => {
    go(input.files[0]);
    input.value = '';
  });
  return h('div', { class: 'install' }, drop, status);
}
