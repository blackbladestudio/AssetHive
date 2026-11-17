const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { buildSuitExport: build, managedFile } = require('../electron/services/characterSuitExport');
const buildSuitExport = (asset, options, analyze) => build(asset, options, analyze, async () => false);

test('monster material inference asks only for ambiguous groups and preserves saved choices', () => {
  const { inferMonsterMaterialType, mergeSuitExportOptions } = require('../electron/services/characterSuitExport');
  for (const name of ['01_Body', 'Skin', 'Face', '02_Flesh']) assert.equal(inferMonsterMaterialType(name), 'skin', name);
  for (const name of ['01_Hat', '01_Upper', '01_Skirt', '01_Cuish', '01_Shoulder_Arm', 'LeatherArmor']) assert.equal(inferMonsterMaterialType(name), 'cloth', name);
  for (const name of ['01', 'Surface_001', 'Body_Armor', 'PartA', 'Fur']) assert.equal(inferMonsterMaterialType(name), '', name);
  const saved = { monsterMaterialTypes: { head: 'skin', other: 'cloth' }, normalFormat: 'dx' };
  assert.deepEqual(mergeSuitExportOptions(saved, { monsterMaterialTypes: { other: 'skin' } }).monsterMaterialTypes, { head: 'skin', other: 'skin' });
  assert.deepEqual(mergeSuitExportOptions(saved).monsterMaterialTypes, saved.monsterMaterialTypes);
  assert.equal(saved.monsterMaterialTypes.other, 'cloth');
});

test('reassociation trusts only completed deletions whose managed directory is still absent', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suit-deletion-proof-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '.assethive', 'Deletions');
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(path.join(root, 'restored'));
  for (const record of [
    { assetId: 'gone', state: 'deleted', path: path.join(root, 'gone') },
    { assetId: 'partial', state: 'failed', path: path.join(root, 'partial') },
    { assetId: 'restored', state: 'deleted', path: path.join(root, 'restored') },
    { assetId: 'outside', state: 'deleted', path: path.join(root, '..', 'outside') },
    { assetId: 'current', state: 'deleted', path: path.join(root, 'current') }
  ]) await fs.writeFile(path.join(directory, crypto.randomUUID() + '.json'), JSON.stringify(record));
  const { deletedSuitOwners } = require('../electron/services/characterSuitExport');
  assert.deepEqual(await deletedSuitOwners(root, [{ id: 'current', path: path.join(root, 'current') }]), ['gone']);
  assert.deepEqual(await deletedSuitOwners(root, [{ id: 'other', path: path.dirname(root) }]), []);
  assert.deepEqual(await deletedSuitOwners('', []), []);
});

