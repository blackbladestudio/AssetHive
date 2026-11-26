const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const ts = require('typescript');
const { buildFamilyPackagePlan } = require('../electron/services/characterFamilyRules');
const { buildCharacterTextureBaseName } = require('../electron/services/characterImport');
const { heroTextureGroup } = require('../shared/heroMaterialRules.mjs');
const { gameplayFileStem } = require('../shared/gameplayNaming.mjs');
const { entries } = require('../shared/gameplayCategories.mjs');
const source = path.resolve(__dirname, '../src/ui/characterImport.ts');
const compiled = ts.transpileModule(fs.readFileSync(source,'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
const mod = {exports:{}};
new Function('exports','module','require',compiled)(mod.exports,mod,createRequire(source));
const { previewFamilyFileName } = mod.exports;
const maps = ['D','N','ORM','A','ShadingMask'];
const groups = ['', '_Parts_a', '_01'];
for (const [family, owner, target, category, extra] of [
 ['weapon','Bow_03','Bow003_New','Bow',{}],
 ['monster','Keeper_01','SK_New_02','1_Boss',{name:'New',formIds:['02']}],
 ['npc','Keeper_01','SK_New_02','Human',{}],
 ['npc','Keeper_01','SK_New_02','Nonhuman',{}],
 ['npc','Scholar017_Keeper','Scholar018_New','Scholar',{}],
 ['item','Chest001_Old','Chest002_New','Chest',{}]
]) test(`${family}/${category}: preserve three material groups across channels and rename`, () => {
 const files = [`SK_${owner}.fbx`,...groups.flatMap(group=>maps.map(map=>`T_${owner}${group}_${map}.tga`))];
 const plan = buildFamilyPackagePlan(family,files[0],files,{assetName:target,category,...extra});
 assert.equal(plan.ok,true,plan.errors.join(';'));
 const textureFiles = plan.files.filter(f=>f.role==='texture');
 assert.equal(new Set(textureFiles.map(f=>f.relativePath.toLowerCase())).size,15);
 for(const group of groups) for(const map of maps) {
   const f=textureFiles.find(f=>f.sourceName===`T_${owner}${group}_${map}.tga`);
   assert.ok(f.normalizedName.endsWith(`${group}_${map}.tga`), f.normalizedName);
   assert.equal(previewFamilyFileName(family,target,f.sourcePath, family==='monster'?'New':''), f.normalizedName);
 }
});
for(const variant of ['Light','Face','Hair']) test(`suit/${variant}: independent Parts_a and numeric groups`,()=>{
 const owner=variant==='Light'?'M01_Light001_Test':'M01_'+variant+'001';
 const outputs=[];
 for(const group of ['Parts_a','01']) for(const map of maps){
  const file=`T_${owner}_${group}_${map}.tga`;
  const name=buildCharacterTextureBaseName(owner,group,map,file,{variant});
  outputs.push(name);
  assert.ok(name.toLowerCase().includes('_'+group.toLowerCase()+'_'),name);
  if(variant!=='Light') assert.equal(heroTextureGroup(file,variant).key,group.toLowerCase());
 }
 assert.equal(new Set(outputs).size,10);
});
test('all current gameplay categories retain material groups',()=>{
 for(const entry of entries.filter(e=>e.leaf)) for(const group of ['Parts_a','01']) for(const map of maps){
  const owner=entry.prefix+'_123';
  assert.equal(gameplayFileStem(owner,'texture',`T_${owner}_${group}_${map}`),`T_${owner}_${group}_${map}`);
 }
});
