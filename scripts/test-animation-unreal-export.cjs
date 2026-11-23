const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {
  DEFAULT_HERO_ANIMATION_SKELETON, parseAnimationLabels, planAnimationExport, normalizeUnrealFolder, suggestAnimationFolders, animationArchiveLocation
} = require('../shared/animationUnrealExport.mjs');
const { buildAnimationExport, sendAnimationJob } = require('../electron/services/animationUnrealExport');
const { buildAnimationMetaFromModel } = require('../electron/services/customAssetLayout');
const { toAssetListRecord } = require('../electron/services/assetListRecord');
const ts = require('typescript');

function loadTypeScript(relative) {
  const file = path.resolve(__dirname, '..', relative);
  const compiled = ts.transpileModule(require('node:fs').readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const output = { exports: {} };
  const load = name => name.startsWith('./') ? loadTypeScript(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(file), `${name}.ts`))) : require(name);
  new Function('require', 'module', 'exports', compiled)(load, output, output.exports);
  return output.exports;
}
const { createSearchDocument } = loadTypeScript('src/ui/assetSearchDocument.ts');
const { AssetSearchIndex } = loadTypeScript('src/ui/assetSearchIndex.ts');

const LIBRARY = '\\\\fileshare\\share\\Artist\\AssetLibrary';
const heroClip = `${LIBRARY}\\Animation\\Hero\\Male_01\\WP00_Unarm\\Locomotion\\AS_Unarm01_M01_RunB.fbx`;

test('UE target uses the chosen folder directly without mirroring the archive', () => {
  const [row] = planAnimationExport([{ assetId: 'a', name: 'Run', fbxPath: heroClip, affiliation: '主角' }], {}, LIBRARY);
  assert.equal(row.error, '');
  assert.equal(row.targetPath, '/Game/Animation/AS_Unarm01_M01_RunB');
  assert.equal(row.characterKey, 'Hero/Male_01');
  assert.equal(row.skeletonPath, DEFAULT_HERO_ANIMATION_SKELETON);
  const [custom] = planAnimationExport([{ assetId: 'a', name: 'Run', fbxPath: heroClip, affiliation: '主角' }], { root: '/Game/Characters/Anim/' }, LIBRARY);
  assert.equal(custom.targetPath, '/Game/Characters/Anim/AS_Unarm01_M01_RunB');
});

test('manual folders are required per archive group; Loco is only a ranked suggestion', () => {
  const clip = `${LIBRARY}/Animation/Monster/ShangExecutor/Locomotion/AS_ShangExecutor_Alert_Walk_Start.fbx`;
  const item = { assetId: 'executor', name: 'Start', fbxPath: clip };
  const folder = '/Game/Characters/Monster/3_Elite/ShangExecutor/Animation/Loco';
  assert.match(planAnimationExport([item], { targetFolders: {} }, LIBRARY)[0].error, /请选择/);
  const [selected] = planAnimationExport([item], { targetFolders: { 'Monster/ShangExecutor/Locomotion': folder } }, LIBRARY);
  assert.equal(selected.error, '');
  assert.equal(selected.targetPath, `${folder}/AS_ShangExecutor_Alert_Walk_Start`);
  assert.match(planAnimationExport([item], { targetFolders: { 'Monster/ShangExecutor/Locomotion': '/Game/../Outside' } }, LIBRARY)[0].error, /请选择/);
  assert.equal(suggestAnimationFolders([folder.replace('/Loco', '/Attack'), folder, '/Game/Characters/Wolf'], animationArchiveLocation(clip))[0], folder);
  assert.deepEqual(suggestAnimationFolders([folder, '/Game/Characters/Wolf'], animationArchiveLocation(clip), 'shang loco'), [folder]);
});

test('paths cannot escape the selected library or hide invalid saved roots', () => {
  const item = fbxPath => ({ assetId: 'a', name: 'Run', fbxPath });
  for (const file of [heroClip.replace('AssetLibrary', 'AssetLibraryOther'), heroClip.replace('fileshare', 'otherhost'),
    `${LIBRARY}/Animation/../Animation/AS_Run.fbx`, `${LIBRARY}/Other/Animation/AS_Run.fbx`]) {
    assert.match(planAnimationExport([item(file)], {}, LIBRARY)[0].error, /资源库/);
  }
  assert.match(planAnimationExport([item(heroClip)], { root: '/Bad/Animation' }, LIBRARY)[0].error, /UE 目标目录/);
  assert.match(planAnimationExport([item(heroClip)], { root: '/Game/../Other' }, LIBRARY)[0].error, /UE 目标目录/);
  assert.equal(planAnimationExport([item(heroClip)], {}, LIBRARY.toUpperCase())[0].error, '');
});

