const test = require('node:test');
const assert = require('node:assert/strict');
const { matchSuitMaterialSlot, reviewSuitMaterialSlots, suitMaterialChoiceKey } = require('../shared/suitMaterialMatching.mjs');
const groups = ['Upbody_Hair', 'Head_Hair', 'Upbody_01'].map(name => ({name,key:name.replaceAll('_','').toLowerCase()}));
test('known hari typo resolves uniquely within the current outfit part; arbitrary typos stay unresolved', () => {
  assert.deepEqual(matchSuitMaterialSlot('M_SK_Char_Suit_H007_M01_hari', groups, 'Upbody'), {key:'upbodyhair',corrected:true});
  assert.equal(matchSuitMaterialSlot('M_hari', groups).key, '');
  assert.equal(matchSuitMaterialSlot('M_hair', [...groups,{name:'Upbody_Hair_02',key:'upbodyhair02'}], 'Upbody').key, '');
  assert.equal(matchSuitMaterialSlot('M_hrai', groups,'Upbody').key,'');
  assert.equal(matchSuitMaterialSlot('M_Upbody_01',groups,'Upbody').key,'upbody01');
});
test('import review honors manual choices, flags missing groups, and accepts model-only packages', () => {
  const models=[{file:'SM_Test_Upbody.fbx',part:'Upbody',slots:['M_Custom','MI_Male_01_Body','M_hari']}];
  let rows=reviewSuitMaterialSlots(models,groups.map(g=>g.name));
  assert.equal(rows.length,2); assert.equal(rows[0].key,''); assert.equal(rows[1].key,'upbodyhair');
  const choices={[suitMaterialChoiceKey('Upbody','M_Custom')]:'upbody01'};
  rows=reviewSuitMaterialSlots(models,groups.map(g=>g.name),choices);
  assert.equal(rows[0].key,'upbody01');
  assert.equal(reviewSuitMaterialSlots(models,['Head_Hair'],choices)[0].key,'');
  assert.deepEqual(reviewSuitMaterialSlots(models,[]),[]);
});
test('backend blocks unresolved slots before writing and persists artist decisions', () => {
  const {validateCharacterImport,normalizeCharacterFields}=require('../electron/services/characterImport');
  const model='SM_M01_Heavy007_Test_Upbody.fbx';
  const input={assetType:'suit',assetName:'M01_Heavy007_Test',category:'Male_01',packageFiles:[model,'T_M01_Heavy007_Test_Upbody_D.tga'],characterFields:{gender:'Male',bodyCode:'01',suitClass:'Heavy',serial:'007',suitName:'Test',displayNameEn:'Test',displayNameZh:'测试',confirmed:true,nameConfirmed:true},modelAnalyses:{[model]:{meshKind:'staticMesh',materialNames:['M_Custom']}}};
  assert(validateCharacterImport(input).some(e=>e.includes('材质槽')));
  input.characterFields.materialSlotMappings={[suitMaterialChoiceKey('Upbody','M_Custom')]:'upbody'};
  assert(!validateCharacterImport(input).some(e=>e.includes('材质槽')));
  assert.deepEqual(normalizeCharacterFields('suit',input.characterFields).materialSlotMappings,input.characterFields.materialSlotMappings);
});
