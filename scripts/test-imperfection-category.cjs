const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { gzipSync, gunzipSync } = require('node:zlib');
const { isImperfectionMetadata } = require('../electron/services/imperfectionClassification');
const { normalizeAssetType, resolveMegascansCategory } = require('../electron/services/megascansCategory');
const { normalizeAssetType: syncedType, getSyncedTopCategory } = require('../electron/services/libraryMetadataSync');
const { writeAssetMetadata } = require('../electron/services/assetMetadata');
const { scanLibrary, searchAssets } = require('../electron/services/assetScanner');
const { runImportJob } = require('../electron/services/megascansBatchImport');
const { buildPlan, applyPlan, syncLocalCaches, restoreBridgeCategories } = require('./migrate-imperfections.cjs');
const { loadApplicationServices } = require('./application-service-harness.cjs');
const { buildDrafts } = require('./import-draft-harness.cjs');

async function fixture(t) {
  const parent = path.resolve(__dirname, '../.tmp/imperfection-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'case-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(parent));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return root;
}

test('Imperfections normalize independently and descriptive plural tags do not select a migration', () => {
  for (const alias of ['imperfection', 'Imperfections', 'surfaceimperfection']) {
    assert.equal(normalizeAssetType(alias), 'imperfection');
    assert.equal(syncedType(alias), 'imperfection');
  }
  assert.equal(getSyncedTopCategory('imperfection'), 'environment');
  assert.equal(resolveMegascansCategory({ assetCategories: { imperfection: { dirt: {} } }, categories: ['imperfection', 'dust'] }, 'imperfection'), 'Dirt');
  assert.equal(isImperfectionMetadata({ type: 'surface', semanticTags: { asset_type: 'imperfection' } }), true);
  for (const category of ['Damage', 'Dirt', 'Fingerprint', 'Frost', 'Grain', 'Grunge', 'Leakage', 'Metal', 'Rubber', 'Stain', 'Stone', 'Wipe Mark', 'Other']) {
    assert.equal(resolveMegascansCategory({ assetCategories: { imperfection: { [category.toLowerCase()]: {} } } }, 'imperfection'), category);
  }
  assert.equal(resolveMegascansCategory({ assetCategories: { imperfection: { dirt: {}, metal: {} } }, categories: ['imperfection', 'metal'] }, 'imperfection'), 'Metal');
  const base = { assetType: 'surface', identity: { sourceKind: 'megascans' }, textureEntries: [{ textureType: 'Roughness' }] };
  assert.equal(isImperfectionMetadata({ ...base, tags: ['surfaceimperfection'] }, { legacy: true }), true);
  assert.equal(isImperfectionMetadata({ ...base, tags: ['imperfection'] }, { legacy: true }), true);
  assert.equal(isImperfectionMetadata({ ...base, tags: ['imperfections'] }, { legacy: true }), false);
  assert.equal(isImperfectionMetadata({ ...base, tags: ['imperfection'], textureEntries: [{ textureType: 'Diffuse' }, ...base.textureEntries] }, { legacy: true }), false);
});

