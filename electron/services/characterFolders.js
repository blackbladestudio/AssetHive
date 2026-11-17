const path = require('node:path');
const fs = require('node:fs/promises');
const { transactionalFs, withFileTransaction } = require('./assetFileTransaction');
const { safePath } = require('./libraryRecycle');

const folders = { model: 'Mesh/StaticMesh', staticMesh: 'Mesh/StaticMesh', skeletalMesh: 'Mesh/SkeletalMesh', texture: 'Texture' };
const normalize = value => String(value).replace(/\\/g, '/').toLowerCase();

// Explicit maintenance for legacy managed copies. Source paths and UE references
// are never moved. Existing version directories retain their revision identity.
async function organizeCharacterFolders(root, assetDir, dryRun = true) {
  await safePath(root, assetDir);
  const metaPath = path.join(assetDir, 'asset_info.json');
  const raw = await fs.readFile(metaPath, 'utf8');
  const meta = JSON.parse(raw);
  if (!['suit', 'weapon', 'monster', 'npc'].includes(meta.assetType)) throw new Error('Not a character asset');
  const moves = new Map();
  function collect(value) {
    if (!value || typeof value !== 'object') return;
    if (value.storedPath && folders[value.role]) {
      const relative = String(value.storedPath).replace(/\\/g, '/');
      const version = relative.match(/^Versions\/[^/]+\//i)?.[0] || '';
      const target = `${version}${folders[value.role]}/${path.basename(relative)}`;
      if (normalize(relative) !== normalize(target)) moves.set(normalize(relative), { from: relative, to: target });
    }
    Object.values(value).forEach(collect);
  }
  collect(meta);
  const plan = [];
  for (const move of moves.values()) {
    const source = path.resolve(assetDir, move.from), target = path.resolve(assetDir, move.to);
    await safePath(assetDir, source, { missing: true });
    await safePath(assetDir, target, { missing: true });
    const exists = await fs.stat(source).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!exists) continue; // An obsolete history snapshot may refer to a removed file.
    if (!exists.isFile()) throw new Error(`Not a file: ${source}`);
    if (await fs.stat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw new Error(`Destination already exists: ${target}`);
    plan.push({ ...move, source, target });
  }
  if (dryRun || !plan.length) return { dryRun, moves: plan };
  const absolute = new Map(plan.map(move => [normalize(move.source), move.target]));
  const relative = new Map(plan.map(move => [normalize(move.from), move.to]));
  const sourceFields = new Set(['originalPath', 'sourcePath', 'sourcePaths', 'sourceFolder', 'originalName', 'normalizedName', 'name']);
  function rewrite(value, key = '') {
    if (sourceFields.has(key)) return value;
    if (typeof value === 'string') return absolute.get(normalize(value))
      || (['storedPath', 'uri', 'path', 'meshPath', 'modelPath'].includes(key) ? relative.get(normalize(value)) : '') || value;
    if (Array.isArray(value)) return value.map(item => rewrite(item, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v, k)]));
    return value;
  }
  return withFileTransaction({ root, owner: 'character-folders', key: metaPath }, async () => {
    if (await fs.readFile(metaPath, 'utf8') !== raw) throw new Error('Asset changed; retry folder organization');
    for (const move of plan) {
      await transactionalFs.mkdir(path.dirname(move.target), { recursive: true });
      await transactionalFs.rename(move.source, move.target);
    }
    const updated = rewrite(meta);
    updated.characterFolderLayout = 1;
    await transactionalFs.writeFile(metaPath, JSON.stringify(updated, null, 2));
    return { dryRun: false, moves: plan };
  });
}

module.exports = { organizeCharacterFolders };
