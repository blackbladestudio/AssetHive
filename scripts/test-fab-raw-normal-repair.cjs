const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { Readable } = require('node:stream');
const sharp = require('sharp');
const { prepareRepair, publishRepair, rebaseRepairAnalysis, repairedIdentity, repairOne, refreshIndexes, repairKind, downloadRawNormal, cachedRawNormal, downloadOnly } = require('./repair-fab-raw-normals.cjs');
const { writeAssetMetadata } = require('../electron/services/assetMetadata');
const { computeContentIdentity } = require('../electron/services/assetIdentity');
const { DOWNLOAD_POLICY, inventory, atomicJson, metadataReferences, hashFile, verifyReceipt } = require('./lib/megascans-transfer.cjs');
const { downloadZipEntry } = require('./lib/fab-zip.cjs');

async function fixture(t) {
  const parent = path.resolve(__dirname, '../.cache/fab-raw-normal-tests');
  await fs.mkdir(parent, { recursive: true });
  const library = await fs.mkdtemp(path.join(parent, 'run-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(library)), await fs.realpath(parent));
    await fs.rm(library, { recursive: true, maxRetries: 5, retryDelay: 100 });
  });
  const id = 'abc', root = path.join(library, 'Environment/3D Assets/megascans_abc');
  const archive = path.join(library, '.megascans/originals/v3/abc'), cache = path.join(library, 'cache');
  const work = path.join(cache, 'raw-normal-repair/assets/abc');
  await fs.mkdir(root, { recursive: true }); await fs.mkdir(archive, { recursive: true }); await fs.mkdir(work, { recursive: true });
  const normalUri = 'T_example_Normal.jpg', model = path.join(root, 'SM_example.fbx');
  await fs.writeFile(model, 'Raw model bytes stay unchanged');
  await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ff8080' } }).jpeg().toFile(path.join(root, normalUri));
  const source = path.join(work, 'Example_abc_Raw_8K_Normal.jpg');
  await sharp({ create: { width: 8192, height: 16, channels: 3, background: '#8080ff' } }).jpeg().toFile(source);
  const identity = await computeContentIdentity({ modelSlots: { Mesh: model }, textureSlots: [{ suffix: 'Normal', source: path.join(root, normalUri), areaIndex: 1, materialRole: 'atlas' }] });
  await writeAssetMetadata(root, { assetID: 'fixedid', name: 'Keep custom name', assetType: '3d', category: 'Props', standardAssetTags: ['Megascans'],
    tags: ['user tag'], favorite: true, exportCount: 9, dimensions: { x: 2, y: 3, z: 4 }, createdAt: '2020-01-01T00:00:00.000Z',
    modelFiles: [model], modelSlots: { Mesh: model }, textureFiles: [path.join(root, normalUri)], textureSlots: { Normal: path.join(root, normalUri) },
    textureEntries: [{ textureType: 'Normal', uri: normalUri, areaIndex: 1, materialRole: 'atlas' }],
    components: [{ type: 'mesh', slot: 'Mesh', uri: 'SM_example.fbx' }, { type: 'texture', slot: 'Normal', uri: normalUri, areaIndex: 1, materialRole: 'atlas' }],
    identity: { ...identity, schemaVersion: 1, sourceKind: 'megascans', sourceAssetId: id, sourceKey: 'megascans:abc' }, normalMapFormat: 'dx', revision: 1 });
  await atomicJson(path.join(archive, 'abc.json'), { id, fab: { listingId: 'listing' }, maps: [{ type: 'normal', uri: 'Example_abc_High_4K_Normal.jpg' }] });
  const meta = JSON.parse(await fs.readFile(path.join(root, 'asset_info.json'), 'utf8')), files = await inventory(root);
  const refs = metadataReferences(root, meta, id, files);
  const receipt = { version: 1, policy: DOWNLOAD_POLICY, id, mode: 'import', resolution: 4096,
    archive: { root: path.relative(library, archive), files: await inventory(archive) }, imported: { root: path.relative(library, root), files, metadataReferences: refs } };
  await atomicJson(path.join(library, '.megascans/receipts/abc.json'), receipt);
  await atomicJson(path.join(library, '.megascans/imports/abc.json'), { id, finalRoot: root, files, metadataReferences: refs });
  const item = { id, key: id, listingId: 'listing', root: path.relative(library, root) };
  const map = { type: 'normal', tier: 0, resolution: '8192x8192' };
  return { library, cache, root, id, source, map, item, meta, files, normalUri, model };
}

test('repaired identity matches the standard content identity for the Raw source', async t => {
  const f = await fixture(t);
  const expected = await computeContentIdentity({ modelSlots: { Mesh: f.model }, textureSlots: [{ suffix: 'Normal', source: f.source, areaIndex: 1, materialRole: 'atlas' }] });
  const identity = repairedIdentity(f.meta, f.root, f.files, f.normalUri, await hashFile(f.source));
  for (const key of Object.keys(expected)) assert.deepEqual(identity[key], expected[key]);
});

