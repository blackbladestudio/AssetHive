const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { gzipSync, gunzipSync } = require('node:zlib');
const { isImperfectionMetadata } = require('../electron/services/imperfectionClassification');
const { writeAssetMetadata } = require('../electron/services/assetMetadata');
const { writeFileAtomic } = require('../electron/services/atomicFile');
const { inside, inventory, verifyInventory } = require('./lib/megascans-transfer.cjs');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const comparePath = value => String(value).replace(/\\/g, '/').toLowerCase();
async function exists(file) {
  try { await fs.stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function relocate(value, from, to) {
  if (typeof value === 'string') {
    const normalized = comparePath(value), prefix = comparePath(from);
    if (normalized !== prefix && !normalized.startsWith(prefix + '/')) return value;
    const replacement = value.includes('\\') ? to : to.replace(/\\/g, '/');
    return replacement + value.slice(from.length);
  }
  if (Array.isArray(value)) return value.map(item => relocate(item, from, to));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item, from, to)]));
  return value;
}

function reclassify(value) {
  const result = { ...value, assetType: 'imperfection', topCategory: 'environment' };
  if ('asset_type' in value) result.asset_type = 'imperfection';
  const clean = values => [...new Set([...(values || []).filter(item => !/^surfaces?$/i.test(item)), 'imperfection'])];
  if (Array.isArray(value.tags)) result.tags = clean(value.tags);
  if (Array.isArray(value.categories)) result.categories = clean(value.categories);
  if (value.semanticTags) result.semanticTags = { ...value.semanticTags, asset_type: 'imperfection',
    ...(Array.isArray(value.semanticTags.contains) ? { contains: clean(value.semanticTags.contains) } : {}) };
  if (value.meta) result.meta = reclassify(value.meta);
  return result;
}

async function buildPlan(library) {
  const root = await fs.realpath(library);
  const sourceRoot = await fs.realpath(path.join(root, 'Environment', 'Surfaces'));
  const targetRoot = path.join(root, 'Environment', 'Imperfections');
  const indexFile = path.join(root, '.assethive', 'custom-index.json.gz');
  const index = JSON.parse(gunzipSync(await fs.readFile(indexFile)));
  const items = [];
  for (const entry of index.assets) {
    const record = entry.record;
    if (!isImperfectionMetadata(record?.meta, { legacy: true }) || record.assetType === 'imperfection') continue;
    const from = await fs.realpath(record.path);
    if (!inside(sourceRoot, from) || path.dirname(from).toLowerCase() !== sourceRoot.toLowerCase()) throw Error('Unexpected migration source: ' + from);
    const to = path.join(targetRoot, path.basename(from));
    if (!inside(root, to) || await exists(to)) throw Error('Migration destination already exists or escapes library: ' + to);
    const bytes = await fs.readFile(path.join(from, 'asset_info.json'));
    const meta = JSON.parse(bytes);
    if (meta.assetID !== record.id || !isImperfectionMetadata(meta, { legacy: true })) throw Error('Metadata identity/classification changed: ' + from);
    items.push({ id: record.id, nativeId: meta.identity.sourceAssetId, from, to, metadataHash: digest(bytes), meta });
  }
  if (new Set(items.map(item => comparePath(item.to))).size !== items.length) throw Error('Duplicate migration destination');
  return { version: 1, library: root, createdAt: new Date().toISOString(), items };
}

async function patchMemo(file, items, backupDir, referenceEntries = []) {
  if (!await exists(file)) return false;
  const bytes = await fs.readFile(file);
  const compressed = file.endsWith('.gz');
  const memo = JSON.parse(compressed ? gunzipSync(bytes) : bytes.toString('utf8'));
  const byId = new Map(items.map(item => [item.id, item]));
  const presentIds = new Set((memo.assets || []).map(entry => entry.record?.id));
  for (const entry of referenceEntries) {
    if (byId.has(entry.record?.id) && !presentIds.has(entry.record.id)) {
      memo.assets.push(entry);
      presentIds.add(entry.record.id);
    }
  }
  let changed = 0;
  for (let index = 0; index < (memo.assets || []).length; index++) {
    const entry = memo.assets[index], item = byId.get(entry.record?.id);
    if (!item) continue;
    const current = comparePath(entry.record.path);
    if (![comparePath(item.from), comparePath(item.to)].includes(current)) throw Error('Concurrent index identity change: ' + item.id);
    const next = relocate(entry, item.from, item.to);
    next.record = reclassify({ ...next.record, ...item.record });
    next.record.meta = reclassify(item.meta);
    const stat = await fs.stat(path.join(item.to, 'asset_info.json'));
    next.metaMtimeMs = stat.mtimeMs;
    next.metaSize = stat.size;
    if ('dirMtimeMs' in next) next.dirMtimeMs = (await fs.stat(item.to)).mtimeMs;
    memo.assets[index] = next;
    changed++;
  }
  if (!changed) return false;
  // Keep unrelated records and schema intact; never publish over a new snapshot.
  if (digest(await fs.readFile(file)) !== digest(bytes)) throw Error('Concurrent index update: ' + file);
  const key = crypto.createHash('sha256').update(file).digest('hex').slice(0, 12);
  await fs.writeFile(path.join(backupDir, key + '-' + path.basename(file)), bytes, { flag: 'wx' });
  memo.generatedAt = new Date().toISOString();
  const text = JSON.stringify(memo);
  await writeFileAtomic(file, compressed ? gzipSync(text) : text);
  return changed;
}

