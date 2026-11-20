const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildSuitExport } = require('../electron/services/characterSuitExport');
const { buildFamilyPackagePlan } = require('../electron/services/characterFamilyRules');
const { auditHeroPackage } = require('../shared/heroPackageRules.mjs');
const fields = { gender: 'Female', bodyCode: '01', variant: 'Face', serial: '001' };

test('targeted LOD slots expose five levels per mesh, preserve higher levels and exclude Groom', () => {
 const {characterLodUpdateTargets}=require('../shared/characterLodUpdateTargets.mjs');
 const file=(name,role)=>({normalizedName:name,storedPath:'Mesh/'+name,role});
 const rows=characterLodUpdateTargets([
  {slot:'left',files:[file('SM_DualHands001_Test_L.fbx','staticMesh'),file('SM_DualHands001_Test_L_LOD1.fbx','staticMesh'),file('SK_DualHands001_Test_L.fbx','skeletalMesh')]},
  {slot:'right',files:[file('SK_DualHands001_Test_R.fbx','skeletalMesh'),...Array.from({length:6},(_,i)=>file(`SK_DualHands001_Test_R_LOD${i+1}.fbx`,'skeletalMesh'))]},
  {slot:'groom',files:[file('F01_Hair001_Groom.abc','model')]},
  {slot:'missing',files:[]}
 ]);
 assert.equal(rows.length,16);
 assert.equal(rows.filter(row=>!row.isNew).length,7);
 assert.deepEqual(rows.filter(row=>row.modelName==='SK_DualHands001_Test_L').map(row=>row.lod),[1,2,3,4,5]);
 assert.equal(rows.find(row=>row.modelName==='SM_DualHands001_Test_L'&&row.lod===1).storedPath,'Mesh/SM_DualHands001_Test_L_LOD1.fbx');
 assert.equal(rows.find(row=>row.modelName==='SK_DualHands001_Test_L'&&row.lod===1).storedPath,'__new_character_lod__:skeletalMesh:1:left');
 assert(rows.some(row=>row.lod===6&&!row.isNew));
 assert(!rows.some(row=>row.lod===0||/groom|missing/.test(row.storedPath)));
});

test('LOD review separates suit parts, mesh kinds and weapon sides and labels manual vs automatic', () => {
 const {characterLodReview,characterLodReviewToken}=require('../shared/characterLodReview.mjs');
 const files=['SK_F01_Medium001_Test_Head','SK_F01_Medium001_Test_Arm','SM_F01_Medium001_Test_Head','SK_PairedSwords001_Test_L','SK_PairedSwords001_Test_R']
  .flatMap(name=>[0,1,2,3,4,5].map(index=>({name:`${name}_LOD${index}.fbx`,sourceHash:'v1'})));
 const groups=characterLodReview(files);
 assert.equal(groups.length,5);
 assert(groups.every(group=>group.files.length===6 && !group.automatic.length && !group.missingBase));
 const partial=files.filter(file=>!/_LOD[2-5]/.test(file.name));
 assert(characterLodReview(partial).every(group=>group.automatic.join() === '2,3,4,5'));
 const token=characterLodReviewToken(partial);
 assert.equal(characterLodReviewToken([...partial].reverse()),token);
 assert.notEqual(characterLodReviewToken(partial.map((file,i)=>i?file:{...file,sourceHash:'v2'})),token);
 assert.notEqual(characterLodReviewToken(partial.map(file=>({...file,name:file.name.replace('Test','Renamed')}))),token);
 assert(characterLodReview([partial[0],partial[0]])[0].duplicate);
 assert(characterLodReview([{name:'SK_Test_LOD1.fbx'}])[0].missingBase);
 assert.deepEqual(characterLodReview([{name:'SK_Test.fbx'}])[0].automatic,[1,2,3,4,5]);
 assert.deepEqual(characterLodReview([{name:'F01_Hair001_Groom.abc'}]),[]);
});

