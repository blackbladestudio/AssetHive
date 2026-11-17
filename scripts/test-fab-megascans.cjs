const test = require('node:test');
const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { deflateRawSync } = require('node:zlib');
const { RemoteZip, trustedFabUrl } = require('./lib/fab-zip.cjs');
const { FabMegascans, sourceIdFromName, existingIds, freePrice, readBridgeMetadata, packageTextureMap, rawNormalMap, applyListingExclusions, isRawModelFile, transientFabConnection } = require('./lib/fab-megascans.cjs');

function archive(name = 'abc.json', crc = 0x3610a686) {
  const filename = Buffer.from(name), data = deflateRawSync(Buffer.from('hello'));
  const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(8, 8); header.writeUInt16LE(filename.length, 26);
  const local = Buffer.concat([header, filename, data]);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(5, 24); central.writeUInt16LE(filename.length, 28);
  const directory = Buffer.concat([central, filename]), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, directory, end]);
}
function zipWith(bytes, ranges = []) {
  return new RemoteZip('https://emp-fastly-stitched.epicgamescdn.com/asset.zip?signature=private', bytes.length, { fetchImpl: async (url, options) => {
    const [, start, end] = options.headers.Range.match(/bytes=(\d+)-(\d+)/).map(Number);
    ranges.push([start, end]);
    return new globalThis.Response(bytes.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` } });
  } });
}

test('Fab filenames preserve source ID case across old and new packages', () => {
  assert.equal(sourceIdFromName('historic_stand_ogAwj_raw.zip'), 'ogAwj');
  assert.equal(sourceIdFromName('brick_wcohafz_4k.zip'), 'wcohafz');
  assert.equal(sourceIdFromName('brick_wcohafz_4k_ue_high.zip'), 'wcohafz');
  assert.equal(sourceIdFromName('butternut_squash_ve3kadgjw_gltf_raw.zip'), 've3kadgjw');
  assert.equal(sourceIdFromName('readme.zip'), null);
});
test('deduplication uses current native identity, preserving case siblings', () => {
  const known = existingIds({ assets: ['AbC', 'abc'].map((id, index) => ({ metaPath: `/library/${index}/asset_info.json`, record: {
    id: `generated${index}`, meta: { identity: { sourceKind: 'megascans', sourceAssetId: id } }
  } })) });
  assert.equal(known.size, 2); assert.equal(known.has('generated0'), false);
  assert.deepEqual(known.get('AbC'), ['/library/0/asset_info.json']);
});
test('price check requires a free Professional license from Quixel', () => {
  const detail = { user: { uid: '45ea3429-f62c-4f17-aa15-5bb9dfcd0079' }, isFree: false,
    licenses: [{ slug: 'professional', priceTier: { price: 0 } }] };
  assert.equal(freePrice(detail), true);
  assert.equal(freePrice({ ...detail, licenses: [{ slug: 'professional', priceTier: { price: 4.99 } }] }), false);
  assert.equal(freePrice({ ...detail, user: { uid: 'different-seller' } }), false);
});

test('Raw FBX selection preserves native IDs and titles containing lod while excluding real export tokens', () => {
  assert.equal(isRawModelFile('Urban_Shanty_Town_Facade_Metal_Modular_01_zglodfanb_Raw.fbx', 'zglodfanb'), true);
  assert.equal(isRawModelFile('Layout_Clod_Stone_abc_Raw.fbx', 'abc'), true);
  assert.equal(isRawModelFile('Stone_layout_Raw.fbx', 'layout'), true);
  for (const name of ['Stone_abc_LOD0.fbx', 'Stone_abc_LOD_1_High.fbx', 'Stone_abc_Layout.fbx', 'LOD0/mesh.fbx', 'Layout/mesh.fbx', 'Stone_abc_Raw.obj']) {
    assert.equal(isRawModelFile(name, 'abc'), false, name);
  }
});

test('explicit bundle exclusions survive refreshed listings and preserve other metadata exclusions', () => {
  const uid = '6426cc8a-2410-45be-b3ce-edfea87d09cc';
  const input = [{ uid, sourceId: 'construction' }, { uid: 'other', excludedSourceType: '3dplant' }];
  const result = applyListingExclusions(input, { listingIds: [uid] });
  assert.equal(result[0].excludedSourceType, 'bundle'); assert.equal(result[0].excludedByUser, true);
  assert.equal(result[1].excludedSourceType, '3dplant'); assert.equal(input[0].excludedSourceType, undefined);
  assert.throws(() => applyListingExclusions(input, { listingIds: ['invalid'] }), /配置无效/);
  assert.equal(applyListingExclusions(input, { sourceType: 'mature', listingIds: [uid] })[0].excludedSourceType, 'mature');
  assert.throws(() => applyListingExclusions(input, { sourceType: 'unrecognized', listingIds: [uid] }), /配置无效/);
});

test('a replaced Fab file UUID refreshes formats once and retries with current free pricing', async () => {
  const client = new FabMegascans('/unused'); let refreshed = false, priceChecks = 0; const used = [];
  client.request = async () => { priceChecks++; return { user: { uid: '45ea3429-f62c-4f17-aa15-5bb9dfcd0079' }, licenses: [{ slug: 'professional', priceTier: { price: 0 } }] }; };
  client.formats = async (listing, { refresh } = {}) => {
    if (refresh) refreshed = true;
    return [{ assetFormatType: { code: 'fbx' }, files: [
      { name: 'test_abc_raw.zip', uid: 'raw' }, { name: 'test_abc_high.zip', uid: refreshed ? 'new-high' : 'old-high' }
    ] }];
  };
  client.zip = async (uid, format, file) => {
    used.push(file.uid);
    if (file.uid === 'old-high') throw Object.assign(new Error('missing file'), { status: 404, endpoint: '/i/listings/test/asset-formats/fbx/files/old-high/download-info' });
    return metadataZip('abc.json', { id: 'abc', categories: ['3d'] });
  };
  const plan = await client.plan({ uid: 'test', listingType: '3d-model', sourceId: 'abc' }, { knownIds: new Map([['abc', []]]) });
  assert.deepEqual(plan.files, []); assert.equal(priceChecks, 2);
  assert.deepEqual(used, ['old-high', 'new-high', 'raw']);
});

test('format refresh does not loop or mask listing 404 and authorization failures', async () => {
  for (const error of [
    Object.assign(new Error('file gone'), { status: 404, endpoint: '/i/listings/test/asset-formats/fbx/files/file/download-info' }),
    Object.assign(new Error('listing gone'), { status: 404, endpoint: '/i/listings/test' }),
    Object.assign(new Error('denied'), { status: 403, endpoint: '/i/listings/test/asset-formats/fbx/files/file/download-info' })
  ]) {
    const client = new FabMegascans('/unused'); let attempts = 0, refreshes = 0;
    client.planCurrent = async () => { attempts++; throw error; }; client.formats = async () => { refreshes++; };
    await assert.rejects(client.plan({ uid: 'test' }), candidate => candidate === error);
    assert.equal(attempts, error.message === 'file gone' ? 2 : 1); assert.equal(refreshes, attempts - 1);
  }
});
test('a transient CDN failure requests another official signed URL without changing hosts', async () => {
  const bytes = archive(); let requests = 0;
  const client = new FabMegascans('/unused', { fetchImpl: async (url, options) => {
    if (url.endsWith('/unavailable')) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    const [, start, end] = options.headers.Range.match(/bytes=(\d+)-(\d+)/).map(Number);
    return new globalThis.Response(bytes.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` } });
  } });
  client.request = async () => ({ downloadInfo: [{ downloadUrl: ++requests === 1 ? 'https://unavailable.epicgamescdn.com/unavailable' : 'https://media.fab.com/available' }] });
  const zip = await client.zip('listing', 'fbx', { uid: 'file', size: bytes.length });
  assert.equal(requests, 2); assert.equal(zip.entries[0].name, 'abc.json');
});
test('native fetch timeouts retry while authorization and integrity failures remain final', () => {
  assert.equal(transientFabConnection(new globalThis.DOMException('The operation was aborted due to timeout', 'TimeoutError')), true);
  assert.equal(transientFabConnection(new globalThis.DOMException('Aborted', 'AbortError')), true);
  assert.equal(transientFabConnection({ code: 23, error: 'The operation was aborted due to timeout' }), true);
  assert.equal(transientFabConnection({ cause: { code: 'UND_ERR_BODY_TIMEOUT' } }), true);
  assert.equal(transientFabConnection({ status: 403 }), false);
  assert.equal(transientFabConnection(new Error('ZIP metadata CRC mismatch')), false);
});

