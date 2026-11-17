const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Buffer } = require('node:buffer');
const { QuixelClient, downloadRequest, selectedFiles, signedFiles, relativeUri, trustedDownload, downloadFile, inventory, verifyInventory, verifyReceipt, ownedCache, cleanupOwnedCache, transferOne, exists, atomicJson, copyVerified } = require('./lib/megascans-transfer.cjs');
const { Progress, readProgress, safeError } = require('./lib/megascans-progress.cjs');
const { buildPayload, runImportJob } = require('../electron/services/megascansBatchImport');
const { materialPreview } = require('../electron/services/megascansPreview');
const { ORDER, selectedTypes, orderedCatalog } = require('./lib/megascans-queue.cjs');
const { requestPause, pauseRequested } = require('./lib/megascans-control.cjs');
const { main: downloaderMain } = require('./megascans-runner.cjs');
const { checkCompletedReceipts } = require('./lib/megascans-resume.cjs');
const { runPipeline, cachedOrder } = require('./lib/megascans-pipeline.cjs');
const { readDeferred, setDeferred, remainingQueue } = require('./lib/megascans-deferred.cjs');
const { recover } = require('./lib/megascans-recovery.cjs');
const { encodedKey, storageId, receiptPath, recordPath } = require('./lib/megascans-paths.cjs');

test('case-sensitive source IDs retain separate files, resume receipts and cache budgets on Windows', async t => {
  const directories = await fixture(t), ids = ['omDgw0', 'omDgW0'];
  const first = await ownedCache(directories.cacheRoot, ids[0]);
  const second = await ownedCache(directories.cacheRoot, ids[1]);
  assert.notEqual(first.toLowerCase(), second.toLowerCase());
  assert.deepEqual((await fs.readdir(path.join(directories.cacheRoot, 'assets'))).map(storageId).sort(), [...ids].sort());
  await cleanupOwnedCache(directories.cacheRoot, ids[1]);
  assert.equal(await exists(first), true);
  const completed = [];
  await runPipeline({ ids, options: pipelineOptions(directories), downloadAssets: 2, onCompleted: async id => completed.push(id) });
  assert.deepEqual(completed, ids);
  const files = await Promise.all(ids.map(id => receiptPath(directories.library, id)));
  assert.notEqual(files[0].toLowerCase(), files[1].toLowerCase());
  const receipts = await Promise.all(files.map(async file => JSON.parse(await fs.readFile(file))));
  assert.notEqual(receipts[0].archive.root.toLowerCase(), receipts[1].archive.root.toLowerCase());
  assert.equal((await checkCompletedReceipts({ ids, library: directories.library, mode: 'archive', resolution: 4096, full: true })).completedIds.size, 2);
  for (const id of ids) await atomicJson(await recordPath(path.join(directories.cacheRoot, 'items'), id), { id, status: 'completed' });
  assert.equal((await fs.readdir(path.join(directories.cacheRoot, 'items'))).length, 2);
  assert.equal(await exists(path.join(directories.cacheRoot, 'assets', encodedKey(ids[1]))), false);
});

test('legacy case-sensitive identities are preserved and unrelated corrupt identities still stop', async t => {
  const { library, cacheRoot } = await fixture(t), root = path.join(library, '.megascans', 'receipts');
  await atomicJson(path.join(root, 'omDgw0.json'), { id: 'omDgw0', preserved: true });
  assert.equal(await receiptPath(library, 'omDgw0'), path.join(root, 'omDgw0.json'));
  assert.equal(await receiptPath(library, 'omDgW0'), path.join(root, encodedKey('omDgW0') + '.json'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'omDgw0.json'))), { id: 'omDgw0', preserved: true });
  const oldCache = path.join(cacheRoot, 'assets', 'LegacyA');
  await atomicJson(path.join(oldCache, '.transfer-owner.json'), { id: 'LegacyA', tool: 'assethive-megascans-v1' });
  assert.equal(await ownedCache(cacheRoot, 'LegacyA'), oldCache);
  await atomicJson(path.join(root, 'broken.json'), { id: 'different' });
  await assert.rejects(receiptPath(library, 'broken'), /所有权/);
  assert.throws(() => storageId('~6fZZ'), /编码/);
});

test('automatic deferral preserves a failed cache and continues ordered publication after pipeline replacement', async t => {
  const options = pipelineOptions(await fixture(t));
  const clientPlan = options.client.plan, completed = [], deferredIds = [];
  options.client.plan = async id => {
    if (id === 'b') throw Object.assign(new Error('HTTP 500 https://quixel.com/private?signed=secret'), { status: 500, source: 'quixel' });
    return clientPlan(id);
  };
  await runPipeline({ ids: ['a', 'b', 'c'], options, downloadAssets: 2,
    execute: (operation, controls) => recover(operation, { ...controls, sleep: async () => {}, shouldDefer: async () => true }),
    onDeferred: async (id, error) => {
      deferredIds.push(id);
      await setDeferred(options, { id, automatic: true, retainedCache: true, reason: error.message, httpStatus: error.status, retryAttempts: error.retryAttempts });
    }, onCompleted: async id => completed.push(id)
  });
  assert.deepEqual(completed, ['a', 'c']); assert.deepEqual(deferredIds, ['b']);
  assert.equal(await exists(path.join(options.library, '.megascans/receipts/b.json')), false);
  assert.equal(await exists(path.join(options.cacheRoot, 'assets/b')), true);
  assert.deepEqual(await cachedOrder(['b'], options), ['b']);
  const record = await readDeferred(options);
  assert.equal(record.items[0].httpStatus, 500); assert.equal(record.items[0].retryAttempts, 3);
  assert.ok(!JSON.stringify(record).includes('signed=secret'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(options.library, '.megascans/deferred.json'))), record);
  await setDeferred(options, { id: 'b', restore: true });
  options.client.plan = clientPlan;
  await runPipeline({ ids: await cachedOrder(['b'], options), options });
  assert.equal(await exists(path.join(options.library, '.megascans/receipts/b.json')), true);
});

test('failed deferral persistence stops before changing recovery order or advancing the queue', async t => {
  const options = pipelineOptions(await fixture(t));
  const attempted = [];
  await assert.rejects(runPipeline({ ids: ['a', 'b'], options, prefetch: false,
    transfer: async ({ id }) => { attempted.push(id); throw Object.assign(new Error('isolated'), { code: 'MEGASCANS_DEFER_ASSET' }); },
    onDeferred: async () => { throw new Error('cannot persist retry record'); }
  }), /cannot persist/);
  assert.deepEqual(attempted, ['a']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(options.cacheRoot, 'pipeline.json'))).ids, ['a']);
});

