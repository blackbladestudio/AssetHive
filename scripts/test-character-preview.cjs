/* global Buffer */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const sharp = require("sharp");
const { runImageTask } = require("../electron/services/imageTasks");

test('Recovered UE material placeholders fall back to clean white materials without changing geometry', async () => {
  const ts = require('typescript');
  const THREE = await import('three');
  const rules = await import('../shared/characterPreviewMaterials.mjs');
  const source = ts.createSourceFile('characterPreview.ts', await fs.readFile(path.join(__dirname, '../src/ui/characterPreview.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'applyStructuredMaterialTextures');
  const js = ts.transpileModule(declaration.getText(source), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const texture = new THREE.Texture();
  const apply = new Function('THREE', 'characterPreviewMaterialPlan', 'characterPreviewTextureKey', 'loadPreviewTexture', `${js};return applyStructuredMaterialTextures;`)(THREE, rules.characterPreviewMaterialPlan, rules.characterPreviewTextureKey, async () => texture);
  const geometry = new THREE.BoxGeometry();
  const original = new THREE.MeshPhongMaterial({name:'MI_DixinSoldier_upbody_01',color:0,map:new THREE.Texture(),vertexColors:true,transparent:true,opacity:0.2});
  const mesh = new THREE.Mesh(geometry, original);
  await apply(mesh, new THREE.LoadingManager(), new Map());
  assert.equal(mesh.geometry, geometry);
  assert.equal(mesh.material.color.getHex(), 0xffffff);
  assert.equal(mesh.material.map, null);
  assert.equal(mesh.material.vertexColors, false);
  assert.equal(mesh.material.transparent, false);
  assert.equal(mesh.material.opacity, 1);
  assert.equal(mesh.material.name, original.name);
  const textured = new THREE.Mesh(geometry, new THREE.MeshPhongMaterial({name:'M_Upbody'}));
  await apply(textured, new THREE.LoadingManager(), new Map([['t_m01_light008_test_upbody_d',{previewPath:'test.png'}]]));
  assert.equal(textured.material.map, texture);
});

test('Hair preview keeps separate part textures and does not guess an ambiguous hair slot', async () => {
  const { characterPreviewMaterialPlan } = await import('../shared/characterPreviewMaterials.mjs');
  const textures = ['t_f01_hair001_front_d', 't_f01_hair001_back_d', 't_f01_hair001_eyebrow_a'];
  assert.equal(characterPreviewMaterialPlan('M_Old_Front', textures, 'Hair').stem, 'f01_hair001_front');
  assert.equal(characterPreviewMaterialPlan('M_Old_Back', textures, 'Hair').stem, 'f01_hair001_back');
  assert.equal(characterPreviewMaterialPlan('M_Eyebrow', textures, 'Hair').stem, 'f01_hair001_eyebrow');
  assert.equal(characterPreviewMaterialPlan('M_Hair', textures, 'Hair').hasTextures, false);
});

test('Face preview matches semantic hair materials and keeps data-only cards white', async () => {
  const { characterPreviewMaterialPlan, characterPreviewTextureKey } = await import('../shared/characterPreviewMaterials.mjs');
  const textures = [
    't_m01_face999_d',
    't_m01_face999_n',
    't_m01_face999_hair_opacity',
    't_m01_face999_eyebrow_a'
  ];
  const beard = characterPreviewMaterialPlan('M_Male01_Beard', textures, 'Face');
  assert.equal(beard.stem, 'm01_face999_hair');
  assert.equal(beard.role, 'hair');
  assert.equal(beard.hasTextures, true);
  assert.equal(beard.neutralWhite, true);
  assert.equal(characterPreviewTextureKey(beard.stem, 'a', textures), 't_m01_face999_hair_opacity');

  const lashes = characterPreviewMaterialPlan('M_Male01_EyeLash', textures, 'Face');
  assert.equal(lashes.stem, 'm01_face999_eyebrow');
  assert.equal(lashes.role, 'eyebrow');
  assert.equal(lashes.neutralWhite, true);

  const sharedBeard = characterPreviewMaterialPlan('M_Male01_Mustache', ['t_m01_face999_d'], 'Face');
  assert.equal(sharedBeard.hasTextures, false);
  assert.equal(sharedBeard.neutralWhite, true);

  const unrelated = characterPreviewMaterialPlan('lambert1', textures, 'Face');
  assert.equal(unrelated.role, '');
  assert.equal(unrelated.neutralWhite, false);

  const suit = characterPreviewMaterialPlan('M_Old_Upbody_01', ['t_m01_light001_test_upbody_01_d'], '', false);
  assert.equal(suit.stem, 'm01_light001_test_upbody_01');
  const multiMaterialWeapon = characterPreviewMaterialPlan('M_Unmatched', ['t_sword001_test_d'], '', false);
  assert.equal(multiMaterialWeapon.hasTextures, false);
});

test('paired short texture names match old embedded material names without swapping sides', () => {
  const { characterPreviewMaterialPlan } = require('../shared/characterPreviewMaterials.mjs');
  const keys = ['t_pairedswords001_l_d', 't_pairedswords001_r_d'];
  assert.equal(characterPreviewMaterialPlan('MI_PairedSwords001_CanCiJian_L', keys).stem, 'pairedswords001_l');
  assert.equal(characterPreviewMaterialPlan('MI_PairedSwords001_R_CanCiJian', keys).stem, 'pairedswords001_r');
  assert.equal(characterPreviewMaterialPlan('Unknown', keys).hasTextures, false);
  assert.equal(characterPreviewMaterialPlan('OldShared', ['t_dualhands001_d']).stem, 'dualhands001');
});

test("角色透明贴图支持 8 位索引色 TGA 缩略图", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-character-preview-"));
  try {
    const input = path.join(directory, "opacity-indexed.tga");
    const output = path.join(directory, "opacity-indexed.png");
    const header = Buffer.alloc(18);
    header[1] = 1;
    header[2] = 1;
    header.writeUInt16LE(2, 5);
    header[7] = 24;
    header.writeUInt16LE(2, 12);
    header.writeUInt16LE(2, 14);
    header[16] = 8;
    header[17] = 0x20;
    const palette = Buffer.from([0, 0, 0, 255, 255, 255]);
    const indices = Buffer.from([0, 1, 1, 0]);
    await fs.writeFile(input, Buffer.concat([header, palette, indices]));
    await runImageTask("resizeTexture", [input, output, 512]);
    const { data, info } = await sharp(output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height, info.channels], [2, 2, 3]);
    assert.deepEqual([...data], [0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
test('Groom import preview uses the actual ABC renderer branch and preserves a manual cover', async () => {
  const ts=require('typescript');
  const source=ts.createSourceFile('App.tsx',await fs.readFile(path.join(__dirname,'../src/ui/App.tsx'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let declaration;
  (function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='generateCharacterPreviewForForm')declaration=node.getText(source);ts.forEachChild(node,visit);})(source);
  const paths=Object.fromEntries(['front','left','right','back'].map(view=>[view,`C:/cache/${view}.png`]));
  const received=[];
  const scope={bridgeAvailable:true,setCharacterPreviewProgress:()=>{},quickDropRequestIdRef:{current:'current'},t:z=>z,bridge:{materializeDroppedFile:()=>{},renderGroomPreview:async file=>{received.push(file);return paths;}}};
  const js=ts.transpileModule(declaration,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const render=new Function('scope',`with(scope){${js};return generateCharacterPreviewForForm;}`)(scope);
  const draft={assetType:'suit',characterFields:{variant:'Hair'},modelSlots:{Mesh0:'C:/groom/hair.abc'},previewImagePath:'C:/manual.png'};
  const result=await render(draft,'current');
  assert.deepEqual(received,['C:/groom/hair.abc']);
  assert.deepEqual(result.characterPreviewPaths,paths);
  assert.equal(result.previewImagePath,'C:/manual.png');
});