test('monster clothing or skin choice survives send and reopening without exposing a parent path option', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monster-material-choice-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = { role: 'texture', normalizedName: 'T_Executioner_01_Surface_D.tga', storedPath: 'color.tga', materialName: 'MI_Executioner_01_Surface' };
  await fs.writeFile(path.join(root, file.storedPath), 'texture');
  const meta = { id: 'choice', name: 'Executioner', assetType: 'monster', category: '3_Elite',
    character: { family: 'monster', name: 'Executioner', variant: '01' }, characterManifest: { files: [file,
      { role: 'staticMesh', normalizedName: 'SM_Executioner_01.fbx', storedPath: 'SM_Executioner_01.fbx' }] } };
  const asset = { id: 'choice', name: 'Executioner', assetType: 'monster', path: root, metaPath: path.join(root, 'asset_info.json'), meta };
  await fs.writeFile(asset.metaPath, JSON.stringify(meta));
  const client = { getEditorInfo: async () => ({ projectPath: 'D:/Test/Project.uproject', capabilities: ['characterSuitV1'] }),
    importAssets: async ({ characterSuit: job }) => ({ suitResult: { inspectToken: 'token', entries: job.suits.flatMap(suit => suit.entries.map(entry => ({
      assetId: suit.assetId, key: entry.key, kind: entry.kind, name: entry.name, targetPath: entry.targetPath, path: entry.targetPath,
      status: job.phase === 'apply' ? 'success' : 'ready', action: 'added'
    }))) } }) };
  const { sendSuitJob } = require('../electron/services/characterSuitExport');
  const choice = { suitOptions: { monsterMaterialTypes: { 'choice:material:01surface': 'skin' } } };
  const checked = (await sendSuitJob([asset], choice, undefined, client)).suitResult;
  assert.equal(checked.monsterMaterialGroups[0].type, 'skin');
  assert.deepEqual(Object.keys(checked.monsterMaterialGroups[0]).sort(), ['assetName', 'key', 'name', 'type']);
  await sendSuitJob([asset], { ...choice, suitPhase: 'apply', suitInspectToken: 'token', suitManifestHash: checked.manifestHash }, undefined, client);
  asset.meta = JSON.parse(await fs.readFile(asset.metaPath, 'utf8'));
  const reopened = (await sendSuitJob([asset], {}, undefined, client)).suitResult;
  assert.equal(reopened.monsterMaterialGroups[0].type, 'skin');
  assert.equal(Object.values(asset.meta.characterUnrealExports)[0].options.monsterMaterialTypes['choice:material:01surface'], 'skin');
});

test('rename reminder clears only after a complete successful send of the current name revision', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'character-rename-sync-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'color.tga'), 'texture');
  const meta = { id: 'rename', name: 'Executioner', assetType: 'monster', category: '3_Elite',
    character: { family: 'monster', name: 'Executioner', ueNameSyncPending: 'rename-1' },
    characterManifest: { files: [
      { role: 'texture', normalizedName: 'T_Executioner_01_Hat_D.tga', storedPath: 'color.tga', materialName: 'MI_Executioner_01_Hat' },
      { role: 'staticMesh', normalizedName: 'SM_Executioner_01.fbx', storedPath: 'mesh.fbx' }
    ] } };
  const asset = { id: 'rename', name: meta.name, assetType: meta.assetType, path: root, metaPath: path.join(root, 'asset_info.json'), meta };
  const { sendSuitJob } = require('../electron/services/characterSuitExport');
  let mode = 'complete';
  const client = { getEditorInfo: async () => ({ projectPath: 'D:/Test/Project.uproject', capabilities: ['characterSuitV1'] }),
    importAssets: async ({ characterSuit: job }) => {
      let entries = job.suits.flatMap(suit => suit.entries.map(entry => ({ assetId: suit.assetId, key: entry.key, kind: entry.kind,
        name: entry.name, targetPath: entry.targetPath, path: entry.targetPath, status: job.phase === 'inspect' ? 'ready' : 'success', action: 'renamed' })));
      if (job.phase === 'apply') {
        if (['failed', 'skipped', 'unchanged'].includes(mode)) entries[0].status = mode;
        if (mode === 'retained') entries[0].action = 'retained';
        if (mode === 'incomplete') entries = entries.slice(1);
        if (mode === 'newer-rename') await require('../electron/services/assetMetadata').updateAssetMetadataFile(asset.metaPath,
          current => ({ ...current, character: { ...current.character, ueNameSyncPending: 'rename-2' } }));
      }
      return { suitResult: { entries, inspectToken: 'token' } };
    } };
  for (mode of ['failed', 'skipped', 'retained', 'incomplete', 'newer-rename', 'unchanged', 'complete']) {
    asset.meta = JSON.parse(JSON.stringify(meta));
    await fs.writeFile(asset.metaPath, JSON.stringify(asset.meta));
    const checked = (await sendSuitJob([asset], {}, undefined, client)).suitResult;
    assert.equal(JSON.parse(await fs.readFile(asset.metaPath, 'utf8')).character.ueNameSyncPending, 'rename-1', 'inspection keeps reminder');
    await sendSuitJob([asset], { suitPhase: 'apply', suitManifestHash: checked.manifestHash }, undefined, client);
    const pending = JSON.parse(await fs.readFile(asset.metaPath, 'utf8')).character.ueNameSyncPending;
    assert.equal(pending, mode === 'newer-rename' ? 'rename-2' : ['complete', 'unchanged'].includes(mode) ? undefined : 'rename-1', mode);
  }
});