test('small ZIP metadata reads use a short timeout while asset streams retain their transfer budget', async () => {
  const zip = zipWith(archive()), budgets = [], range = zip.range.bind(zip);
  zip.range = (start, end, options) => { budgets.push(options?.timeoutMs); return range(start, end, options); };
  await zip.directory(); await zip.read(zip.entries[0]);
  assert.deepEqual(budgets, [30000, 30000, 30000, 30000]);
  budgets.length = 0;
  for await (const chunk of await zip.stream(zip.entries[0])) assert.ok(chunk.length);
  assert.deepEqual(budgets, [30000, 30 * 60 * 1000]);
});

test('paid assets stop before download-info requests', async () => {
  const client = new FabMegascans('/unused'); const requests = [];
  client.request = async endpoint => { requests.push(endpoint); return { licenses: [] }; };
  await assert.rejects(client.plan({ uid: 'test' }), error => error.code === 'FAB_NOT_FREE');
  assert.deepEqual(requests, ['/i/listings/test']);
});

test('mature content can be skipped during identity discovery without masking other permission failures', async () => {
  const client = new FabMegascans('/unused');
  client.formats = async () => { throw Object.assign(new Error('skip'), { code: 'FAB_MATURE_SKIPPED' }); };
  assert.deepEqual(await client.listingIdentity({ uid: 'mature' }), { uid: 'mature', excludedSourceType: 'mature', excludedByUser: true });
  client.formats = async () => { throw Object.assign(new Error('denied'), { status: 403 }); };
  await assert.rejects(client.listingIdentity({ uid: 'restricted' }), error => error.status === 403);
});

