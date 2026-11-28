const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const { analyzeNaniteFoliage, groupNaniteFoliage, archiveNaniteFoliage } = require('../electron/services/naniteFoliage');
const { buildDrafts } = require('./import-draft-harness.cjs');
const { buildExportAssets } = require('../electron/services/unrealExporter');
const { plantBranches, useNaniteFoliageBranch } = require('../shared/plantBranches.mjs');
const { toAssetListRecord, toAssetIndexRecord } = require('../electron/services/assetListRecord');

async function plantExportMenu() {
  const ts = require('typescript');
  const source = await fs.readFile(path.join(__dirname, '../src/ui/App.tsx'), 'utf8');
  const parsed = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ['collectAssetModelFilePaths', 'collectQuickFilterTagKeys', 'isZionPlantAsset',
    'supportsPlantExportMode', 'canSelectPlantExportMode', 'isNaniteFoliageAsset', 'resolvePlantModeForAssets'];
  const functions = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(functions.length, names.length);
  const constants = parsed.statements.filter(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(item => ['PLANT_EXPORT_MODE_OPTIONS', 'QUICK_THIRD_PARTY_TAG_KEYS'].includes(item.name.getText(parsed))));
  const menuNames = ['exportPlants', 'showPlantExportModeSelect', 'canSelectOpaqueMode', 'allNaniteFoliage', 'allNaniteOnly', 'effectivePlantMode', 'plantExportModeOptions'];
  const menu = [];
  let dispatch;
  function visit(node) {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => menuNames.includes(item.name.getText(parsed)))) menu.push(node);
    if (ts.isPropertyAssignment(node) && node.name.getText(parsed) === 'plantExportMode' && node.initializer.getText(parsed).startsWith('resolvePlantModeForAssets(')) dispatch = node.initializer.getText(parsed);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.equal(menu.length, menuNames.length);
  assert(dispatch, 'test the actual export IPC option');
  const code = [...constants, ...functions].map(node => node.getText(parsed)).join('\n')
    + '\nreturn (allAssets, currentPlantExportMode, selectedAsset = null) => { const detailExportAssetIds = allAssets.map(asset => asset.id); const assetIds = detailExportAssetIds; const showUnrealExportOptions = true; const t = zh => zh;'
    + menu.map(node => node.getText(parsed)).join('\n')
    + `; return { visible: showPlantExportModeSelect, mode: effectivePlantMode, options: plantExportModeOptions, sentMode: ${dispatch} }; };`;
  return new Function('plantBranches', ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(plantBranches);
}

test('legacy plant component metadata cannot break list projection', () => {
  for (const components of [null, {}, 'legacy', [null, { type: 'texture', uri: 'D.png' }, { type: 'model', uri: 'Grass.fbx' }]]) {
    const asset = { id: 'legacy', assetType: '3dplant', modelFiles: ['Grass.fbx'], meta: { components } };
    assert.deepEqual(plantBranches(toAssetListRecord(asset)), { standard: true, naniteFoliage: false });
  }
  assert.deepEqual(plantBranches(null, null), { standard: false, naniteFoliage: false });
});

test('compact plant records retain branch choices through index, cache, menu and dispatch', async () => {
  const menu = await plantExportMenu();
  const full = { id: 'grass', assetType: '3dplant', modelFiles: ['Grass.fbx'], zionTags: ['Zion'],
    meta: { identity: { contentFingerprint: 'stored' }, naniteFoliage: { variants: [{ file: 'Grass.usda' }], groups: [{ textures: ['D.png'] }] } } };
  const compact = asset => toAssetListRecord(JSON.parse(JSON.stringify(toAssetIndexRecord(asset))));
  const listed = compact(full);
  assert.deepEqual(plantBranches(listed), { standard: true, naniteFoliage: true });
  assert.equal(listed.meta.naniteFoliage, undefined, 'do not put the full material/variant manifest back into card records');
  assert.equal(menu([listed], 'naniteFoliage').mode, 'naniteFoliage');
  assert.equal(menu([listed], 'naniteFoliage').sentMode, 'naniteFoliage');
  assert(menu([listed], 'lod').options.some(option => option.value === 'naniteFoliage'));
  assert.equal(menu([listed], 'lod').sentMode, 'lod', 'original branch remains selectable');
  const legacy = { ...listed, meta: { ...listed.meta } };
  delete legacy.meta.plantBranches;
  const refreshed = menu([legacy], 'naniteFoliage', full);
  assert(refreshed.options.some(option => option.value === 'naniteFoliage'), 'detail metadata upgrades an old list cache immediately');
  assert.equal(refreshed.sentMode, 'naniteFoliage', 'dispatch must use the same fresh detail as the menu');
  const naniteOnly = compact({ ...full, id: 'tree', modelFiles: [] });
  assert.deepEqual(menu([naniteOnly], 'lod').options.map(option => option.value), ['naniteFoliage']);
  assert.equal(menu([naniteOnly], 'lod').sentMode, 'naniteFoliage');
  assert(menu([listed, naniteOnly], 'naniteFoliage').options.some(option => option.value === 'naniteFoliage'));
  for (const model of ['Grass.fbx', 'Tree.st9']) {
    const standard = compact({ ...full, id: 'standard', modelFiles: [model], meta: {} });
    assert.equal(menu([listed, standard], 'naniteFoliage').options.some(option => option.value === 'naniteFoliage'), false);
    assert.equal(menu([listed, standard], 'naniteFoliage').sentMode, 'lod');
  }
  assert.equal(full.meta.naniteFoliage.variants.length, 1);
});