test('LOD review renders visible level files, missing generation settings hint and explicit checkbox', () => {
 const ts=require('typescript');
 const Module=require('module');
 const filename=path.resolve('src/ui/CharacterLodReview.tsx');
 const compiled=ts.transpileModule(require('node:fs').readFileSync(filename,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const mod=new Module(filename,module);mod.filename=filename;mod.paths=Module._nodeModulePaths(path.dirname(filename));mod._compile(compiled,filename);
 const html=require('react-dom/server').renderToStaticMarkup(require('react').createElement(mod.exports.CharacterLodReview,{
  files:[{name:'SK_Sword001_Test.fbx'},{name:'SK_Sword001_Test_LOD1.fbx',status:'added'}],t:zh=>zh,confirmed:false,onConfirm:()=>{}
 }));
 assert.match(html,/character-identity-unconfirmed/);assert.match(html,/type="checkbox"/);
 assert.match(html,/SK_Sword001_Test_LOD1.fbx/);assert.match(html,/LOD2、LOD3、LOD4、LOD5/);assert.match(html,/未配置时会提示/);
 assert.match(html,/新增/);
 assert.match(html, /来源文件/); assert.match(html, /入库文件名/); assert.match(html, /<table/);
 const render = props => require('react-dom/server').renderToStaticMarkup(require('react').createElement(mod.exports.CharacterLodReview, {t:zh=>zh,onConfirm:()=>{}, ...props}));
 const empty = render({files:[],showEmpty:true,confirmed:true});
 assert.match(empty,/待选择模型/); assert.match(empty,/character-identity-unconfirmed/);
 assert.match(empty, /disabled=""/); assert.doesNotMatch(empty, /checked=""/);
 // Texture-only updates and read-only empty cards must not acquire a model confirmation.
 assert.equal(render({files:[{name:'T_Test_D.tga'}]}), '');
 const failed = render({files:[{name:'SM_Test.fbx',sourcePath:'C:/Art/original.fbx',inspection:'failed',inspectionMessage:'Unreadable FBX'}],confirmed:true});
 assert.match(failed,/original\.fbx/); assert.match(failed,/SM_Test\.fbx/); assert.match(failed,/Unreadable FBX/);
 assert.match(failed,/disabled=""/); assert.doesNotMatch(failed,/checked=""/);
 const pending = render({files:[{name:'SM_Test.fbx',inspection:'pending'}]});
 assert.match(pending,/检查中/); assert.match(pending,/disabled=""/);
 const ready = render({files:[{name:'SM_Test.fbx',inspection:'ready'}],confirmed:true});
 assert.match(ready,/checked=""/); assert.doesNotMatch(ready,/disabled=""/);
 const compact = render({compact:true,files:[{name:'SM_Test.fbx'},{name:'SK_Test.fbx'}, {name:'SM_Test_LOD1.fbx'}]});
 assert.match(compact, /<details class="character-file-section/);
 assert.match(compact, /模型 LOD 文件/); assert.match(compact, /SM_Test_LOD1.fbx/);
 assert.doesNotMatch(compact, /<table|type="checkbox"|未配置/);
 assert.match(compact, /LOD0 列表<span>2 个文件/);
 assert.match(compact, /LOD1 列表<span>1 个文件/);
 assert.doesNotMatch(compact, /LOD2 列表/);
 assert(compact.indexOf('SK_Test.fbx') < compact.indexOf('LOD1 列表'));
});

test('face auxiliary textures stay in export but never enter master bindings', async t => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'face-aux-')); t.after(() => fs.rm(dir,{recursive:true,force:true}));
 const files = ['SM_F01_Face001.fbx','T_F01_Face001_SRMF.tga','T_F01_Face001_Mask.tga','T_F01_Face001_Scatter.tga'].map(name=>({normalizedName:name,storedPath:name,role:name.startsWith('SM')?'staticMesh':'texture'}));
 for (const f of files) await fs.writeFile(path.join(dir,f.storedPath),f.storedPath);
 const out = await buildSuitExport({id:'aux',assetType:'suit',path:dir,meta:{character:fields,characterManifest:{files}}},{includeStaticMeshes:true},async()=>({meshKind:'staticMesh',materialNames:['Face']}));
 assert.equal(out.entries.filter(e=>e.kind==='texture').length,3);
 const material=out.entries.find(e=>e.kind==='material');
 assert.ok(material.config.parentPath.endsWith('/M_Char_Face'));
 assert.deepEqual(Object.keys(material.textures),['Scatter']);
});