test('Raw repair downsamples to 4K, preserves user fields and model, and verifies backup and receipts', async t => {
  const f = await fixture(t), modelHash = await hashFile(f.model), oldHash = await hashFile(path.join(f.root, f.normalUri));
  const journal = await prepareRepair(f.library, f.cache, f.item, f.source, f.map, 'example_abc_raw.zip');
  const result = await publishRepair(f.library, f.cache, journal);
  const meta = JSON.parse(await fs.readFile(path.join(f.root, 'asset_info.json'), 'utf8'));
  assert.ok(result.completedAt);
  assert.equal(meta.textureEntries[0].width, 4096);
  assert.equal(meta.textureEntries[0].sourceWidth, 8192);
  assert.equal(meta.textureEntries[0].compressed, true);
  for (const key of ['assetID', 'name', 'tags', 'favorite', 'exportCount', 'createdAt', 'dimensions', 'normalMapFormat']) assert.deepEqual(meta[key], f.meta[key]);
  assert.equal(await hashFile(f.model), modelHash);
  assert.equal(await hashFile(path.join(f.library, '.megascans/raw-normal-repairs/backups/abc', f.normalUri)), oldHash);
  assert.notEqual(await hashFile(path.join(f.root, f.normalUri)), oldHash);
  const receipt = JSON.parse(await fs.readFile(path.join(f.library, '.megascans/receipts/abc.json'), 'utf8'));
  assert.equal(receipt.repairs[0].kind, repairKind);
  await verifyReceipt(f.library, receipt, f.id);
  const again = await repairOne(f.library, f.cache, f.item, { plan() { throw new Error('must not download twice'); } });
  assert.equal(again.completedAt, result.completedAt);
});

test('download-only caches official Raw originals without accessing an unavailable library and later repairs offline', async t => {
  const f = await fixture(t), downloadDir = path.join(f.cache, 'download-first');
  const sourceName = path.basename(f.source), bytes = (await fs.stat(f.source)).size;
  const normal = { ...f.map, uri: sourceName }, before = await fs.readFile(path.join(f.root, 'asset_info.json'), 'utf8');
  let plans = 0, downloads = 0;
  const client = { plan: async (listing, options) => {
    plans++; assert.equal(listing.sourceId, f.id); assert.equal(options.normalOnly, true);
    return { meta: { id: f.id }, normal, rawPackage: 'example_abc_raw.zip', files: [{ file: sourceName, bytes }] };
  } };
  const cached = await downloadRawNormal(f.cache, downloadDir, f.item, client, { download: async (file, work) => {
    downloads++; await fs.copyFile(f.source, path.join(work, file.file));
  } });
  assert.equal(cached.sha256, await hashFile(f.source)); assert.equal(cached.sourceWidth, 8192);
  assert.equal(await fs.readFile(path.join(f.root, 'asset_info.json'), 'utf8'), before);
  const unavailableLibrary = path.join(f.library, 'offline-share');
  await downloadOnly({ library: unavailableLibrary, items: [f.item] }, [f.item], f.cache, downloadDir, 1);
  await assert.rejects(fs.stat(unavailableLibrary), { code: 'ENOENT' });
  const progress = JSON.parse(await fs.readFile(path.join(downloadDir, 'progress.json'), 'utf8'));
  assert.equal(progress.status, 'completed'); assert.equal(progress.completed, 1); assert.equal(progress.phase, 'download_only');
  assert.equal(plans, 1); assert.equal(downloads, 1);
  const modelHash = await hashFile(f.model);
  const journal = await repairOne(f.library, f.cache, f.item, { plan: () => { throw new Error('cached streaming apply must not request Fab'); } }, { downloadDir, downloadMissing: true });
  assert.ok(journal.completedAt); assert.equal(journal.provenance.sourceSha256, cached.sha256);
  assert.equal(await hashFile(f.model), modelHash);
  const meta = JSON.parse(await fs.readFile(path.join(f.root, 'asset_info.json'), 'utf8'));
  assert.equal(meta.textureEntries[0].width, 4096); assert.equal(meta.textureEntries[0].sourceWidth, 8192);
  assert.equal(await hashFile(cached.source), cached.sha256);
  await fs.writeFile(cached.source, 'changed cached original');
  await assert.rejects(cachedRawNormal(downloadDir, f.item), /缓存校验失败/);
});