test('explicit deferred cache survives pipeline replacement and restores before remaining work', async t => {
  const directories = await fixture(t), options = pipelineOptions(directories);
  await runPipeline({ ids: ['a'], options, transfer: async () => { throw new Error('source file denied'); } }).catch(() => {});
  await setDeferred(options, { id: 'a', retainedCache: true, reason: 'source file denied' });
  let record = await readDeferred(options);
  const completedIds = new Set(['done']);
  assert.deepEqual(remainingQueue({ eligible: ['done', 'a', 'b', 'c'], completedIds, orderedCached: ['a'], record }), { deferredIds: ['a'], queue: ['b', 'c'] });
  await runPipeline({ ids: ['b'], options, transfer: async () => ({}) });
  assert.deepEqual(await cachedOrder(['a'], options), ['a']);
  assert.equal((await readDeferred(options)).items[0].state, 'deferred');
  await setDeferred(options, { id: 'a', restore: true });
  record = await readDeferred(options);
  assert.deepEqual(remainingQueue({ eligible: ['a', 'c'], completedIds, orderedCached: await cachedOrder(['a'], options), record }), { deferredIds: [], queue: ['a', 'c'] });
  await assert.rejects(cachedOrder(['a', 'unknown'], options), /恢复记录/);
  await assert.rejects(readDeferred({ ...options, resolution: 2048 }), /待重试记录/);
  await assert.rejects(setDeferred(options, { id: 'unknown', restore: true }), /没有待重试/);
});

test('deferred files still consume cache budget and other failures still stop the pipeline', async t => {
  const directories = await fixture(t);
  const options = pipelineOptions(directories, { maxCacheBytes: 100 });
  await fs.mkdir(path.join(directories.cacheRoot, 'assets', 'held'), { recursive: true });
  await fs.writeFile(path.join(directories.cacheRoot, 'assets', 'held', 'partial.bin'), 'x'.repeat(80));
  await setDeferred(options, { id: 'held', retainedCache: true, reason: 'source denied' });
  const attempted = [];
  const transfer = async ({ id, reserveCache }) => { attempted.push(id); await reserveCache(30); return {}; };
  await assert.rejects(runPipeline({ ids: ['b', 'c'], options, transfer, checkFree: async () => 10000 }), /缓存预算/);
  assert.deepEqual(attempted, ['b']);
  assert.equal((await fs.readFile(path.join(directories.cacheRoot, 'assets', 'held', 'partial.bin'))).length, 80);
  assert.equal((await readDeferred(options)).items.length, 1);
});

test('CLI keeps monitor/status/concurrency options and reads saved progress without login', async t => {
  const { cacheRoot, library } = await fixture(t);
  const messages = [], previousLog = console.log;
  console.log = message => messages.push(message);
  try {
    await downloaderMain(['--help']);
    assert.match(messages.join('\n'), /--monitor/); assert.match(messages.join('\n'), /--status/); assert.match(messages.join('\n'), /--download-workers/);
    const progress = new Progress({ cacheRoot, library, resolution: 4096, mode: 'import', total: 4 });
    await progress.update({ completed: 2, status: 'paused' });
    await downloaderMain(['--status', '--library', library, '--cache', cacheRoot]);
    assert.match(messages.join('\n'), /完成 2\/4/);
    await assert.rejects(downloaderMain(['--download-workers', '9']), /并发数/);
    await assert.rejects(downloaderMain(['--download-assets', '3']), /下载资产数/);
    await assert.rejects(downloaderMain(['--download-connections', '9']), /下载连接数/);
  } finally { console.log = previousLog; }
});

test('material preview selects largest PNG Grid sphere and excludes Popup/clay/tiled downloads', () => {
  const images = [
    { uri: '/sphere01/sphere01_PopupClay_3840.png', resolution: '3840x2160', tags: ['preview', 'clay'] },
    { uri: '/sphere01/sphere01_Popup_3840.png', resolution: '3840x2160', tags: ['preview'] },
    { uri: '/sphere01/sphere01_Grid_420.png', resolution: '420x420', tags: ['thumb'] },
    { uri: '/sphere01/sphere01_Grid_840_thumb.jpg', resolution: '840x840', tags: ['thumb'] },
    { uri: '/sphere01/sphere01_Grid_840.png', resolution: '840x840', tags: ['thumb'] }
  ];
  for (const type of ['surface', 'decal', 'atlas']) {
    const meta = { id: 'sphere01', categories: [type], previews: { images } };
    assert.match(materialPreview(meta, type).uri, /Grid_840.png$/);
    const files = [...images.map(item => ({ file: path.basename(item.uri), bytes: 1 })), { file: 'albedo.jpg', bytes: 1 }];
    assert.deepEqual(selectedFiles(meta, files).map(file => file.file), ['sphere01_Grid_840.png', 'albedo.jpg']);
  }
  assert.equal(materialPreview({ previews: { images } }, '3d'), null);
});

test('ordered queue caches types, excludes plants/HDRI/other and resumes classification after pause', async t => {
  const { cacheRoot } = await fixture(t);
  const metadata = { a: 'decal', b: '3dplant', c: 'hdri', d: 'surface', e: '3d', f: 'brush' };
  let calls = 0, stop = false;
  const client = { metadata: async id => { calls++; return { type: metadata[id] }; } };
  const ids = Object.keys(metadata);
  assert.equal((await orderedCatalog(ids, { client, cacheRoot, concurrency: 2, shouldStop: async () => stop, onProgress: async fields => { if (fields.orderingDone >= 2) stop = true; } })).paused, true);
  assert.equal(calls, 2);
  const result = await orderedCatalog(ids, { client, cacheRoot });
  assert.deepEqual(result.ids, ['e', 'd', 'a']); assert.equal(result.excluded, 3); assert.equal(calls, 6);
  assert.deepEqual(result.counts, { '3d': 1, surface: 1, decal: 1 });
  const cached = await orderedCatalog(ids, { client, cacheRoot });
  assert.deepEqual(cached.ids, ['e', 'd', 'a']); assert.equal(cached.types.b, '3dplant'); assert.equal(calls, 6);
  const plants = await orderedCatalog(ids, { client, cacheRoot, assetTypes: ['3dplant'] });
  assert.deepEqual(plants.ids, ['b']); assert.deepEqual(plants.counts, { '3dplant': 1 });
  const all = await orderedCatalog(ids, { client, cacheRoot, assetTypes: ORDER });
  assert.deepEqual(all.ids, ['e', 'b', 'd', 'a', 'c']); assert.equal(all.excluded, 1); assert.equal(calls, 6);
  assert.deepEqual(selectedTypes('hdri,3dplant,hdri'), ['3dplant', 'hdri']);
  assert.throws(() => selectedTypes([]), /请选择/);
  assert.throws(() => selectedTypes('brush'), /请选择/);
  await assert.rejects(downloaderMain(['--types', '3dplant,invalid']), /请选择/);
});

