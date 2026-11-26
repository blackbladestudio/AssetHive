const test = require('node:test');
const assert = require('node:assert/strict');
const { splitWeaponPackage, weaponAssemblyKind, weaponModelSlot } = require('../shared/weaponRules.mjs');
const { buildFamilyPackagePlan } = require('../electron/services/characterFamilyRules');
const { applySkeletonOptions } = require('../shared/characterSkeletonOptions.cjs');

test('hero skeleton defaults distinguish female and male without overriding explicit choices', () => {
  const { defaultHeroSkeleton } = require('../shared/characterSkeletonOptions.cjs');
  assert.equal(defaultHeroSkeleton({ gender: 'Female' }), '/Game/Characters/Hero/Asset_PJZ/Common/SKEL_Female');
  assert.equal(defaultHeroSkeleton({ gender: 'Male' }), '/Game/Characters/Hero/Asset_PJZ/Common/SKEL_Character');
  const entry = { key: 'female:head', name: 'SK_F01_Head', kind: 'skeletalMesh', targetPath: '/Game/Test/SK_F01_Head', skeletonPath: defaultHeroSkeleton({ gender: 'Female' }), config: {} };
  assert.equal(applySkeletonOptions(entry, { skeletonSelection: { mode: 'auto' } }).skeletonPath, entry.skeletonPath);
  assert.equal(applySkeletonOptions(entry, { skeletonSelection: { mode: 'existing', path: '/Game/Shared/SKEL_Shared' } }).skeletonPath, '/Game/Shared/SKEL_Shared');
});

test('new Gameplay filenames retain separate material groups and use the agreed package layout', () => {
  const files = ['SM_WoodenCase.fbx', 'SK_WoodenCase.fbx', 'T_WoodenCase_Wood_D.tga', 'T_WoodenCase_Wood_01_D.tga', 'T_WoodenCase_Wood_01_A.tga'];
  const plan = buildFamilyPackagePlan('item', 'C:/Art/WoodenCase', files, {
    assetName: 'WeaponCase_WoodenCase', name: 'WoodenCase', category: 'Gameplay/Int_Loot/WeaponCase'
  });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.deepEqual(plan.files.map(file => file.relativePath), ['Mesh/StaticMesh/SM_WeaponCase_WoodenCase.fbx', 'Mesh/SkeletalMesh/SK_WeaponCase_WoodenCase.fbx',
    'Texture/T_WeaponCase_WoodenCase_Wood_D.tga', 'Texture/T_WeaponCase_WoodenCase_Wood_01_D.tga', 'Texture/T_WeaponCase_WoodenCase_Wood_01_A.tga']);
  const { validateCharacterImport } = require('../electron/services/characterImport');
  const payload = { assetType: 'item', category: 'Item/Consumable/Eat', assetName: 'Eat_901010001', packageFiles: ['SK_Eat_901010001.fbx'],
    characterFields: { name: '901010001', displayNameEn: '901010001', displayNameZh: '草药', confirmed: true, nameConfirmed: true } };
  assert.deepEqual(validateCharacterImport(payload), []);
  assert.match(validateCharacterImport({ ...payload, characterFields: { ...payload.characterFields, displayNameEn: 'Herb' } })[0], /资源 ID/);
});

