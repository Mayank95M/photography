// Admin panel entry: sign in, then manage photos, the About page and settings.
// Nothing here is secret: the page is useless without a GitHub token that can write to this
// repository, and GitHub enforces that on every change.
import { h, $, toast, modal, confirmDialog, field, checkbox } from './ui.js';
import { GitHub } from './github.js';
import { seal, unseal, device } from './vault.js';
import { Store } from './store.js';
import { photosView, aboutView, settingsView } from './views.js';
import { addView, instagramView } from './upload.js';

const app = $('#app');
const SITE_URL = new URL('../', location.href).href;
const DEFAULTS = { longEdge: 2560, quality: 0.9, removeBorders: true, enhance: true };

try {
  const t = localStorage.getItem('pf-theme');
  if (t) document.documentElement.dataset.theme = t;
} catch {
  /* ignore */
}

// Guess owner/repo from the address: https://owner.github.io/repo/admin/
function guessRepo() {
  const m = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
  if (!m) return { owner: '', repo: '' };
  const owner = m[1];
  const parts = location.pathname.split('/').filter(Boolean);
  const repo = parts.length >= 2 && parts[parts.length - 1] === 'admin' ? parts[0] : parts[0] === 'admin' ? `${owner}.github.io` : parts[0] || `${owner}.github.io`;
  return { owner, repo };
}

// ---------------------------------------------------------------- sign in

function gate(message) {
  const saved = device.load();
  const guess = guessRepo();
  const err = h('p', { class: 'error', role: 'alert' }, message || '');

  if (saved?.box) {
    const pass = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Passcode' });
    const btn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Unlock');
    const form = h(
      'form',
      { class: 'gate-card' },
      h('h1', {}, 'Admin'),
      h('p', { class: 'lede' }, `Unlock to manage ${saved.owner}/${saved.repo}.`),
      field('Passcode', pass),
      err,
      h('div', { class: 'row' }, btn, h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => (device.forget(), gate()) }, 'Use a different token')),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      err.textContent = '';
      try {
        const token = await unseal(saved.box, pass.value);
        device.setSession({ owner: saved.owner, repo: saved.repo, branch: saved.branch, token });
        await enter();
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
        pass.select();
      }
    });
    app.replaceChildren(h('main', { class: 'gate' }, form));
    pass.focus();
    return;
  }

  const repo = h('input', { class: 'input', value: guess.owner ? `${guess.owner}/${guess.repo}` : saved ? `${saved.owner}/${saved.repo}` : '', placeholder: 'username/repository', autocomplete: 'off', spellcheck: 'false' });
  const branch = h('input', { class: 'input', value: saved?.branch || 'main', autocomplete: 'off', spellcheck: 'false' });
  const token = h('input', { class: 'input', type: 'password', placeholder: 'github_pat_…', autocomplete: 'off', spellcheck: 'false' });
  const pass = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Choose a passcode' });
  let remember = true;
  const btn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Connect');
  const form = h(
    'form',
    { class: 'gate-card' },
    h('h1', {}, 'Admin'),
    h('p', { class: 'lede' }, 'Changes made here are saved to your GitHub repository and appear on your site about a minute later.'),
    field('Repository', repo, 'Where this site lives, as username/repository.'),
    field('Branch', branch),
    field('Access token', token, 'A fine-grained token with access to only this repository. See below.'),
    checkbox('Remember this device', remember, (v) => {
      remember = v;
      passWrap.hidden = !v;
    }),
    h('div', { class: '', id: 'pass-wrap' }),
    err,
    h('div', { class: 'row' }, btn),
    h(
      'details',
      { class: 'help' },
      h('summary', {}, 'How to create the access token'),
      h(
        'ol',
        {},
        h('li', {}, 'Open ', h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener' }, 'GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token'), '.'),
        h('li', {}, 'Name it “Photo site admin” and choose an expiry (a year is fine).'),
        h('li', {}, 'Under Repository access, choose ', h('b', {}, 'Only select repositories'), ' and pick this site’s repository.'),
        h('li', {}, 'Under Permissions → Repository permissions, set ', h('b', {}, 'Contents'), ' to ', h('b', {}, 'Read and write'), '. Nothing else is needed.'),
        h('li', {}, 'Generate the token, copy it, and paste it above. GitHub shows it only once.'),
      ),
    ),
  );
  const passWrap = field('Passcode for this device', pass, 'Next time, unlock with this instead of the token. The token is stored encrypted with it.');
  form.querySelector('#pass-wrap').replaceWith(passWrap);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const [owner, name] = repo.value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '').split('/');
    if (!owner || !name) {
      err.textContent = 'Enter the repository as username/repository, for example mayank/photographs.';
      return;
    }
    if (!token.value.trim()) {
      err.textContent = 'Paste your access token.';
      return;
    }
    if (remember && pass.value.length < 4) {
      err.textContent = 'Choose a passcode of at least 4 characters, or untick “Remember this device”.';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Checking with GitHub…';
    const cfg = { owner, repo: name, branch: branch.value.trim() || 'main', token: token.value.trim() };
    try {
      await new GitHub(cfg).verify();
      if (remember) device.save({ owner, repo: name, branch: cfg.branch, box: await seal(cfg.token, pass.value) });
      else device.save({ owner, repo: name, branch: cfg.branch });
      device.setSession(cfg);
      await enter();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
  });
  app.replaceChildren(h('main', { class: 'gate' }, form));
  (repo.value ? token : repo).focus();
}