test('an explicitly blank hero Skeleton stays blank for native selection', () => {
  const item = { assetId: 'a', name: 'Run', fbxPath: heroClip, affiliation: '主角' };
  const [row] = planAnimationExport([item], { skeletons: { 'Hero/Male_01': '' } }, LIBRARY);
  assert.equal(row.skeletonPath, '');
  assert.equal(row.error, '');
  assert.match(planAnimationExport([item], { skeletons: { 'Hero/Male_01': '' }, showImportDialog: false }, LIBRARY)[0].error, /Skeleton/);
});

test('monster clips need a Skeleton and remembered skeletons apply per character folder', () => {
  const clip = `${LIBRARY}\\Animation\\Monster\\Wolf_01\\Attack\\AS_Wolf01_Bite.fbx`;
  const [missing] = planAnimationExport([{ assetId: 'm', name: 'Bite', fbxPath: clip, affiliation: '怪物' }], { showImportDialog: false }, LIBRARY);
  assert.match(missing.error, /Skeleton/);
  const [remembered] = planAnimationExport([{ assetId: 'm', name: 'Bite', fbxPath: clip, affiliation: '怪物' }],
    { skeletons: { 'Monster/Wolf_01': '/Game/Characters/Monster/Wolf/SKEL_Wolf' } }, LIBRARY);
  assert.equal(remembered.error, '');
  assert.equal(remembered.skeletonPath, '/Game/Characters/Monster/Wolf/SKEL_Wolf');
});

test('native import can choose a Skeleton, and flat monster clips remember it per character', () => {
  const clip = `${LIBRARY}\\Animation\\Monster\\AS_ShangExecutor_Battle_Run_Stop.fbx`;
  const item = { assetId: 'executor', name: 'Stop', fbxPath: clip, affiliation: '怪物' };
  const [interactive] = planAnimationExport([item], {}, LIBRARY);
  assert.equal(interactive.error, '');
  assert.equal(interactive.characterKey, 'Monster/ShangExecutor');
  assert.equal(interactive.skeletonPath, '');
  const [automated] = planAnimationExport([item], { showImportDialog: false }, LIBRARY);
  assert.match(automated.error, /Skeleton/);
  const [remembered] = planAnimationExport([item], { skeletons: { 'Monster/ShangExecutor': '/Game/Monster/SKEL_ShangExecutor' } }, LIBRARY);
  assert.equal(remembered.skeletonPath, '/Game/Monster/SKEL_ShangExecutor');
});

test('invalid roots, folders and clip names are blocked before sending', () => {
  assert.equal(normalizeUnrealFolder('/Content/Anim'), '');
  assert.equal(normalizeUnrealFolder('/Game/动画'), '');
  assert.equal(normalizeUnrealFolder('\\Game\\Anim\\'), '/Game/Anim');
  const [badRoot] = planAnimationExport([{ assetId: 'a', name: 'Run', fbxPath: heroClip, affiliation: '主角' }], { root: 'Animation' }, LIBRARY);
  assert.match(badRoot.error, /\/Game/);
  const [unicodeArchive] = planAnimationExport([{ assetId: 'b', name: 'x', fbxPath: `${LIBRARY}\\Animation\\Hero\\男主\\AS_Run.fbx`, affiliation: '主角' }], {}, LIBRARY);
  assert.equal(unicodeArchive.error, '');
  const [outside] = planAnimationExport([{ assetId: 'c', name: 'x', fbxPath: 'D:\\Temp\\AS_Run.fbx', affiliation: '主角' }], {}, LIBRARY);
  assert.match(outside.error, /Animation/);
});