test('Item ID export uses numeric identity for every resource and keeps reusable material groups', async t => {
  const fs = require('node:fs/promises'); const path = require('node:path');
  const library = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'gameplay-id-'));
  t.after(() => fs.rm(library, { recursive: true, force: true }));
  const root = path.join(library, 'Eat_901010001');
  await fs.mkdir(root);
  const files = ['SK_Eat_901010001.fbx', 'T_Eat_901010001_Body_D.tga', 'T_Eat_901010001_Body_01_D.tga'].map((name, index) => ({role: index ? 'texture' : 'skeletalMesh', normalizedName: name, storedPath: name}));
  for (const file of files) await fs.writeFile(path.join(root, file.storedPath), file.storedPath);
  const meta = { id: 'stable-id', name: 'Eat_901010001', assetType: 'item', category: 'Item/Consumable/Eat', character: { name: '901010001', displayNameEn: '901010001', displayNameZh: '草药' }, characterManifest: { files } };
  const asset = { id: meta.id, name: meta.name, assetType: 'item', source: 'custom', path: root, metaPath: path.join(root, 'asset_info.json'), meta };
  const analyze = async () => ({meshKind: 'skeletalMesh', hasSkin: true, skinnedMeshCount: 1, materialNames: ['Body', 'Body_01']});
  const { buildSuitExport } = require('../electron/services/characterSuitExport');
  const plan = await buildSuitExport(asset, {}, analyze);
  assert.equal(plan.targetRoot, '/Game/Characters/GameplayItem/Eat_901010001');
  const mesh = plan.entries.find(entry => entry.kind === 'skeletalMesh');
  assert.equal(mesh.targetPath, plan.targetRoot + '/Mesh/SkeletalMesh/SK_Eat_901010001');
  assert.equal(mesh.skeletonPath, plan.targetRoot + '/Mesh/SkeletalMesh/SKEL_Eat_901010001');
  assert.equal(mesh.config.physicsAssetPath, plan.targetRoot + '/Mesh/SkeletalMesh/SK_Eat_901010001_Physics');
  assert.deepEqual(plan.entries.filter(entry => entry.kind === 'material').map(entry => entry.name).sort(), ['MI_Eat_901010001_Body', 'MI_Eat_901010001_Body_01']);
  assert.deepEqual(mesh.unresolvedMaterials, []);
  await fs.writeFile(asset.metaPath, JSON.stringify(meta));
  const result = await require('../electron/services/characterNames').updateCharacterNames({ root: library, asset, displayNameZh: '草药', displayNameEn: '901010002', nameConfirmed: true, expectedName: '草药', expectedEnglishName: '901010001' });
  assert.equal(result.assetName, 'Eat_901010002');
  const updated = JSON.parse(await fs.readFile(asset.metaPath, 'utf8'));
  const renamed = await buildSuitExport({ ...asset, meta: updated, name: updated.name }, {}, analyze);
  assert.equal(renamed.targetRoot, '/Game/Characters/GameplayItem/Eat_901010002');
  assert.deepEqual(renamed.entries.map(entry => entry.key), plan.entries.map(entry => entry.key));
  assert.equal(updated.id, meta.id);
});

test('final L/R names group together and normalize old and new sources identically', () => {
  const { weaponSideInternal, weaponSideOutput, weaponPackageOutput } = require('../shared/weaponRules.mjs');
  for (const type of ['DualHands', 'PairedSwords', 'ShieldAxe']) {
    const owner = `${type}001_CanCiJian`;
    const old = [`SM_${owner}_L.fbx`, `SM_${owner}_R.fbx`, `T_${owner}_L_D.tga`, `T_${owner}_R_D.tga`];
    const modern = old.map(file => weaponPackageOutput(weaponSideOutput(file.replace(/\.[^.]+$/, '')), owner) + require('node:path').extname(file));
    assert.equal(splitWeaponPackage(modern.map(file => `${owner}/${file}`)).groups.length, 1);
    assert.equal(splitWeaponPackage(modern.map(file => `${owner}/${file}`)).groups[0].assetName, owner);
    for (const files of [old, modern]) {
      const plan = buildFamilyPackagePlan('weapon', '', files, { assetName: owner, category: type });
      assert.equal(plan.ok, true, plan.errors.join(';'));
      assert.deepEqual(plan.files.map(file => file.normalizedName), modern);
    }
    assert.equal(weaponSideInternal(`${type}001_L_CanCiJian`), `${owner}_L`);
  }
  assert.equal(weaponSideOutput('SK_Bow001_SheRi_Arrowbag'), 'SK_Bow001_SheRi_Arrowbag');
});

test('legacy bow sources retain unique components after a confirmed identity change', () => {
  const files = ['SK_Arrow_06.fbx', 'SK_Bow_06.fbx', 'SK_Bow_06_Parts_a.fbx'];
  const plan = buildFamilyPackagePlan('weapon', '', files, { assetName: 'Bow999_gongjiantest', category: 'Bow' });
  assert.equal(plan.ok, true, plan.errors.join(';'));
  assert.deepEqual(plan.files.map(file => file.normalizedName), [
    'SK_Bow999_gongjiantest_Arrow.fbx', 'SK_Bow999_gongjiantest_Bow.fbx', 'SK_Bow999_gongjiantest_Arrowbag.fbx'
  ]);
  const path = require('node:path');
  const staticPlan = buildFamilyPackagePlan('weapon', '', files, { assetName: 'Bow999_gongjiantest', category: 'Bow',
    modelAnalyses: new Map(files.map(file => [path.resolve(file).toLowerCase(), { meshKind: 'staticMesh' }])) });
  assert.equal(staticPlan.ok, true, staticPlan.errors.join(';'));
  assert.deepEqual(staticPlan.files.map(file => file.normalizedName), [
    'SM_Bow999_gongjiantest_Arrow.fbx', 'SM_Bow999_gongjiantest_Bow.fbx', 'SM_Bow999_gongjiantest_Arrowbag.fbx'
  ]);
});