test('HDRI requests original HDR/EXR and imports them while ordinary textures still reject EXR', () => {
  const maps = [{ type: 'hdr', resolution: '4096x2048', uri: '/sky01/sky.exr', mimeType: 'image/x-exr' },
    { type: 'hdr', resolution: '4096x2048', uri: '/sky01/sky.jpg', mimeType: 'image/jpeg' }];
  const meta = { id: 'sky01', semanticTags: { asset_type: 'hdri' }, maps };
  assert.equal(downloadRequest(meta).components[0].mimeType, 'image/x-exr');
  const files = ['sky.exr', 'preview.jpg'].map(file => ({ file, bytes: 1 }));
  assert.equal(selectedFiles(meta, files).length, 2);
  assert.deepEqual(selectedFiles({ id: 'ordinary', type: 'surface' }, files).map(file => file.file), ['preview.jpg']);
  const slots = [{ filePath: '/sky.exr', textureType: 'HDR' }, { filePath: '/preview.jpg', textureType: 'Albedo' }];
  assert.equal(buildPayload({ assetType: 'hdri', textureSlots: slots }, '/staging').textureEntries[0].filePath, '/sky.exr');
  assert.equal(buildPayload({ assetType: 'surface', textureSlots: slots }, '/staging').textureEntries[0].filePath, '/preview.jpg');
});

test('pause applies only to the active run, never a later continuation', async t => {
  const { cacheRoot } = await fixture(t);
  await atomicJson(path.join(cacheRoot, 'runner.lock'), { host: os.hostname(), pid: process.pid });
  await requestPause(cacheRoot, 'run-one');
  assert.equal(await pauseRequested(cacheRoot, 'run-one'), true);
  assert.equal(await pauseRequested(cacheRoot, 'run-two'), false);
});

test('resume checks existing receipts with visible progress, can pause, and supports full hashes', async t => {
  const directories = await fixture(t);
  const receipt = await transferOne(parameters(directories));
  const args = { ids: ['missing', 'test01'], library: directories.library, resolution: 4096, mode: 'archive' };
  const updates = [];
  const result = await checkCompletedReceipts({ ...args, onProgress: async fields => updates.push(fields) });
  assert.deepEqual([...result.completedIds], ['test01']);
  assert.equal(updates.at(-1).checkingDone, 1); assert.equal(updates.at(-1).checkingTotal, 1);
  assert.equal(updates.at(-1).completed, 1); assert.equal(updates.at(-1).checkingMode, 'quick');
  let checks = 0;
  const paused = await checkCompletedReceipts({ ...args, shouldStop: async () => ++checks > 1 });
  assert.equal(paused.paused, true); assert.equal(paused.completedIds.size, 0);
  const file = path.join(directories.library, receipt.archive.root, 'color.png');
  await fs.writeFile(file, Buffer.alloc(bytes.length));
  assert.equal((await checkCompletedReceipts(args)).completedIds.size, 1);
  await assert.rejects(checkCompletedReceipts({ ...args, full: true }), /校验失败/);
  await assert.rejects(verifyReceipt(directories.library, receipt, 'test01'), /校验失败/);
  await fs.writeFile(file, 'short');
  await assert.rejects(checkCompletedReceipts(args), /校验失败/);
});

test('a forbidden redundant 3D preview does not discard models/textures or block publication', async t => {
  const directories = await fixture(t);
  const meta = { id: 'test01', categories: ['3d'], previews: { images: [{ uri: '/test01/normal.png' }, { uri: '/test01/retina.png' }] } };
  const files = ['high.fbx', 'albedo.png', 'normal.png', 'retina.png'].map(file => ({ file, bytes: bytes.length }));
  const receipt = await transferOne(parameters({ ...directories, downloadWorkers: 4, client: { plan: async () => ({ meta, files }) },
    download: async (entry, dir) => { if (entry.file === 'retina.png') throw Object.assign(new Error('forbidden'), { status: 403 }); await fakeDownload(entry, dir); } }));
  assert.deepEqual(receipt.omittedPreviews, [{ file: 'retina.png', status: 403 }]);
  assert.deepEqual(receipt.archive.files.map(file => file.file).sort(), ['albedo.png', 'high.fbx', 'normal.png', 'test01.json']);
  const saved = JSON.parse(await fs.readFile(path.join(directories.library, receipt.archive.root, 'test01.json'), 'utf8'));
  assert.equal(saved.previews.images.length, 1);
  await verifyReceipt(directories.library, receipt, 'test01');
});

test('forbidden models and sole previews still stop and retain cache', async t => {
  for (const modelFails of [true, false]) {
    const directories = await fixture(t);
    const meta = { id: 'test01', categories: ['3d'], previews: { images: [{ uri: '/test01/preview.png' }] } };
    const files = ['high.fbx', 'preview.png'].map(file => ({ file, bytes: bytes.length }));
    await assert.rejects(transferOne(parameters({ ...directories, client: { plan: async () => ({ meta, files }) }, download: async (entry, dir) => {
      if (entry.file === (modelFails ? 'high.fbx' : 'preview.png')) throw Object.assign(new Error('forbidden'), { status: 403 });
      await fakeDownload(entry, dir);
    } })), modelFails ? /forbidden/ : /所有 3D 预览/);
    assert.equal(await exists(path.join(directories.library, '.megascans/receipts/test01.json')), false);
    assert.equal(await exists(path.join(directories.cacheRoot, 'assets/test01')), true);
  }
});

test('withdrawn catalog 404 is recorded separately; authentication and network failures still stop', async t => {
  const { cacheRoot } = await fixture(t);
  const client = { metadata: async id => {
    if (id === 'gone') throw Object.assign(new Error('missing'), { status: 404 });
    return { type: 'surface' };
  } };
  const result = await orderedCatalog(['gone', 'live'], { client, cacheRoot });
  assert.deepEqual(result.ids, ['live']); assert.equal(result.unavailable, 1);
  const saved = JSON.parse(await fs.readFile(path.join(cacheRoot, 'asset-types.json'), 'utf8'));
  assert.equal(saved.unavailable.gone.status, 404);
  await assert.rejects(orderedCatalog(['expired'], { cacheRoot, client: { metadata: async () => { throw Object.assign(new Error('expired'), { status: 401 }); } } }), /expired/);
});

