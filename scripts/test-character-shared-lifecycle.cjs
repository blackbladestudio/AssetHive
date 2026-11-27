const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Buffer } = require('node:buffer');
const lifecycle = require('../electron/services/characterSharedLifecycle');
const shared = require('../electron/services/characterSharedResources');

test('related imports retain one resource through export, local receipts and status requests', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'character-lifecycle-'));
  try {
    const assets = [], suits = [];
    const bytes = Buffer.from('shared texture source');
    for (const id of ['one', 'two']) {
      const directory = path.join(root, id);
      await fs.mkdir(directory);
      const source = path.join(directory, `T_${id}_D.tga`);
      await fs.writeFile(source, bytes);
      const metaPath = path.join(directory, 'asset_info.json');
      await fs.writeFile(metaPath, '{}');
      assets.push({ id, path: directory, metaPath, assetType: 'monster', meta: { characterImportGroupId: 'batch',
        characterManifest: { files: [{ role: 'texture', normalizedName: path.basename(source), storedPath: path.basename(source) }] } } });
      const texture = { key: `${id}:texture:body:D`, kind: 'texture', channel: 'D', sourcePath: source,
        sourceHash: createHash('sha256').update(bytes).digest('hex'), config: { virtualTexture: true },
        targetPath: `/Game/Test/T_${id}_D`, name: `T_${id}_D` };
      const material = { key: `${id}:material:body`, kind: 'material', name: `MI_${id}`, targetPath: `/Game/Test/MI_${id}`,
        textures: { D: texture.key }, config: { parentPath: '/Game/Test/M_Parent' }, sourceHash: id, fingerprint: id };
      suits.push({ assetId: id, entries: [texture, material, { key: `${id}:staticMesh:main`, kind: 'staticMesh', materials: { Body: material.key } }] });
    }
    const first = await lifecycle.prepareSharedExport(root, assets, suits);
    assert.equal(first.suits.flatMap(suit => suit.entries).length, 4);
    assert.equal(first.suits[1].entries[0].materials.Body, 'one:material:body');
    const state = await shared.readRegistry(root);
    assert.equal(Object.keys(state.resources).length, 2);
    const again = await lifecycle.prepareSharedExport(root, assets, suits);
    assert.deepEqual(again, first);
    assert.equal((await shared.readRegistry(root)).revision, state.revision);
    const rows = lifecycle.localizeSharedRows([{ key: 'one:material:body', status: 'success',
      effectiveDependencies: ['one:texture:body:D'] }], first.aliases);
    assert.equal(rows[1].key, 'two:material:body');
    assert.deepEqual(rows[1].effectiveDependencies, ['two:texture:body:D']);
    const status = lifecycle.projectStatusEntries(rows);
    assert.equal(status.entries.length, 1);
    assert.equal(status.entries[0].key, 'one:material:body');
    const changed = globalThis.structuredClone(suits[0]);
    changed.entries[1].config.parentPath = '/Game/Test/M_NewParent';
    const updated = await lifecycle.prepareSharedExport(root, [assets[0]], [changed]);
    assert.equal(updated.suits[0].entries.find(entry => entry.kind === 'material').config.parentPath, '/Game/Test/M_NewParent');
    assert.deepEqual(updated.affectedAssets.map(asset => asset.assetId), ['one', 'two']);
    // Another owner's saved options must not revert a shared appearance update.
    const stale = await lifecycle.prepareSharedExport(root, [assets[1]], [suits[1]]);
    assert.equal(stale.suits[0].entries.find(entry => entry.kind === 'material').config.parentPath, '/Game/Test/M_NewParent');
    // An explicit choice can intentionally return to the earlier setting.
    const reverted = await lifecycle.prepareSharedExport(root, [assets[1]], [suits[1]], new Set(['two:material:body']));
    assert.equal(reverted.suits[0].entries.find(entry => entry.kind === 'material').config.parentPath, '/Game/Test/M_Parent');
    const conflicting = globalThis.structuredClone(suits);
    conflicting[0].entries[1].config.parentPath = '/Game/Test/M_ChoiceA';
    conflicting[1].entries[1].config.parentPath = '/Game/Test/M_ChoiceB';
    const beforeConflict = await shared.readRegistry(root);
    await assert.rejects(lifecycle.prepareSharedExport(root, assets, conflicting), /同一共享材质或贴图选择了不同设置/);
    assert.deepEqual(await shared.readRegistry(root), beforeConflict);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