test('real Bridge Imperfection imports and drafts retain their independent type and texture slots', async t => {
  const root = await fixture(t), library = path.join(root, 'Library');
  const source = path.join(library, '.megascans', 'originals', 'dustfixture');
  await fs.mkdir(source, { recursive: true });
  await require('sharp')({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).png().toFile(path.join(source, 'roughness.png'));
  await fs.writeFile(path.join(source, 'dustfixture.json'), JSON.stringify({ id: 'dustfixture', name: 'Dust', type: 'surface',
    source: 'quixel', assetCategories: { imperfection: { dirt: {}, damage: {} } }, semanticTags: { asset_type: 'imperfection' }, categories: ['imperfection', 'dust'], maps: [{ type: 'roughness', uri: 'roughness.png' }] }));
  const services = await loadApplicationServices(root);
  const result = await runImportJob({ id: 'dustfixture', source, library }, {
    readMetadata: services.readMegascansDropMetadata, importAsset: payload => services.importCustomAsset(payload, null)
  });
  assert.equal(result.ok, true);
  assert.equal(path.basename(path.dirname(result.assetPath)), 'Imperfections');
  const meta = JSON.parse(await fs.readFile(path.join(result.assetPath, 'asset_info.json')));
  assert.equal(meta.assetType, 'imperfection');
  assert.equal(meta.category, 'Dirt');
  assert.deepEqual(meta.sourceClassification.assetCategories, { imperfection: { dirt: {}, damage: {} } });
  const imported = await scanLibrary(library);
  assert.equal(searchAssets(imported, { assetTypes: ['imperfection'], themes: ['Dirt'] }).length, 1);
  assert.equal(searchAssets(imported, { assetTypes: ['imperfection'], themes: ['Damage'] }).length, 1);
  assert.ok(meta.textureEntries.some(entry => entry.textureType === 'Roughness'));
  const { drafts } = await buildDrafts([path.join(source, 'roughness.png')], {
    metadata: { name: 'Dust', assetType: 'imperfection', category: 'Other', standardAssetTags: ['Megascans'], tags: ['imperfection', 'dust'] }
  });
  assert.equal(drafts[0].form.assetType, 'imperfection');
  assert.equal(drafts[0].form.tagsText.split(/,\s*/).includes('imperfection'), false);
});

async function migrationFixture(t) {
  const root = await fixture(t), library = path.join(root, 'Library');
  for (const [id, tags] of [['dust', ['surfaceimperfection']], ['wood', ['imperfections']]]) {
    const dir = path.join(library, 'Environment', 'Surfaces', id);
    await fs.mkdir(dir, { recursive: true });
    await require('sharp')({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).png().toFile(path.join(dir, 'roughness.png'));
    await writeAssetMetadata(dir, { assetID: id, name: id, assetType: 'surface', topCategory: 'environment', category: 'Other',
      tags, createdAt: '2020-01-01T00:00:00Z', identity: { sourceKind: 'megascans', sourceAssetId: id, contentFingerprint: 'unchanged' },
      previewImage: path.join(dir, 'roughness.png'), textureEntries: [{ textureType: 'Roughness', uri: 'roughness.png', resolution: '4K' }] });
  }
  const records = await scanLibrary(library);
  const assets = [];
  for (const record of records) {
    const stat = await fs.stat(record.metaPath);
    assets.push({ metaPath: record.metaPath, metaMtimeMs: stat.mtimeMs, metaSize: stat.size, record });
  }
  const memo = { version: 2, generatedAt: 'before', root: library, assets };
  await fs.mkdir(path.join(library, '.assethive'), { recursive: true });
  await fs.writeFile(path.join(library, '.assethive/custom-index.json.gz'), gzipSync(JSON.stringify(memo)));
  await fs.writeFile(path.join(library, '.assethive/custom-index.json'), JSON.stringify(memo));
  return { root, library, records };
}

test('migration preserves identity and file bytes, updates both indexes, and leaves descriptive-tag surfaces untouched', async t => {
  const { root, library, records } = await migrationFixture(t);
  const before = await fs.readFile(path.join(library, 'Environment/Surfaces/dust/roughness.png'));
  const woodBefore = await fs.readFile(path.join(library, 'Environment/Surfaces/wood/asset_info.json'));
  const plan = await buildPlan(library);
  const cacheDir = path.join(root, 'Cache');
  await fs.mkdir(cacheDir);
  const key = require('node:crypto').createHash('sha256').update(path.resolve(plan.library).toLowerCase()).digest('hex').slice(0, 16);
  await fs.copyFile(path.join(library, '.assethive/custom-index.json.gz'), path.join(cacheDir, key + '.memo.json.gz'));
  const { DatabaseSync } = require('node:sqlite');
  const dbFile = path.join(cacheDir, key + '.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE assets (id TEXT PRIMARY KEY, path TEXT, metaPath TEXT, previewImage TEXT, detailImage TEXT, assetType TEXT, topCategory TEXT, tagsJson TEXT, themesJson TEXT, listRecordJson TEXT, favorite INTEGER)');
  for (const record of records) db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(record.id, record.path, record.metaPath, record.previewImage, record.detailImage, record.assetType, record.topCategory, JSON.stringify(record.tags), JSON.stringify(record.themes), JSON.stringify(record), 1);
  db.close();
  assert.deepEqual(plan.items.map(item => item.id), ['dust']);
  const report = await applyPlan(plan, path.join(root, 'backup'));
  assert.equal(report.migrated.length, 1);
  const moved = path.join(library, 'Environment/Imperfections/dust');
  const meta = JSON.parse(await fs.readFile(path.join(moved, 'asset_info.json')));
  assert.equal(meta.assetType, 'imperfection');
  assert.equal(meta.asset_type, 'imperfection');
  assert.equal(meta.identity.contentFingerprint, 'unchanged');
  assert.equal(meta.createdAt, '2020-01-01T00:00:00.000Z');
  assert.equal(meta.previewImage, path.join(moved, 'roughness.png'));
  assert.deepEqual(await fs.readFile(path.join(moved, 'roughness.png')), before);
  assert.deepEqual(await fs.readFile(path.join(library, 'Environment/Surfaces/wood/asset_info.json')), woodBefore);
  for (const name of ['custom-index.json', 'custom-index.json.gz']) {
    const bytes = await fs.readFile(path.join(library, '.assethive', name));
    const memo = JSON.parse(name.endsWith('.gz') ? gunzipSync(bytes) : bytes);
    assert.equal(memo.assets.find(entry => entry.record.id === 'dust').record.assetType, 'imperfection');
    assert.deepEqual(memo.assets.find(entry => entry.record.id === 'wood').record, JSON.parse(JSON.stringify(records.find(record => record.id === 'wood'))));
  }
  const memoPath = path.join(root, 'stale-memo.json.gz');
  const memo = JSON.parse(gunzipSync(await fs.readFile(path.join(library, '.assethive/custom-index.json.gz'))));
  memo.assets.find(entry => entry.record.id === 'dust').record.assetType = 'surface';
  await fs.writeFile(memoPath, gzipSync(JSON.stringify(memo)));
  const metadataBeforeScan = await fs.readFile(path.join(moved, 'asset_info.json'));
  const scanned = await scanLibrary(library, { scanMemoPath: memoPath, incrementalScan: true, pollShard: -1 });
  assert.equal(searchAssets(scanned, { assetTypes: ['imperfection'] }).length, 1);
  assert.deepEqual(await fs.readFile(path.join(moved, 'asset_info.json')), metadataBeforeScan);
  assert.equal((await buildPlan(library)).items.length, 0);
  const source = { id: 'dust', semanticTags: { asset_type: 'imperfection' }, categories: ['surface', 'Imperfections', 'Dust'], assetCategories: { imperfection: { dirt: {} } } };
  const sourceFile = path.join(root, 'bridge-source.json');
  const sourceBytes = JSON.stringify(source);
  await fs.writeFile(sourceFile, sourceBytes);
  const sourceSha256 = require('node:crypto').createHash('sha256').update(sourceBytes).digest('hex');
  const restored = await restoreBridgeCategories(plan, { results: [{ id: 'dust', nativeId: 'dust', sourceFile, sourceSha256 }], failures: [] }, path.join(root, 'category-backup'));
  assert.deepEqual(restored.categories, { Dirt: 1 });
  const classified = JSON.parse(await fs.readFile(path.join(moved, 'asset_info.json')));
  assert.equal(classified.category, 'Dirt');
  assert.deepEqual(classified.sourceClassification.assetCategories, source.assetCategories);
  assert.equal(classified.identity.contentFingerprint, 'unchanged');
  assert.deepEqual(await fs.readFile(path.join(moved, 'roughness.png')), before);
  const legacyIndexFile = path.join(library, '.assethive/custom-index.json');
  const legacyIndex = JSON.parse(await fs.readFile(legacyIndexFile));
  legacyIndex.assets = legacyIndex.assets.filter(entry => entry.record.id !== 'dust');
  await fs.writeFile(legacyIndexFile, JSON.stringify(legacyIndex));
  await syncLocalCaches([cacheDir], plan, path.join(root, 'cache-backup'));
  assert.equal(JSON.parse(await fs.readFile(legacyIndexFile)).assets.find(entry => entry.record.id === 'dust').record.assetType, 'imperfection');
  const cache = new DatabaseSync(dbFile);
  try {
    const dust = cache.prepare("SELECT * FROM assets WHERE id='dust'").get();
    assert.equal(dust.assetType, 'imperfection');
    assert.equal(dust.path, moved);
    assert.equal(dust.favorite, 1);
    assert.deepEqual(JSON.parse(dust.themesJson), ['dirt']);
    assert.equal(JSON.parse(dust.listRecordJson).meta.category, 'Dirt');
    assert.equal(JSON.parse(dust.listRecordJson).assetType, 'imperfection');
    assert.equal(cache.prepare("SELECT assetType FROM assets WHERE id='wood'").get().assetType, 'surface');
  } finally { cache.close(); }
});

test('migration stops before moving anything when a planned asset is edited concurrently', async t => {
  const { root, library } = await migrationFixture(t);
  const plan = await buildPlan(library);
  const file = path.join(plan.items[0].from, 'asset_info.json');
  const meta = JSON.parse(await fs.readFile(file));
  meta.name = 'User edit';
  await fs.writeFile(file, JSON.stringify(meta));
  await assert.rejects(applyPlan(plan, path.join(root, 'backup')), /Metadata changed/);
  assert.equal(JSON.parse(await fs.readFile(file)).name, 'User edit');
  await assert.rejects(fs.stat(plan.items[0].to), { code: 'ENOENT' });
});


test('Imperfections category filters use Bridge taxonomy rather than descriptive tags', () => {
  const assets = [
    { id: 'metal', assetType: 'imperfection', themes: ['metal'], tags: ['damage'] },
    { id: 'damage', assetType: 'imperfection', themes: ['damage'], tags: [] },
    { id: 'surface', assetType: 'surface', themes: ['metal'], tags: ['damage'] }
  ];
  assert.deepEqual(searchAssets(assets, { assetTypes: ['imperfection'], themes: ['Damage'] }).map(asset => asset.id), ['damage']);
  assert.deepEqual(searchAssets(assets, { assetTypes: ['surface'], themes: ['Damage'] }).map(asset => asset.id), ['surface']);
});
