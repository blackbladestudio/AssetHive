const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { inventory, metadataReferences, verifyImportedFiles, atomicJson } = require('./lib/megascans-transfer.cjs');

async function fixture(t) {
  const parent = path.resolve(__dirname, '../.cache/megascans-preview-edit-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'run-'));
  t.after(async () => { assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(parent)); await fs.rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 }); });
  await fs.mkdir(path.join(root, 'Preview'));
  await fs.writeFile(path.join(root, 'model.fbx'), 'model');
  await fs.writeFile(path.join(root, 'Preview/old.png'), 'original preview');
  const meta = { schemaVersion: '1.0', assetID: 'local', assetType: '3d', identity: { sourceKind: 'megascans', sourceAssetId: 'abc' },
    modelFiles: ['model.fbx'], previewImage: 'Preview/old.png', detailImage: 'Preview/old.png' };
  await atomicJson(path.join(root, 'asset_info.json'), meta);
  const files = await inventory(root), references = metadataReferences(root, meta, 'abc', files);
  await fs.writeFile(path.join(root, 'Preview/new.png'), 'edited preview');
  await fs.unlink(path.join(root, 'Preview/old.png'));
  const next = { ...meta, previewImage: 'Preview/new.png', detailImage: 'Preview/new.png' };
  await atomicJson(path.join(root, 'asset_info.json'), next);
  return { root, files, references, meta: next };
}
test('versioned editor preview replacement does not invalidate a completed import', async t => {
  const f = await fixture(t); await verifyImportedFiles(f.root, 'abc', f.files, f.references);
});
test('preview replacement never weakens model checksum verification', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'model.fbx'), 'MODEL');
  await assert.rejects(verifyImportedFiles(f.root, 'abc', f.files, f.references));
});
test('the edited preview must still exist', async t => {
  const f = await fixture(t); await fs.unlink(path.join(f.root, 'Preview/new.png'));
  await assert.rejects(verifyImportedFiles(f.root, 'abc', f.files, f.references), /ENOENT/);
});
test('an edited preview cannot reference a file outside its asset', async t => {
  const f = await fixture(t); await atomicJson(path.join(f.root, 'asset_info.json'), { ...f.meta, previewImage: '../outside.png' });
  await assert.rejects(verifyImportedFiles(f.root, 'abc', f.files, f.references), /越界/);
});