test('job carries animation-only import settings with root motion options and reimport', async () => {
  const asset = { id: 'run', name: 'Run', assetType: 'animation', animationAffiliation: '主角', modelFiles: [heroClip] };
  const stat = async () => ({ isFile: () => true });
  const [entry] = await buildAnimationExport([asset, asset], { enableRootMotion: true, forceRootLock: false }, LIBRARY, stat, async value => value);
  assert.equal(entry.kind, 'animSequence');
  assert.equal(entry.name, 'AS_Unarm01_M01_RunB');
  assert.equal(entry.sourcePath, heroClip);
  assert.deepEqual({ ...entry.config, version: undefined }, {
    version: undefined, importMesh: false, importAnimations: true, importMaterials: false, importTextures: false,
    sampleRate: 60, animationLength: 'exportedTime', importBoneTracks: true, importCustomAttribute: true,
    removeRedundantKeys: false, convertScene: true, enableRootMotion: true, forceRootLock: false, showImportDialog: true, allowEngineCompressionFallback: true, overwrite: 'reimport'
  });
  await assert.rejects(buildAnimationExport([asset], {}, LIBRARY, async () => null, async value => value), /不存在/);
  await assert.rejects(buildAnimationExport([{ ...asset, assetType: '3d' }], {}, LIBRARY, stat, async value => value), /仅用于动画/);
  await assert.rejects(buildAnimationExport([asset], {}, LIBRARY, stat, async value => value === LIBRARY ? value : 'D:/Outside/AS_Run.fbx'), /实际路径/);
});

test('send requires the plugin capability and maps per-clip results', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anim-ue-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const clip = path.join(root, 'Animation', 'Hero', 'Male_01', 'Locomotion', 'AS_Run01.fbx');
  await fs.mkdir(path.dirname(clip), { recursive: true });
  await fs.writeFile(clip, 'fbx');
  const asset = { id: 'run', name: 'Run', assetType: 'animation', animationAffiliation: '主角', modelFiles: [clip] };
  const jobs = [];
  const client = capabilities => ({
    getEditorInfo: async () => ({ projectPath: 'D:/P/P.uproject', capabilities }),
    importAssets: async job => { jobs.push(job); return { animationResult: { entries: [{ key: 'run', status: 'success', action: 'reimported', path: '/Game/Animation/Hero/Male_01/Locomotion/AS_Run01' }] } }; }
  });
  await assert.rejects(sendAnimationJob([asset], { customLibraryPath: root }, null, client(['characterSuitV1'])), /动画导入/);
  const reply = await sendAnimationJob([asset], { customLibraryPath: root, animationExport: { forceRootLock: true } }, null, client(['characterAnimationV1']));
  const focused = [];
  const confirmedClient = client(['characterAnimationV1']);
  confirmedClient.getEditorInfo = async () => ({ projectPath: 'D:/P/P.uproject', capabilities: ['characterAnimationV1'], pid: 123 });
  await sendAnimationJob([asset], { customLibraryPath: root }, null, confirmedClient, async pid => { focused.push(pid); throw new Error('focus refused'); });
  assert.deepEqual(focused, [123]);
  confirmedClient.importAssets = async () => ({ animationResult: { entries: [{ key: 'run', status: 'failed' }] } });
  const failure = await sendAnimationJob([asset], { customLibraryPath: root }, null, confirmedClient, async pid => focused.push(pid));
  assert.equal(failure.ok, false);
  assert.deepEqual(focused, [123]);
  assert.equal(reply.ok, true);
  assert.equal(reply.results[0].status, 'success');
  assert.equal(jobs[0].characterAnimation.animations[0].targetPath, '/Game/Animation/AS_Run01');
  assert.equal(jobs[0].characterAnimation.animations[0].config.enableRootMotion, true);
  await assert.rejects(sendAnimationJob([asset], { customLibraryPath: root, unrealProjectPath: 'D:/Other.uproject' }, null, client(['characterAnimationV1'])), /不一致/);
});