test('new character sends stop before dispatch when the loaded plugin is outdated', async () => {
  const client = { getEditorInfo: async () => ({ projectPath: 'C:/Test/Test.uproject', capabilities: ['characterSuitV1'] }),
    importAssets: () => { throw new Error('must not dispatch'); } };
  await assert.rejects(require('../electron/services/characterSuitExport').sendSuitJob(
    [{ id: 'item', assetType: 'item', meta: {} }], {}, undefined, client), /更新 AssetHive UE 插件/);
});

test('bow components share one package and shared textures; legacy arrows remain separate', () => {
  const files = ['SM_Bow001_SheRi_Bow_弓身.fbx', 'SM_Bow001_SheRi_Arrow.fbx', 'SM_Bow001_SheRi_Arrowbag.fbx', 'T_Bow001_SheRi_D.tga'];
  const result = splitWeaponPackage(files);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].assetName, 'Bow001_SheRi');
  assert.deepEqual(result.groups[0].files, files);
  const plan = buildFamilyPackagePlan('weapon', '', files, { assetName: 'Bow001_SheRi', category: 'Bow' });
  assert.equal(plan.ok, true, plan.errors.join(';'));
  assert.deepEqual(plan.files.filter(file => file.role === 'staticMesh').map(file => file.normalizedName),
    ['SM_Bow001_SheRi_Bow.fbx', 'SM_Bow001_SheRi_Arrow.fbx', 'SM_Bow001_SheRi_Arrowbag.fbx']);
});

test('assembly is weapon quantity, not hand count or number of model files', () => {
  assert.equal(weaponAssemblyKind({ name: 'GreatSword001_Test' }), 'single');
  assert.equal(weaponAssemblyKind({ name: 'DualAxe001_Test' }), 'combined');
  assert.equal(weaponAssemblyKind({ name: 'Sword001_Test', meta: { character: { weaponAssembly: 'combined' } } }), 'combined');
  assert.equal(weaponModelSlot('SK_ShieldAxe001_Long_Weapon_Name_L_青铜盾.fbx'), 'L');
});

test('explicit skeleton overrides preserve physics policy and do not mutate defaults', () => {
  const original = { key: 'hero:mesh', kind: 'skeletalMesh', name: 'SK_F01_Face001', targetPath: '/Game/Hero/Face/SK_F01_Face001',
    skeletonPath: '/Game/Common/SKEL_Character', config: { family: 'suit', createPhysicsAsset: false } };
  assert.equal(applySkeletonOptions(original), original);
  const created = applySkeletonOptions(original, { skeletonOverrides: { 'hero:mesh': { mode: 'create' } } });
  assert.equal(created.skeletonPath, '/Game/Hero/Face/SKEL_F01_Face001_Custom');
  assert.equal(created.config.ownSkeleton, true);
  assert.equal(created.config.createPhysicsAsset, false);
  const existing = applySkeletonOptions(original, { skeletonSelection: { mode: 'existing', path: '/Game/Common/Other.Other' } });
  assert.equal(existing.skeletonPath, '/Game/Common/Other');
  assert.equal(existing.config.ownSkeleton, false);
  assert.throws(() => applySkeletonOptions(original, { skeletonSelection: { mode: 'existing', path: '' } }), /骨架路径/);
  assert.equal(original.skeletonPath, '/Game/Common/SKEL_Character');
});

test('Item package accepts a confirmed category without an invented serial', () => {
  const plan = buildFamilyPackagePlan('item', '', ['SM_Herb.fbx', 'T_Herb_D.tga'], { assetName: 'Herb', category: 'Consumable' });
  assert.equal(plan.ok, true, plan.errors.join(';'));
  assert.deepEqual(plan.files.map(file => file.normalizedName), ['SM_Herb.fbx', 'T_Herb_D.tga']);
});

