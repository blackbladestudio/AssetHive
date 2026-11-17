const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const { FabMegascans } = require('./lib/fab-megascans.cjs');
const { atomicJson } = require('./lib/megascans-transfer.cjs');
const { main } = require('./fab-megascans-runner.cjs');

test('runner deduplicates with a gzip-only index and prefers it over stale legacy JSON', async t => {
  const parent = path.resolve(__dirname, '../.cache/fab-runner-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'gzip-index-'));
  const library = path.join(root, 'library'), cache = path.join(root, 'cache');
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(parent));
    await fs.rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
  });
  const metaPath = path.join(library, 'existing/asset_info.json');
  await atomicJson(metaPath, {});
  await fs.mkdir(path.join(library, '.assethive'), { recursive: true });
  const index = { assets: [{ metaPath, record: { meta: { identity: { sourceKind: 'megascans', sourceAssetId: 'existingfixture' } } } }] };
  const compressedPath = path.join(library, '.assethive/custom-index.json.gz');
  await fs.writeFile(compressedPath, gzipSync(JSON.stringify(index)));
  await atomicJson(path.join(cache, 'free-catalog.json'), { items: [{ uid: 'existing', sourceId: 'existingfixture', listingType: '3d-model' }] });
  for (const legacy of [false, true]) {
    if (legacy) await atomicJson(path.join(library, '.assethive/custom-index.json'), { assets: [] });
    await main(['--library', library, '--cache', cache]);
    const result = JSON.parse(await fs.readFile(path.join(cache, 'deduplication.json'), 'utf8'));
    assert.equal(result.duplicates, 1);
    assert.equal(result.pending, 0);
  }
  await fs.writeFile(compressedPath, 'corrupt gzip');
  await assert.rejects(main(['--library', library, '--cache', cache]), { code: 'Z_DATA_ERROR' });
});

test('reference-only free listings finish outside the download queue and retain an auditable price list', async t => {
  const parent = path.resolve(__dirname, '../.cache/fab-runner-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'not-free-'));
  const library = path.join(root, 'library'), cache = path.join(root, 'cache');
  const originalRequest = FabMegascans.prototype.request, requests = [];
  t.after(async () => {
    FabMegascans.prototype.request = originalRequest;
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(parent));
    await fs.rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
  });
  FabMegascans.prototype.request = async endpoint => {
    requests.push(endpoint);
    return { user: { uid: '45ea3429-f62c-4f17-aa15-5bb9dfcd0079' }, licenses: [
      { slug: 'uefn-reference-only', priceTier: { price: 0 } },
      { slug: 'professional', priceTier: { price: 4.99 } }
    ] };
  };
  await atomicJson(path.join(library, '.assethive/custom-index.json'), { assets: [] });
  await atomicJson(path.join(cache, 'eula-consent.json'), { userConfirmed: true, scope: 'test-fixture' });
  await atomicJson(path.join(cache, 'free-catalog.json'), { items: [{ uid: 'paidfixture', sourceId: 'abc', listingType: '3d-model', title: 'Fixture' }] });
  await atomicJson(path.join(cache, 'deferred.json'), { items: [{ id: 'old-recovered-error' }] });
  await main(['--run', '--library', library, '--cache', cache]);
  const progress = JSON.parse(await fs.readFile(path.join(cache, 'progress.json'), 'utf8'));
  const notFree = JSON.parse(await fs.readFile(path.join(cache, 'not-free.json'), 'utf8'));
  const deferred = JSON.parse(await fs.readFile(path.join(cache, 'deferred.json'), 'utf8'));
  assert.equal(progress.status, 'completed'); assert.equal(progress.pending, 0);
  assert.equal(progress.notFree, 1); assert.equal(progress.completed, 0); assert.equal(progress.total, 0);
  assert.equal(progress.deferred, 0); assert.deepEqual(deferred.items, []);
  assert.equal(notFree.items[0].listingId, 'paidfixture');
  assert.deepEqual(requests, ['/i/listings/paidfixture']);
});

test('newly encountered mature content is excluded by user policy even with a healthy control asset', async t => {
  const parent = path.resolve(__dirname, '../.cache/fab-runner-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'mature-'));
  const library = path.join(root, 'library'), cache = path.join(root, 'cache');
  const originalPlan = FabMegascans.prototype.plan;
  t.after(async () => {
    FabMegascans.prototype.plan = originalPlan;
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(parent));
    await fs.rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
  });
  FabMegascans.prototype.plan = async listing => {
    assert.equal(listing.sourceId, 'maturefixture', 'user exclusion must not probe control assets');
    throw Object.assign(new Error('按用户要求暂时跳过成熟内容'), { code: 'FAB_MATURE_SKIPPED', status: 403, source: 'fab', assetType: 'mature' });
  };
  const metaPath = path.join(library, 'existing/asset_info.json');
  await atomicJson(metaPath, {});
  await atomicJson(path.join(library, '.assethive/custom-index.json'), { assets: [{ metaPath,
    record: { meta: { identity: { sourceKind: 'megascans', sourceAssetId: 'existingfixture' } } } }] });
  await atomicJson(path.join(cache, 'eula-consent.json'), { userConfirmed: true, scope: 'test-fixture' });
  await atomicJson(path.join(cache, 'free-catalog.json'), { items: [
    { uid: 'existing', sourceId: 'existingfixture', listingType: '3d-model' },
    { uid: 'newmature', sourceId: 'maturefixture', listingType: '3d-model' }
  ] });
  await main(['--run', '--library', library, '--cache', cache]);
  const progress = JSON.parse(await fs.readFile(path.join(cache, 'progress.json'), 'utf8'));
  const catalog = JSON.parse(await fs.readFile(path.join(cache, 'free-catalog.json'), 'utf8'));
  assert.equal(progress.status, 'completed'); assert.equal(progress.pending, 0); assert.equal(progress.deferred, 0);
  assert.equal(progress.excludedByMetadata, 1);
  assert.equal(catalog.items.find(item => item.uid === 'newmature').excludedSourceType, 'mature');
});
