const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { buildSuitExport } = require('../electron/services/characterSuitExport');
const { auditHeroPackage } = require('../shared/heroPackageRules.mjs');
const { buildCharacterTextureBaseName } = require('../electron/services/characterImport');
for (const variant of ['Face', 'Hair']) test(`${variant} independent naming and channel mapping`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hero-export-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fields = { gender: 'Male', bodyCode: '01', serial: '001', variant };
  const name = `M01_${variant}001`;
  const channels = variant === 'Hair' ? ['Opacity','Root','ID','Height','Tangent','ShadingMask'] : ['D','N','ORM','ShadingMask'];
  const sources = channels.map(c => `T_${variant === 'Hair' ? 'Top_1' : 'Male01_head01'}_${c}.tga`);
  assert.ok(sources.every(require('../shared/characterFilePolicy.mjs').isAllowedCharacterTextureFile));
  assert.deepEqual(auditHeroPackage([`SK_${name}.fbx`, ...sources], fields), []);
  const files = [{ role: 'skeletalMesh', storedPath: `SK_${name}.fbx`, normalizedName: `SK_${name}.fbx` },
    ...sources.map(source => ({ role: 'texture', originalName: source, storedPath: buildCharacterTextureBaseName(name, '', '', source, fields)+'.tga' }))];
  for (const f of files) { f.normalizedName = f.storedPath; await fs.writeFile(path.join(root,f.storedPath),f.storedPath); }
  const asset = { id: 'hero', name, path: root, assetType: 'suit', meta: { character: fields, characterManifest: { files } } };
  const slots = variant === 'Hair' ? ['pasted__M_Male01_hair01'] : ['M_Male01_head02','MI_Char_LacriMIalfluid','M_Male01_head01_eye_occlusion','M_Male01_oral1','M_Male01_eyebrow01','MI_Char_ProceduralIris'];
  const plan = await buildSuitExport(asset, {}, async () => ({ meshKind:'skeletalMesh', bones:[{name:'root',parent:''}],materialNames:slots }));
  assert.equal(plan.materialRequests.length,0);
  assert.equal(plan.entries.filter(e=>e.kind==='texture').length,channels.length);
  assert.equal(plan.entries.filter(e=>e.kind==='material').length,1);
  for (const entry of plan.entries.filter(e => ['material','texture'].includes(e.kind))) {
    assert.ok(entry.targetPath.startsWith(`/Game/Characters/Hero/Asset_PJZ/Male_01/Mesh/${variant}${variant==='Hair'?'/HairCard':''}/Material/${name}/`));
  }
  const mesh=plan.entries.find(e=>e.kind==='skeletalMesh');
  assert.equal(mesh.targetPath,`/Game/Characters/Hero/Asset_PJZ/Male_01/Mesh/${variant}${variant==='Hair'?'/HairCard':''}/SK_${name}`);
  if (variant==='Face') assert.deepEqual(Object.values(mesh.heroSharedRoles).sort(),['eye','eyebrow','lacrimal','occlusion','oral']);
  else assert.deepEqual(Object.keys(plan.entries.find(e=>e.kind==='material').textures),channels);
});
test('Groom ABC has canonical suffix and no material or texture jobs',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hero-groom-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'hair.abc'),'fixture');
  const plan=await buildSuitExport({id:'groom',assetType:'suit',path:root,meta:{character:{variant:'Hair',gender:'Female',bodyCode:'01',serial:'002'},characterManifest:{files:[{role:'model',storedPath:'hair.abc'}]}}});
  assert.equal(plan.entries[0].targetPath, '/Game/Characters/Hero/Asset_PJZ/Female_01/Mesh/Hair/Groom/F01_Hair002_Groom');
  assert.equal(plan.entries.length,1);assert.equal(plan.entries[0].kind,'groom');assert.equal(plan.entries[0].name,'F01_Hair002_Groom');
});