test('Monster forms and owned weapons export together with independent skeletons and shared static opt-in', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monster-export-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = ['01', '02', '01_WP_GreatSword'].flatMap(subject => [
    { role:'skeletalMesh', normalizedName:`SK_Executioner_${subject}.fbx` },
    { role:'staticMesh', normalizedName:`SM_Executioner_${subject}.fbx` },
    ...['D','N','ORM','Emissive'].map(channel => ({role:'texture', normalizedName:`T_Executioner_${subject}_${channel}.tga`, materialName:`MI_Executioner_${subject}`}))
  ]).map(file => ({...file,storedPath:file.normalizedName, ...(/_WP_/.test(file.normalizedName) ? {componentRole:'weapon',componentName:'GreatSword'} : {})}));
  for (const file of files) await fs.writeFile(path.join(root,file.storedPath),file.role);
  const asset={id:'monster-test',name:'Executioner',assetType:'monster',path:root,meta:{category:'3_Elite', character:{family:'monster',name:'Executioner',serial:'003',variant:'01'},characterManifest:{files}}};
  const analyze=async file=>({meshKind:path.basename(file).startsWith('SK_')?'skeletalMesh':'staticMesh',hasSkin:true,skinnedMeshCount:1,bones:[{name:'root',parent:''}],materialNames:['MI_'+path.basename(file).replace(/^(SM|SK)_/,'').replace(/\.fbx$/,'')]});
  const manifest=await buildSuitExport(asset,{},analyze);
  assert.equal(manifest.family,'monster');
  assert.equal(manifest.targetRoot,'/Game/Characters/Monster/3_Elite/Elite_Executioner');
  assert.equal(manifest.materialRequests.length,0);
  const meshes=manifest.entries.filter(e=>e.kind==='skeletalMesh');
  assert.equal(meshes.length,3);
  assert(meshes.every(e=>e.config.ownSkeleton && e.config.createPhysicsAsset && e.skeletonPath.includes('/SKEL_Executioner_')));
  const weaponMaterial = manifest.entries.find(e=>e.kind==='material' && e.config.materialRole==='monsterWeapon');
  assert.equal(weaponMaterial.config.parentPath,'/Game/MaterialLibrary/Weapon/Common/M_Weapon_Monster');
  assert.ok(weaponMaterial.textures.E);
  assert.equal(weaponMaterial.targetPath,manifest.targetRoot+'/Weapon/Material/MI_Executioner_GreatSword');
  assert(manifest.entries.filter(e=>e.kind==='material' && e!==weaponMaterial).every(e=>e.config.materialRole==='monsterCloth' && e.config.parentPath==='/Game/MaterialLibrary/Character/Common/M_Char_Monster_ComplexShading'));
  const weaponMesh = meshes.find(e=>e.name==='SK_Executioner_GreatSword');
  assert.equal(weaponMesh.targetPath,manifest.targetRoot+'/Weapon/Mesh/SkeletalMesh/SK_Executioner_GreatSword');
  assert.equal(weaponMesh.materials.MI_Executioner_01_WP_GreatSword,weaponMaterial.key);
  assert(manifest.entries.filter(e=>e.kind==='texture' && e.groupName==='GreatSword').every(e=>e.targetPath.includes('/Weapon/Texture/') && e.config.virtualTexture===false));
  const emissiveTextures = manifest.entries.filter(e=>e.kind==='texture' && e.channel==='E');
  assert.equal(emissiveTextures.length,3);
  assert.ok(emissiveTextures.every(e=>e.name.endsWith('_E') && e.targetPath.endsWith('_E')));
  assert.ok(manifest.entries.filter(e=>e.kind==='material' && e!==weaponMaterial).every(e=>e.textures.E));
  assert.equal(manifest.entries.filter(e=>e.kind==='staticMesh').length,0);
  const withStatic=await buildSuitExport(asset,{includeStaticMeshes:true},analyze);
  assert.equal(withStatic.entries.filter(e=>e.kind==='staticMesh').length,3);
  assert.deepEqual(withStatic.entries.filter(e=>e.kind==='material'),manifest.entries.filter(e=>e.kind==='material'));
  asset.meta.character.serial='';
  assert.equal((await buildSuitExport(asset,{},analyze)).targetRoot,'/Game/Characters/Monster/3_Elite/Elite_Executioner');
  asset.meta.character.formIds=['01'];
  assert.equal((await buildSuitExport(asset,{},analyze)).entries.filter(e=>e.kind==='skeletalMesh').length,3);
  asset.assetType='npc';
  await assert.rejects(buildSuitExport(asset,{},analyze),/本入口/);
});