test('streaming repair downloads an uncached Raw normal and publishes it immediately', async t => {
  const f = await fixture(t), downloadDir = path.join(f.cache, 'existing-empty-downloads');
  let planned = 0, downloaded = 0;
  const normal = { ...f.map, uri: path.basename(f.source) };
  const client = { plan: async (listing, options) => {
    planned++; assert.equal(options.normalOnly, true); assert.equal(listing.sourceId, f.id);
    return { meta: { id: f.id }, normal, rawPackage: 'example_abc_raw.zip', files: [{ file: normal.uri }] };
  } };
  await assert.rejects(repairOne(f.library, f.cache, f.item, client, { downloadDir }), /尚未完成本地下载/);
  assert.equal(planned, 0);
  const result = await repairOne(f.library, f.cache, f.item, client, { downloadDir, downloadMissing: true,
    download: async (file, work) => { downloaded++; assert.equal(path.join(work, file.file), f.source); }
  });
  assert.equal(planned, 1); assert.equal(downloaded, 1); assert.ok(result.completedAt);
  assert.equal(result.provenance.sourceSha256, await hashFile(f.source));
  await verifyReceipt(f.library, result.receipt, f.id);
  await assert.rejects(fs.stat(downloadDir), { code: 'ENOENT' });
});

test('repair resumes after file replacement or metadata publication', async t => {
  for (const interruptedStep of ['normal', 'metadata', 'import-record']) {
    const f = await fixture(t);
    const journal = await prepareRepair(f.library, f.cache, f.item, f.source, f.map, 'example_abc_raw.zip');
    await atomicJson(path.join(f.library, '.megascans/raw-normal-repairs/abc.json'), journal);
    await assert.rejects(publishRepair(f.library, f.cache, journal, { afterStep: async step => { if (step === interruptedStep) throw new Error('interrupted'); } }), /interrupted/);
    const result = await repairOne(f.library, f.cache, f.item, {});
    assert.ok(result.completedAt);
    await verifyReceipt(f.library, result.receipt, f.id);
  }
});

test('a CDN body that stops sending bytes times out and removes its partial file', async t => {
  const f = await fixture(t), source = new Readable({ read() {} });
  const file = { file: 'stalled-normal.jpg', bytes: 5, entry: { crc: 0 }, zip: { stream: async () => source } };
  await assert.rejects(downloadZipEntry(file, f.cache, { idleTimeoutMs: 20 }), error => error.code === 'UND_ERR_BODY_TIMEOUT');
  assert.equal(source.destroyed, true);
  await assert.rejects(fs.stat(path.join(f.cache, file.file + '.part')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.cache, file.file)), { code: 'ENOENT' });
});

test('repair preserves a user-edited normal and refuses concurrent metadata changes', async t => {
  const f = await fixture(t);
  const target = path.join(f.root, f.normalUri), previous = await fs.readFile(target);
  await fs.writeFile(target, 'user normal edit');
  await assert.rejects(prepareRepair(f.library, f.cache, f.item, f.source, f.map, 'raw.zip'), /法线已被用户修改|校验|大小/);
  await fs.writeFile(target, previous);
  const journal = await prepareRepair(f.library, f.cache, f.item, f.source, f.map, 'raw.zip');
  const metaFile = path.join(f.root, 'asset_info.json');
  const edited = { ...f.meta, name: 'Concurrent user edit' };
  await fs.writeFile(metaFile, JSON.stringify(edited));
  await assert.rejects(publishRepair(f.library, f.cache, journal), /修复期间/);
  assert.equal(JSON.parse(await fs.readFile(metaFile, 'utf8')).name, edited.name);
  assert.equal(await hashFile(target), journal.provenance.previousSha256);
});

test('explicit analysis recovery preserves both snapshots and retains publication guards', async t => {
  const f = await fixture(t), metaPath = path.join(f.root, 'asset_info.json');
  const journal = await prepareRepair(f.library, f.cache, f.item, f.source, f.map, 'raw.zip');
  const journalPath = path.join(f.library, '.megascans/raw-normal-repairs/abc.json');
  await atomicJson(journalPath, journal);
  const before = await fs.readFile(metaPath, 'utf8'), journalBefore = await fs.readFile(journalPath, 'utf8');
  const current = { ...JSON.parse(before), textureAnalysis: { dimensions: { x: 2, y: 3, z: 4 }, dimensionsSource: 'measured', refreshedBy: 'concurrent scan' } };
  await fs.writeFile(metaPath, JSON.stringify(current));
  const currentText = await fs.readFile(metaPath, 'utf8');
  await assert.rejects(publishRepair(f.library, f.cache, journal), /修复期间/);
  const rebased = await rebaseRepairAnalysis(f.library, f.cache, journal);
  assert.equal(await fs.readFile(metaPath, 'utf8'), currentText);
  assert.deepEqual(JSON.parse(rebased.metaText).textureAnalysis, current.textureAnalysis);
  assert.equal(rebased.oldMetadataHash, await hashFile(metaPath));
  assert.equal(await fs.readFile(path.join(f.library, '.megascans/raw-normal-repairs/backups/abc/asset_info.json'), 'utf8'), before);
  const saved = path.join(f.library, rebased.analysisRebases[0].backup);
  assert.equal(await fs.readFile(path.join(saved, 'asset_info.json'), 'utf8'), currentText);
  assert.equal(await fs.readFile(path.join(saved, 'journal.json'), 'utf8'), journalBefore);
  await fs.writeFile(metaPath, JSON.stringify({ ...current, favorite: !current.favorite }));
  await assert.rejects(publishRepair(f.library, f.cache, rebased), /修复期间/);
  assert.equal(await hashFile(path.join(f.root, f.normalUri)), journal.provenance.previousSha256);
  await fs.writeFile(metaPath, currentText);
  const done = await publishRepair(f.library, f.cache, rebased);
  const published = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  assert.ok(done.completedAt);
  assert.equal(published.name, current.name);
  assert.equal(published.textureAnalysis.dimensionsSource, 'measured');
  await verifyReceipt(f.library, done.receipt, f.id);
});

