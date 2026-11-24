const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { Buffer } = require('node:buffer');
const path = require('node:path');
const sharp = require('sharp');
const { ImportWorker } = require('./lib/megascans-import-worker.cjs');
const { validateImported } = require('../electron/services/megascansBatchImport');
const { repairPreview } = require('./repair-megascans-previews.cjs');
const { DOWNLOAD_POLICY, inventory, atomicJson, verifyReceipt, metadataReferences, ownedCache, transferOne } = require('./lib/megascans-transfer.cjs');
const { receiptPath } = require('./lib/megascans-paths.cjs');
const { checkCompletedReceipts } = require('./lib/megascans-resume.cjs');
const { repair: repairFabPreview } = require('./repair-fab-preview-cutouts.cjs');

test('Fab background-removal flag publishes transparent PNGs through the actual importer', { timeout: 120000 }, async t => {
  const parent = path.resolve(__dirname, '../.cache/megascans-electron-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'fab-cutout-'));
  const library = path.join(root, 'library'), cacheRoot = path.join(root, 'cache');
  const worker = new ImportWorker({ cacheRoot });
  t.after(async () => {
    await worker.close();
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(parent));
    await fs.rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
  });
  for (const type of ['3d', 'surface', 'decal']) {
    const id = `cutout${type}`, source = path.join(library, '.megascans/originals/v3', id);
    await fs.mkdir(source, { recursive: true });
    await sharp(Buffer.from('<svg width="160" height="120"><rect width="160" height="120" fill="#202020"/><circle cx="80" cy="60" r="35" fill="#d94422"/></svg>')).jpeg().toFile(path.join(source, 'grid.jpg'));
    const original = await fs.readFile(path.join(source, 'grid.jpg'));
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#887766' } }).png().toFile(path.join(source, 'color.png'));
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#80a0ff' } }).png().toFile(path.join(source, 'normal.png'));
    await fs.writeFile(path.join(source, 'Raw.fbx'), '; FBX 7.4.0 project file\nObjects: {}\nConnections: {}\n');
    await atomicJson(path.join(source, id + '.json'), { id, name: 'Fab cutout fixture', type, source: 'quixel', fab: { listingId: 'fixture' },
      tags: ['rock', '02', 'fab_cutout_fixture'], semanticTags: { name: 'Fab cutout fixture', name_formats: ['fab_cutout_fixture'], variant: '02', contains: ['stone'] },
      maps: [{ type: 'albedo', uri: 'color.png' }, { type: 'normal', uri: 'normal.png' }],
      models: type === '3d' ? [{ type: 'original', lod: -1, uri: 'Raw.fbx' }] : [],
      previews: { images: [{ uri: 'grid.jpg', tags: ['grid', 'preview'] }] } });
    const result = await worker.run({ id, source, library, cacheRoot, downloadSource: 'fab', removePreviewBackground: true });
    const meta = await validateImported(result.assetPath, id);
    const normal = meta.textureEntries.find(entry => entry.textureType === 'Normal');
    assert.equal(meta.normalMapFormat, 'opengl');
    assert.equal(meta.normalMapFormats[1], 'opengl');
    assert.equal(normal.normalMapFormat, 'opengl');
    assert.equal(meta.components.find(entry => entry.type === 'texture' && entry.slot === 'Normal').normalMapFormat, 'opengl');
    assert.deepEqual(await fs.readFile(path.join(result.assetPath, normal.uri)), await fs.readFile(path.join(source, 'normal.png')));
    assert.ok(meta.tags.includes('rock')); assert.ok(meta.tags.includes('stone'));
    assert.ok(!meta.tags.some(tag => /^\d+$/.test(tag) || /fab[\s_]*cutout[\s_]*fixture/i.test(tag)), 'actual importer excludes names and variant numbers from tags');
    const image = sharp(path.join(result.assetPath, meta.previewImage));
    const info = await image.metadata(), stats = await image.stats();
    assert.equal(info.format, 'png'); assert.equal(info.hasAlpha, true);
    assert.equal(stats.channels.at(-1).min, 0); assert.ok(stats.channels.at(-1).max > 0);
    assert.ok(Math.max(info.width, info.height) <= 1024);
    assert.deepEqual(await fs.readFile(path.join(source, 'grid.jpg')), original);
    if (type === 'decal') {
      const files = await inventory(result.assetPath);
      const receipt = { version: 1, policy: DOWNLOAD_POLICY, id, mode: 'import', resolution: 4096,
        archive: { root: path.relative(library, source), files: await inventory(source) },
        imported: { root: path.relative(library, result.assetPath), files, metadataReferences: metadataReferences(result.assetPath, meta, id, files) } };
      const receiptFile = await receiptPath(library, id);
      await atomicJson(receiptFile, receipt);
      const previewFile = path.join(result.assetPath, meta.previewImage), bytes = await fs.readFile(previewFile);
      await fs.writeFile(previewFile, 'user edited preview');
      await assert.rejects(repairFabPreview(library, cacheRoot, id, { method: 'color' }));
      assert.equal(await fs.readFile(previewFile, 'utf8'), 'user edited preview');
      await fs.writeFile(previewFile, bytes);
      const repaired = await repairFabPreview(library, cacheRoot, id, { method: 'color' });
      const saved = await validateImported(result.assetPath, id);
      assert.notEqual(saved.previewImage, meta.previewImage);
      assert.deepEqual(await fs.readFile(previewFile), bytes, 'old preview remains intact');
      assert.deepEqual(saved.textureEntries, meta.textureEntries);
      assert.deepEqual(saved.identity, meta.identity);
      assert.ok((await fs.stat(path.join(repaired.backup, 'before.json'))).size > 0);
      await verifyReceipt(library, JSON.parse(await fs.readFile(receiptFile)), id);
    }
  }
});

