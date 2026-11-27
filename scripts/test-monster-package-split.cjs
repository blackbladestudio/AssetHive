const test = require('node:test');
const assert = require('node:assert/strict');
const { splitMonsterPackage, buildMonsterAssetName } = require('../shared/monsterPackageAudit.mjs');

test('numbered monster forms retain paired meshes and subject appearances', () => {
  const files = ['SM_Villager_01.fbx', 'SK_Villager_01.fbx', 'SM_Villager_02.fbx',
    'T_Villager_Body_D.tga', 'T_Villager_01_Hair_D.tga', 'SM_WP_Villager_Bow.fbx'];
  const result = splitMonsterPackage(files);
  assert.deepEqual(result.unassigned, []);
  assert.equal(result.groups.length, 2);
  assert(result.groups.every(group => group.files.includes('T_Villager_Body_D.tga')));
  assert(result.groups.every(group => group.files.includes('SM_WP_Villager_Bow.fbx')));
  assert(result.groups[0].files.includes('SK_Villager_01.fbx'));
  assert(!result.groups[1].files.includes('T_Villager_01_Hair_D.tga'));
  assert(!result.groups[1].files.includes('SK_Villager_01.fbx'));
});

test('unidentified models and unrelated textures require confirmation, never copy to every form', () => {
  const result = splitMonsterPackage(['SM_Villager_01.fbx', 'SM_Villager_02.fbx', 'unknown.fbx', 'T_Wolf_D.tga']);
  assert.deepEqual(result.unassigned, ['unknown.fbx', 'T_Wolf_D.tga']);
  assert(result.groups.every(group => group.files.length === 1));
  assert.equal(buildMonsterAssetName('Wolf', ['base']), 'SK_Wolf_01');
});