test('parallel files stay within worker limit and serialize durable progress writes', async t => {
  const directories = await fixture(t);
  const files = Array.from({ length: 7 }, (_, index) => ({ file: `file${index}.jpg`, bytes: bytes.length }));
  let active = 0, maximum = 0, writingProgress = false;
  const receipt = await transferOne(parameters({ ...directories, downloadWorkers: 3,
    client: { plan: async () => ({ ...plan, files }) },
    download: async (entry, dir, { onBytes }) => {
      active++; maximum = Math.max(maximum, active);
      try { await onBytes(2); await new Promise(resolve => globalThis.setTimeout(resolve, 10)); await fakeDownload(entry, dir); }
      finally { active--; }
    }, onProgress: async () => {
      assert.equal(writingProgress, false); writingProgress = true;
      await new Promise(resolve => globalThis.setTimeout(resolve, 1)); writingProgress = false;
    } }));
  assert.equal(maximum, 3); assert.equal(active, 0); assert.equal(receipt.archive.files.length, 8);
});

test('failed parallel download drains in-flight files and never archives a partial asset', async t => {
  const directories = await fixture(t);
  let active = 0;
  const files = [{ file: 'bad.jpg', bytes: bytes.length }, { file: 'slow.jpg', bytes: bytes.length }];
  await assert.rejects(transferOne(parameters({ ...directories, downloadWorkers: 2, client: { plan: async () => ({ ...plan, files }) },
    download: async (entry, dir) => {
      active++;
      try {
        if (entry.file === 'bad.jpg') throw new Error('simulated failure');
        await new Promise(resolve => globalThis.setTimeout(resolve, 3200)); await fakeDownload(entry, dir);
      } finally { active--; }
    } })), /simulated failure/);
  assert.equal(active, 0);
  assert.equal(await exists(path.join(directories.library, '.megascans', 'receipts', 'test01.json')), false);
});

test('inventory excludes unselected stale cache bytes before hashing', async t => {
  const { cacheRoot } = await fixture(t);
  await fs.writeFile(path.join(cacheRoot, 'current.png'), bytes);
  await fs.writeFile(path.join(cacheRoot, 'old.exr'), bytes);
  await fs.writeFile(path.join(cacheRoot, 'current.png.transfer-sha256'), 'checkpoint');
  assert.deepEqual((await inventory(cacheRoot, { include: file => file === 'current.png' })).map(file => file.file), ['current.png']);
});

test('parallel archive failure drains writers and never overwrites a conflicting shared file', async t => {
  const { cacheRoot, library } = await fixture(t);
  for (const name of ['a.bin', 'b.bin', 'c.bin']) await fs.writeFile(path.join(cacheRoot, name), Buffer.alloc(1024 * 1024, 1));
  const files = await inventory(cacheRoot);
  await fs.writeFile(path.join(library, 'a.bin'), Buffer.alloc(1024 * 1024, 2));
  await assert.rejects(copyVerified(cacheRoot, library, files), /已存在不同内容/);
  assert.equal((await fs.readFile(path.join(library, 'a.bin')))[0], 2);
  await verifyInventory(library, files.filter(file => file.file !== 'a.bin'));
  assert.deepEqual((await fs.readdir(library)).sort(), ['a.bin', 'b.bin', 'c.bin']);
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const pipelineOptions = (directories, fields = {}) => parameters({ ...directories,
  client: { plan: async id => ({ meta: { ...plan.meta, id, json: { uri: `${id}.json` } }, files: plan.files }) }, ...fields });

test('one-item pipeline overlaps downloads, gates publication and never creates a third cache', async t => {
  const directories = await fixture(t), bStarted = deferred(), completed = [], stages = [];
  let maxCaches = 0;
  const options = pipelineOptions(directories, { download: async (entry, dir) => {
    maxCaches = Math.max(maxCaches, (await fs.readdir(path.join(directories.cacheRoot, 'assets'))).length);
    if (path.basename(path.dirname(dir)) === 'b') { assert.deepEqual(completed, []); bStarted.resolve(); }
    await fakeDownload(entry, dir);
  } });
  await runPipeline({ ids: ['a', 'b', 'c'], options,
    onProgress: async (id, details) => {
      stages.push([id, details.stage]);
      if (id === 'a' && details.stage === 'archiving') await bStarted.promise;
      if (id === 'b' && details.stage === 'archiving') assert.deepEqual(completed, ['a']);
    }, onCompleted: async id => completed.push(id)
  });
  assert.deepEqual(completed, ['a', 'b', 'c']);
  assert.equal(maxCaches, 2);
  assert.ok(stages.some(([id, stage]) => id === 'b' && stage === 'prefetched'));
  assert.deepEqual(await fs.readdir(path.join(directories.cacheRoot, 'assets')), []);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directories.cacheRoot, 'pipeline.json'))).ids, []);
  for (const id of completed) await verifyReceipt(directories.library, JSON.parse(await fs.readFile(path.join(directories.library, '.megascans/receipts', `${id}.json`))), id);
});

test('dual-asset downloads share a bounded connection pool and publish in order', { timeout: 10000 }, async t => {
  const directories = await fixture(t), bStarted = deferred(), completed = [];
  const active = new Map();
  let count = 0, peakConnections = 0, peakAssets = 0, maxCaches = 0;
  const options = pipelineOptions(directories, { downloadWorkers: 4,
    client: { plan: async id => ({ meta: { ...plan.meta, id }, files: Array.from({ length: 6 }, (_, i) => ({ file: `map${i}.png`, bytes: bytes.length })) }) },
    download: async (entry, dir) => {
      const owner = path.basename(path.dirname(dir));
      count++; peakConnections = Math.max(peakConnections, count);
      active.set(owner, (active.get(owner) || 0) + 1); peakAssets = Math.max(peakAssets, active.size);
      maxCaches = Math.max(maxCaches, (await fs.readdir(path.join(directories.cacheRoot, 'assets'))).length);
      if (owner === 'b') bStarted.resolve();
      try {
        if (owner === 'a' && entry.file === 'map0.png') await bStarted.promise;
        await new Promise(resolve => globalThis.setTimeout(resolve, 15));
        await fakeDownload(entry, dir);
      } finally { count--; const remaining = active.get(owner) - 1; if (remaining) active.set(owner, remaining); else active.delete(owner); }
    }
  });
  await runPipeline({ ids: ['a', 'b', 'c'], options, downloadAssets: 2, downloadConnections: 4,
    onProgress: async (id, details) => { if (id === 'b' && details.stage === 'archiving') assert.deepEqual(completed, ['a']); },
    onCompleted: async id => completed.push(id)
  });
  assert.deepEqual(completed, ['a', 'b', 'c']);
  assert.equal(peakConnections, 4); assert.equal(peakAssets, 2); assert.equal(maxCaches, 2); assert.equal(count, 0);
});

