const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeFileAtomic } = require('./atomicFile');
const normalize = value => String(value || '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

// Local profile only: colleagues and relocated checkouts must check independently.
function createUnrealWorkspaceCheck(directory) {
  const active = new Map(), complete = new Set();
  return async function ensure({ projectPath, libraryPath, assets, refresh, isCurrent = () => true }) {
    if (!projectPath || !libraryPath || !assets.length) return { checked: false, deferred: true };
    const key = crypto.createHash('sha256').update(normalize(libraryPath) + '|' + normalize(projectPath)).digest('hex');
    if (complete.has(key)) return { checked: false };
    if (active.has(key)) return active.get(key);
    const work = (async () => {
      const file = path.join(directory, key + '.json');
      try {
        const saved = JSON.parse(await fs.readFile(file, 'utf8'));
        if (saved.version === 2 && normalize(saved.projectPath) === normalize(projectPath) && normalize(saved.libraryPath) === normalize(libraryPath)) {
          complete.add(key); return { checked: false };
        }
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      for (const asset of assets) {
        if (!isCurrent()) throw new Error('工作区已切换，未保存首次核验记录');
        await refresh(asset);
      }
      if (!isCurrent()) throw new Error('工作区已切换，未保存首次核验记录');
      await fs.mkdir(directory, { recursive: true });
      await writeFileAtomic(file, JSON.stringify({ version: 2, projectPath, libraryPath, checkedAt: new Date().toISOString(), assetIds: assets.map(asset => asset.id) }));
      complete.add(key);
      return { checked: true, count: assets.length };
    })();
    active.set(key, work);
    try { return await work; } finally { active.delete(key); }
  };
}
module.exports = { createUnrealWorkspaceCheck };