test('Monster indexed slots auto-match one material group and body uses the skin master', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monster-slots-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = ['01_Body', '01_Hat'].flatMap(group => [
    ...['D', 'N', 'ORM', 'E'].map(channel => ({ role: 'texture', normalizedName: `T_Executioner_${group}_${channel}.tga`, materialName: `MI_Executioner_${group}` }))
  ]);
  files.push({ role: 'skeletalMesh', normalizedName: 'SK_Executioner_01.fbx' });
  for (const file of files) {
    file.storedPath = file.normalizedName;
    await fs.writeFile(path.join(root, file.storedPath), file.role);
  }
  const asset = { id: 'monster-slots', name: 'Executioner', assetType: 'monster', path: root,
    meta: { category: '1_Boss', character: { family: 'monster', name: 'Executioner', serial: '001', variant: '01' }, characterManifest: { files } } };
  const analyze = async () => ({ meshKind: 'skeletalMesh', hasSkin: true, skinnedMeshCount: 1, bones: [{ name: 'root', parent: '' }],
    materialNames: ['MI_Executioner_01_Body', ...[1, 2, 3, 4, 5].map(index => `MI_Executioner_01_Hat_${index}`)] });
  const manifest = await buildSuitExport(asset, {}, analyze);
  assert.equal(manifest.targetRoot, '/Game/Characters/Monster/1_Boss/Boss_Executioner');
  assert.equal(manifest.materialRequests.length, 0);
  const mesh = manifest.entries.find(entry => entry.kind === 'skeletalMesh');
  for (const index of [1, 2, 3, 4, 5]) assert.equal(mesh.materials[`MI_Executioner_01_Hat_${index}`], 'monster-slots:material:01hat');
  const body = manifest.entries.find(entry => entry.key === 'monster-slots:material:01body');
  const hat = manifest.entries.find(entry => entry.key === 'monster-slots:material:01hat');
  assert.equal(body.config.materialRole, 'monsterSkin');
  assert.equal(body.config.parentPath, '/Game/MaterialLibrary/Character/Common/M_Char_Monster_skin');
  assert.equal(hat.config.materialRole, 'monsterCloth');
  assert.equal(body.validationError, '');
  assert.equal(hat.validationError, '');
  const override = await buildSuitExport(asset, { monsterMaterialTypes: { [hat.key]: 'skin' } }, analyze);
  const changed = override.entries.find(entry => entry.key === hat.key);
  assert.equal(changed.config.materialRole, 'monsterSkin');
  assert.notEqual(changed.fingerprint, hat.fingerprint);
  assert.equal(override.entries.find(entry => entry.key === body.key).fingerprint, body.fingerprint);
  const unknown = { ...asset, meta: { ...asset.meta, characterManifest: { files: files.map(file => ({ ...file,
    normalizedName: file.normalizedName.replace('Hat', 'Surface'), materialName: file.materialName?.replace('Hat', 'Surface') })) } } };
  const pending = await buildSuitExport(unknown, {}, analyze);
  const group = pending.entries.find(entry => entry.key === 'monster-slots:material:01surface');
  assert.equal(group.materialType, '');
  assert.match(group.validationError, /衣服或皮肤/);
  const resolved = await buildSuitExport(unknown, { monsterMaterialTypes: { [group.key]: 'cloth' } }, analyze);
  assert.equal(resolved.entries.find(entry => entry.key === group.key).validationError, '');
  await assert.rejects(buildSuitExport(asset, { monsterMaterialTypes: { [hat.key]: '/Game/ArbitraryParent' } }, analyze), /无效的怪物材质类型/);
  assert.equal(hat.config.parentPath, '/Game/MaterialLibrary/Character/Common/M_Char_Monster_ComplexShading');
});

