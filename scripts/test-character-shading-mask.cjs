const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { buildSuitExport } = require('../electron/services/characterSuitExport');
const { heroTextureChannel } = require('../shared/heroMaterialRules.mjs');
const { isAllowedCharacterTextureFile } = require('../shared/characterFilePolicy.mjs');
for (const assetType of ['suit','monster','npc','weapon','item']) test(`${assetType}: ShadingMask survives grouping and export`, async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'shading-mask-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const name=assetType==='suit'?'M01_Light001_Test':assetType==='weapon'?'Jade003_JiuTaotieyu':'Test';
 const files=['D','N','ORM','ShadingMask'].map(c=>({role:'texture',storedPath:`T_${name}_Head_${c}.tga`,materialName:`MI_${name}_Head`}));
 files.push({role:'staticMesh',storedPath:`SM_${name}_Head.fbx`});
 for(const f of files){f.normalizedName=f.storedPath; await fs.writeFile(path.join(root,f.storedPath),'fixture');}
 const asset={id:'mask-test',name,assetType,path:root,meta:{name,category:assetType==='monster'?'Boss':assetType==='npc'?'Human':'Prop',character:{name,gender:'Male',bodyCode:'01',category:'Boss'},characterManifest:{files}}};
 const plan=await buildSuitExport(asset,{includeStaticMeshes:true},async()=>({meshKind:'staticMesh',materialNames:[`MI_${name}_Head`]}),async()=>false);
 const tex=plan.entries.find(e=>e.channel==='ShadingMask'); assert.ok(tex); assert.equal(tex.config.virtualTexture,true);
 const mat=plan.entries.find(e=>e.kind==='material'&&e.textures.ShadingMask); assert.ok(mat); assert.equal(mat.textures.ShadingMask,tex.key);
});
test('ShadingMask is a distinct case-insensitive channel',()=>{
 for(const suffix of ['ShadingMask','shadingmask','SHADINGMASK']){const file=`T_Test_${suffix}.tga`;assert.ok(isAllowedCharacterTextureFile(file));assert.equal(heroTextureChannel(file),'ShadingMask');}
});
