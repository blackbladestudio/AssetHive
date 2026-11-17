const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { repairTextureSlots } = require('./repair-megascans-texture-slots.cjs');
const { writeAssetMetadata } = require('../electron/services/assetMetadata');
const { computeContentIdentity } = require('../electron/services/assetIdentity');
const { DOWNLOAD_POLICY, inventory, atomicJson, metadataReferences, hashFile, verifyReceipt, exists } = require('./lib/megascans-transfer.cjs');

async function fixture(t, slot = 'Roughness') {
  const parent = path.resolve(__dirname, '../.cache/megascans-texture-repair-tests');
  await fs.mkdir(parent, { recursive: true });
  const library = await fs.mkdtemp(path.join(parent, 'run-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(library)), await fs.realpath(parent));
    await fs.rm(library, { recursive: true, maxRetries: 5, retryDelay: 100 });
  });
  const id = 'testR', root = path.join(library, 'Environment/3D Assets/megascans_testR');
  const archive = path.join(library, '.megascans/originals/v3', id);
  await fs.mkdir(root, { recursive: true }); await fs.mkdir(archive, { recursive: true });
  const preview = 'testR_Thumb_HighPoly.png', wrong = `T_example_${slot}.png`;
  const image = color => sharp({ create: { width: 16, height: 16, channels: 3, background: color } });
  await image({ r: 250, g: 0, b: 0 }).png().toFile(path.join(archive, preview));
  await image({ r: 120, g: 120, b: 120 }).jpeg().toFile(path.join(archive, 'roughness.jpg'));
  await fs.writeFile(path.join(archive, 'high.fbx'), 'fixed model bytes');
  await atomicJson(path.join(archive, id + '.json'), { id, source: 'quixel', components: [{ type: 'roughness', uri: 'roughness.jpg' }], previews: { images: [{ uri: preview }] } });
  await fs.copyFile(path.join(archive, preview), path.join(root, wrong));
  await fs.copyFile(path.join(archive, 'high.fbx'), path.join(root, 'SM_example.fbx'));
  const models = { Mesh: path.join(root, 'SM_example.fbx') };
  const identity = await computeContentIdentity({ modelSlots: models, textureSlots: [{ suffix: slot, source: path.join(root, wrong), areaIndex: 1, materialRole: 'atlas' }] });
  await writeAssetMetadata(root, { assetID: 'fixedid', name: 'Keep custom name', slug: 'megascans_testR', assetType: '3d', category: 'Props', source: 'custom',
    standardAssetTags: ['Megascans'], tags: ['user tag'], zionTags: ['user zion'], favorite: true, exportCount: 9, dimensions: { x: 2, y: 3, z: 4 },
    modelFiles: Object.values(models), modelSlots: models, textureFiles: [path.join(root, wrong)], textureSlots: { [slot]: path.join(root, wrong) },
    textureEntries: [{ textureType: slot, uri: wrong, areaIndex: 1, materialRole: 'atlas' }],
    components: [{ type: 'mesh', slot: 'Mesh', uri: 'SM_example.fbx' }, { type: 'texture', slot, uri: wrong, areaIndex: 1, materialRole: 'atlas' }],
    identity: { ...identity, schemaVersion: 1, sourceKind: 'megascans', sourceAssetId: id, sourceKey: 'megascans:testR' },
    createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', normalMapFormat: 'opengl', normalMapFormats: { 1: 'opengl' }, revision: 1 });
  const meta = JSON.parse(await fs.readFile(path.join(root, 'asset_info.json'), 'utf8'));
  const files = await inventory(root), refs = metadataReferences(root, meta, id, files);
  const receipt = { version: 1, policy: DOWNLOAD_POLICY, id, mode: 'import', resolution: 4096, archive: { root: path.relative(library, archive), files: await inventory(archive) },
    imported: { root: path.relative(library, root), files, metadataReferences: refs } };
  await atomicJson(path.join(library, '.megascans/receipts', id + '.json'), receipt);
  await atomicJson(path.join(library, '.megascans/imports', id + '.json'), { id, finalRoot: root, files, metadataReferences: refs });
  return { library, root, archive, id, wrong, meta, issue: { id, inferredFromAssetDirectory: slot, files: [{ file: wrong }] } };
}

test('repairs real maps, removes invented slots, preserves user metadata and verifies receipts', async t => {
  for (const slot of ['Roughness', 'Emissive']) {
    const f = await fixture(t, slot);
    const result = await repairTextureSlots(f.library, f.issue);
    assert.ok(result.completedAt);
    const meta = JSON.parse(await fs.readFile(path.join(f.root, 'asset_info.json'), 'utf8'));
    for (const field of ['assetID', 'name', 'tags', 'zionTags', 'favorite', 'exportCount', 'dimensions', 'createdAt', 'normalMapFormats']) assert.deepEqual(meta[field], f.meta[field]);
    assert.deepEqual(meta.identity.modelFingerprints, f.meta.identity.modelFingerprints);
    assert.notEqual(meta.identity.contentFingerprint, f.meta.identity.contentFingerprint);
    assert.equal(await exists(path.join(f.root, f.wrong)), false);
    assert.equal(meta.textureFiles.length, slot === 'Roughness' ? 1 : 0);
    const backup = path.join(f.library, '.megascans/texture-slot-repairs/backups', f.id);
    assert.equal(await hashFile(path.join(backup, 'removed', f.wrong)), await hashFile(path.join(f.archive, 'testR_Thumb_HighPoly.png')));
    if (slot === 'Roughness') assert.equal(await hashFile(path.join(f.root, meta.textureEntries[0].uri)), await hashFile(path.join(f.archive, 'roughness.jpg')));
    const receipt = JSON.parse(await fs.readFile(path.join(f.library, '.megascans/receipts', f.id + '.json'), 'utf8'));
    await verifyReceipt(f.library, receipt, f.id);
    const record = JSON.parse(await fs.readFile(path.join(f.library, '.megascans/imports', f.id + '.json'), 'utf8'));
    assert.deepEqual(record.metadataReferences, receipt.imported.metadataReferences);
  }
});

test('repair resumes after metadata publication and is idempotent after completion', async t => {
  const f = await fixture(t);
  await assert.rejects(repairTextureSlots(f.library, f.issue, { afterStep: async step => { if (step === 'metadata') throw new Error('simulated interruption'); } }), /simulated interruption/);
  await repairTextureSlots(f.library, f.issue);
  const first = await fs.readFile(path.join(f.root, 'asset_info.json'), 'utf8');
  await repairTextureSlots(f.library, f.issue);
  assert.equal(await fs.readFile(path.join(f.root, 'asset_info.json'), 'utf8'), first);
  assert.equal(JSON.parse(first).revision, 2);
});

test('replay rejects metadata edited during interruption and initial corruption preserves files', async t => {
  const f = await fixture(t);
  await assert.rejects(repairTextureSlots(f.library, f.issue, { afterStep: async () => { throw new Error('interrupted'); } }), /interrupted/);
  const file = path.join(f.root, 'asset_info.json'), meta = JSON.parse(await fs.readFile(file, 'utf8'));
  meta.tags.push('new user tag'); await fs.writeFile(file, JSON.stringify(meta));
  await assert.rejects(repairTextureSlots(f.library, f.issue), /元数据被编辑/);
  assert.ok(JSON.parse(await fs.readFile(file, 'utf8')).tags.includes('new user tag'));
  const corrupt = await fixture(t);
  await fs.writeFile(path.join(corrupt.root, corrupt.wrong), 'changed data');
  await assert.rejects(repairTextureSlots(corrupt.library, corrupt.issue), /校验失败/);
  assert.equal(await exists(path.join(corrupt.root, corrupt.wrong)), true);
});
