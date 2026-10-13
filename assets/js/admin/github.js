// Minimal GitHub REST client for publishing from the browser.
// Every publish is a single commit made with the Git Data API (blobs → tree → commit → ref),
// so GitHub Pages rebuilds once per publish rather than once per file.

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GitHub {
  /**
   * @param {{owner:string, repo:string, branch:string, token:string, onWait?:(seconds:number, why:string)=>void}} cfg
   */
  constructor({ owner, repo, branch, token, onWait }) {
    this.owner = owner;
    this.repo = repo;
    this.branch = branch || 'main';
    this.token = token;
    this.onWait = onWait;
  }

  get base() {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  async request(method, path, body, { raw = false, attempt = 0 } = {}) {
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
    } catch (err) {
      if (attempt < 3) {
        await sleep(1500 * (attempt + 1));
        return this.request(method, path, body, { raw, attempt: attempt + 1 });
      }
      throw new GitHubError('Could not reach GitHub. Check your internet connection and try again.', 0, String(err));
    }

    // Rate limits: wait as long as GitHub asks, then try again.
    if ((res.status === 403 || res.status === 429) && attempt < 6) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const remaining = res.headers.get('x-ratelimit-remaining');
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      let wait = 0;
      if (retryAfter) wait = retryAfter;
      else if (remaining === '0' && reset) wait = Math.max(1, reset - Math.floor(Date.now() / 1000));
      else if (res.status === 429) wait = 60;
      else {
        const text = await res.clone().text();
        if (/secondary rate limit/i.test(text)) wait = 60;
      }
      if (wait) {
        this.onWait?.(wait, 'GitHub asked us to slow down');
        await sleep(Math.min(wait, 3600) * 1000 + 500);
        return this.request(method, path, body, { raw, attempt: attempt + 1 });
      }
    }
    if (res.status >= 500 && attempt < 3) {
      await sleep(2000 * (attempt + 1));
      return this.request(method, path, body, { raw, attempt: attempt + 1 });
    }
    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = j.message || '';
      } catch {
        /* not json */
      }
      throw new GitHubError(describe(res.status, detail, path), res.status, detail);
    }
    if (res.status === 204) return null;
    return raw ? res.text() : res.json();
  }

  // ------------------------------------------------------------ checks

  /** Confirms the token can read and write this repository. Returns repo info. */
  async verify() {
    const repo = await this.request('GET', this.base);
    await this.head();
    try {
      await this.createBlobText('ok');
    } catch (err) {
      if (err.status === 403 || err.status === 404) {
        throw new GitHubError(
          "This token can see the repository but can't change it. Edit the token on GitHub and set Contents to “Read and write”.",
          err.status,
        );
      }
      throw err;
    }
    return repo;
  }

  // ------------------------------------------------------------ reading

  async head() {
    try {
      const ref = await this.request('GET', `${this.base}/git/ref/heads/${encodeURIComponent(this.branch)}`);
      const commit = await this.request('GET', `${this.base}/git/commits/${ref.object.sha}`);
      return { commit: ref.object.sha, tree: commit.tree.sha };
    } catch (err) {
      if (err.status === 404 || err.status === 409) {
        throw new GitHubError(`The branch “${this.branch}” wasn't found. Upload the site files to the repository first, then try again.`, err.status);
      }
      throw err;
    }
  }

  async readText(path, ref) {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    return this.request('GET', `${this.base}/contents/${path.split('/').map(encodeURIComponent).join('/')}${q}`, null, { raw: true });
  }

  async readJSON(path, ref) {
    return JSON.parse(await this.readText(path, ref));
  }

  /** All file paths in a tree, as a Set. */
  async paths(treeSha) {
    const t = await this.request('GET', `${this.base}/git/trees/${treeSha}?recursive=1`);
    return new Set(t.tree.filter((e) => e.type === 'blob').map((e) => e.path));
  }

  // ------------------------------------------------------------ writing

  async createBlobBase64(base64) {
    const r = await this.request('POST', `${this.base}/git/blobs`, { content: base64, encoding: 'base64' });
    return r.sha;
  }

  async createBlobText(text) {
    const r = await this.request('POST', `${this.base}/git/blobs`, { content: text, encoding: 'utf-8' });
    return r.sha;
  }

  /**
   * Make one commit on top of the branch.
   * @param {string} message
   * @param {(head:{commit:string,tree:string}) => Promise<Array<{path:string, sha?:string|null, content?:string}>>} build
   *   Called with the current head; returns tree entries. Called again if the branch moved.
   */
  async commit(message, build) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const head = await this.head();
      const entries = await build(head);
      if (!entries.length) return { commit: head.commit, unchanged: true };
      const tree = await this.request('POST', `${this.base}/git/trees`, {
        base_tree: head.tree,
        tree: entries.map((e) =>
          'content' in e
            ? { path: e.path, mode: '100644', type: 'blob', content: e.content }
            : { path: e.path, mode: '100644', type: 'blob', sha: e.sha ?? null },
        ),
      });
      const commit = await this.request('POST', `${this.base}/git/commits`, {
        message,
        tree: tree.sha,
        parents: [head.commit],
      });
      try {
        await this.request('PATCH', `${this.base}/git/refs/heads/${encodeURIComponent(this.branch)}`, { sha: commit.sha, force: false });
        return { commit: commit.sha, unchanged: false };
      } catch (err) {
        // Someone (or another tab) pushed in between: rebuild on the new head.
        if (err.status === 422 && attempt < 2) continue;
        throw err;
      }
    }
    throw new GitHubError('The repository kept changing while publishing. Try again in a moment.', 409);
  }
}

function describe(status, detail, path) {
  if (status === 401) return "GitHub didn't accept this token. Check it was copied in full and hasn't expired.";
  if (status === 404 && /\/repos\/[^/]+\/[^/]+$/.test(path))
    return "This repository wasn't found, or the token doesn't have access to it. When creating the token, choose “Only select repositories” and pick this one.";
  if (status === 404) return `GitHub couldn't find ${path.replace(/^\/repos\/[^/]+\/[^/]+/, '') || 'that item'}.`;
  if (status === 403) return `GitHub refused the request${detail ? `: ${detail}` : ''}. Check the token has Contents set to “Read and write”.`;
  if (status === 409) return 'The repository is empty. Upload the site files first, then sign in again.';
  if (status === 422) return `GitHub rejected the change${detail ? `: ${detail}` : ''}.`;
  return `GitHub returned an error (${status})${detail ? `: ${detail}` : ''}.`;
}