test('combined cache budget falls back to serial instead of exceeding the cap', async t => {
  const directories = await fixture(t), body = Buffer.alloc(4096, 1);
  let waited = false;
  const options = pipelineOptions(directories, { maxCacheBytes: 9000,
    client: { plan: async id => ({ meta: { ...plan.meta, id }, files: [{ file: 'color.png', bytes: body.length }] }) },
    download: async (entry, dir) => {
      if (path.basename(path.dirname(dir)) === 'b') assert.equal(await exists(path.join(directories.cacheRoot, 'assets/a')), false);
      await fs.writeFile(path.join(dir, entry.file), body);
      assert.ok((await inventory(path.join(directories.cacheRoot, 'assets'), { content: false })).reduce((sum, file) => sum + file.bytes, 0) <= 9000);
    }
  });
  await runPipeline({ ids: ['a', 'b'], options, downloadAssets: 2, onProgress: async (id, details) => {
    if (id === 'a' && details.stage === 'archiving') await new Promise(resolve => globalThis.setTimeout(resolve, 50));
    if (details.stage === 'waiting_capacity') waited = true;
  } });
  assert.equal(waited, true);
});

test('dual download reserves foreground bytes still in flight against free-space floor', { timeout: 10000 }, async t => {
  const directories = await fixture(t), waiting = deferred(), body = Buffer.alloc(4096, 1);
  let foregroundWritten = false, waited = false;
  const options = pipelineOptions(directories, {
    client: { plan: async id => ({ meta: { ...plan.meta, id }, files: [{ file: 'color.png', bytes: body.length }] }) },
    download: async (entry, dir) => {
      if (path.basename(path.dirname(dir)) === 'a') { await waiting.promise; foregroundWritten = true; }
      else assert.equal(foregroundWritten, true, 'prefetch cannot spend space reserved by the unfinished foreground download');
      await fs.writeFile(path.join(dir, entry.file), body);
    }
  });
  await runPipeline({ ids: ['a', 'b'], options, downloadAssets: 2, checkFree: async () => 7000,
    onProgress: async (id, details) => { if (id === 'b' && details.stage === 'waiting_capacity') { waited = true; waiting.resolve(); } }
  });
  assert.equal(waited, true);
});

test('foreground failure drains prefetched streams, preserves both caches and resumes their durable order', async t => {
  const directories = await fixture(t), bStarted = deferred();
  let bDrained = false;
  const options = pipelineOptions(directories, { download: async (entry, dir) => {
    if (path.basename(path.dirname(dir)) === 'b') {
      bStarted.resolve();
      await new Promise(resolve => globalThis.setTimeout(resolve, 100));
      bDrained = true;
    }
    await fakeDownload(entry, dir);
  } });
  await assert.rejects(runPipeline({ ids: ['a', 'b', 'c'], options, downloadAssets: 2, onProgress: async (id, details) => {
    if (id === 'a' && details.stage === 'archiving') { await bStarted.promise; throw new Error('share offline'); }
  } }), /share offline/);
  assert.equal(bDrained, true);
  assert.deepEqual((await fs.readdir(path.join(directories.cacheRoot, 'assets'))).sort(), ['a', 'b']);
  assert.deepEqual(await cachedOrder(['b', 'a'], options), ['a', 'b']);
  assert.equal(await exists(path.join(directories.library, '.megascans/receipts/a.json')), false);
  assert.equal(await exists(path.join(directories.library, '.megascans/receipts/b.json')), false);
  await runPipeline({ ids: await cachedOrder(['b', 'a'], options), options });
  assert.deepEqual(await fs.readdir(path.join(directories.cacheRoot, 'assets')), []);
});

test('pause finishes the primary, drains prefetched work without publishing it, and supports continuation', async t => {
  const directories = await fixture(t), bStarted = deferred();
  let stop = false, drained = false;
  const options = pipelineOptions(directories, { download: async (entry, dir) => {
    if (path.basename(path.dirname(dir)) === 'b') {
      stop = true; bStarted.resolve();
      await new Promise(resolve => globalThis.setTimeout(resolve, 50)); drained = true;
    }
    await fakeDownload(entry, dir);
  } });
  await runPipeline({ ids: ['a', 'b', 'c'], options, downloadAssets: 2, shouldStop: async () => stop,
    onProgress: async (id, details) => { if (id === 'a' && details.stage === 'archiving') await bStarted.promise; }
  });
  assert.equal(drained, true);
  assert.equal(await exists(path.join(directories.library, '.megascans/receipts/a.json')), true);
  assert.equal(await exists(path.join(directories.library, '.megascans/receipts/b.json')), false);
  assert.deepEqual(await cachedOrder(['b'], options), ['b']);
  stop = false;
  await runPipeline({ ids: ['b'], options: { ...options, download: fakeDownload }, shouldStop: async () => stop });
  assert.deepEqual(await fs.readdir(path.join(directories.cacheRoot, 'assets')), []);
});

test('unrecorded multiple caches are rejected and serial mode never prefetches', async t => {
  const directories = await fixture(t), options = pipelineOptions(directories);
  await assert.rejects(cachedOrder(['a', 'b'], options), /恢复记录/);
  let primaryDone = false;
  await runPipeline({ ids: ['a', 'b'], options, prefetch: false,
    onProgress: async id => { if (id === 'b') assert.equal(primaryDone, true); },
    onCompleted: async id => { if (id === 'a') primaryDone = true; }
  });
});