async function fixture(t, name = 'F01_Medium001_Test', withSkeletal = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suit-export-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = ['Head', 'Arm'].flatMap(part => [
    { role: 'staticMesh', normalizedName: `SM_${name}_${part}.fbx` },
    ...(withSkeletal ? [{ role: 'skeletalMesh', normalizedName: `SK_${name}_${part}.fbx` }] : []),
    ...['D', 'N', 'ORM'].map(channel => ({ role: 'texture', normalizedName: `T_${name}_${part}_${channel}.tga`, materialName: `MI_${name}_${part}` }))
  ]).map(file => ({ ...file, storedPath: file.normalizedName }));
  for (const file of files) await fs.writeFile(path.join(root, file.storedPath), file.role);
  const asset = { id: 'stable-id', name, assetType: 'suit', path: root, meta: { name,
    character: { gender: 'Female', bodyCode: '01' }, characterManifest: { files } } };
  const analyze = async file => ({ meshKind: path.basename(file).startsWith('SK_') ? 'skeletalMesh' : 'staticMesh', hasSkin: withSkeletal, skinnedMeshCount: withSkeletal ? 1 : 0, materialNames: [file.endsWith('_Head.fbx') ? 'MI_Art_head' : 'MI_Art_arm'] });
  return { asset, analyze, files };
}

test('Suit manifest uses real file SHA-256, optional SK and only managed paths', async t => {
  const { asset, analyze } = await fixture(t);
  const manifest = await buildSuitExport(asset, { normalFormat: 'dx' }, analyze);
  assert.equal(manifest.entries.filter(e => e.kind === 'skeletalMesh').length, 0);
  assert.equal(manifest.entries.filter(e => e.kind === 'staticMesh').length, 0);
  assert.equal(manifest.entries.find(e => e.kind === 'texture').sourceHash, crypto.createHash('sha256').update('texture').digest('hex'));
  await assert.rejects(managedFile(asset, '../outside.fbx'));
  assert(manifest.entries.every(e => e.targetPath.startsWith('/Game/Characters/Hero/Asset_PJZ/Female_01/Mesh/F01_Medium001_Test/')));
});

test('duplicate manifest rows for the same texture export once; distinct same-channel files still conflict', async t => {
  const { asset, analyze, files } = await fixture(t);
  const normal = files.find(file => file.normalizedName.endsWith('_Arm_N.tga'));
  files.push({ ...normal, textureType: 'MAP', originalPath: 'different/source/N.tga' });
  const plan = await buildSuitExport(asset, {}, analyze);
  assert.equal(plan.entries.filter(e => e.kind === 'texture').length, 6);
  assert.equal(plan.entries.filter(e => e.kind === 'texture' && e.name.endsWith('_Arm_N')).length, 1);
  await fs.writeFile(path.join(asset.path, 'other-normal.tga'), 'different normal');
  files.push({ ...normal, storedPath: 'other-normal.tga' });
  await assert.rejects(buildSuitExport(asset, {}, analyze), /同材质组贴图类型重复.*Arm\/N/);
});

