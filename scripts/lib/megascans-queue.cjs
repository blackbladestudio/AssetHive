const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicJson, catalogAssetType } = require('./megascans-transfer.cjs');
const ORDER = ['3d', '3dplant', 'surface', 'decal', 'hdri'];
const DEFAULT_TYPES = ['3d', 'surface', 'decal'];

function selectedTypes(value = DEFAULT_TYPES) {
  const types = typeof value === 'string' ? value.split(',').map(type => type.trim().toLowerCase()) : value;
  if (!Array.isArray(types) || !types.length || types.some(type => !ORDER.includes(type))) throw new Error('请选择有效资产类型：3d,3dplant,surface,decal,hdri');
  return ORDER.filter(type => types.includes(type));
}

async function orderedCatalog(ids, { client, cacheRoot, assetTypes, shouldStop = async () => false, onProgress = async () => {}, concurrency = 4 }) {
  const order = selectedTypes(assetTypes);
  const file = path.join(cacheRoot, 'asset-types.json');
  let types = {}, unavailable = {};
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    if (saved.version === 1) { types = saved.types; unavailable = saved.unavailable || {}; }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const validTypes = [...ORDER, 'other', 'unavailable'];
  const missing = ids.filter(id => !validTypes.includes(types[id]));
  const persist = () => atomicJson(file, { version: 1, updatedAt: new Date().toISOString(), types, unavailable });
  let classified = ids.length - missing.length;
  await onProgress({ stage: 'ordering', orderingDone: classified, orderingTotal: ids.length });
  for (let index = 0; index < missing.length; index += concurrency) {
    if (await shouldStop()) { await persist(); return { paused: true }; }
    const batch = missing.slice(index, index + concurrency);
    const results = await Promise.allSettled(batch.map(async id => {
      try { types[id] = catalogAssetType(await client.metadata(id)); }
      catch (error) {
        if (error.status !== 404) throw error;
        types[id] = 'unavailable';
        unavailable[id] = { status: 404, reason: '已购 ID 的源站目录返回 404', checkedAt: new Date().toISOString() };
      }
      classified++;
    }));
    if (index % 32 === 0 || index + concurrency >= missing.length || results.some(result => result.status === 'rejected')) await persist();
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    await onProgress({ stage: 'ordering', orderingDone: classified, orderingTotal: ids.length, unavailable: Object.keys(unavailable).length });
  }
  const counts = Object.fromEntries(order.map(type => [type, 0]));
  const position = new Map(ids.map((id, index) => [id, index]));
  const selected = ids.filter(id => order.includes(types[id]));
  for (const id of selected) counts[types[id]]++;
  selected.sort((a, b) => ORDER.indexOf(types[a]) - ORDER.indexOf(types[b]) || position.get(a) - position.get(b));
  return { ids: selected, types, counts, excluded: ids.length - selected.length, unavailable: Object.keys(unavailable).length };
}

module.exports = { ORDER, DEFAULT_TYPES, selectedTypes, orderedCatalog };