test('byte progress coalesces writes and preserves the final durable boundary', async t => {
  const { cacheRoot, library } = await fixture(t);
  const writes = [];
  const progress = new Progress({ cacheRoot, library, resolution: 4096, mode: 'archive', byteFlushMs: 10000,
    writeJson: async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); writes.push({ file, value: globalThis.structuredClone(value) }); }
  });
  await progress.asset('test01', { stage: 'downloading', downloadedBytes: 0 });
  const initialWrites = writes.length;
  for (let downloadedBytes = 1; downloadedBytes <= 100; downloadedBytes++) await progress.asset('test01', { stage: 'downloading', downloadedBytes, byteUpdate: true });
  assert.equal(writes.length, initialWrites, 'byte callbacks must not block streams on SMB writes');
  await progress.asset('test01', { stage: 'verifying' });
  await progress.flush();
  assert.equal(writes.at(-1).value.current.downloadedBytes, 100);
  assert.equal(writes.at(-1).value.current.stage, 'verifying');
  assert.equal(writes.length, initialWrites + 4);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assethive-megascans-test-'));
  const cacheRoot = path.join(root, 'cache'), library = path.join(root, 'library');
  await fs.mkdir(cacheRoot); await fs.mkdir(library);
  t.after(async () => {
    // The resolved delete target must remain our freshly-created test workspace.
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(os.tmpdir()));
    assert.match(path.basename(root), /^assethive-megascans-test-/);
    await fs.rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, cacheRoot, library };
}
const bytes = Buffer.from('original resource');
const plan = { meta: { id: 'test01', name: 'Rock', categories: ['surface'], components: [], json: { uri: '/test01/test01.json' } }, files: [{ file: 'color.png', bytes: bytes.length, url: 'https://cdn.quixel.com/test01/color.png' }] };
const fakeDownload = async (entry, dir) => { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, entry.file), bytes); };
const parameters = fields => ({ id: 'test01', client: { plan: async () => globalThis.structuredClone(plan) }, resolution: 4096, maxCacheBytes: 1024 * 1024, reserveBytes: 0, mode: 'archive', log: () => {}, download: fakeDownload, ...fields });

test('non-3D-Asset v1 request keeps FBX LODs and excludes EXR-only displacement', () => {
  const meta = { id: 'rock01', meshes: [{ type: 'lod', tris: 100 }, { type: 'lod', tris: 50 }], components: [
    { type: 'normal', uris: [{ resolutions: [{ resolution: '4096x4096', formats: [{ uri: '/n.jpg', mimeType: 'image/jpeg', tris: 100 }, { uri: '/n1.jpg', mimeType: 'image/jpeg', tris: 50 }] }] }] },
    { type: 'displacement', uris: [{ resolutions: [{ resolution: '4096x2048', formats: [{ uri: '/h.exr', mimeType: 'image/x-exr' }] }] }] }
  ] };
  const request = downloadRequest(meta);
  assert.deepEqual(request.config.lods, [100, 50]);
  assert.equal(request.config.meshMimeType, 'application/x-fbx');
  assert.deepEqual(request.components.filter(x => x.type === 'normal').map(x => x.tris), [100, 50]);
  assert.equal(request.components.find(x => x.type === 'displacement'), undefined);
});

test('v2 request preserves variation coverage by not selecting just one variation', () => {
  const request = downloadRequest({ id: 'plant01', version: 2, models: [{ type: 'lod', lod: 0 }, { type: 'lod', lod: 1 }], maps: [{ type: 'albedo', resolution: '2048x2048', mimeType: 'image/jpeg', uri: '/a.jpg' }] });
  assert.deepEqual(request.meshes, [{ mimeType: 'application/x-fbx', lod: 0 }, { mimeType: 'application/x-fbx', lod: 1 }]);
  assert.equal(request.components[0].resolution, '2048x2048');
});

test('3D Assets cap textures at 4K in both API formats even when global resolution is 8K', () => {
  const maps = [2048, 4096, 8192].map(size => ({ type: 'albedo', resolution: `${size}x${size}`, mimeType: 'image/jpeg', uri: `/albedo_${size}.jpg` }));
  const types = [{ categories: ['3d', 'other'] }, { assetCategories: { '3D asset': { props: {} } } }, { assetType: '3d' }];
  for (const version of [1, 2]) {
    for (const type of types) {
      const highFile = { mimeType: 'application/x-fbx', uri: '/rock01/rock01_High.fbx' };
      const meta = { id: 'rock01', version, ...type, ...(version === 2 ? { maps, models: [{ type: 'vfx', uris: [highFile] }] } : { components: maps, meshes: [{ type: 'original', uris: [highFile] }] }) };
      assert.deepEqual(downloadRequest(meta, 8192).components.map(c => c.resolution), ['4096x4096']);
      assert.deepEqual(downloadRequest(meta, 2048).components.map(c => c.resolution), ['2048x2048']);
    }
  }
  for (const category of ['surface', 'decal', 'atlas', 'imperfection', 'displacement']) {
    assert.equal(downloadRequest({ id: 'surface01', categories: [category], maps }, 8192).components[0].resolution, '4096x4096');
  }
  assert.equal(downloadRequest({ id: 'plant01', categories: ['3dplant'], maps }, 8192).components[0].resolution, '8192x8192');
});

test('3D Assets request only Highpoly FBX; server extras and EXR are excluded', () => {
  const highFile = { mimeType: 'application/x-fbx', uri: '/rock01/rock01_High.fbx' };
  for (const version of [1, 2]) {
    const meta = { id: 'rock01', categories: ['3d'], version, components: [],
      ...(version === 2 ? { models: [{ type: 'vfx', uris: [highFile] }, { type: 'lod', lod: 0 }] } : { meshes: [{ type: 'original', uris: [highFile] }, { type: 'lod', tris: 100 }] }) };
    const request = downloadRequest(meta);
    if (version === 2) assert.deepEqual(request.meshes, [{ mimeType: 'application/x-fbx', type: 'vfx' }]);
    else { assert.equal(request.config.highpoly, true); assert.deepEqual(request.config.lods, []); assert.equal(request.config.lowerlod_normals, false); }
    const files = ['rock01_High.fbx', 'rock01_LOD0.fbx', 'rock01_High.obj', 'height.EXR', 'albedo.png'].map(file => ({ file, bytes: 1 }));
    assert.deepEqual(selectedFiles(meta, files).map(file => file.file), ['rock01_High.fbx', 'albedo.png']);
    assert.throws(() => selectedFiles(meta, files.filter(file => file.file !== 'rock01_High.fbx')), /没有所需的 Highpoly/);
  }
  assert.throws(() => downloadRequest({ id: 'nohigh', categories: ['3d'], meshes: [{ type: 'lod', tris: 10 }] }), /没有可用的 Highpoly/);
  const components = downloadRequest({ id: 'surface01', components: [{ type: 'displacement', uris: [
    { uri: '/h.exr', resolution: '4096x4096', mimeType: 'image/x-exr' },
    { uri: '/h.png', resolution: '2048x2048', mimeType: 'image/png' }
  ] }] }).components;
  assert.equal(components[0].mimeType, 'image/png');
  assert.equal(components[0].resolution, '2048x2048');
});