test('Static opt-in sends SM to its own directory; later SK reuses unchanged material identities', async t => {
  const { asset, analyze, files } = await fixture(t, 'F01_Medium001_Test', true);
  const allFiles = [...files];
  asset.meta.characterManifest.files = files.filter(file => file.role !== 'skeletalMesh');
  const first = await buildSuitExport(asset, { includeStaticMeshes: true }, analyze);
  const staticMeshes = first.entries.filter(entry => entry.kind === 'staticMesh');
  assert.equal(staticMeshes.length, 2);
  for (const mesh of staticMeshes) {
    assert.match(mesh.name, /^SM_/);
    assert.match(mesh.targetPath, /\/Mesh\/StaticMesh\/SM_/);
    assert.equal(mesh.skeletonPath, undefined);
    assert.equal(mesh.config.createPhysicsAsset, false);
  }
  asset.meta.characterManifest.files = allFiles;
  const later = await buildSuitExport(asset, {}, analyze);
  assert.equal(later.entries.some(entry => entry.kind === 'staticMesh'), false);
  const resources = entries => entries.filter(entry => ['material', 'texture'].includes(entry.kind));
  assert.deepEqual(resources(later.entries), resources(first.entries));
  for (const mesh of later.entries.filter(entry => entry.kind === 'skeletalMesh')) {
    assert.match(mesh.targetPath, /\/Mesh\/SkeletalMesh\/SK_/);
    assert(Object.values(mesh.materials).every(key => first.entries.some(entry => entry.kind === 'material' && entry.key === key)));
  }
});

test('Selecting any part compares the entire suit, including all models and textures', async t => {
  const { asset, analyze } = await fixture(t);
  const { listCharacterComponents } = await import('../shared/characterComponents.mjs');
  asset.exportComponentSlot = listCharacterComponents(asset).find(part => part.name.endsWith('_Head')).slot;
  const manifest = await buildSuitExport(asset, {}, analyze);
  assert.equal(manifest.entries.length, 8);
  assert.equal(manifest.selectedSlot, '');
  assert(manifest.entries.some(e => e.name.includes('_Arm')));
  assert.deepEqual(manifest, await buildSuitExport({ ...asset, exportComponentSlot: '' }, {}, analyze));
});

test('Renaming retains resource identities, while changing bytes updates only affected fingerprint', async t => {
  const a = await fixture(t, 'F01_Medium001_Old');
  const b = await fixture(t, 'F01_Medium001_New');
  const before = await buildSuitExport(a.asset, {}, a.analyze);
  const renamed = await buildSuitExport(b.asset, {}, b.analyze);
  assert.deepEqual(before.entries.map(e => e.key), renamed.entries.map(e => e.key));
  assert.deepEqual(before.entries.map(e => e.fingerprint), renamed.entries.map(e => e.fingerprint));
  await fs.writeFile(path.join(b.asset.path, 'T_F01_Medium001_New_Head_D.tga'), 'new pixels');
  const changed = await buildSuitExport(b.asset, {}, b.analyze);
  assert.deepEqual(changed.entries.filter((e, i) => e.fingerprint !== renamed.entries[i].fingerprint).map(e => e.key), ['stable-id:texture:head:D']);
});