test('Item export creates the approved VT material and links mesh slots', async t => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const os = require('node:os');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'item-export-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = [{ role: 'staticMesh', normalizedName: 'SM_Herb.fbx', storedPath: 'SM_Herb.fbx' },
    { role: 'texture', normalizedName: 'T_Herb_D.tga', storedPath: 'T_Herb_D.tga' }];
  for (const file of files) await fs.writeFile(path.join(directory, file.storedPath), file.normalizedName);
  const { buildSuitExport } = require('../electron/services/characterSuitExport');
  const result = await buildSuitExport({ id: 'herb', name: 'Herb', assetType: 'item', path: directory,
    meta: { name: 'Herb', category: 'Consumable', characterManifest: { files } } }, { includeStaticMeshes: true },
  async () => ({ meshKind: 'staticMesh', materialNames: ['HerbMaterial'] }));
  assert.equal(result.targetRoot, '/Game/Characters/GameplayItem/Consumable/Herb');
  const classified = await buildSuitExport({ id: 'herb', name: 'Herb', assetType: 'item', path: directory,
    meta: { name: 'Herb', category: 'Gameplay/Int_Loot/WeaponCase', characterManifest: { files } } }, { includeStaticMeshes: true },
  async () => ({ meshKind: 'staticMesh', materialNames: ['HerbMaterial'] }));
  assert.equal(classified.targetRoot, '/Game/Characters/GameplayItem/WeaponCase_Herb');
  assert.equal(classified.entries.length, result.entries.length);
  assert.equal(result.entries.length, 3);
  const material = result.entries.find(entry => entry.kind === 'material');
  assert.equal(material.config.parentPath, '/Game/MaterialLibrary/Character/Common/M_GamePlayItem_Base_VT');
  assert.equal(material.config.virtualTexture, true);
  assert.equal(result.entries.find(entry => entry.kind === 'texture').config.maxSize, 2048);
  assert.equal(result.entries.find(entry => entry.kind === 'texture').config.virtualTexture, true);
  const mesh = result.entries.find(entry => entry.kind === 'staticMesh');
  assert.equal(mesh.name, 'SM_Herb');
  assert.equal(mesh.config.deferMaterials, undefined);
  assert.equal(mesh.materials.HerbMaterial, material.key);
  assert.deepEqual(mesh.unresolvedMaterials, []);
  const alpha = { role: 'texture', normalizedName: 'T_Herb_A.tga', storedPath: 'T_Herb_A.tga' };
  await fs.writeFile(path.join(directory, alpha.storedPath), 'mask');
  const masked = await buildSuitExport({ id: 'herb', name: 'Herb', assetType: 'item', path: directory,
    meta: { name: 'Herb', category: 'Consumable', characterManifest: { files: [...files, alpha] } } }, { includeStaticMeshes: true },
    async () => ({ meshKind: 'staticMesh', materialNames: ['HerbMaterial'] }));
  assert.equal(masked.entries.find(entry => entry.kind === 'material').config.parentPath,
    '/Game/MaterialLibrary/Character/Common/M_GamePlayItem_Base_Masked_VT');
  assert.equal(masked.entries.filter(entry => entry.kind === 'texture' && entry.channel === 'A').length, 1);
});

test('bow models bind to one shared material and texture entry', async t => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'bow-export-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = ['Bow', 'Arrow', 'Arrowbag'].map(slot => ({ role: 'staticMesh', normalizedName: `SM_Bow001_SheRi_${slot}.fbx`, storedPath: `SM_Bow001_SheRi_${slot}.fbx` }));
  files.push({ role: 'texture', normalizedName: 'T_Bow001_SheRi_D.tga', storedPath: 'T_Bow001_SheRi_D.tga' });
  for (const file of files) await fs.writeFile(path.join(directory, file.storedPath), file.normalizedName);
  const result = await require('../electron/services/characterSuitExport').buildSuitExport({ id: 'bow', name: 'Bow001_SheRi', assetType: 'weapon', path: directory,
    meta: { name: 'Bow001_SheRi', category: 'Bow', characterManifest: { files } } }, { includeStaticMeshes: true },
    async () => ({ meshKind: 'staticMesh', materialNames: ['SharedMaterial'] }));
  const meshes = result.entries.filter(entry => entry.kind === 'staticMesh');
  assert.equal(meshes.length, 3);
  assert.equal(result.entries.filter(entry => entry.kind === 'texture').length, 1);
  assert.equal(result.entries.filter(entry => entry.kind === 'material').length, 1);
  assert.equal(new Set(meshes.map(entry => entry.materials.SharedMaterial)).size, 1);
  assert(meshes.every(entry => entry.unresolvedMaterials.length === 0));
});