test('actual importer stores Raw 8K normal at 4K and records the source dimensions', { timeout: 60000 }, async t => {
  const parent = path.resolve(__dirname, '../.cache/megascans-electron-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'raw-normal-'));
  const library = path.join(root, 'library'), cacheRoot = path.join(root, 'cache'), id = 'rawnormalfixture';
  const source = path.join(library, '.megascans/originals/v3', id);
  const worker = new ImportWorker({ cacheRoot });
  t.after(async () => {
    await worker.close();
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(parent));
    await fs.rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
  });
  await fs.mkdir(source, { recursive: true });
  await sharp({ create: { width: 8192, height: 8192, channels: 3, background: '#8080ff' } }).jpeg().toFile(path.join(source, 'Example_Raw_8K_Normal.jpg'));
  await sharp({ create: { width: 16, height: 16, channels: 3, background: '#887766' } }).png().toFile(path.join(source, 'Example_4K_Albedo.png'));
  await sharp({ create: { width: 16, height: 16, channels: 3, background: '#887766' } }).png().toFile(path.join(source, 'preview.png'));
  await fs.writeFile(path.join(source, 'Example_Raw.fbx'), '; FBX 7.4.0 project file\nObjects: {}\nConnections: {}\n');
  await atomicJson(path.join(source, id + '.json'), { id, name: 'Raw normal fixture', type: '3d', source: 'quixel', fabNormalSource: 'raw',
    maps: [{ type: 'normal', tier: 0, resolution: '8192x8192', uri: 'Example_Raw_8K_Normal.jpg' },
      { type: 'albedo', tier: 1, uri: 'Example_4K_Albedo.png' }],
    models: [{ type: 'original', lod: -1, uri: 'Example_Raw.fbx' }], previews: { images: [{ uri: 'preview.png', tags: ['preview'] }] } });
  const inspected = await worker.run({ kind: 'inspect-source', id, source });
  assert.ok(inspected.metadata.textureSlots.some(entry => entry.textureType === 'Normal' && entry.filePath.endsWith('Example_Raw_8K_Normal.jpg')));
  const result = await worker.run({ id, source, library, cacheRoot });
  assert.equal(result.ok, true);
  const meta = await validateImported(result.assetPath, id), normal = meta.textureEntries.find(entry => entry.textureType === 'Normal');
  assert.equal(meta.normalMapFormat, 'dx');
  assert.equal(meta.normalMapFormats[1], 'dx');
  assert.equal(normal.normalMapFormat, 'dx');
  assert.equal(normal.width, 4096); assert.equal(normal.height, 4096);
  assert.equal(normal.sourceWidth, 8192); assert.equal(normal.sourceHeight, 8192);
  assert.equal(normal.sourceResolution, '8K'); assert.equal(normal.compressed, true);
});