test('Unmatched slots need explicit mapping; file prefixes do not decide skeletal type', async t => {
  const { asset } = await fixture(t);
  // Legacy unclassified FBX can be named SM while its content is actually skinned.
  for (const file of asset.meta.characterManifest.files) if (file.role === 'staticMesh') file.role = 'model';
  const analyze = async () => ({ meshKind: 'skeletalMesh', hasSkin: true, skinnedMeshCount: 1, materialNames: ['body'] });
  let manifest = await buildSuitExport(asset, {}, analyze);
  assert.equal(manifest.materialRequests.length, 2);
  assert(manifest.entries.filter(e => e.kind === 'skeletalMesh').every(e => e.name.startsWith('SK_')));
  const materialMappings = Object.fromEntries(manifest.materialRequests.map(r => [r.key, '/Game/Common/MI_Body']));
  manifest = await buildSuitExport(asset, { materialMappings }, analyze);
  assert.equal(manifest.materialRequests.length, 0);
  assert(manifest.entries.filter(e => e.kind === 'skeletalMesh').every(e => e.externalMaterials.body === '/Game/Common/MI_Body'));
  await assert.rejects(buildSuitExport(asset, {}, async () => ({ meshKind: 'skeletalMesh', hasSkin: false })), /蒙皮/);
});

test('Public character MIs follow suit gender and body, without being mistaken for suit arm/head groups', async t => {
  const { asset } = await fixture(t, 'F01_Medium001_Test', true);
  const analyze = async () => ({ meshKind: 'skeletalMesh', hasSkin: true, skinnedMeshCount: 1, materialNames: ['M_Male01_body', 'M_Female01_hand', 'MI_Female01_arm', 'M_Female01_head01', 'MI_Art_head'] });
  for (const gender of ['Female', 'Male']) {
    asset.meta.character.gender = gender;
    const manifest = await buildSuitExport(asset, {}, analyze);
    assert.equal(manifest.materialRequests.length, 0);
    const model = manifest.entries.find(e => e.kind === 'skeletalMesh');
    for (const [slot, suffix] of [['M_Male01_body','body'], ['M_Female01_hand','hand'], ['MI_Female01_arm','arm'], ['M_Female01_head01','head01']]) {
      assert.equal(model.externalMaterials[slot], `/Game/Characters/Hero/Asset_PJZ/${gender}_01/Mesh/SK_${gender}01/Materials/MI_${gender}01_${suffix}`);
    }
    assert.equal(model.materials.MI_Art_head, 'stable-id:material:head');
    assert.equal(model.sharedMaterialSlots.length, 4);
  }
});

test('SM stays managed but is not read, sent or counted; adding SK sends only SK with textures and MIs', async t => {
  const { asset, analyze, files } = await fixture(t, 'F01_Medium001_Test', true);
  const calls = [];
  const inspect = async file => { calls.push(path.basename(file)); return analyze(file); };
  const before = await buildSuitExport(asset, {}, inspect);
  assert.deepEqual(calls.sort(), ['SK_F01_Medium001_Test_Arm.fbx', 'SK_F01_Medium001_Test_Head.fbx']);
  assert.equal(before.entries.filter(entry => entry.kind === 'skeletalMesh').length, 2);
  assert.equal(before.entries.filter(entry => entry.kind === 'staticMesh').length, 0);
  assert.equal(before.entries.filter(entry => entry.kind === 'material').length, 2);
  assert.equal(before.entries.filter(entry => entry.kind === 'texture').length, 6);
  for (const file of files.filter(file => file.role === 'staticMesh')) {
    assert.equal(await fs.readFile(path.join(asset.path, file.storedPath), 'utf8'), 'staticMesh');
    await fs.writeFile(path.join(asset.path, file.storedPath), 'changed art mesh');
  }
  const after = await buildSuitExport(asset, {}, inspect);
  assert.equal(after.manifestHash, before.manifestHash);
  assert.equal(asset.meta.characterManifest.files.filter(file => file.role === 'staticMesh').length, 2);
});

test('legacy static FBX is excluded after content inspection', async t => {
  const { asset } = await fixture(t);
  for (const file of asset.meta.characterManifest.files) if (file.role === 'staticMesh') file.role = 'model';
  const manifest = await buildSuitExport(asset, {}, async () => ({ meshKind: 'staticMesh', materialNames: [] }));
  assert.equal(manifest.entries.some(entry => ['staticMesh', 'skeletalMesh'].includes(entry.kind)), false);
  assert.equal(manifest.materialRequests.length, 0);
});