// ---------------------------------------------------------------- shell

let ctx;
let busyCount = 0;

addEventListener('beforeunload', (e) => {
  if (busyCount > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

async function enter() {
  const session = device.session();
  if (!session) return gate();
  const waitNote = { el: null };
  const gh = new GitHub({
    ...session,
    onWait: (sec, why) => {
      waitNote.el?.remove();
      waitNote.el = toast(`${why}. Continuing in ${Math.ceil(sec)} s.`, { timeout: Math.min(sec, 60) * 1000 });
    },
  });
  const store = new Store(gh, { siteUrl: SITE_URL });
  app.replaceChildren(h('main', { class: 'gate' }, h('p', { class: 'muted' }, 'Reading your site from GitHub…')));
  try {
    await store.load();
  } catch (ex) {
    if (ex.status === 401) {
      device.endSession();
      return gate('GitHub no longer accepts this token. It may have expired: create a new one and connect again.');
    }
    app.replaceChildren(
      h(
        'main',
        { class: 'gate' },
        h('div', { class: 'gate-card' }, h('h1', {}, 'Could not load'), h('p', { class: 'error' }, ex.message), h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => enter() }, 'Try again'), h('button', { class: 'btn', type: 'button', onclick: () => lock() }, 'Sign out'))),
      ),
    );
    return;
  }
  if (store.site.theme) document.documentElement.dataset.theme = store.site.theme;

  ctx = {
    gh,
    store,
    siteUrl: SITE_URL,
    settings: () => ({ ...DEFAULTS, ...(store.site.processing || {}) }),
    busy: (on) => {
      busyCount = Math.max(0, busyCount + (on ? 1 : -1));
    },
    publish,
    lock,
    forget,
  };

  const tabs = [
    ['photos', 'Photos'],
    ['add', 'Add photos'],
    ['instagram', 'Import from Instagram'],
    ['about', 'About page'],
    ['settings', 'Settings'],
  ];
  const nav = h('nav', { class: 'tabs', 'aria-label': 'Admin sections' }, ...tabs.map(([id, label]) => h('a', { class: 'tab', href: `#${id}`, 'data-tab': id }, label)));
  const publishBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => publish() });
  const name = h('strong', {});
  const bar = h(
    'header',
    { class: 'bar' },
    h('div', { class: 'bar-title' }, name, h('span', { class: 'muted hide-small' }, 'Admin')),
    nav,
    h('div', { class: 'bar-actions' }, h('a', { class: 'btn btn-quiet hide-small', href: SITE_URL, target: '_blank', rel: 'noopener' }, 'View site'), publishBtn),
  );
  const view = h('main', { class: 'view', id: 'main' });
  app.replaceChildren(h('div', { class: 'shell' }, bar, view));

  const refreshBar = () => {
    const n = store.pending;
    name.textContent = store.site.name || 'Your site';
    publishBtn.replaceChildren(...['Publish', n ? h('span', { class: 'badge' }, n) : null].filter(Boolean));
    publishBtn.disabled = !n;
    publishBtn.title = n ? store.summary().text : 'Nothing to publish';
  };
  store.addEventListener('change', refreshBar);
  refreshBar();

  let current;
  const route = () => {
    const id = (location.hash.slice(1) || 'photos').split('/')[0];
    const make = { photos: photosView, add: addView, instagram: instagramView, about: aboutView, settings: settingsView }[id] || photosView;
    current?.cleanup?.();
    current = make(ctx);
    view.replaceChildren(current);
    nav.querySelectorAll('.tab').forEach((t) => (t.dataset.tab === id ? t.setAttribute('aria-current', 'page') : t.removeAttribute('aria-current')));
    scrollTo(0, 0);
  };
  removeEventListener('hashchange', window.__route);
  window.__route = route;
  addEventListener('hashchange', route);
  route();

  if (store.pending) {
    toast(`You have ${store.pending} unpublished change${store.pending === 1 ? '' : 's'} from earlier.`, { action: { label: 'Publish now', run: () => publish() }, timeout: 9000 });
  }
}

