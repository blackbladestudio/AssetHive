const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { splitWeaponPackage, weaponTargetRoot } = require('../shared/weaponRules.mjs');
const { buildFamilyPackagePlan } = require('../electron/services/characterFamilyRules');
const { buildSuitExport } = require('../electron/services/characterSuitExport');
const { characterModelPreviewComponents, listCharacterComponents, applyCharacterRigUpdateState, characterRigProgress } = require('../shared/characterComponents.mjs');
const { heroPackageNeedsScopeReview, inferHeroPackageFileScopes, splitHeroPackageByScope } = require('../shared/heroPackageRules.mjs');
const { finishCharacterImportTasks } = require('../shared/characterImportTasks.mjs');

test('a suit with fewer than five models still separates its weapon and associated textures', () => {
  const files = ['SM_F01_Medium001_Test_Head.fbx', 'SM_Sword009_QingTongJian.fbx',
    'T_F01_Medium001_Test_Head_D.png', 'T_Sword009_QingTongJian_D.png'];
  assert.equal(heroPackageNeedsScopeReview(files), true);
  const split = splitHeroPackageByScope(files, inferHeroPackageFileScopes(files));
  assert.deepEqual(split.suit, [files[0], files[2]]);
  assert.deepEqual(split.weapon, [files[1], files[3]]);
  assert.deepEqual(split.unassigned, []);
  assert.equal(heroPackageNeedsScopeReview(files, true), false);
});

test('finishing one character task preserves edits and failures in other tabs', () => {
  const draft = (queueId, name) => ({ form: { queueId, name }, tagInput: '' });
  const suit = draft('suit', 'Suit');
  const weapon = draft('weapon', 'Old');
  const current = draft('weapon', 'Edited while importing');
  const arrow = draft('arrow', 'Arrow');
  const result = finishCharacterImportTasks([suit, weapon], current, ['suit'], [arrow]);
  assert.deepEqual(result.drafts, [current, arrow]);
  assert.equal(result.activeIndex, 0);
  assert.equal(finishCharacterImportTasks([suit], suit, []).drafts.length, 1);
  assert.deepEqual(finishCharacterImportTasks([suit], suit, ['suit']).drafts, []);
});

test('bow and shared arrow remain independent assets with their own files and Bow destination', () => {
  const files = ['SM_Bow001_ChangGong.fbx', 'SK_Bow001_ChangGong.fbx', 'T_Bow001_ChangGong_D.png',
    'SM_Arrow001_TieJian.fbx', 'T_Arrow001_TieJian_D.png'].map(name => `C:/art/${name}`);
  const result = splitWeaponPackage(files);
  assert.equal(result.groups.length, 2);
  assert.deepEqual(result.unassigned, []);
  assert.equal(result.groups[0].files.length, 3);
  assert.equal(result.groups[1].files.length, 2);
  assert.equal(weaponTargetRoot('Arrow001_TieJian'), '/Game/Characters/Weapon_PJZ/Bow/Arrow001_TieJian');
  assert(result.groups.every(group => !group.parentId));
});

test('weapon content inspection distinguishes misleading SK filenames and preserves texture groups during rename', () => {
  const root = path.resolve('weapon-input');
  const files = ['SK_Sword006_Old.fbx', 'SK_Sword_06.fbx', 'T_Sword006_Old_Blade_D.png', 'T_Sword006_Old_Handle_D.png'].map(name => path.join(root, name));
  const modelAnalyses = new Map([[files[0].toLowerCase(), { meshKind: 'skeletalMesh' }], [files[1].toLowerCase(), { meshKind: 'staticMesh' }]]);
  const plan = buildFamilyPackagePlan('weapon', root, files, { assetName: 'Sword006_XinMing', category: 'Sword', modelAnalyses });
  assert.equal(plan.ok, true, plan.errors.join(';'));
  assert.deepEqual(plan.files.map(file => file.normalizedName), ['SK_Sword006_XinMing.fbx', 'SM_Sword006_XinMing.fbx', 'T_Sword006_XinMing_Blade_D.png', 'T_Sword006_XinMing_Handle_D.png']);
});

