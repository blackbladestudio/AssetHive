const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const shared = require('../electron/services/characterSharedResources');
const updates = require('../electron/services/characterSharedUpdates');
const { withRecycleLock } = require('../electron/services/libraryRecycle');
const { withFileTransaction } = require('../electron/services/assetFileTransaction');
const digest = text => createHash('sha256').update(text).digest('hex');

test('cross-asset texture update is atomic, preserves history, and detects another owner changing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'character-shared-update-'));
  try {
    const parents = [];
    let state = shared.empty();
    for (const id of ['one', 'two']) {
      const directory = path.join(root, id);
      await fs.mkdir(directory);
      const name = `T_${id}_D.tga`;
      await fs.writeFile(path.join(directory, name), 'old');
      const meta = { assetID: id, name: id, assetType: 'monster', character: { maturity: 'rigged' },
        characterManifest: { files: [{ normalizedName: name, storedPath: name, role: 'texture', sha256: digest('old') }] } };
      const metaPath = path.join(directory, 'asset_info.json');
      await fs.writeFile(metaPath, JSON.stringify(meta));
      const parent = { id, path: directory, metaPath, meta, assetType: 'monster' };
      parents.push(parent);
      state = shared.registerResource(state, { reference: { assetId: id, localKey: `${id}:D`, metadataPath: `${id}/asset_info.json`, sourceName: name },
        evidence: { kind: 'texture', channel: 'D', config: {}, sourceHash: digest('old') }, scopeId: 'batch',
        ueTarget: { key: `${id}:D`, path: `/Game/Test/T_${id}_D` } }).state;
    }
    // Two local material groups can refer to this same texture identity.
    const alternateName = 'T_one_Alternate_D.tga';
    await fs.writeFile(path.join(parents[0].path, alternateName), 'old');
    parents[0].meta.characterManifest.files.push({ normalizedName: alternateName, storedPath: alternateName, role: 'texture', sha256: digest('old') });
    await fs.writeFile(parents[0].metaPath, JSON.stringify(parents[0].meta));
    state = shared.registerResource(state, { reference: { assetId: 'one', localKey: 'one:alternate:D', metadataPath: 'one/asset_info.json', sourceName: alternateName },
      evidence: { kind: 'texture', channel: 'D', config: {}, sourceHash: digest('old') }, scopeId: 'batch',
      ueTarget: { key: 'one:alternate:D', path: '/Game/Test/T_One_Alternate_D' } }).state;
    await shared.mutateRegistry(root, () => ({ state }));
    const sourcePath = path.join(root, 'replacement.tga');
    await fs.writeFile(sourcePath, 'new');
    await assert.rejects(updates.prepareSharedFileUpdates(root, parents[0], [
      { normalizedName: 'T_one_D.tga', role: 'texture', sha256: digest('new'), sourcePath },
      { normalizedName: alternateName, role: 'texture', sha256: digest('different'), sourcePath }
    ], [{ name: 'T_one_D.tga', status: 'changed' }, { name: alternateName, status: 'changed' }]), /同一共享贴图提供了不同内容/);
    const plan = await updates.prepareSharedFileUpdates(root, parents[0],
      [{ normalizedName: 'T_one_D.tga', role: 'texture', sha256: digest('new'), sourcePath }], [{ name: 'T_one_D.tga', status: 'changed' }]);
    assert.deepEqual(plan.affectedAssets.map(asset => asset.assetId), ['one', 'two']);
    const transact = fn => withRecycleLock(root, () => withFileTransaction({ root, owner: 'shared-update-test', key: parents[0].metaPath }, fn));
    const before = await fs.readFile(parents[1].metaPath, 'utf8');
    await assert.rejects(transact(async () => {
      await updates.applySharedFileUpdates(root, parents[0], plan, 'shared change');
      throw new Error('simulated failure after fanout');
    }), /simulated failure/);
    assert.equal(await fs.readFile(parents[1].metaPath, 'utf8'), before);
    assert.deepEqual(await shared.readRegistry(root), state);
    await transact(() => updates.applySharedFileUpdates(root, parents[0], plan, 'shared change'));
    const changed = JSON.parse(await fs.readFile(parents[1].metaPath, 'utf8'));
    const file = changed.characterManifest.files[0];
    assert.equal(await fs.readFile(path.join(parents[1].path, file.storedPath), 'utf8'), 'new');
    assert.equal(await fs.readFile(path.join(parents[1].path, 'T_two_D.tga'), 'utf8'), 'old');
    assert.equal(changed.character.maturity, 'rigged');
    assert.equal(changed.characterPackageHistory.length, 1);
    assert.equal(Object.values((await shared.readRegistry(root)).resources)[0].evidence.sourceHash, digest('new'));
    const initiating = JSON.parse(await fs.readFile(parents[0].metaPath, 'utf8'));
    const alternate = initiating.characterManifest.files.find(file => file.normalizedName === alternateName);
    assert.equal(await fs.readFile(path.join(parents[0].path, alternate.storedPath), 'utf8'), 'new');
    await assert.rejects(transact(() => updates.applySharedFileUpdates(root, parents[0], plan, 'stale update')), /重新检查/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