test('actual importer preserves Bridge names and imports original OpenGL normal maps', { timeout: 60000 }, async t => {
  const parent = path.resolve(__dirname, '../.cache/megascans-electron-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'names-'));
  const library = path.join(root, 'library'), cacheRoot = path.join(root, 'cache');
  const worker = new ImportWorker({ cacheRoot });
  t.after(async () => {
    await worker.close();
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(parent));
    await fs.rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
  });
  for (const [id, fields, expected] of [
    ['semanticname', { semanticTags: { name: 'Urban Shanty Town Facade Metal Modular 01' } }, 'Urban Shanty Town Facade Metal Modular 01'],
    ['structuredname', { name: { formats: { title: 'Grey Sandstone', file: 'Grey_Sandstone' } } }, 'Grey Sandstone']
  ]) {
    const source = path.join(library, '.megascans', 'originals', id);
    await fs.mkdir(source, { recursive: true });
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#887766' } }).png().toFile(path.join(source, 'color.png'));
    const sourceNormal = path.join(source, 'normal.png');
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#80a0ff' } }).png().toFile(sourceNormal);
    await fs.writeFile(path.join(source, `${id}.json`), JSON.stringify({
      id, source: 'quixel', type: 'surface', categories: ['surface', 'rock'],
      maps: [{ type: 'albedo', uri: 'color.png', mimeType: 'image/png' }, { type: 'normal', uri: 'normal.png', mimeType: 'image/png' }], ...fields
    }));
    assert.equal((await worker.run({ kind: 'inspect-source', id, source })).metadata.name, expected);
    const result = await worker.run({ id, source, library, cacheRoot, downloadSource: 'bridge' });
    const meta = await validateImported(result.assetPath, id);
    const normal = meta.textureEntries.find(entry => entry.textureType === 'Normal');
    assert.equal(meta.name, expected);
    assert.equal(meta.normalMapFormat, 'opengl');
    assert.equal(meta.normalMapFormats[1], 'opengl');
    assert.equal(normal.normalMapFormat, 'opengl');
    assert.equal(meta.components.find(entry => entry.type === 'texture' && entry.slot === 'Normal').normalMapFormat, 'opengl');
    assert.deepEqual(await fs.readFile(path.join(result.assetPath, normal.uri)), await fs.readFile(sourceNormal));
  }
});