async function syncLocalCaches(cacheDirs, plan, reportDir) {
  const { DatabaseSync } = require('node:sqlite');
  const { toAssetListRecord } = require('../electron/services/assetListRecord');
  const { getAssetDetailsByMetaPath } = require('../electron/services/assetScanner');
  const items = plan.items;
  for (const item of items) {
    item.meta = JSON.parse(await fs.readFile(path.join(item.to, 'asset_info.json')));
    if (item.meta.assetID !== item.id || item.meta.assetType !== 'imperfection') throw Error('Migration is not complete: ' + item.id);
    item.record = await getAssetDetailsByMetaPath(path.join(item.to, 'asset_info.json'), 'custom');
    if (item.record?.id !== item.id) throw Error('Cannot rebuild migrated card: ' + item.id);
  }
  await fs.mkdir(reportDir, { recursive: true });
  const key = crypto.createHash('sha256').update(path.resolve(plan.library).toLowerCase()).digest('hex').slice(0, 16);
  const byId = new Map(items.map(item => [item.id, item]));
  const results = [];
  const reference = JSON.parse(gunzipSync(await fs.readFile(path.join(plan.library, '.assethive/custom-index.json.gz'))));
  const mainIndex = path.join(plan.library, '.assethive/custom-index.json.gz');
  results.push({ file: mainIndex, updated: await patchMemo(mainIndex, items, reportDir) });
  const legacyIndex = path.join(plan.library, '.assethive/custom-index.json');
  results.push({ file: legacyIndex, updated: await patchMemo(legacyIndex, items, reportDir, reference.assets) });
  for (const dir of cacheDirs) {
    const memoFile = path.join(dir, key + '.memo.json.gz');
    results.push({ file: memoFile, updated: await patchMemo(memoFile, items, reportDir, reference.assets) });
    const file = path.join(dir, key + '.sqlite');
    if (!await exists(file)) continue;
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      const before = [];
      const columns = new Set(db.prepare('PRAGMA table_info(assets)').all().map(row => row.name));
      for (const row of db.prepare('SELECT * FROM assets').all()) {
        const item = byId.get(row.id);
        if (!item) continue;
        if (![comparePath(item.from), comparePath(item.to)].includes(comparePath(row.path))) throw Error('SQLite identity changed: ' + row.id);
        before.push(row);
        const next = relocate(row, item.from, item.to);
        next.assetType = 'imperfection';
        next.topCategory = 'environment';
        next.tagsJson = JSON.stringify(item.record.tags);
        next.themesJson = JSON.stringify(item.record.themes);
        if (columns.has('listRecordJson') && row.listRecordJson) {
          const record = reclassify({ ...relocate(JSON.parse(row.listRecordJson), item.from, item.to), ...item.record });
          next.listRecordJson = JSON.stringify(toAssetListRecord(record));
        }
        const fields = ['path', 'metaPath', 'previewImage', 'detailImage', 'assetType', 'topCategory', 'tagsJson', 'themesJson', 'listRecordJson'].filter(field => columns.has(field));
        db.prepare(`UPDATE assets SET ${fields.map(field => field + '=?').join(',')} WHERE id=?`).run(...fields.map(field => next[field]), row.id);
      }
      const backupKey = digest(file).slice(0, 12);
      await fs.writeFile(path.join(reportDir, backupKey + '-sqlite-before.json'), JSON.stringify(before), { flag: 'wx' });
      db.exec('COMMIT');
      if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('SQLite integrity check failed: ' + file);
      results.push({ file, updated: before.length });
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    } finally { db.close(); }
  }
  await writeFileAtomic(path.join(reportDir, 'result.json'), JSON.stringify(results, null, 2));
  return results;
}