// ---------------------------------------------------------------- publish

let publishing = false;
async function publish({ skipConfirm = false } = {}) {
  const { store } = ctx;
  if (!store.pending || publishing) return;
  const sum = store.summary();
  if (!skipConfirm) {
    const choice = await new Promise((resolve) => {
      const m = modal(
        [
          h('h2', { id: 'pub-title' }, 'Publish changes'),
          h('p', {}, `${sum.text[0].toUpperCase()}${sum.text.slice(1)}.`),
          h('p', { class: 'muted' }, 'Your site updates about a minute after publishing.'),
          h(
            'div',
            { class: 'row', style: { justifyContent: 'space-between' } },
            h('button', { class: 'btn btn-danger', type: 'button', onclick: () => (resolve('discard'), m.close()) }, 'Discard changes'),
            h(
              'div',
              { class: 'row' },
              h('button', { class: 'btn', type: 'button', onclick: () => (resolve(null), m.close()) }, 'Cancel'),
              h('button', { class: 'btn btn-primary', type: 'button', onclick: () => (resolve('publish'), m.close()) }, 'Publish'),
            ),
          ),
        ],
        { labelledBy: 'pub-title', onClose: () => resolve(null) },
      );
    });
    if (choice === 'discard') {
      if (await confirmDialog({ title: 'Discard all changes?', body: 'Photos you added here are removed from the list. This cannot be undone.', confirm: 'Discard', danger: true })) {
        store.discard();
        toast('Changes discarded.');
        window.__route?.();
      }
      return;
    }
    if (choice !== 'publish') return;
  }
  publishing = true;
  ctx.busy(true);
  const note = toast('Publishing…', { timeout: 0 });
  try {
    const res = await store.publish((s) => (note.firstChild.textContent = `${s}…`));
    note.remove();
    toast('Published. Your site updates in about a minute.', { timeout: 8000 });
    watchLive(res.updated);
  } catch (ex) {
    console.error(ex);
    note.remove();
    toast(`Not published: ${ex.message}`, { tone: 'bad', timeout: 12000 });
  } finally {
    publishing = false;
    ctx.busy(false);
  }
}

// Poll the live site until the new data shows up.
async function watchLive(updated) {
  const started = Date.now();
  while (Date.now() - started < 6 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 12000));
    try {
      const res = await fetch(`${SITE_URL}data/photos.json?live=${Date.now()}`, { cache: 'no-store' });
      if (res.ok && (await res.json()).updated === updated) {
        toast('Your changes are live.', { action: { label: 'View site', run: () => open(SITE_URL, '_blank') }, timeout: 10000 });
        return;
      }
    } catch {
      /* keep waiting */
    }
  }
}

function lock() {
  device.endSession();
  location.hash = '';
  gate();
}

async function forget() {
  if (!(await confirmDialog({ title: 'Forget this device?', body: 'You will need your access token to sign in here again.', confirm: 'Forget', danger: true }))) return;
  device.forget();
  location.hash = '';
  gate();
}

// ---------------------------------------------------------------- start

if (device.session()) enter();
else gate();