test('actual importer publishes plant variants/LODs and HDRI into their library categories', { timeout: 60000 }, async t => {
  const parent = path.resolve(__dirname, '../.cache/megascans-electron-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'categories-'));
  const library = path.join(root, 'library'), cacheRoot = path.join(root, 'cache');
  const worker = new ImportWorker({ cacheRoot });
  t.after(async () => {
    await worker.close();
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(parent));
    await fs.rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
  });
  for (const type of ['3dplant', 'hdri']) {
    const id = type === '3dplant' ? 'plantfixture' : 'skyfixture';
    const source = path.join(library, '.megascans', 'originals', id);
    await fs.mkdir(source, { recursive: true });
    let maps, models = [];
    if (type === '3dplant') {
      for (const variation of [1, 2]) for (const lod of [0, 1]) {
        const uri = `Var${variation}_LOD${lod}.fbx`;
        await fs.writeFile(path.join(source, uri), '; FBX 7.4.0 project file\nObjects: {}\nConnections: {}\n');
        models.push({ type: 'lod', lod, variation, uri, mimeType: 'application/x-fbx' });
      }
      await sharp({ create: { width: 8, height: 8, channels: 3, background: '#408020' } }).png().toFile(path.join(source, 'albedo.png'));
      maps = [{ type: 'albedo', uri: 'albedo.png', mimeType: 'image/png' }];
    } else {
      await fs.writeFile(path.join(source, 'sky.hdr'), Buffer.concat([
        Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 4\n'), Buffer.from(Array(8).fill([128, 128, 128, 129]).flat())
      ]));
      maps = [{ type: 'hdr', uri: 'sky.hdr', mimeType: 'image/vnd.radiance' }];
    }
    await fs.writeFile(path.join(source, `${id}.json`), JSON.stringify({ id, name: id, type, source: 'quixel', maps, models }));
    const inspected = await worker.run({ kind: 'inspect-source', id, source });
    assert.equal(inspected.ok, true);
    assert.equal(inspected.metadata.assetType, type);
    assert.equal(inspected.metadata.sourceIdentity.sourceAssetId, id);
    assert.equal(inspected.metadata.modelFiles.length, models.length ? 2 : 0);
    await assert.rejects(fs.stat(path.join(library, 'Environment', type === '3dplant' ? 'Foliage' : 'HDRI')), { code: 'ENOENT' });
    const result = await worker.run({ id, source, library, cacheRoot });
    assert.equal(result.ok, true);
    const meta = await validateImported(result.assetPath, id);
    assert.equal(meta.assetType, type);
    if (type === '3dplant') {
      assert.equal(meta.modelFiles.length, 2); assert.equal(meta.modelLods.filter(item => item.lod === 1).length, 2);
      assert.deepEqual(meta.modelVariants.map(item => item.variantKey), ['01', '02']);
      assert.match(result.assetPath, /Foliage/);
    } else { assert.equal(meta.textureFiles.length, 1); assert.match(meta.textureFiles[0], /\.hdr$/); assert.match(result.assetPath, /HDRI/); }
  }
});