async function restoreBridgeCategories(plan, audit, reportDir) {
  const { resolveMegascansCategory, CATEGORY_OPTIONS } = require('../electron/services/megascansCategory');
  if (audit.failures?.length || audit.results.length !== plan.items.length) throw Error('Bridge source audit is incomplete');
  const sources = new Map(audit.results.map(item => [item.id, item]));
  const changes = [];
  // Check all source identities and categories before changing shared metadata.
  for (const item of plan.items) {
    const info = sources.get(item.id);
    if (info?.nativeId !== item.nativeId) throw Error('Bridge source audit identity mismatch: ' + item.id);
    const bytes = await fs.readFile(info.sourceFile);
    if (digest(bytes) !== info.sourceSha256) throw Error('Bridge source metadata changed: ' + item.id);
    const source = JSON.parse(bytes);
    if (source.id !== item.nativeId || source.semanticTags?.asset_type !== 'imperfection'
      || !source.assetCategories?.imperfection) throw Error('Source is not an explicit Bridge Imperfection: ' + item.id);
    const category = resolveMegascansCategory(source, 'imperfection');
    if (!CATEGORY_OPTIONS.imperfection.includes(category)) throw Error('Unknown Bridge category: ' + item.id);
    const file = path.join(item.to, 'asset_info.json'), before = await fs.readFile(file), meta = JSON.parse(before);
    if (meta.assetID !== item.id || meta.assetType !== 'imperfection' || meta.identity?.sourceAssetId !== item.nativeId) throw Error('Library identity changed: ' + item.id);
    changes.push({ item, source, category, file, before, hash: digest(before), meta, sourceSha256: info.sourceSha256 });
  }
  await fs.mkdir(reportDir, { recursive: true });
  const result = { startedAt: new Date().toISOString(), planned: changes.length, updated: [], categories: {} };
  const save = () => writeFileAtomic(path.join(reportDir, 'result.json'), JSON.stringify(result, null, 2));
  await save();
  for (const change of changes) {
    const { item, source, category, file, before, meta } = change;
    if (digest(await fs.readFile(file)) !== change.hash) throw Error('Concurrent metadata edit: ' + item.id);
    await fs.writeFile(path.join(reportDir, item.id + '.before.json'), before, { flag: 'wx' });
    const oldCategory = String(meta.category || '').toLowerCase();
    const clean = values => (values || []).filter(value => String(value).toLowerCase() !== oldCategory);
    const tags = [...new Set([...clean(meta.tags), 'imperfection', category, ...(meta.standardAssetTags || [])])];
    const now = new Date().toISOString();
    const next = { ...meta, category, tags, categories: [...new Set([...clean(meta.categories), 'environment', 'imperfection', category.toLowerCase()])],
      semanticTags: { ...meta.semanticTags, asset_type: 'imperfection', subject_matter: category, theme: [category], contains: [...new Set([...clean(meta.semanticTags?.contains), ...tags])] },
      sourceClassification: { source: 'quixel', sourceAssetId: source.id, assetType: 'imperfection', assetCategories: source.assetCategories,
        categories: source.categories || [], semanticTags: source.semanticTags || {}, metadataSha256: change.sourceSha256, recordedAt: now },
      revision: (Number(meta.revision) || 0) + 1, updatedAt: now };
    await writeAssetMetadata(item.to, next);
    const saved = JSON.parse(await fs.readFile(file));
    if (saved.assetID !== meta.assetID || JSON.stringify(saved.identity) !== JSON.stringify(meta.identity)
      || saved.category !== category || JSON.stringify(saved.textureEntries) !== JSON.stringify(meta.textureEntries)) throw Error('Bridge category verification failed: ' + item.id);
    result.updated.push({ id: item.id, nativeId: item.nativeId, category });
    result.categories[category] = (result.categories[category] || 0) + 1;
    if (result.updated.length % 100 === 0) { await save(); console.log(JSON.stringify({ categoriesUpdated: result.updated.length, total: changes.length })); }
  }
  result.completedAt = new Date().toISOString();
  await save();
  return result;
}