for(const variant of ['Face','Hair','Medium']) for(const kind of ['staticMesh','skeletalMesh']) test(`${variant} ${kind}: one UE model, additions update fingerprint`, async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lod-export-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const name=variant==='Medium'?'F01_Medium001_Test_Head':`F01_${variant}001`;
 const prefix=kind==='skeletalMesh'?'SK':'SM';
 const files=[`${prefix}_${name}.fbx`,`${prefix}_${name}_lod1.fbx`,`${prefix}_${name}_LOD2.fbx`].map(name=>({normalizedName:name,storedPath:name,role:kind}));
 for(const f of files) await fs.writeFile(path.join(dir,f.storedPath),f.storedPath);
 const asset={id:'lod',name:variant==='Medium'?'F01_Medium001_Test':name,assetType:'suit',path:dir,meta:{character:{...fields,variant},characterManifest:{files}}};
 const analyze=async()=>({meshKind:kind,hasSkin:true,skinnedMeshCount:1,bones:[{name:'root',parent:''}],materialNames:['Face']});
 const out=await buildSuitExport(asset,{includeStaticMeshes:true},analyze);
 const meshes=out.entries.filter(e=>e.kind===kind);assert.equal(meshes.length,1);assert.deepEqual(meshes[0].config.lodSources.map(e=>e.index),[1,2]);
 await fs.writeFile(path.join(dir,files[1].storedPath),'updated');
 const next=await buildSuitExport(asset,{includeStaticMeshes:true},analyze);assert.notEqual(next.entries.find(e=>e.kind===kind).fingerprint,meshes[0].fingerprint);
 asset.meta.characterManifest.files=[files[0],files[2]];
 await assert.rejects(buildSuitExport(asset,{includeStaticMeshes:true},analyze),/连续/);
});

test('explicit LOD0 is accepted as face primary',()=>assert.deepEqual(auditHeroPackage(['SM_F01_Face001_LOD0.fbx','SM_F01_Face001_LOD1.fbx'],fields),[]));
test('all four suit parts keep independent full artist LOD chains in one suit export', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'suit-four-lods-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:3}));
 const files=['Head','Upbody','Downbody','Arm'].flatMap(part=>[0,1,2,3,4,5].map(level=>{
  const name=`SK_F01_Medium001_Test_${part}${level?`_LOD${level}`:''}.fbx`;
  return {role:'skeletalMesh',normalizedName:name,storedPath:name};
 }));
 for(const file of files) await fs.writeFile(path.join(dir,file.storedPath),file.storedPath);
 const asset={id:'whole-suit',name:'F01_Medium001_Test',assetType:'suit',path:dir,meta:{character:{...fields,variant:'Medium',suitClass:'Medium',suitName:'Test'},characterManifest:{files}}};
 const result=await buildSuitExport(asset,{},async()=>({meshKind:'skeletalMesh',hasSkin:true,skinnedMeshCount:1,bones:[{name:'root',parent:''}],materialNames:[]}));
 const meshes=result.entries.filter(entry=>entry.kind==='skeletalMesh');
 assert.equal(meshes.length,4);assert.equal(new Set(meshes.map(entry=>entry.targetPath)).size,4);
 for(const mesh of meshes){
  assert.equal(mesh.config.lodPolicy,'existing-settings-v1');
  assert.deepEqual(mesh.config.lodSources.map(source=>source.index),[1,2,3,4,5]);
  const part=mesh.sourcePath.match(/_(Head|Upbody|Downbody|Arm)\.fbx$/)[1];
  assert(mesh.config.lodSources.every(source=>source.sourcePath.includes(`_${part}_LOD`)));
 }
});
for(const [family,folder,options,model] of [
 ['weapon','Sword001_Test',{assetName:'Sword001_Test'},'SM_Sword001_Test'],
 ['weapon','PairedSwords001_Test',{assetName:'PairedSwords001_Test'},'SM_PairedSwords001_Test_L'],
 ['item','GamePlay_WeaponCase_Box',{assetName:'WeaponCase_Box',category:'Gameplay/Int_Loot/WeaponCase',name:'Box'},'SM_WeaponCase_Box'],
 ['npc','Merchant_FireKeeper_防火女',{assetName:'SK_FireKeeper_01',category:'Merchant',name:'FireKeeper',formIds:['01']},'SM_FireKeeper_01']
]) test(`${family} ${model} keeps level suffix`,()=>{
 const plan=buildFamilyPackagePlan(family,folder,[`${folder}/${model}_LOD0.fbx`,`${folder}/${model}_LOD1.fbx`],options);
 assert.equal(plan.ok,true,plan.errors.join('\n'));
 assert.ok(plan.files.some(f=>f.normalizedName===model+'.fbx'),JSON.stringify(plan.files));
 assert.ok(plan.files.some(f=>f.normalizedName===model+'_LOD1.fbx'));
});