test('Suit detail reads retain UE receipts and history while list records stay small', async t => {
  const { asset } = await fixture(t);
  const { getAssetDetailsByMetaPath } = require('../electron/services/assetScanner');
  const { toAssetListRecord } = require('../electron/services/assetListRecord');
  const receipt = { projectPath: 'D:/Zion.uproject', targetRoot: '/Game/Test', entries: {} };
  const metaPath = path.join(asset.path, 'asset_info.json');
  await fs.writeFile(metaPath, JSON.stringify({ ...asset.meta, id: asset.id, assetType: 'suit', enginePath: '/Game/Test', characterUnrealExports: { project: receipt }, characterUpdateHistory: [{ note: 'send' }] }));
  const detail = await getAssetDetailsByMetaPath(metaPath);
  assert.equal(detail.meta.enginePath, '/Game/Test');
  assert.deepEqual(detail.meta.characterUnrealExports.project, receipt);
  assert.equal(detail.meta.characterUpdateHistory[0].note, 'send');
  assert.equal(toAssetListRecord(detail).meta.characterUnrealExports, undefined);
});

test('UE path disappears for deleted entries and returns when restored, scoped to project and part', () => {
  const ts = require('typescript');
  const code = ts.transpileModule(require('node:fs').readFileSync(path.resolve('src/ui/suitExportLocations.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const compiled = { exports: {} }; new Function('exports', 'module', code)(compiled.exports, compiled);
  const locations = compiled.exports.suitExportLocations;
  const row = { kind: 'staticMesh', partSlot: 'head', lastSuccessPath: '/Game/Test/SM_Head', path: '/Game/Test/SM_Head', status: 'success', action: 'added', missingInUE: false };
  const meta = { characterUnrealExports: { project: { projectPath: 'D:/Zion.uproject', targetRoot: '/Game/Test', entries: { head: row } } } };
  assert.equal(locations(meta, 'd:\\Zion.uproject')[0].path, '/Game/Test');
  row.missingInUE = true;
  assert.equal(locations(meta, '')[0].path, '');
  assert.equal(locations(meta, '')[0].missing, true);
  assert.equal(locations({ ...meta, componentView: { slot: 'head' } }, '')[0].path, '');
  row.missingInUE = false;
  assert.equal(locations(meta, '')[0].path, '/Game/Test');
  assert.equal(locations(meta, 'D:/Other.uproject'), null);
});

test('Observed UE deletion is recorded once and preserves source update time', () => {
  const { recordUEPresenceChanges } = require('../electron/services/characterSuitExport');
  const meta = { characterManifest: { contentUpdatedAt: 'source-time', lastUpdateSummary: 'source-change' } };
  const receipt = { entries: { head: { name: 'SM_Head', lastSuccessPath: '/Game/Test/SM_Head', missingInUE: false } } };
  const deleted = [{ key: 'head', present: false, path: '' }];
  recordUEPresenceChanges(meta, receipt, deleted, 'D:/Zion.uproject');
  assert.equal(meta.characterUpdateHistory.length, 1);
  assert.equal(meta.characterUpdateHistory[0].label, '检测到 UE 资源删除');
  assert.equal(meta.characterUpdateHistory[0].files[0].uePath, '/Game/Test/SM_Head');
  receipt.entries.head.missingInUE = true;
  recordUEPresenceChanges(meta, receipt, deleted, 'D:/Zion.uproject');
  assert.equal(meta.characterUpdateHistory.length, 1);
  recordUEPresenceChanges(meta, receipt, [{key:'head',present:true,path:'/Game/Test/SM_Head'}], 'D:/Zion.uproject');
  assert.equal(meta.characterUpdateHistory[1].label, '检测到 UE 资源恢复');
  assert.equal(meta.characterManifest.contentUpdatedAt, 'source-time');
});
