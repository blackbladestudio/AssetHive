const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { buildHeroPartExport } = require('../electron/services/heroPartExport');

for (const variant of ['Face', 'Hair']) for (const kind of ['staticMesh', 'skeletalMesh']) {
  test(`${variant} ${kind} Blockout keeps arbitrary slots and colours without formal materials`, async t => {
    const dir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'hero-blockout-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'model.fbx');
    await fs.writeFile(file, `${variant}-${kind}`);
    const asset = { id: 'hero', meta: { character: { gender: 'Female', bodyCode: '01', variant, serial: '001' },
      characterManifest: { files: [{ role: kind, storedPath: 'model.fbx' }] } } };
    const plan = await buildHeroPartExport(asset, { materialMode: 'blockout', includeStaticMeshes: true },
      async () => ({ meshKind: kind, materialNames: ['lambert2', 'blinn1'], sourceMaterials: { lambert2: { color: [1, 0, 0] } } }),
      async () => ({ sourcePath: file, sourceHash: 'source' }));
    assert.deepEqual(plan.materialRequests, []);
    const mesh = plan.entries.find(e => e.kind === kind);
    assert.deepEqual(Object.keys(mesh.materials), ['lambert2', 'blinn1']);
    assert.equal(mesh.config.materialMode, 'blockout');
    const materials = plan.entries.filter(e => e.kind === 'material');
    assert.equal(materials.length, 2);
    assert.deepEqual(materials[0].config.blockoutMaterial.color, [1, 0, 0]);
    assert.ok(materials.every(e => e.config.parentPath.endsWith('/M_Blockout')));
    if (kind === 'skeletalMesh') assert.ok(mesh.skeletonPath.endsWith('/SKEL_Female'));
  });
}