test('progress persists stages, failure details and append-only history across runs', async t => {
  const directories = await fixture(t);
  const args = { ...directories, resolution: 4096, mode: 'import', total: 2 };
  const progress = new Progress(args);
  await progress.update({ skipped: 1, completed: 1, pending: 1 });
  await progress.asset('test01', { stage: 'downloading', completedFiles: 1, totalFiles: 3, downloadedBytes: 20 });
  await progress.failed(new Error('CDN https://cdn.quixel.com/file?secret=private Bearer hidden-value'));
  const state = await readProgress(args);
  assert.equal(state.status, 'failed');
  assert.equal(state.current.id, 'test01');
  assert.equal(state.completed, 1);
  const share = JSON.parse(await fs.readFile(path.join(args.library, '.megascans', 'progress.json'), 'utf8'));
  assert.deepEqual(share, state);
  const journal = path.join(args.library, '.megascans', 'events.jsonl');
  const before = await fs.readFile(journal, 'utf8');
  assert.ok(!before.includes('secret=private'));
  assert.ok(!before.includes('hidden-value'));
  await new Progress(args).update();
  assert.ok((await fs.readFile(journal, 'utf8')).startsWith(before));
  assert.ok(!safeError(new Error('eyJhbGciOiJIUzI1NiJ9.abc.def')).includes('eyJ'));
});

test('signed manifests reject unknown sizes, duplicate destinations, and unsafe hosts/paths', () => {
  assert.throws(() => trustedDownload('https://evil.test/a'), /非 Quixel/);
  assert.throws(() => relativeUri('/id/a%2fb.png', 'id'), /不安全/);
  assert.throws(() => relativeUri('/id/CON.png', 'id'), /不安全/);
  assert.throws(() => signedFiles({ uri: 'https://cdn.quixel.com/id/a.png' }, 'id'), /大小未知/);
  assert.throws(() => signedFiles([{ uri: 'https://cdn.quixel.com/id/a.png?x=1', contentLength: 2 }, { uri: 'https://cdn.quixel.com/id/a.png?x=2', contentLength: 2 }], 'id'), /重名/);
  assert.deepEqual(signedFiles({ uri: 'https://cdn.quixel.com/id/a.png?secret=abc', contentLength: 2 }, 'id').map(x => x.file), ['a.png']);
});

test('401 fails immediately and never includes a token in the error', async () => {
  let calls = 0;
  const client = new QuixelClient('private-token', { fetchImpl: async () => { calls++; return new globalThis.Response('{}', { status: 401 }); } });
  await assert.rejects(client.acquired(), error => !error.message.includes('private-token') && /登录/.test(error.message));
  assert.equal(calls, 1);
});

test('rate limits retry and acquired list deduplicates; changed pagination shapes fail closed', async () => {
  let calls = 0;
  const client = new QuixelClient('private-token', { sleep: async () => {}, fetchImpl: async () => ++calls === 1 ? new globalThis.Response('{}', { status: 429 }) : new globalThis.Response('[{"assetID":"a1"},{"assetID":"a1"},{"assetID":"b2"}]') });
  assert.deepEqual(await client.acquired(), ['a1', 'b2']);
  const changed = new QuixelClient('x', { fetchImpl: async () => new globalThis.Response('{"items":[],"next":true}') });
  await assert.rejects(changed.acquired(), /格式变化/);
});

test('bounded download rejects oversized body and removes .part', async t => {
  const { cacheRoot } = await fixture(t);
  await assert.rejects(downloadFile({ file: 'a.bin', bytes: 2, url: 'https://cdn.quixel.com/a.bin' }, cacheRoot, { checkFree: async () => 100, fetchImpl: async () => new globalThis.Response('too big') }), /超过/);
  assert.equal(await exists(path.join(cacheRoot, 'a.bin.part')), false);
  assert.equal(await exists(path.join(cacheRoot, 'a.bin')), false);
});

test('completed files reuse verified cache; same-size tampering triggers redownload', async t => {
  const { cacheRoot } = await fixture(t);
  let calls = 0;
  const entry = { file: 'a.bin', bytes: 3, url: 'https://cdn.quixel.com/a.bin' };
  const options = { checkFree: async () => 100, fetchImpl: async () => { calls++; return new globalThis.Response('abc'); } };
  await downloadFile(entry, cacheRoot, options);
  await downloadFile(entry, cacheRoot, options);
  assert.equal(calls, 1);
  await fs.writeFile(path.join(cacheRoot, 'a.bin'), 'bad');
  await downloadFile(entry, cacheRoot, options);
  assert.equal(calls, 2);
  assert.equal(await fs.readFile(path.join(cacheRoot, 'a.bin'), 'utf8'), 'abc');
});

test('signed JSON metadata accepts its content type; error pages and malformed JSON never publish', async t => {
  const { cacheRoot } = await fixture(t);
  const body = '{"id":"test01"}';
  const options = (text, type) => ({ checkFree: async () => 1000, fetchImpl: async () => new globalThis.Response(text, { headers: { 'content-type': type } }) });
  const entry = { file: 'test01.json', bytes: Buffer.byteLength(body), url: 'https://cdn.quixel.com/test01.json' };
  await downloadFile(entry, cacheRoot, options(body, 'application/json; charset=utf-8'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(cacheRoot, entry.file), 'utf8')), { id: 'test01' });
  for (const [file, text, type, error] of [
    ['model.fbx', body, 'application/json', /不是资源/],
    ['html.json', '<html>error</html>', 'text/html', /不是资源/],
    ['broken.json', '{', 'application/json', /JSON 文件无效/]
  ]) {
    await assert.rejects(downloadFile({ ...entry, file, bytes: Buffer.byteLength(text) }, cacheRoot, options(text, type)), error);
    assert.equal(await exists(path.join(cacheRoot, file)), false);
    assert.equal(await exists(path.join(cacheRoot, file + '.part')), false);
    assert.equal(await exists(path.join(cacheRoot, file + '.transfer-sha256')), false);
  }
});