test('action labels are normalized, survive rescans and are searchable', () => {
  assert.deepEqual(parseAnimationLabels('跑， 急停、跑;  slow  run '), ['跑', '急停', 'slow run']);
  assert.deepEqual(parseAnimationLabels(['a', 'A', '']), ['a']);
  const listed = toAssetListRecord({ id: 'run', name: 'AS_Run01', assetType: 'animation', animationLabels: ['跑', '急停'], meta: {} });
  assert.deepEqual(listed.animationLabels, ['跑', '急停']);
  const rebuilt = buildAnimationMetaFromModel(heroClip, listed);
  assert.deepEqual(rebuilt.animationLabels, ['跑', '急停']);
  const document = createSearchDocument(listed);
  assert.ok(document.fields.includes('跑'));
  const index = new AssetSearchIndex();
  index.update([document, { id: 'idle', name: 'AS_Idle01', fields: ['AS_Idle01', 'idle'] }]);
  assert.deepEqual(index.search('跑'), ['run']);
  assert.deepEqual(index.search('jiting'), ['run']);
});

test('a freshly imported clip rescans as one record with its id, labels and game tag', async t => {
  const { writeAnimationIdentitySidecar } = require('../electron/services/animationIdentity');
  const { scanLibrary } = require('../electron/services/assetScanner');
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'anim-scan-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const root = path.join(workspace, 'Library');
  const clip = path.join(root, 'Animation', 'Monster', 'Wolf_01', 'Attack', 'AS_Wolf01_Bite.fbx');
  await fs.mkdir(path.dirname(clip), { recursive: true });
  await fs.writeFile(clip, 'fbx');
  const meta = {
    assetID: 'imported-id', name: 'AS_Wolf01_Bite', animationAffiliation: '怪物', animationLabels: ['咬'],
    animationGameTag: { kind: 'monster', id: 'Monster_Wolf', name: '狼' }, identity: { contentFingerprint: 'abc' }
  };
  await writeAnimationIdentitySidecar(clip, meta);
  const scanMemoPath = path.join(workspace, 'memo.json.gz');
  const animations = records => records.filter(record => record.assetType === 'animation');
  const [first, ...rest] = animations(await scanLibrary(root, { scanMemoPath }));
  assert.equal(rest.length, 0);
  assert.equal(first.id, 'imported-id');
  assert.deepEqual(first.animationLabels, ['咬']);
  assert.deepEqual(first.animationGameTag, { kind: 'monster', id: 'Monster_Wolf', name: '狼' });
  await writeAnimationIdentitySidecar(clip, { ...meta, animationLabels: ['咬', '扑'] });
  const [edited] = animations(await scanLibrary(root, { scanMemoPath }));
  assert.equal(edited.id, 'imported-id');
  assert.deepEqual(edited.animationLabels, ['咬', '扑']);
  const document = createSearchDocument(edited);
  assert.ok(document.fields.includes('狼') && document.fields.includes('Monster_Wolf'));
});

test('UE DataTables provide weapon categories and monsters', async t => {
  const { parseDataTableRows } = require('../electron/services/unrealDataTable');
  const { weaponOptionsFromRows, monsterOptionsFromRows, animationGameTagKind } = require('../shared/animationGameTags.mjs');
  assert.equal(animationGameTagKind('主角'), 'weapon');
  assert.equal(animationGameTagKind('怪物'), 'monster');
  assert.equal(animationGameTagKind('NPC'), '');
  assert.deepEqual(weaponOptionsFromRows([{ name: 'Sword01', values: { WeaponType: 'ESEFVWeaponType::Sword' } }]),
    [{ kind: 'weapon', id: 'Sword01', name: '单手剑', group: 'Sword' }]);
  assert.deepEqual(monsterOptionsFromRows([
    { name: 'Monster_Wolf', values: { CharacterName: '狼', CharacterSubType: 'ActCharacterSubType::NormalMonster' } },
    { name: 'Trap_SpikeTrap', values: { CharacterName: '地刺陷阱', CharacterSubType: 'ActCharacterSubType::InteractObj' } }
  ]), [{ kind: 'monster', id: 'Monster_Wolf', name: '狼', group: 'NormalMonster' }]);
  assert.throws(() => parseDataTableRows(require('node:buffer').Buffer.alloc(128)), /UE/);
  const project = 'E:/Zion_MalinLine/Project';
  const table = path.join(project, 'Content/Config/Battle/Weapon/DT_WeaponCategoryConfig.uasset');
  if (!await fs.stat(table).catch(() => null)) return t.skip('UE project not available');
  const rows = parseDataTableRows(await fs.readFile(table));
  assert.ok(rows.some(row => row.name === 'Unarmed01' && row.values.WeaponType === 'ESEFVWeaponType::UnArmed'));
});