for (const [family,name,category,character,model] of [
 ['weapon','Bow001_Test','Bow',{},'Bow001_Test_Bow'],
 ['weapon','PairedSwords001_Test','PairedSwords',{},'PairedSwords001_L'],
 ['monster','Executioner','3_Elite',{name:'Executioner',formIds:['01']},'Executioner_01'],
 ['npc','FireKeeper','Merchant',{name:'FireKeeper',category:'Merchant',formIds:['01']},'FireKeeper_01'],
 ['item','WeaponCase_Box','Gameplay/Int_Loot/WeaponCase',{name:'Box',displayNameEn:'Box'},'WeaponCase_Box']
]) test(`${family} ${model}: levels are attached, not separate UE assets`,async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'family-lods-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const files=[`SK_${model}.fbx`,`SK_${model}_LOD1.fbx`].map(name=>({role:'skeletalMesh',normalizedName:name,storedPath:name}));
 for(const f of files) await fs.writeFile(path.join(dir,f.storedPath),f.storedPath);
 const asset={id:'familylod',name,assetType:family,path:dir,meta:{name,category,character,characterManifest:{files}}};
 const out=await buildSuitExport(asset,{},async()=>({meshKind:'skeletalMesh',hasSkin:true,skinnedMeshCount:1,materialNames:[],bones:[{name:'root',parent:''}]}));
 const meshes=out.entries.filter(e=>e.kind==='skeletalMesh');assert.equal(meshes.length,1);assert.equal(meshes[0].config.lodSources.length,1);assert.ok(!meshes[0].targetPath.includes('LOD'));
});

test('LOD files do not overlap in model previews or change LOD0 preview revisions',()=>{
 const {characterModelPreviewComponents,characterMeshAssetRecord,characterMeshPreviewRevision}=require('../shared/characterComponents.mjs');
 const base={role:'staticMesh',normalizedName:'SM_Sword001_Test.fbx',storedPath:'SM_Sword001_Test.fbx',sha256:'base'};
 const low={...base,normalizedName:'SM_Sword001_Test_LOD1.fbx',storedPath:'SM_Sword001_Test_LOD1.fbx',sha256:'low'};
 const parent={id:'preview',assetType:'weapon',path:'C:/library',meta:{characterManifest:{files:[low,base]}}};
 const part=characterModelPreviewComponents(parent)[0];
 const card=characterMeshAssetRecord(parent,part,'staticMesh');
 assert.equal(card.modelFiles.length,1);assert.ok(card.modelFiles[0].endsWith(base.storedPath));
 assert.equal(characterMeshPreviewRevision([base,low],'staticMesh'),characterMeshPreviewRevision([base],'staticMesh'));
});
