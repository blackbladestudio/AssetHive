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
  const result = plan(old, [file('SK_Arm', 'new'), file('SM_Arm_LOD1', 'new')], ['changed', 'changed']);
  const staticBase = result.files.find(f => f.normalizedName === 'SM_Arm.fbx');
  assert.equal(staticBase.ignoreEmbeddedLods, true);
  assert.ok(result.files.some(f => f.normalizedName === 'SM_Arm_LOD1.fbx'));
  const later = plan(result.files, [file('SM_Arm')], ['unchanged']);
  assert.equal(later.files[0].ignoreEmbeddedLods, true);
  assert.equal(later.files[0].lodReset, staticBase.lodReset);
});