const metadataZip = (name, meta) => ({ entries: [{ name }], read: async () => Buffer.from(JSON.stringify(meta)) });
test('lowercased Fab package IDs resolve to the exact native ID inside Bridge JSON', async () => {
  const meta = await readBridgeMetadata([metadataZip('rbrkA.json', { id: 'rbrkA', categories: ['3dplant'] })], 'rbrka');
  assert.equal(meta.id, 'rbrkA');
  const known = new Map([['rbrka', 'different-asset']]);
  assert.equal(known.has(meta.id), false);
});
test('Bridge metadata may be nested or only present in the Raw package', async () => {
  const meta = await readBridgeMetadata([{ entries: [] }, metadataZip('source/AbC.json', { id: 'AbC' })], 'abc');
  assert.equal(meta.id, 'AbC');
});
test('genuinely missing Bridge metadata is an item-specific unsupported format', async () => {
  await assert.rejects(readBridgeMetadata([{ entries: [{ name: 'mesh.fbx' }] }], 'abc'), error => error.code === 'FAB_UNSUPPORTED');
});
test('unrelated or ambiguous native metadata cannot change the asset identity', async () => {
  await assert.rejects(readBridgeMetadata([metadataZip('abc.json', { id: 'different' })], 'abc'), /不匹配/);
  await assert.rejects(readBridgeMetadata([{ entries: [{ name: 'a/abc.json' }, { name: 'b/abc.json' }] }], 'abc'), /多个/);
});
test('a Fab 3D listing with plant metadata is excluded before model selection or downloads', async () => {
  const client = new FabMegascans('/unused');
  client.request = async () => ({ user: { uid: '45ea3429-f62c-4f17-aa15-5bb9dfcd0079' }, licenses: [{ slug: 'professional', priceTier: { price: 0 } }] });
  client.formats = async () => [{ assetFormatType: { code: 'fbx' }, files: [{ name: 'dead_leaves_rbrka_high.zip' }, { name: 'dead_leaves_rbrka_raw.zip' }] }];
  client.zip = async () => metadataZip('rbrkA.json', { id: 'rbrkA', categories: ['3dplant', 'plants', '3d'] });
  await assert.rejects(client.plan({ uid: 'listing', sourceId: 'rbrka', listingType: '3d-model' }), error => error.code === 'FAB_EXCLUDED' && error.nativeId === 'rbrkA' && error.assetType === '3dplant');
});