async function fixture(t, { grass = false, separate = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assethive-nanite-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  await fs.mkdir(path.join(root, 'Textures'));
  for (const [name, color] of [['D', '#869d39'], ['D2', '#725c35'], ['N', '#8080ff']]) {
    await sharp({ create: { width: 4, height: 4, channels: 4, background: color } }).png().toFile(path.join(root, 'Textures', name + '.png'));
  }
  const models = [];
  for (const number of ['01', '02']) {
    const name = 'Plant_' + number;
    const dir = path.join(root, name);
    await fs.mkdir(dir);
    const material = (slot, diffuse) => `def Material "${slot}" {
      def Shader "stReader" { string inputs:varname = "st" }
      def Shader "ColorTex" { asset inputs:file = @../Textures/${diffuse}.png@ }
      def Shader "NormalTex" { asset inputs:file = @../Textures/N.png@ }
    }`;
    const model = path.join(dir, name + '.usda');
    await fs.writeFile(model, `#usda 1.0
    def Xform "${name}" (apiSchemas = ["NaniteAssemblyRootAPI"]) {
      token unreal:naniteAssembly:meshType = "skeletalMesh"
      ${material(grass ? 'Material_Mat' : 'Mesh_Mat', 'D')}
      ${grass ? '' : material('leaf_Mat', separate && number === '02' ? 'D2' : 'D')}
      ${grass ? '' : 'def PointInstancer "Leaves" { int[] protoIndices = [0, 0] }'}
      float2[] primvars:st = [(0, ${number === '01' ? '0' : '1'})]
    }`);
    await fs.writeFile(path.join(dir, name + '_WindData.json'), JSON.stringify({ Joints: [{ JointName: 'Root', SimulationGroupIndex: 0 }], SimulationGroups: [{ Influence: Number(number) / 10 }], bIsGroundCover: grass }));
    models.push(model);
  }
  return { root, models };
}

test('shared atlas keeps both grass variants and their independent wind files', async t => {
  const { models } = await fixture(t, { grass: true });
  const result = await groupNaniteFoliage(models);
  assert.equal(result.assets.length, 1);
  const manifest = result.assets[0].metadata.naniteFoliage;
  assert.equal(manifest.groups.length, 1);
  assert.equal(manifest.variants.length, 2);
  assert.ok(manifest.variants.every(v => !v.assembly));
  assert.notEqual(manifest.variants[0].windFile, manifest.variants[1].windFile);
  const { drafts } = await buildDrafts(result.assets[0].files, { resolvedAssets: result.assets });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].form.assetType, '3dplant');
  assert.equal(drafts[0].form.plantAssetType, 'naniteFoliage');
  assert.equal(Object.keys(drafts[0].form.modelSlots).length, 2);
});

test('tree variants keep separate leaf atlases and share matching trunk material', async t => {
  const { models } = await fixture(t, { separate: true });
  const manifest = await analyzeNaniteFoliage(models);
  assert.equal(manifest.groups.length, 3);
  assert.ok(manifest.variants.every(v => v.assembly && v.materials.length === 2));
  const [a, b] = manifest.variants;
  assert.equal(a.materials[0].key, b.materials[0].key);
  assert.equal(a.materials[0].role, 'trunk');
  assert.notEqual(a.materials[1].key, b.materials[1].key);
});

test('material sampling differences prevent reuse even with identical textures', async t => {
  const { models } = await fixture(t, { grass: true });
  const source = await fs.readFile(models[1], 'utf8');
  await fs.writeFile(models[1], source.replace('asset inputs:file', 'float4 inputs:scale = (0.5, 0.5, 0.5, 1)\nasset inputs:file'));
  assert.equal((await analyzeNaniteFoliage(models)).groups.length, 2);
});

test('archive preserves USD bytes, relative texture references and variant mappings', async t => {
  const { root, models } = await fixture(t, { separate: true });
  const destination = path.join(root, 'Library');
  const manifest = await archiveNaniteFoliage(models, destination);
  const archivedModels = manifest.variants.map(v => path.join(destination, v.file));
  assert.deepEqual(await fs.readFile(archivedModels[0]), await fs.readFile(models[0]));
  assert.equal((await analyzeNaniteFoliage(archivedModels)).groups.length, 3);
  const asset = { id: 'fixture', name: 'Plant', assetType: '3dplant', path: destination, modelFiles: archivedModels,
    meta: { plantAssetType: 'naniteFoliage', naniteFoliage: manifest, standardAssetTags: ['Tree'] } };
  const jobs = await buildExportAssets([asset], null, '4k', 'decal', 'naniteFoliage', 'auto', new Map(), { meshOverwritePolicy: ['texture'] });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].plantExportMode, 'naniteFoliage');
  assert.deepEqual(jobs[0].meshOverwritePolicy, ['texture']);
  assert.equal(jobs[0].naniteFoliage.groups.length, 3);
  assert.equal(jobs[0].naniteFoliage.variants.length, 2);
});