test('analysis recovery refuses user metadata, Normal, receipt and import edits', async t => {
  for (const change of ['metadata', 'normal', 'receipt', 'import']) {
    const f = await fixture(t), metaPath = path.join(f.root, 'asset_info.json');
    const journal = await prepareRepair(f.library, f.cache, f.item, f.source, f.map, 'raw.zip');
    const journalPath = path.join(f.library, '.megascans/raw-normal-repairs/abc.json');
    await atomicJson(journalPath, journal);
    const current = { ...f.meta, textureAnalysis: { refreshedBy: 'scan' } };
    if (change === 'metadata') current.name = 'User edit must remain';
    await fs.writeFile(metaPath, JSON.stringify(current));
    if (change === 'normal') await fs.writeFile(path.join(f.root, f.normalUri), 'User normal');
    if (['receipt', 'import'].includes(change)) {
      const file = path.join(f.library, `.megascans/${change === 'receipt' ? 'receipts' : 'imports'}/abc.json`);
      await fs.appendFile(file, ' ');
    }
    const journalHash = await hashFile(journalPath), normalHash = await hashFile(path.join(f.root, f.normalUri));
    await assert.rejects(rebaseRepairAnalysis(f.library, f.cache, journal), /修改/);
    assert.equal(await hashFile(journalPath), journalHash);
    assert.equal(await hashFile(path.join(f.root, f.normalUri)), normalHash);
    assert.deepEqual(JSON.parse(await fs.readFile(metaPath, 'utf8')), current);
  }
});

test('repair refreshes shared indexes, local memo and SQLite without changing other records', async t => {
  const f = await fixture(t), metaPath = path.join(f.root, 'asset_info.json');
  const journal = await prepareRepair(f.library, f.cache, f.item, f.source, f.map, 'raw.zip');
  await publishRepair(f.library, f.cache, journal);
  const localCacheRoot = path.join(f.cache, 'test-sqlite');
  await fs.mkdir(localCacheRoot, { recursive: true });
  const document = { assets: [{ metaPath, record: { id: 'fixedid', meta: f.meta } }, { metaPath: 'unrelated', record: { name: 'Keep me' } }] };
  const shared = path.join(f.library, '.assethive/custom-index.json');
  await atomicJson(shared, document);
  await fs.writeFile(shared + '.gz', zlib.gzipSync(JSON.stringify(document)));
  await fs.writeFile(path.join(localCacheRoot, 'test.memo.json.gz'), zlib.gzipSync(JSON.stringify(document)));
  const dbPath = path.join(localCacheRoot, 'test.sqlite'), db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE assets (metaPath TEXT PRIMARY KEY, textureAnalysisJson TEXT)');
  db.prepare('INSERT INTO assets VALUES (?, ?)').run(metaPath, 'old');
  db.prepare('INSERT INTO assets VALUES (?, ?)').run('unrelated', 'keep');
  db.close();
  const result = await refreshIndexes(f.library, f.cache, [{ id: f.id, root: f.root }], { localCacheRoot });
  assert.equal(result.files.length, 3);
  for (const file of [shared, shared + '.gz', path.join(localCacheRoot, 'test.memo.json.gz')]) {
    const bytes = await fs.readFile(file), doc = JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(bytes) : bytes).toString());
    assert.equal(doc.assets[0].record.meta.textureEntries[0].sourceWidth, 8192);
    assert.equal(doc.assets[1].record.name, 'Keep me');
  }
  const check = new DatabaseSync(dbPath, { readOnly: true });
  assert.notEqual(check.prepare('SELECT textureAnalysisJson FROM assets WHERE metaPath = ?').get(metaPath).textureAnalysisJson, 'old');
  assert.equal(check.prepare('SELECT textureAnalysisJson FROM assets WHERE metaPath = ?').get('unrelated').textureAnalysisJson, 'keep');
  check.close();
});