test('4K package maps accept stale 8K metadata and retain the selected tier calibration', () => {
  const map = packageTextureMap({ maps: [
    { type: 'bump', uri: 'tier_0/piEuq_8K_Bump.jpg', resolution: '8192x8192', tier: 0, scale: 1 },
    { type: 'bump', uri: 'tier_1/piEuq_8K_Bump.jpg', resolution: '8192x8192', tier: 1, scale: 2 }
  ] }, { name: 'Sandstone_Rock_piEuq_High_4K_Bump.jpg', bytes: 2470242 }, 1);
  assert.equal(map.resolution, '4096x4096'); assert.equal(map.scale, 2);
  assert.equal(map.type, 'bump'); assert.equal(map.contentLength, 2470242);
});
test('texture aliases match source semantics while unknown types remain deferred', () => {
  assert.equal(packageTextureMap({ maps: [{ type: 'albedo', uri: 'abc.png' }] }, { name: 'abc_4K_BaseColor.jpg', bytes: 20 }).type, 'albedo');
  assert.equal(packageTextureMap({ maps: [] }, { name: 'abc_8K_Bump.jpg' }), null);
  assert.throws(() => packageTextureMap({ maps: [{ type: 'normal' }] }, { name: 'abc_4K_Bump.jpg', bytes: 2 }), error => error.code === 'FAB_UNSUPPORTED');
});
test('Raw normal selection keeps the Raw tier and its original 8K resolution', () => {
  const meta = { maps: [
    { type: 'normal', tier: 1, uri: 'tier_1/abc_4K_Normal.jpg', resolution: '4096x4096', calibration: 'high' },
    { type: 'normal', tier: 0, uri: 'tier_0/abc_8K_Normal.jpg', resolution: '8192x8192', calibration: 'raw' }
  ] };
  const selected = rawNormalMap(meta, { entries: [{ name: 'Stone_abc_Raw_8K_Normal.jpg', bytes: 100 }] });
  assert.equal(selected.map.tier, 0);
  assert.equal(selected.map.resolution, '8192x8192');
  assert.equal(selected.map.calibration, 'raw');
  assert.throws(() => rawNormalMap(meta, { entries: [{ name: 'mesh.fbx' }] }), error => error.code === 'FAB_UNSUPPORTED');
  assert.throws(() => rawNormalMap({ maps: meta.maps.slice(0, 1) }, { entries: [selected.entry] }), /缺少 Raw 档/);
});
test('Fab 3D plans pair Raw mesh with Raw normal and keep other 4K High textures', async () => {
  const meta = { id: 'abc', categories: ['3d'], maps: [
    { type: 'normal', tier: 0, uri: 'tier_0/abc_8K_Normal.jpg', resolution: '8192x8192' },
    { type: 'normal', tier: 1, uri: 'tier_1/abc_4K_Normal.jpg', resolution: '4096x4096' },
    { type: 'albedo', tier: 1, uri: 'tier_1/abc_4K_Albedo.jpg', resolution: '4096x4096' }
  ] };
  const raw = metadataZip('abc.json', meta);
  raw.entries.push({ name: 'Stone_abc_Raw.fbx', bytes: 1000 }, { name: 'Stone_abc_Raw_8K_Normal.jpg', bytes: 100 });
  const high = metadataZip('abc.json', meta);
  high.entries.push({ name: 'Stone_abc_High_4K_Normal.jpg', bytes: 20 }, { name: 'Stone_abc_High_4K_Albedo.jpg', bytes: 20 });
  const client = new FabMegascans('/unused', { fetchImpl: async () => new globalThis.Response(null, { headers: { 'content-length': '10' } }) });
  client.request = async () => ({ user: { uid: '45ea3429-f62c-4f17-aa15-5bb9dfcd0079' },
    licenses: [{ slug: 'professional', priceTier: { price: 0 } }], medias: [{ type: 'image', mediaUrl: 'https://media.fab.com/preview.jpg' }] });
  client.formats = async () => [{ assetFormatType: { code: 'fbx' }, files: [{ name: 'stone_abc_raw.zip' }, { name: 'stone_abc_high.zip' }] }];
  const packages = [];
  client.zip = async (uid, format, file) => { packages.push(file.name); return /_raw/.test(file.name) ? raw : high; };
  const listing = { uid: 'listing', sourceId: 'abc', listingType: '3d-model' };
  const plan = await client.plan(listing);
  assert.deepEqual(plan.files.filter(file => /Normal/.test(file.file)).map(file => file.file), ['Stone_abc_Raw_8K_Normal.jpg']);
  assert.ok(plan.files.some(file => file.file === 'Stone_abc_Raw.fbx'));
  assert.ok(plan.files.some(file => file.file === 'Stone_abc_High_4K_Albedo.jpg'));
  packages.length = 0;
  const normalOnly = await client.plan(listing, { normalOnly: true });
  assert.equal(normalOnly.files.length, 1);
  assert.equal(normalOnly.normal.tier, 0);
  assert.deepEqual(packages, ['stone_abc_raw.zip']);
  raw.entries = raw.entries.filter(entry => entry.name !== 'abc.json');
  await client.plan(listing, { normalOnly: true });
  assert.equal(packages.at(-1), 'stone_abc_high.zip');
  raw.entries = raw.entries.filter(entry => !/Normal/.test(entry.name));
  await assert.rejects(client.plan(listing), /禁止搭配 High 法线/);
});
test('ZIP member decompression validates CRC and bounded ranges', async () => {
  const ranges = [], zip = zipWith(archive(), ranges);
  const entries = await zip.directory();
  assert.equal((await zip.read(entries[0])).toString(), 'hello');
  assert.equal(ranges.length, 4);
  assert.deepEqual(ranges.at(-1), [38, 44]);
});
test('ZIP path traversal and case collisions never become local files', async () => {
  await assert.rejects(zipWith(archive('../escape')).directory(), /不安全/);
  await assert.rejects(zipWith(archive('C:/escape')).directory(), /不安全/);
});
test('corrupted decompressed bytes fail CRC rather than being imported', async () => {
  const zip = zipWith(archive('abc.json', 123)); const [entry] = await zip.directory();
  await assert.rejects(zip.read(entry), /CRC/);
});
test('a server ignoring Range is rejected without consuming the full archive', async () => {
  const zip = new RemoteZip('https://media.fab.com/a.zip', 100, { fetchImpl: async () => new globalThis.Response('unexpected', { status: 200 }) });
  await assert.rejects(zip.directory(), /Range/);
});

test('oversized ZIP format is deferred per item while invalid sizes remain integrity errors', () => {
  assert.throws(() => new RemoteZip('https://media.fab.com/a.zip', 4537890550), error => error.code === 'FAB_UNSUPPORTED');
  for (const size of [0, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new RemoteZip('https://media.fab.com/a.zip', size), error => error.code !== 'FAB_UNSUPPORTED');
  }
});
test('signed URLs must remain on official download hosts', () => {
  assert.match(trustedFabUrl('https://content-download-emp.distro.on.epicgames.com/a'), /^https:/);
  assert.throws(() => trustedFabUrl('https://fab.com.attacker.example/a'));
  assert.throws(() => trustedFabUrl('https://user:password@media.fab.com/a'));
});