test('missing wind and unsupported UV sampling return explicit errors', async t => {
  const { models } = await fixture(t, { grass: true });
  await fs.writeFile(models[0], (await fs.readFile(models[0], 'utf8')).replace('"st"', '"st2"'));
  await assert.rejects(analyzeNaniteFoliage([models[0]]), /UV/);
  await fs.unlink(models[1].replace('.usda', '_WindData.json'));
  await assert.rejects(analyzeNaniteFoliage([models[1]]), /Wind/);
});

test('a Nanite Foliage branch coexists with original FBX under one asset ID', async t => {
  const { root, models } = await fixture(t, { grass: true });
  const destination = path.join(root, 'Library');
  const manifest = await archiveNaniteFoliage(models, destination);
  const fbx = path.join(destination, 'Plant_01.fbx');
  await fs.writeFile(fbx, 'original model placeholder');
  const asset = { id: 'same-id', name: 'Plant', assetType: '3dplant', path: destination, modelFiles: [fbx],
    meta: { plantAssetType: 'standard', naniteFoliage: manifest, standardAssetTags: ['Grass'], zionTags: ['Zion'], modelFiles: [fbx], modelVariants: [{ file: fbx, variantKey: '01' }] } };
  assert.deepEqual(plantBranches(asset), { standard: true, naniteFoliage: true });
  assert.equal(useNaniteFoliageBranch(asset, asset.meta, 'lod'), false);
  const [nanite] = await buildExportAssets([asset], null, '4k', 'decal', 'naniteFoliage', 'auto');
  assert.equal(nanite.id, 'same-id');
  assert.equal(nanite.naniteFoliage.variants.length, 2);
  assert(nanite.modelFiles.every(file => /\.usda$/i.test(file)));
  // 覆盖选项必须传给所选 USDA 骨骼分支，不因同 ID 的原始 FBX 而丢失。
  for (const [selection, expected] of [
    [['mesh'], 'meshOnly'],
    [['mesh', 'texture'], ['texture', 'mesh']],
    [['material', 'texture', 'mesh'], 'all'],
    [['texture'], ['texture']],
    [[], []]
  ]) {
    const [selected] = await buildExportAssets([asset], null, '4k', 'decal', 'naniteFoliage', 'auto', new Map(), { meshOverwritePolicy: selection });
    assert.equal(selected.plantAssetType, 'naniteFoliage');
    assert.deepEqual(selected.meshOverwritePolicy, expected);
    assert.deepEqual(selected.modelFiles, nanite.modelFiles);
    assert.deepEqual(selected.naniteFoliage.variants.map(v => v.windFile), nanite.naniteFoliage.variants.map(v => v.windFile));
  }
  // Plan resolution must not put alternate USDA files into the FBX LOD chain.
  const { buildExportModelPlan } = require('../electron/services/unrealExporter');
  assert.deepEqual(buildExportModelPlan(asset, asset.meta, 'lod').modelVariants.map(v => v.file), [fbx]);
  assert.equal(asset.meta.modelFiles[0], fbx);
});

test('editing an archived branch reuses root library textures without nesting or copying', async t => {
  const { root, models } = await fixture(t, { grass: true });
  const destination = path.join(root, 'Library');
  const manifest = await archiveNaniteFoliage(models, destination);
  const archived = manifest.variants.map(v => path.join(destination, v.file));
  const maps = manifest.groups[0].textures;
  for (const [slot, rel] of Object.entries(maps)) await fs.copyFile(path.join(destination, rel), path.join(destination, slot + '.png'));
  for (const file of archived) {
    let text = await fs.readFile(file, 'utf8');
    for (const [slot, rel] of Object.entries(maps)) text = text.replaceAll('../Textures/' + path.basename(rel), '../../' + slot + '.png');
    await fs.writeFile(file, text);
  }
  const before = await Promise.all(archived.map(file => fs.readFile(file)));
  const after = await archiveNaniteFoliage(archived, destination);
  assert.deepEqual(after.groups[0].textures, { Diffuse: 'Diffuse.png', Normal: 'Normal.png' });
  assert.deepEqual(after.variants.map(v => v.file), manifest.variants.map(v => v.file));
  for (const [i, file] of archived.entries()) assert.deepEqual(await fs.readFile(file), before[i]);
  await assert.rejects(fs.access(path.join(destination, 'NaniteFoliage', 'NaniteFoliage')));
});
