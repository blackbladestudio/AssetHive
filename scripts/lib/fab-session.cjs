const fs = require('node:fs/promises');
const path = require('node:path');
const { ImportWorker } = require('./megascans-import-worker.cjs');

// Cookies stay inside a dedicated Chromium profile. Only allow read-only Fab
// listing APIs over the existing private worker protocol; never send cookies
// to Node, logs, a CDN or another origin.
function listingApiUrl(input) {
  const url = new globalThis.URL(input);
  const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  const pattern = new RegExp(`^/i/listings/${uuid}(?:/asset-formats(?:/[a-z0-9-]+/files/${uuid}/download-info)?)?$`, 'i');
  if (url.origin !== 'https://www.fab.com' || url.username || url.password || url.search || url.hash || !pattern.test(url.pathname)) {
    throw new Error('Fab 会话仅允许读取官方商品接口');
  }
  return url.href;
}

async function readListingResponse(session, input) {
  const url = listingApiUrl(input);
  const response = await session.fetch(url, { method: 'GET', credentials: 'include', redirect: 'error',
    signal: globalThis.AbortSignal.timeout(60000) });
  // Bound IPC messages, including a broken or unexpected server response.
  const reader = response.body?.getReader(), chunks = [];
  let length = 0;
  if (reader) try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8 * 1024 * 1024) throw new Error('Fab 接口响应超过会话大小限制');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const { Buffer } = require('node:buffer');
  return { ok: true, status: response.status, body: Buffer.concat(chunks).toString('utf8') };
}

class FabSession {
  constructor(cacheRoot, { worker } = {}) {
    this.root = path.join(cacheRoot, 'fab-session');
    // Reuse the sequential private job protocol, with a separate entry/profile.
    this.worker = worker || new ImportWorker({ cacheRoot: this.root,
      entry: path.resolve(__dirname, '../fab-session-electron.cjs') });
  }
  async available() {
    try { return JSON.parse(await fs.readFile(path.join(this.root, 'status.json'), 'utf8')).ready === true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async fetch(url) {
    const result = await this.worker.run({ url: listingApiUrl(url) });
    return new globalThis.Response(result.body, { status: result.status, headers: { 'content-type': 'application/json' } });
  }
  async close() { await this.worker.close(); }
}

module.exports = { FabSession, listingApiUrl, readListingResponse };
