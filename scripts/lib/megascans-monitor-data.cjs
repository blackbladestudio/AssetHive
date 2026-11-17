const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { assetId, inside } = require('./megascans-transfer.cjs');
const { receiptPath, storageId } = require('./megascans-paths.cjs');

class MonitorLibrary {
  constructor(library) { this.library = path.resolve(library); this.rows = new Map(); this.lastScan = 0; }
  async readAsset(id) {
    assetId(id);
    const receipt = JSON.parse(await fs.readFile(await receiptPath(this.library, id), 'utf8'));
    if (receipt.id !== id || !receipt.archive) throw new Error('资产完成记录无效');
    const folder = path.resolve(this.library, (receipt.imported || receipt.archive).root);
    if (!inside(this.library, folder)) throw new Error('资产目录越界');
    const metadataFile = receipt.imported ? path.join(folder, 'asset_info.json') : path.join(folder, `${id}.json`);
    const meta = JSON.parse(await fs.readFile(metadataFile, 'utf8'));
    const candidates = [meta.previewImage, meta.previews?.preview, ...(meta.previews?.images || [])].filter(Boolean);
    let preview = '';
    for (const item of candidates) {
      const raw = typeof item === 'string' ? item : item.uri;
      if (typeof raw !== 'string' || !/\.(png|jpe?g|webp)$/i.test(raw)) continue;
      const file = path.resolve(folder, raw);
      if (inside(folder, file)) { preview = pathToFileURL(file).href; break; }
    }
    return { id, name: meta.name || id, assetType: meta.assetType || meta.categories?.[0] || '',
      status: receipt.imported ? 'imported' : 'archived', completedAt: receipt.completedAt,
      folder, preview, reason: receipt.archivedOnlyReason || '' };
  }
  async list({ query = '', offset = 0, force = false } = {}) {
    if (force || Date.now() - this.lastScan > 5000) {
      let files;
      try { files = await fs.readdir(path.join(this.library, '.megascans', 'receipts')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
      const ids = files.filter(file => /^(?:[a-zA-Z0-9_-]+|~[0-9a-f]+)\.json$/.test(file)).map(file => storageId(file.slice(0, -5)));
      const present = new Set(ids);
      for (const id of this.rows.keys()) if (!present.has(id)) this.rows.delete(id);
      const unread = ids.filter(id => force || !this.rows.has(id) || this.rows.get(id)?.unreadable);
      for (let i = 0; i < unread.length; i += 16) {
        await Promise.all(unread.slice(i, i + 16).map(async id => {
          try { this.rows.set(id, await this.readAsset(id)); }
          catch { this.rows.set(id, { id, unreadable: true }); }
        }));
      }
      this.lastScan = Date.now();
    }
    const all = [...this.rows.values()].filter(row => !row.unreadable);
    const needle = String(query).slice(0, 200).toLowerCase();
    const filtered = all.filter(row => `${row.id} ${row.name} ${row.assetType}`.toLowerCase().includes(needle))
      .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)) || a.id.localeCompare(b.id));
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    return { items: filtered.slice(start, start + 30), total: filtered.length, offset: start,
      imported: all.filter(row => row.status === 'imported').length,
      archived: all.filter(row => row.status === 'archived').length,
      unreadable: this.rows.size - all.length };
  }
}

module.exports = { MonitorLibrary };
