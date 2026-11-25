const test = require('node:test');
const assert = require('node:assert/strict');
const { invalidateReplacedBaseLods } = require('../electron/services/characterLodInvalidation');
const file = (name, hash = 'old') => ({ normalizedName: name + '.fbx', storedPath: name + '.fbx',
  role: name.startsWith('SK_') ? 'skeletalMesh' : 'staticMesh', sha256: hash });
function plan(previous, incoming, statuses) {
  const retained = new Map(previous.filter(old => !incoming.some(next => next.normalizedName === old.normalizedName))
    .map(old => [old.normalizedName.toLowerCase(), old]));
  const changes = incoming.map((f, i) => ({ name: f.normalizedName, status: statuses[i] }));
  invalidateReplacedBaseLods(incoming, retained, changes, previous);
  return { files: [...incoming, ...retained.values()], changes };
}
test('changed SM LOD0 invalidates both old chains, retaining other parts and historical inventory', () => {
  const old = ['SM_Arm', 'SM_Arm_LOD1', 'SK_Arm', 'SK_Arm_LOD1', 'SM_Head', 'SM_Head_LOD1'].map(n => file(n));
  const result = plan(old, [file('SM_Arm', 'new')], ['changed']);
  assert.deepEqual(result.files.map(f => f.normalizedName).sort(), ['SM_Arm.fbx', 'SK_Arm.fbx', 'SM_Head.fbx', 'SM_Head_LOD1.fbx'].sort());
  assert.equal(result.files.find(f => f.normalizedName === 'SK_Arm.fbx').lodReset, result.files[0].lodReset);
  assert.equal(result.changes.filter(c => c.status === 'removed').length, 2);
  assert.equal(old.length, 6);
  assert.equal(old[2].lodReset, undefined);
});
test('unchanged upload and first SK base do not invalidate an existing SM LOD1', () => {
  const old = [file('SM_Arm'), file('SM_Arm_LOD1')];
  for (const [incoming, status] of [[file('SM_Arm'), 'unchanged'], [file('SK_Arm'), 'added']]) {
    const result = plan(old, [incoming], [status]);
    assert.ok(result.files.some(f => f.normalizedName === 'SM_Arm_LOD1.fbx'));
    assert.ok(result.files.every(f => !f.lodReset));
  }
});
test('new LOD1 in the same update survives; retained embedded LODs stay invalid on later uploads', () => {
  const old = [file('SM_Arm'), file('SK_Arm'), file('SM_Arm_LOD1')];
  const result = plan(old, [file('SM_Arm', 'new'), file('SM_Arm_LOD1', 'new')], ['changed', 'changed']);
  const staticBase = result.files.find(f => f.normalizedName === 'SK_Arm.fbx');
  assert.equal(staticBase.ignoreEmbeddedLods, true);
  assert.ok(result.files.some(f => f.normalizedName === 'SM_Arm_LOD1.fbx'));
  const later = plan(result.files, [file('SK_Arm')], ['unchanged']);
  assert.equal(later.files[0].ignoreEmbeddedLods, true);
  assert.equal(later.files[0].lodReset, staticBase.lodReset);
});

test('replacing SK preserves completed static chain and removes only stale skeletal levels', () => {
  for (const role of ['skeletalMesh', 'model']) {
    const old = ['SM_Arm', 'SM_Arm_LOD1', 'SK_Arm', 'SK_Arm_LOD1', 'SK_Arm_LOD2', 'SK_Head_LOD1'].map(n => file(n));
    old[0].lodCount = 6;
    const incoming = [{ ...file('SK_Arm', 'new'), role }, { ...old[0] }];
    const result = plan(old, incoming, ['changed', 'unchanged']);
    assert.deepEqual(result.files.find(f => f.normalizedName === 'SM_Arm.fbx'), old[0]);
    assert.deepEqual(result.files.find(f => f.normalizedName === 'SM_Arm_LOD1.fbx'), old[1]);
    assert.deepEqual(result.changes.filter(c => c.status === 'removed').map(c => c.name).sort(), ['SK_Arm_LOD1.fbx', 'SK_Arm_LOD2.fbx']);
    assert.ok(result.files[0].lodReset);
    assert.ok(result.files.some(f => f.normalizedName === 'SK_Head_LOD1.fbx'));
  }
});

test('replacing both bases still invalidates both old chains', () => {
  const old = ['SM_Arm', 'SM_Arm_LOD1', 'SK_Arm', 'SK_Arm_LOD1'].map(n => file(n));
  const result = plan(old, [file('SK_Arm', 'new'), file('SM_Arm', 'new')], ['changed', 'changed']);
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].lodReset, result.files[1].lodReset);
});

test('SK replacement export reuses retained SM LOD1 with a skeletal reset', async t => {
  const { attachCharacterLods } = require('../electron/services/characterLodExport');
  const old = ['SM_Arm', 'SM_Arm_LOD1', 'SK_Arm', 'SK_Arm_LOD1'].map(n => file(n));
  const updated = plan(old, [file('SK_Arm', 'new')], ['changed']);
  const path = require('node:path');
  const fs = require('node:fs/promises');
  const dir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'rig-update-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const f of updated.files) await fs.writeFile(path.join(dir, f.storedPath), f.sha256);
  const managed = async (asset, storedPath) => ({ sourcePath: path.join(dir, storedPath), sourceHash: updated.files.find(f => f.storedPath === storedPath).sha256 });
  const entries = await Promise.all(updated.files.filter(f => !f.normalizedName.includes('_LOD')).map(async f => ({
    kind: f.role, key: `asset:${f.role}:arm`, name: f.normalizedName, fingerprint: f.sha256,
    ...await managed(null, f.storedPath)
  })));
  const result = { entries };
  await attachCharacterLods(result, { meta: { characterManifest: { files: updated.files } } }, { includeStaticMeshes: true },
    async sourcePath => ({ meshKind: path.basename(sourcePath).startsWith('SK_') ? 'skeletalMesh' : 'staticMesh', materialNames: [], lodCount: 1 }), managed);
  const sk = entries.find(e => e.kind === 'skeletalMesh');
  const sm = entries.find(e => e.kind === 'staticMesh');
  assert.ok(sk.config.lodReset);
  assert.equal(sk.config.skinLodSource.sourcePath, path.join(dir, 'SM_Arm_LOD1.fbx'));
  assert.equal(sm.config.lodReset, undefined);
  assert.equal(sm.config.lodSources[0].sourcePath, sk.config.skinLodSource.sourcePath);
});