test('weapon export excludes SM, owns its skeleton and material, and detects only the changed texture', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weapon-export-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const name = 'Bow001_ChangGong';
  const files = [
    { role: 'staticMesh', normalizedName: `SM_${name}.fbx` },
    { role: 'skeletalMesh', normalizedName: `SK_${name}.fbx` },
    ...['D', 'N', 'ORM'].map(channel => ({ role: 'texture', normalizedName: `T_${name}_${channel}.png` }))
  ].map(file => ({ ...file, storedPath: file.normalizedName }));
  for (const file of files) await fs.writeFile(path.join(root, file.storedPath), file.normalizedName);
  const asset = { id: 'weapon-test', assetType: 'weapon', name, path: root, meta: { name, character: { weaponType: 'Bow' }, characterManifest: { files } } };
  const analyze = async () => ({ meshKind: 'skeletalMesh', hasSkin: true, skinnedMeshCount: 1, materialNames: ['MI_OriginalBow'] });
  const build = () => buildSuitExport(asset, { normalFormat: 'DirectX' }, analyze, async () => false);
  const manifest = await build();
  assert.equal(manifest.entries.length, 5);
  assert(!manifest.entries.some(entry => entry.kind === 'staticMesh'));
  assert.equal(manifest.materialRequests.length, 0);
  const mesh = manifest.entries.find(entry => entry.kind === 'skeletalMesh');
  assert.equal(mesh.config.ownSkeleton, true);
  assert.equal(mesh.config.createPhysicsAsset, true);
  assert.equal(mesh.config.physicsAssetPath, `${manifest.targetRoot}/Mesh/SkeletalMesh/${mesh.name}_Physics`);
  assert.match(mesh.skeletonPath, /\/Mesh\/SkeletalMesh\/SKEL_Bow001_ChangGong$/);
  assert(manifest.entries.filter(entry => entry.kind === 'texture').every(entry => entry.targetPath.includes('/Texture/T_Bow001_ChangGong_')));
  assert.equal(manifest.entries.find(entry => entry.kind === 'material').name, `MI_${name}`);
  assert.equal(manifest.entries.find(entry => entry.kind === 'material').config.parentPath, '/Game/MaterialLibrary/Weapon/Common/M_Weapon_Slab');
  assert.equal(manifest.entries.find(entry => entry.kind === 'material').config.virtualTexture, false);
  assert.equal(manifest.entries.find(entry => entry.kind === 'material').config.useOpacityMasked, false);
  assert.equal(listCharacterComponents(asset).length, 0);
  assert.equal(characterModelPreviewComponents(asset).length, 1);
  await fs.writeFile(path.join(root, `T_${name}_D.png`), 'updated pixels');
  const changed = await build();
  assert.deepEqual(changed.entries.filter((entry, i) => entry.fingerprint !== manifest.entries[i].fingerprint).map(entry => entry.kind), ['texture']);
  asset.meta.characterManifest.files = applyCharacterRigUpdateState(files, [{ name: `SM_${name}.fbx`, status: 'changed' }]);
  assert.equal(characterRigProgress(asset).pendingReview, 1);
  assert.equal(characterRigProgress(asset).complete, false);
});

test('all weapon outputs keep the full package identity and append component and LOD suffixes', () => {
 const {WEAPON_CATEGORIES,weaponPackageOutput,weaponTargetRoot}=require('../shared/weaponRules.mjs');
 const {buildFamilyPackagePlan}=require('../electron/services/characterFamilyRules');
 for(const type of WEAPON_CATEGORIES){
  const owner=`${type}001_TestName`;
  assert.equal(weaponTargetRoot(owner,true),`/Game/Characters/Weapon_PJZ/${type}/${owner}`);
  const parts=type==='Bow'?['Bow','Arrow','Arrowbag']:['DualHands','PairedSwords','ShieldAxe'].includes(type)?['L','R']:[''];
  const models=parts.flatMap(part=>['SM','SK'].map(prefix=>`${prefix}_${owner}${part?'_'+part:''}.fbx`));
  const plan=buildFamilyPackagePlan('weapon',owner,models,{assetName:owner,category:type});
  assert.equal(plan.ok,true,plan.errors.join(';'));
  assert.deepEqual(plan.files.map(file=>file.normalizedName),models);
  for(const side of ['L','R']) for(const prefix of ['SM','SK','SKEL','MI','T']){
   const tail=prefix==='T'?'_D':'';
   assert.equal(weaponPackageOutput(`${prefix}_${type}001_${side}${tail}`,owner),`${prefix}_${owner}_${side}${tail}`);
   assert.equal(weaponPackageOutput(`${prefix}_${type}001_${side}_TestName${tail}`,owner),`${prefix}_${owner}_${side}${tail}`);
  }
  assert.equal(weaponPackageOutput(`SK_${type}001_L_LOD2`,owner),`SK_${owner}_L_LOD2`);
 }
});