test('left/right UE output keeps stable keys and binds separate textures with final names', async t => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const root = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'paired-export-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { weaponSideOutput } = require('../shared/weaponRules.mjs');
  const name = 'PairedSwords001_CanCiJian';
  const oldFiles = ['L', 'R'].flatMap(side => [
    { role: 'staticMesh', normalizedName: `SM_${name}_${side}.fbx`, storedPath: `SM_${name}_${side}.fbx` },
    { role: 'skeletalMesh', normalizedName: `SK_${name}_${side}.fbx`, storedPath: `SK_${name}_${side}.fbx` },
    { role: 'texture', normalizedName: `T_${name}_${side}_D.tga`, storedPath: `T_${name}_${side}_D.tga` }
  ]);
  for (const file of oldFiles) await fs.writeFile(path.join(root, file.storedPath), 'test fixture');
  const analyze = async source => ({ meshKind: path.basename(source).startsWith('SK_') ? 'skeletalMesh' : 'staticMesh',
    hasSkin: path.basename(source).startsWith('SK_'), skinnedMeshCount: path.basename(source).startsWith('SK_') ? 1 : 0,
    materialNames: [weaponSideOutput(`MI_${name}_${source.includes('_L.') ? 'L' : 'R'}`)] });
  const build = files => require('../electron/services/characterSuitExport').buildSuitExport({ id: 'pair', name, path: root, assetType: 'weapon',
    meta: { name, category: 'PairedSwords', characterManifest: { files } } }, { includeStaticMeshes: true }, analyze);
  const oldJob = await build(oldFiles);
  const modernJob = await build(oldFiles.map(file => ({ ...file, normalizedName: file.normalizedName.replace('_CanCiJian', '') })));
  assert.deepEqual(modernJob.entries.map(e => [e.key, e.name, e.targetPath]), oldJob.entries.map(e => [e.key, e.name, e.targetPath]));
  assert.equal(modernJob.entries.filter(e => e.kind === 'material').length, 2);
  for (const side of ['L', 'R']) {
    const mesh = modernJob.entries.find(e => e.name === `SM_PairedSwords001_CanCiJian_${side}`);
    assert(mesh);
    assert.deepEqual(mesh.unresolvedMaterials, []);
    assert.equal(Object.values(mesh.materials)[0], `pair:material:${side.toLowerCase()}`);
    assert(modernJob.entries.some(e => e.name === `T_PairedSwords001_CanCiJian_${side}_D`));
    assert.equal(modernJob.targetRoot, '/Game/Characters/Weapon_PJZ/PairedSwords/PairedSwords001_CanCiJian');
    const skeletal = modernJob.entries.find(e => e.name === `SK_${name}_${side}`);
    assert(skeletal);
    assert.deepEqual(skeletal.unresolvedMaterials, []);
    assert.equal(skeletal.skeletonPath, `${modernJob.targetRoot}/Mesh/SkeletalMesh/${side}/SKEL_${name}_${side}`);
    assert.equal(skeletal.config.physicsAssetPath, `${modernJob.targetRoot}/Mesh/SkeletalMesh/${side}/SK_${name}_${side}_Physics`);
  }
});

test('Item rename preserves identity and updates managed files and manifest', async t => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const root = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'item-rename-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'Herb');
  await fs.mkdir(directory);
  const metaPath = path.join(directory, 'asset_info.json');
  const meta = { id: 'item-identity', name: 'Herb', assetType: 'item', category: 'Consumable',
    character: { name: 'Herb', displayNameEn: 'Herb', displayNameZh: '草药' },
    characterManifest: { files: [{ role: 'staticMesh', normalizedName: 'SM_Herb.fbx', storedPath: 'SM_Herb.fbx' }] } };
  await fs.writeFile(metaPath, JSON.stringify(meta));
  await fs.writeFile(path.join(directory, 'SM_Herb.fbx'), 'fixture');
  await require('../electron/services/characterNames').updateCharacterNames({ root,
    asset: { id: meta.id, source: 'custom', assetType: 'item', path: directory, metaPath },
    displayNameZh: '药草', displayNameEn: 'Medicine', nameConfirmed: true, expectedName: '草药', expectedEnglishName: 'Herb' });
  const updated = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  assert.equal(updated.id, meta.id);
  assert.equal(updated.name, 'Medicine');
  assert.equal(updated.characterManifest.files[0].normalizedName, 'SM_Medicine.fbx');
  assert.equal(await fs.readFile(path.join(directory, 'SM_Medicine.fbx'), 'utf8'), 'fixture');
});