test('actual Electron importer builds a Megascans surface and safely recovers its published folder', { timeout: 120000 }, async t => {
  const parent = path.resolve(__dirname, '../.cache/megascans-electron-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'run-'));
  const worker = new ImportWorker({ cacheRoot: path.join(root, 'cache') });
  const importAsset = job => worker.run(job);
  t.after(async () => {
    await worker.close();
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(parent));
    await fs.rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
  });
  const library = path.join(root, 'library'), cacheRoot = path.join(root, 'Normal', 'cache');
  const id = 'smoketest01', source = path.join(library, '.megascans', 'originals', id);
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(cacheRoot, { recursive: true });
  await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 120, g: 80, b: 40 } } }).png().toFile(path.join(source, 'color.png'));
  await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 40, b: 220, alpha: 0.8 } } }).png().toFile(path.join(source, `${id}_Grid_840.png`));
  await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 220, g: 0, b: 0, alpha: 0.8 } } }).png().toFile(path.join(source, `${id}_PopupClay_1440.png`));
  await fs.writeFile(path.join(source, `${id}.json`), JSON.stringify({
    id, name: 'Megascans Smoke Test', source: 'quixel', categories: ['surface', 'rock'],
    semanticTags: { asset_type: 'surface' }, json: { uri: `${id}.json` },
    previews: { images: [
      { uri: `${id}_PopupClay_1440.png`, tags: ['preview', 'clay'], resolution: '1440x768' },
      { uri: `${id}_Grid_840.png`, tags: ['thumb'], resolution: '840x840' }
    ] },
    maps: [{ type: 'albedo', mimeType: 'image/png', uri: 'color.png' }]
  }));
  const localDir = await ownedCache(cacheRoot, id), localSource = path.join(localDir, 'payload');
  await fs.cp(source, localSource, { recursive: true });
  await assert.rejects(importAsset({ id, source, library, cacheRoot, localSource: source }), /不属于当前资产缓存/);
  await atomicJson(path.join(localDir, '.transfer-owner.json'), { id: 'wrong', tool: 'assethive-megascans-v1' });
  await assert.rejects(importAsset({ id, source, library, cacheRoot, localSource }), /缓存所有权/);
  await atomicJson(path.join(localDir, '.transfer-owner.json'), { id, tool: 'assethive-megascans-v1' });
  const result = await importAsset({ id, source, library, cacheRoot, localSource });
  const workerPid = worker.proc.pid;
  assert.equal(result.ok, true);
  const meta = await validateImported(result.assetPath, id);
  assert.equal(meta.schemaVersion, '1.0');
  assert.equal(meta.assetType, 'surface');
  assert.deepEqual(meta.standardAssetTags, ['ThirdParty']);
  assert.ok(meta.tags.some(tag => /^megascans$/i.test(tag)));
  assert.equal(meta.textureFiles.length, 1);
  const preview = await sharp(path.join(result.assetPath, meta.previewImage)).raw().toBuffer();
  assert.ok(preview[2] > preview[0], 'material sphere should be blue, never the red clay preview');
  const receipt = { version: 1, policy: DOWNLOAD_POLICY, id, mode: 'import', resolution: 4096,
    archive: { root: path.relative(library, source), files: await inventory(source) },
    imported: { root: path.relative(library, result.assetPath), files: await inventory(result.assetPath) } };
  await atomicJson(path.join(library, '.megascans', 'receipts', `${id}.json`), receipt);
  assert.equal(await repairPreview(library, id), true);
  assert.equal(await repairPreview(library, id), true, 'repair journal must replay safely');
  const repaired = JSON.parse(await fs.readFile(path.join(library, '.megascans', 'receipts', `${id}.json`), 'utf8'));
  await verifyReceipt(library, repaired, id);
  assert.match((await validateImported(result.assetPath, id)).previewImage, /megascans_material_grid/);
  const current = JSON.parse(await fs.readFile(path.join(result.assetPath, 'asset_info.json'), 'utf8'));
  repaired.imported.metadataReferences = metadataReferences(result.assetPath, current, id, repaired.imported.files);
  await atomicJson(path.join(result.assetPath, 'asset_info.json'), { ...current, scanInformation: { dimensions: { x: 1, y: 1, z: 1 } } });
  await verifyReceipt(library, repaired, id);
  assert.equal((await importAsset({ id, source, library, cacheRoot })).recovered, true, 'normal metadata updates must not break importer recovery');
  await assert.rejects(verifyReceipt(library, { ...repaired, imported: { ...repaired.imported, metadataReferences: { ...repaired.imported.metadataReferences, id: 'wrong' } } }, id), /来源或资源引用/);
  await atomicJson(path.join(result.assetPath, 'asset_info.json'), current);
  await assert.rejects(importAsset({ id, source: path.join(root, 'outside'), library, cacheRoot }), /原始归档/);
  assert.equal((await importAsset({ id, source, library, cacheRoot })).recovered, true);
  assert.equal(worker.proc.pid, workerPid, 'successful and failed jobs must reuse the same isolated Electron');
  const ids = ['caseasset', 'CaseAsset'], imports = [];
  for (const caseId of ids) {
    const meta = JSON.parse(await fs.readFile(path.join(source, `${id}.json`)));
    meta.id = caseId; meta.json.uri = `${caseId}.json`;
    const files = (await inventory(source)).filter(file => /color\.png$|Grid_840\.png$/.test(file.file));
    const completed = await transferOne({ id: caseId, library, cacheRoot, resolution: 4096, mode: 'import', maxCacheBytes: 1024 ** 2, reserveBytes: 0, log: () => {},
      client: { plan: async () => ({ meta, files }) }, importer: importAsset,
      download: async (file, destination) => fs.copyFile(path.join(source, file.file), path.join(destination, file.file)) });
    await verifyReceipt(library, completed, caseId);
    imports.push(completed);
  }
  assert.notEqual(imports[0].imported.root.toLowerCase(), imports[1].imported.root.toLowerCase());
  assert.notEqual((await receiptPath(library, ids[0])).toLowerCase(), (await receiptPath(library, ids[1])).toLowerCase());
  assert.equal((await checkCompletedReceipts({ ids, library, resolution: 4096, mode: 'import', full: true })).completedIds.size, 2);
  await worker.close();
  assert.notEqual(worker.proc.exitCode, null, 'closing the runner must release its worker');
});
