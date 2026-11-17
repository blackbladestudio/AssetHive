const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Buffer } = require('node:buffer');
const { pruneArchive, createArchiveBudget } = require('./lib/megascans-archive-retention.cjs');
const { DOWNLOAD_POLICY, inventory, atomicJson, metadataReferences, verifyReceipt, exists } = require('./lib/megascans-transfer.cjs');
const { checkCompletedReceipts } = require('./lib/megascans-resume.cjs');
const { runPipeline } = require('./lib/megascans-pipeline.cjs');
const { main } = require('./megascans-runner.cjs');
const { encodedKey, receiptPath } = require('./lib/megascans-paths.cjs');

test('capacity cleanup resolves an encoded case-sensitive receipt without touching its sibling', async t => {
  const f = await fixture(t), a = await f.asset('CaseAsset');
  const key = encodedKey(a.receipt.id), archive = path.join(path.dirname(a.archive), key);
  await fs.rename(a.archive, archive);
  a.receipt.archive.root = path.relative(f.library, archive);
  const imported = path.join(path.dirname(a.root), key);
  await fs.rename(a.root, imported);
  a.receipt.imported.root = path.relative(f.library, imported);
  const legacy = path.join(f.library, '.megascans/receipts/CaseAsset.json');
  await atomicJson(path.join(f.library, '.megascans/receipts', key + '.json'), a.receipt);
  await fs.unlink(legacy);
  const sibling = await f.asset('caseasset');
  await pruneArchive({ library: f.library, id: 'CaseAsset' });
  assert.equal(JSON.parse(await fs.readFile(await receiptPath(f.library, 'CaseAsset'))).archive.retention.status, 'pruned');
  assert.equal(await exists(path.join(sibling.archive, 'model.fbx')), true);
});

async function fixture(t) {
  const parent = path.resolve(__dirname, '../.cache/megascans-retention-tests');
  await fs.mkdir(parent, { recursive: true });
  const library = await fs.mkdtemp(path.join(parent, 'run-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(library)), await fs.realpath(parent));
    await fs.rm(library, { recursive: true, maxRetries: 5, retryDelay: 100 });
  });
  async function asset(id, completedAt = '2020-01-01', imported = true) {
    const archive = path.join(library, '.megascans/originals/v3', id), root = path.join(library, 'Environment/3D Assets', id);
    await fs.mkdir(archive, { recursive: true }); await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(archive, 'model.fbx'), Buffer.alloc(64, 1));
    await fs.writeFile(path.join(archive, 'color.png'), Buffer.alloc(128, 2));
    await fs.writeFile(path.join(archive, 'preview.png'), Buffer.alloc(16, 3));
    await atomicJson(path.join(archive, id + '.json'), { id, components: [{ type: 'albedo', uri: 'color.png' }], meshes: [{ uri: 'model.fbx' }], previews: { images: [{ uri: 'preview.png' }] } });
    await fs.copyFile(path.join(archive, 'model.fbx'), path.join(root, 'model.fbx'));
    await fs.copyFile(path.join(archive, 'color.png'), path.join(root, 'color.png'));
    const meta = { schemaVersion: '1.0', assetID: id + '-fixed', assetType: '3d', identity: { sourceKind: 'megascans', sourceAssetId: id }, modelFiles: ['model.fbx'], textureFiles: ['color.png'],
      components: [{ type: 'mesh', uri: 'model.fbx' }, { type: 'texture', uri: 'color.png' }], tags: ['user'] };
    await atomicJson(path.join(root, 'asset_info.json'), meta);
    const files = await inventory(root);
    const receipt = { id, version: 1, policy: DOWNLOAD_POLICY, resolution: 4096, mode: imported ? 'import' : 'archive', completedAt,
      archive: { root: path.relative(library, archive), files: await inventory(archive) },
      ...(imported ? { imported: { root: path.relative(library, root), files, metadataReferences: metadataReferences(root, meta, id, files) } } : {}) };
    await atomicJson(path.join(library, '.megascans/receipts', id + '.json'), receipt);
    return { archive, root, receipt, meta };
  }
  return { library, asset, usage: async () => (await inventory(path.join(library, '.megascans/originals'), { content: false })).reduce((sum, file) => sum + file.bytes, 0) };
}

test('archive cap prunes oldest verified import, retains JSON/previews and resumes without redownload', async t => {
  const f = await fixture(t), old = await f.asset('old'), recent = await f.asset('recent', '2021-01-01');
  const used = await f.usage(), cap = used - 1;
  const budget = await createArchiveBudget({ library: f.library, maxBytes: cap });
  assert.equal(budget.snapshot().reclaimedBytes, 192);
  assert.equal(await exists(path.join(old.archive, 'color.png')), false);
  assert.equal(await exists(path.join(old.archive, 'old.json')), true);
  assert.equal(await exists(path.join(old.archive, 'preview.png')), true);
  assert.equal(await exists(path.join(recent.archive, 'model.fbx')), true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(old.root, 'asset_info.json'), 'utf8')), old.meta);
  const updated = JSON.parse(await fs.readFile(path.join(f.library, '.megascans/receipts/old.json'), 'utf8'));
  assert.equal(updated.archive.files.length, old.receipt.archive.files.length);
  await verifyReceipt(f.library, updated, 'old');
  const checked = await checkCompletedReceipts({ ids: ['old', 'recent'], library: f.library, resolution: 4096, mode: 'import', full: true });
  assert.equal(checked.completedIds.size, 2);
  await fs.unlink(path.join(old.archive, 'old.json'));
  await assert.rejects(verifyReceipt(f.library, updated, 'old'), /ENOENT/);
});