test('archive → hashes → receipt → local cleanup; rerun does not redownload', async t => {
  const directories = await fixture(t);
  const args = parameters(directories);
  const receipt = await transferOne(args);
  assert.equal(await exists(path.join(directories.cacheRoot, 'assets', 'test01')), false);
  await verifyInventory(path.join(directories.library, receipt.archive.root), receipt.archive.files);
  assert.ok(!JSON.stringify(receipt).includes('?secret='));
  args.client.plan = () => { throw new Error('must not download'); };
  assert.deepEqual(await transferOne(args), receipt);
  await assert.rejects(transferOne({ ...args, resolution: 8192 }), /另一分辨率/);
});

test('import failure preserves local cache and does not publish completion; rerun can finish', async t => {
  const directories = await fixture(t);
  const args = parameters({ ...directories, mode: 'import', importer: async () => ({ ok: false, message: 'offline' }) });
  await assert.rejects(transferOne(args), /offline/);
  assert.equal(await exists(path.join(directories.cacheRoot, 'assets', 'test01', 'payload', 'color.png')), true);
  assert.equal(await exists(path.join(directories.library, '.megascans', 'receipts', 'test01.json')), false);
  args.importer = async () => {
    const dest = path.join(directories.library, 'Environment', 'Surfaces', 'megascans_test01');
    await fs.mkdir(dest, { recursive: true });
    await atomicJson(path.join(dest, 'asset_info.json'), { id: 'test01' });
    return { ok: true, assetPath: dest };
  };
  await transferOne(args);
  assert.equal(await exists(path.join(directories.cacheRoot, 'assets', 'test01')), false);
});

test('share corruption blocks resume and preserves remaining local cache', async t => {
  const directories = await fixture(t);
  const args = parameters(directories);
  const receipt = await transferOne(args);
  await ownedCache(directories.cacheRoot, 'test01');
  await fs.writeFile(path.join(directories.library, receipt.archive.root, 'color.png'), 'broken');
  await assert.rejects(transferOne(args), /校验失败/);
  assert.equal(await exists(path.join(directories.cacheRoot, 'assets', 'test01')), true);
});

test('oversized asset stops before download; unowned cache cannot be deleted', async t => {
  const directories = await fixture(t);
  let calls = 0;
  await assert.rejects(transferOne(parameters({ ...directories, maxCacheBytes: 1, download: async () => { calls++; } })), /超过缓存/);
  assert.equal(calls, 0);
  await atomicJson(path.join(directories.cacheRoot, 'assets', 'test01', '.transfer-owner.json'), { id: 'someone-else' });
  await assert.rejects(cleanupOwnedCache(directories.cacheRoot, 'test01'), /拒绝清理/);
  await assert.rejects(cleanupOwnedCache(directories.cacheRoot, '..'), /无效/);
});

test('interrupted partial files do not prevent resume or enter the shared archive', async t => {
  const directories = await fixture(t);
  const dir = await ownedCache(directories.cacheRoot, 'test01');
  await fs.mkdir(path.join(dir, 'payload'), { recursive: true });
  await fs.writeFile(path.join(dir, 'payload', 'color.png.part'), Buffer.alloc(2000));
  await fs.writeFile(path.join(dir, 'payload', 'old_albedo_8K.jpg'), Buffer.alloc(100));
  const receipt = await transferOne(parameters({ ...directories, maxCacheBytes: 2000 }));
  assert.ok(receipt.archive.files.every(file => !file.file.endsWith('.part')));
  assert.equal(receipt.archive.files.some(file => file.file === 'old_albedo_8K.jpg'), false);
  assert.equal(await exists(path.join(directories.library, receipt.archive.root, 'old_albedo_8K.jpg')), false);
});

test('full import payload keeps every model variant, LOD, atlas and billboard texture', () => {
  const metadata = { name: 'Plant', assetType: '3dplant', modelFiles: ['/a/Var1_LOD0.fbx', '/a/Var2_LOD0.fbx'], modelVariants: [{ file: '/a/Var1_LOD0.fbx', variantKey: '01' }, { file: '/a/Var2_LOD0.fbx', variantKey: '02' }], modelLods: [{ file: '/a/Var1_LOD1.fbx', variantKey: '01', lod: 1 }, { file: '/a/Var2_LOD1.fbx', variantKey: '02', lod: 1 }], textureSlots: [{ filePath: '/a/a.jpg', textureType: 'Albedo', materialRole: 'atlas' }, { filePath: '/a/b.jpg', textureType: 'Albedo', materialRole: 'billboard' }] };
  const payload = buildPayload(metadata, '/staging');
  assert.equal(Object.keys(payload.modelSlots).length, 2);
  assert.equal(payload.modelLodFiles.Mesh2[0].filePath, '/a/Var2_LOD1.fbx');
  assert.equal(payload.textureEntries.length, 2);
});

test('import publishing recovers after rename and rejects modified final content', async t => {
  const { library } = await fixture(t);
  const source = path.join(library, '.megascans', 'originals', 'test01');
  await fs.mkdir(source, { recursive: true });
  const job = { id: 'test01', source, library };
  let calls = 0;
  const services = {
    readMetadata: async () => ({ name: 'Rock', assetType: 'surface', standardAssetTags: ['Megascans'], textureSlots: [{ filePath: '/fixture/color.png', textureType: 'Albedo' }] }),
    importAsset: async payload => {
      calls++;
      const dest = path.join(payload.destinationPath, 'random_asset_id');
      await fs.mkdir(dest, { recursive: true });
      await fs.writeFile(path.join(dest, 'color.png'), bytes);
      await atomicJson(path.join(dest, 'asset_info.json'), { assetID: 'internal', name: 'Rock', assetType: 'surface', identity: { sourceKind: 'megascans', sourceAssetId: 'test01' }, textureFiles: [path.join(dest, 'color.png')], components: [{ uri: 'color.png', type: 'texture' }] });
      return { ok: true, assetPath: dest };
    }
  };
  const result = await runImportJob(job, services);
  const meta = JSON.parse(await fs.readFile(path.join(result.assetPath, 'asset_info.json'), 'utf8'));
  assert.equal(meta.textureFiles[0].replaceAll('\\', '/'), path.join(result.assetPath, 'color.png').replaceAll('\\', '/'));
  await atomicJson(path.join(result.assetPath, 'asset_info.json'), { ...meta, tags: ['edited tag'], scanInformation: { dimensions: { x: 1, y: 2, z: 3 } } });
  assert.equal((await runImportJob(job, services)).recovered, true);
  assert.equal(calls, 1);
  await fs.writeFile(path.join(result.assetPath, 'color.png'), 'tampered');
  await assert.rejects(runImportJob(job, services), /校验失败/);
});
