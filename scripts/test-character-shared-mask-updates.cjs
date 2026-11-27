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
const hash = value => createHash('sha256').update(value).digest('hex');

test('adding optional ShadingMask extends one shared material and copies it to every owner atomically', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-mask-'));
  try {
    let state = shared.empty();
    const assets = [];
    for (const id of ['one', 'two']) {
      const directory = path.join(root, id);
      await fs.mkdir(directory);
      const name = `T_${id}_Body_D.tga`;
      await fs.writeFile(path.join(directory, name), 'diffuse');
      const meta = { assetID: id, name: id, assetType: 'monster', character: { maturity: 'rigged' }, characterManifest: { files: [{ normalizedName: name, storedPath: name, role: 'texture', materialName: `MI_${id}_Body`, sha256: hash('diffuse') }] } };
      const metaPath = path.join(directory, 'asset_info.json');
      await fs.writeFile(metaPath, JSON.stringify(meta));
      assets.push({ id, path: directory, metaPath, meta, assetType: 'monster' });
      const texture = shared.registerResource(state, { reference: { assetId: id, localKey: `${id}:texture:body:D`, metadataPath: `${id}/asset_info.json`, sourceName: name }, evidence: { kind: 'texture', sourceHash: hash('diffuse'), channel: 'D', config: { virtualTexture: true } }, scopeId: 'batch', ueTarget: { key: `${id}:texture:body:D`, path: `/Game/Test/Texture/T_${id}_Body_D` } });
      state = texture.state;
      state = shared.registerResource(state, { reference: { assetId: id, localKey: `${id}:material:body`, metadataPath: `${id}/asset_info.json` }, evidence: { kind: 'material', parentPath: '/Game/Test/M_Parent', config: { parentPath: '/Game/Test/M_Parent' }, textures: { D: texture.resource.id } }, scopeId: 'batch', ueTarget: { key: `${id}:material:body`, path: `/Game/Test/MI_${id}_Body` } }).state;
    }
    await shared.mutateRegistry(root, () => ({ state }));
    const sourcePath = path.join(root, 'mask.tga');
    await fs.writeFile(sourcePath, 'mask');
    const files = [{ normalizedName: 'T_one_Body_ShadingMask.tga', role: 'texture', sourcePath, sha256: hash('mask') }];
    const changes = [{ name: files[0].normalizedName, status: 'added' }];
    const plan = await updates.prepareSharedFileUpdates(root, assets[0], files, changes);
    assert.deepEqual(await updates.prepareSharedFileUpdates(root, assets[0], files, changes), plan, 'preview/apply tokens must stay stable');
    assert.deepEqual(plan.affectedAssets.map(asset => asset.assetId), ['one', 'two']);
    const transact = fn => withRecycleLock(root, () => withFileTransaction({ root, owner: 'mask-test', key: assets[0].metaPath }, fn));
    const before = await fs.readFile(assets[1].metaPath, 'utf8');
    await assert.rejects(transact(async () => { await updates.applySharedFileUpdates(root, assets[0], plan, 'mask'); throw new Error('rollback'); }), /rollback/);
    assert.equal(await fs.readFile(assets[1].metaPath, 'utf8'), before);
    assert.deepEqual(await shared.readRegistry(root), state);
    await transact(() => updates.applySharedFileUpdates(root, assets[0], plan, 'mask'));
    const result = JSON.parse(await fs.readFile(assets[1].metaPath, 'utf8'));
    const mask = result.characterManifest.files.find(file => file.normalizedName === 'T_two_Body_ShadingMask.tga');
    assert.ok(mask);
    assert.equal(mask.materialName, 'MI_two_Body');
    assert.equal(await fs.readFile(path.join(assets[1].path, mask.storedPath), 'utf8'), 'mask');
    assert.equal(result.character.maturity, 'rigged');
    const registered = await shared.readRegistry(root);
    const material = Object.values(registered.resources).find(resource => resource.evidence.kind === 'material');
    assert.equal(registered.resources[material.evidence.textures.ShadingMask].references.length, 2);
    assert.equal(registered.resources[material.evidence.textures.ShadingMask].evidence.sourceHash, hash('mask'));
    const removal = await updates.prepareSharedFileUpdates(root, assets[0], [], [{ name: files[0].normalizedName, status: 'removed' }]);
    await transact(() => updates.applySharedFileUpdates(root, assets[0], removal, 'restore older appearance'));
    const restored = JSON.parse(await fs.readFile(assets[1].metaPath, 'utf8'));
    assert.equal(restored.characterManifest.files.length, 1);
    assert.equal(Object.values((await shared.readRegistry(root)).resources).find(resource => resource.evidence.kind === 'material').evidence.textures.ShadingMask, undefined);
    assert.equal(await fs.readFile(path.join(assets[1].path, mask.storedPath), 'utf8'), 'mask', 'history keeps the earlier mask bytes');
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); }
});