test('interrupted deletion intent resumes even when capacity is already below limit', async t => {
  const f = await fixture(t), a = await f.asset('resume');
  await assert.rejects(pruneArchive({ library: f.library, id: 'resume', afterDelete: async () => { throw new Error('interrupted'); } }), /interrupted/);
  const receiptPath = path.join(f.library, '.megascans/receipts/resume.json');
  const pending = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(pending.archive.retention.status, 'pruning');
  await verifyReceipt(f.library, pending, 'resume');
  await createArchiveBudget({ library: f.library, maxBytes: 100000 });
  const repaired = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(repaired.archive.retention.status, 'pruned');
  await verifyReceipt(f.library, repaired, 'resume');
  assert.equal(await exists(path.join(a.archive, 'model.fbx')), false);
  await assert.rejects(pruneArchive({ library: f.library, id: 'resume', shouldStop: async () => true }), { code: 'MEGASCANS_PAUSED' });
});

test('corrupted import or changed source never gets silently deleted', async t => {
  const f = await fixture(t), a = await f.asset('broken'), b = await f.asset('changed');
  await fs.writeFile(path.join(a.root, 'color.png'), Buffer.alloc(128, 9));
  await assert.rejects(pruneArchive({ library: f.library, id: 'broken' }), /校验失败/);
  assert.equal(await exists(path.join(a.archive, 'color.png')), true);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.library, '.megascans/receipts/broken.json'), 'utf8')).archive.retention, undefined);
  await fs.writeFile(path.join(b.archive, 'color.png'), Buffer.alloc(128, 9));
  await assert.rejects(pruneArchive({ library: f.library, id: 'changed' }), /被修改/);
  assert.equal(await exists(path.join(b.archive, 'color.png')), true);
});

test('unimported and unowned files consume capacity and remain protected', async t => {
  const f = await fixture(t), a = await f.asset('archiveOnly', '2020', false);
  await fs.writeFile(path.join(f.library, '.megascans/originals/unowned.bin'), 'keep');
  await assert.rejects(createArchiveBudget({ library: f.library, maxBytes: 1 }), /受保护或未成功入库/);
  assert.equal(await exists(path.join(a.archive, 'model.fbx')), true);
  await assert.rejects(main(['--max-archive-gb', '0']), /上限必须为正数/);
});

test('incoming archive reserves space before copy and newly completed assets remain eligible', async t => {
  const f = await fixture(t); const first = await f.asset('first');
  const initial = await f.usage(), incoming = initial, maxBytes = initial + incoming - 1;
  const budget = await createArchiveBudget({ library: f.library, maxBytes });
  const archiveRoot = path.join(f.library, '.megascans/originals/v3/later');
  await budget.reserve({ id: 'later', archiveRoot, files: first.receipt.archive.files.map(file => ({ ...file, file: file.file.replace('first', 'later') })) });
  assert.ok(budget.snapshot().usedBytes <= maxBytes);
  assert.equal(budget.snapshot().prunedAssets, 1);
  const a = await f.asset('later', '2022');
  budget.completed(a.receipt);
  assert.equal(await f.usage(), budget.snapshot().usedBytes);
  // The new candidate is considered without restarting the runner.
  const retained = a.receipt.archive.files.filter(file => /\.json$/.test(file.file) || file.file === 'preview.png').reduce((sum, file) => sum + file.bytes, 0);
  await budget.reserve({ id: 'next', archiveRoot: path.join(f.library, '.megascans/originals/v3/next'), files: [{ file: 'next.bin', bytes: maxBytes - budget.snapshot().usedBytes + 1 }] });
  assert.equal(budget.snapshot().prunedAssets, 2);
  assert.ok(retained > 0);
});

test('pipeline applies archive reservation after promotion and before publication', async t => {
  const f = await fixture(t), events = [], cacheRoot = path.join(f.library, 'cache');
  await runPipeline({ ids: ['one', 'two'], options: { library: f.library, cacheRoot, resolution: 4096, mode: 'import',
    beforeArchive: async details => events.push('reserve:' + details.id) },
    transfer: async ({ id, beforeArchive }) => { await beforeArchive({ id }); events.push('publish:' + id); return { id }; },
    onCompleted: async id => events.push('complete:' + id) });
  assert.deepEqual(events, ['reserve:one', 'publish:one', 'complete:one', 'reserve:two', 'publish:two', 'complete:two']);
});