async function applyPlan(plan, reportDir) {
  const root = await fs.realpath(plan.library);
  if (root !== plan.library) throw Error('Library path changed');
  const sourceRoot = await fs.realpath(path.join(root, 'Environment', 'Surfaces'));
  const targetRoot = path.join(root, 'Environment', 'Imperfections');
  if (await exists(targetRoot) && comparePath(await fs.realpath(targetRoot)) !== comparePath(targetRoot)) throw Error('Destination is a link');
  // Validate every absolute source and destination before the first move.
  for (const item of plan.items) {
    if (comparePath(path.dirname(item.from)) !== comparePath(sourceRoot)
      || comparePath(path.dirname(item.to)) !== comparePath(targetRoot)
      || !inside(root, item.from) || !inside(root, item.to)
      || comparePath(await fs.realpath(item.from)) !== comparePath(item.from)
      || await exists(item.to)) throw Error('Unsafe or occupied migration path: ' + item.id);
    const bytes = await fs.readFile(path.join(item.from, 'asset_info.json'));
    if (digest(bytes) !== item.metadataHash || !isImperfectionMetadata(JSON.parse(bytes), { legacy: true })) throw Error('Metadata changed after planning: ' + item.id);
  }
  await fs.mkdir(reportDir, { recursive: true });
  const report = { startedAt: new Date().toISOString(), library: root, planned: plan.items.length, migrated: [], caches: [] };
  const saveReport = () => writeFileAtomic(path.join(reportDir, 'result.json'), JSON.stringify(report, null, 2));
  await saveReport();
  await fs.mkdir(targetRoot, { recursive: true });
  for (const item of plan.items) {
    const originalBytes = await fs.readFile(path.join(item.from, 'asset_info.json'));
    if (digest(originalBytes) !== item.metadataHash) throw Error('Concurrent asset edit: ' + item.id);
    const files = await inventory(item.from, { include: file => file !== 'asset_info.json' });
    const backup = path.join(reportDir, item.id + '.before.json');
    await fs.writeFile(backup, originalBytes, { flag: 'wx' });
    await writeFileAtomic(path.join(reportDir, item.id + '.files.json'), JSON.stringify(files));
    await fs.rename(item.from, item.to);
    try {
      const meta = reclassify(relocate(item.meta, item.from, item.to));
      meta.updatedAt = new Date().toISOString();
      await writeAssetMetadata(item.to, meta);
      await verifyInventory(item.to, files);
      item.meta = JSON.parse(await fs.readFile(path.join(item.to, 'asset_info.json')));
      if (item.meta.assetID !== item.id || item.meta.identity.sourceAssetId !== item.nativeId) throw Error('Identity changed');
    } catch (error) {
      await writeFileAtomic(path.join(item.to, 'asset_info.json'), originalBytes);
      await fs.rename(item.to, item.from);
      throw error;
    }
    report.migrated.push({ id: item.id, nativeId: item.nativeId, from: item.from, to: item.to, files: files.length });
    if (report.migrated.length % 25 === 0) {
      await saveReport();
      console.log(JSON.stringify({ migrated: report.migrated.length, total: plan.items.length }));
    }
  }
  await saveReport();
  for (const name of ['custom-index.json.gz', 'custom-index.json']) {
    const file = path.join(root, '.assethive', name);
    report.caches.push({ file, updated: await patchMemo(file, plan.items, reportDir) });
    await saveReport();
  }
  report.completedAt = new Date().toISOString();
  await saveReport();
  return report;
}

if (require.main === module) {
  (async () => {
    const args = require('node:util').parseArgs({ options: { library: { type: 'string' }, plan: { type: 'string' }, apply: { type: 'boolean' }, report: { type: 'string' }, 'cache-dir': { type: 'string', multiple: true }, 'classification-audit': { type: 'string' } } }).values;
    if (!args.plan) throw Error('Provide --plan <file>; planning is read-only on the library');
    if (args['classification-audit']) {
      if (!args.report) throw Error('Provide a fresh --report directory for metadata backups');
      const result = await restoreBridgeCategories(JSON.parse(await fs.readFile(args.plan)), JSON.parse(await fs.readFile(args['classification-audit'])), path.resolve(args.report));
      console.log(JSON.stringify({ updated: result.updated.length, categories: result.categories }));
    } else if (args['cache-dir']) {
      if (!args.report) throw Error('Provide a fresh --report directory for cache backups');
      console.log(JSON.stringify(await syncLocalCaches(args['cache-dir'], JSON.parse(await fs.readFile(args.plan)), path.resolve(args.report))));
    } else if (args.apply) {
      if (!args.report) throw Error('Provide a fresh --report directory for backups and verification');
      const result = await applyPlan(JSON.parse(await fs.readFile(args.plan)), path.resolve(args.report));
      console.log(JSON.stringify({ migrated: result.migrated.length, report: path.resolve(args.report, 'result.json') }));
    } else {
      if (!args.library) throw Error('Provide --library');
      const plan = await buildPlan(args.library);
      await fs.mkdir(path.dirname(path.resolve(args.plan)), { recursive: true });
      await writeFileAtomic(args.plan, JSON.stringify(plan, null, 2));
      console.log(JSON.stringify({ planned: plan.items.length, plan: path.resolve(args.plan) }));
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { buildPlan, applyPlan, patchMemo, syncLocalCaches, restoreBridgeCategories, relocate, reclassify };
