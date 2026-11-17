const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const sharp = require("sharp");
const { characterGalleryRevision } = require('../shared/characterPreviewRevision.mjs');
const { characterHistorySummary } = require('../shared/characterHistorySummary.mjs');
const { updateCharacterStatus } = require("../electron/services/characterComponents");
const { updateCharacterNames } = require("../electron/services/characterNames");
const { analyzeCharacterModelTriangles, analyzeCharacterMayaTriangles, summarizeCharacterTriangles } = require("../electron/services/characterModelMetrics");

test('suit preview status follows automatic view work and preserves manual directions', () => {
  const { characterSuitPendingPreviewViews } = require('../shared/characterComponents.mjs');
  const asset = { assetType: 'suit', previewImage: 'cover.png', meta: {
    characterComponents: { contentRevision: 'new-sk', previewRevision: 'old', suitPreviewNeedsUpdate: false },
    previews: { images: [] }
  } };
  assert.equal(characterPreviewState(asset), 'current');
  asset.meta.characterComponents.suitPreviewNeedsUpdate = true;
  assert.equal(characterPreviewState(asset), 'stale');
  assert.equal(characterSuitPendingPreviewViews(asset).length, 4);
  asset.meta.previews.images = ['front', 'left', 'right', 'back'].map(view => ({ uri: view + '.png', tags: ['view:' + view, 'origin:manual'] }));
  assert.equal(characterSuitPendingPreviewViews(asset).length, 0);
  assert.equal(characterPreviewState(asset), 'current');
});

test('freshly imported preview revision survives scanner projection and saves without a false conflict', async t => {
  const f = await fixture(t, true);
  const { characterMeshPreviewRevision } = require('../shared/characterComponents.mjs');
  for (const file of f.asset.meta.characterManifest.files) file.sha256 = require('node:crypto').createHash('sha256').update(file.normalizedName).digest('hex');
  f.asset.meta.type = 'suit';
  f.asset.meta.topCategory = 'character';
  f.asset.meta.modelFiles = f.asset.modelFiles;
  await fs.writeFile(f.asset.metaPath, JSON.stringify(f.asset.meta));
  const scanned = await require('../electron/services/assetScanner').getAssetDetailsByMetaPath(f.asset.metaPath);
  const part = listCharacterComponents(scanned)[0];
  assert.ok(part, JSON.stringify(scanned));
  const revision = characterMeshPreviewRevision(part.files, 'staticMesh');
  assert.equal(revision, characterMeshPreviewRevision(listCharacterComponents(f.asset)[0].files, 'staticMesh'));
  const sourcePath = path.join(f.temp, 'view.png');
  await sharp({ create: { width: 16, height: 16, channels: 3, background: '#123456' } }).png().toFile(sourcePath);
  await updateCharacterComponentPreview({ ...f, slot: part.slot, meshKind: 'staticMesh', automatic: true,
    expectedRevision: revision, expectedPreviewUri: part.meshPreviews.staticMesh.previewUri,
    images: ['front', 'left', 'right', 'back'].map(view => ({ view, sourcePath })) });
  assert.equal(listCharacterComponents(await f.reload())[0].meshPreviews.staticMesh.previewImages.length, 4);
});

test('import saves prepared part previews by source identity and leaves the owner cover intact', async t => {
  const f = await fixture(t, true);
  const { saveCharacterImportPreviews } = require('../electron/services/characterImportPreviews');
  const { needsCharacterMeshPreview } = require('../shared/characterComponents.mjs');
  const meta = f.asset.meta;
  const part = listCharacterComponents(f.asset)[0];
  const model = part.files.find(file => file.role === 'model' || file.role === 'staticMesh');
  model.role = 'staticMesh'; model.originalPath = path.join(f.temp, 'arbitrary-original.fbx'); model.sha256 = 'source-hash';
  meta.previewImage = 'custom-cover.png';
  const paths = Object.fromEntries(['front', 'left', 'right', 'back'].map(view => [view, `${view}.png`]));
  let saved = 0;
  await saveCharacterImportPreviews({ meta, assetType: 'suit', destinationDir: f.asset.path,
    previews: [{ sourcePath: model.originalPath, sourceHash: model.sha256, meshKind: 'staticMesh', paths }],
    saveImage: async (_, name) => { saved++; return path.join(f.asset.path, 'Preview', `${name}.png`); } });
  const imported = listCharacterComponents({ ...f.asset, meta })[0];
  assert.equal(saved, 4);
  assert.equal(needsCharacterMeshPreview(imported, 'staticMesh'), false);
  const related = componentAssetRecord({ ...f.asset, meta }, imported);
  assert.equal(related.previewImage, related.meta.componentView.meshSlots.staticMesh.previewPath);
  assert.equal(related.previewImages.length, 4);
  assert.equal(characterPreviewState(related), 'current');
  assert.equal(characterPreviewState({ ...related, meta: { ...related.meta, componentView: { ...related.meta.componentView, visibleMeshKind: 'skeletalMesh' } } }), 'missing');
  model.sha256 = 'updated-model';
  const changed = componentAssetRecord(f.asset, listCharacterComponents(f.asset)[0]);
  assert.equal(characterPreviewState(changed), 'stale');
  model.sha256 = 'source-hash';
  assert.equal(meta.previewImage, 'custom-cover.png');
  await assert.rejects(saveCharacterImportPreviews({ meta, assetType: 'suit', destinationDir: f.asset.path,
    previews: [{ sourcePath: model.originalPath, sourceHash: 'changed', meshKind: 'staticMesh', paths }], saveImage: async () => '' }), /模型在扫描后已变化/);
});

test("character model metrics report triangles, preserve unknown values, and only warn above 300k", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-character-metrics-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const obj = path.join(root, "SK_Test.obj");
  await fs.writeFile(obj, "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n");
  assert.equal(await analyzeCharacterModelTriangles(obj), 2);
  const summary = summarizeCharacterTriangles([
    { role: "model", normalizedName: "SK_Known.obj", triangleCount: 300001 },
    { role: "model", normalizedName: "SK_Unknown.abc", triangleCount: null }
  ]);
  assert.equal(summary.knownTriangleCount, 300001);
  assert.equal(summary.unknownModelCount, 1);
  assert.equal(summary.totalTriangleCount, null);
  assert.equal(summary.overBudget, true);
});

test("character model metrics read triangulated face counts from Maya ASCII", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-character-maya-metrics-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const maya = path.join(root, "Suit.ma");
  await fs.writeFile(maya, [
    'createNode mesh -n "SuitShape";',
    'setAttr -s 2 ".fc[0:1]" -type "polyFaces"',
    '    f 4 0 1 2 3',
    '    f 3 4 5 6',
    '    ;'
  ].join("\n"));
  assert.equal(await analyzeCharacterMayaTriangles(maya), 3);
});

test("confirmed English name renames managed files and preserves Chinese and source identity", async t => {
  const f = await fixture(t, true);
  await require("../electron/services/assetMetadata").updateAssetMetadataFile(f.asset.metaPath, meta => ({ ...meta, modelFiles: f.asset.modelFiles }));
  const original = await f.reload();
  const firstFile = original.meta.characterManifest.files[0];
  firstFile.originalPath = path.join(f.temp, "source", firstFile.originalName);
  await fs.writeFile(f.asset.metaPath, JSON.stringify(original.meta));
  const oldPaths = original.meta.characterManifest.files.map(file => path.join(f.asset.path, file.storedPath));
  const bytes = await Promise.all(oldPaths.map(file => fs.readFile(file)));
  await assert.rejects(updateCharacterNames({ ...f, displayNameZh: '蓑衣女', displayNameEn: 'OfficialOutfit' }), /勾选确认/);
  await assert.rejects(updateCharacterNames({ ...f, displayNameZh: '蓑衣女', displayNameEn: '', nameConfirmed: true }), /英文名/);
  await updateCharacterNames({ ...f, displayNameZh: "蓑衣女", displayNameEn: "OfficialOutfit", nameConfirmed: true, expectedName: "", expectedAssetName: "M01_Heavy001_Stone" });
  const updated = await f.reload();
  assert.equal(updated.meta.character.displayNameZh, "蓑衣女");
  assert.equal(updated.meta.character.displayNameEn, "OfficialOutfit");
  assert.equal(updated.meta.character.suitName, "OfficialOutfit");
  assert.equal(updated.meta.name, "M01_Heavy001_OfficialOutfit");
  const scanned = await require("../electron/services/assetScanner").getAssetDetailsByMetaPath(f.asset.metaPath);
  assert.equal(scanned.meta.character.displayNameZh, "蓑衣女");
  assert.equal(scanned.meta.character.displayNameEn, "OfficialOutfit");
  assert.ok(scanned.meta.character.ueNameSyncPending, 'detail scan must retain the UE rename reminder');
  assert.equal(require("../electron/services/assetListRecord").toAssetListRecord(scanned).meta.character.ueNameSyncPending, scanned.meta.character.ueNameSyncPending);
  assert.equal(scanned.meta.characterDisplaySchema, 1);
  assert.equal(require("../electron/services/assetListRecord").toAssetListRecord(scanned).meta.character.displayNameZh, "蓑衣女");
  assert.equal(updated.meta.characterManifest.fields.displayNameEn, "OfficialOutfit");
  assert.equal(updated.meta.characterManifest.files.every(file => file.normalizedName.includes("M01_Heavy001_OfficialOutfit")), true);
  assert.equal(updated.meta.characterManifest.files[0].originalName, firstFile.originalName);
  assert.equal(updated.meta.characterManifest.files[0].originalPath, firstFile.originalPath);
  assert.equal(updated.meta.createdAt, original.meta.createdAt);
  for (const [index, file] of updated.meta.characterManifest.files.entries()) {
    assert.deepEqual(await fs.readFile(path.join(f.asset.path, file.storedPath)), bytes[index]);
    assert.equal(await fs.stat(oldPaths[index]).then(() => true, () => false), false);
  }
  assert.match(updated.meta.characterUpdateHistory.at(-1).label, /名称更新.*蓑衣女/);
  assert.equal(updated.meta.characterUpdateHistory.at(-1).details.assetName, "M01_Heavy001_OfficialOutfit");
  assert.equal(updated.meta.characterUpdateHistory.at(-1).files.length, updated.meta.characterManifest.files.length);
  const chineseOnly = await updateCharacterNames({ ...f, asset: updated, displayNameZh: '新中文名', displayNameEn: 'OfficialOutfit', nameConfirmed: true,
    expectedName: '蓑衣女', expectedEnglishName: 'OfficialOutfit', expectedAssetName: updated.meta.name });
  assert.equal(chineseOnly.renamedFiles, 0);
  assert.equal((await f.reload()).meta.character.displayNameEn, 'OfficialOutfit');
  await assert.rejects(updateCharacterNames({ ...f, displayNameZh: "中文", displayNameEn: "NewName", nameConfirmed: true, expectedName: "", expectedAssetName: "M01_Heavy001_Stone" }), /资产名称已变化|已变更/);
  await assert.rejects(updateCharacterNames({ ...f, displayNameZh: "PinYin" }), /中文名/);
});

for (const family of ['suit', 'monster', 'npc', 'weapon']) test(`${family} rename keeps rendered previews, active versions and actual UE locations`, async t => {
  const f = await fixture(t, family === 'suit');
  f.asset.assetType = family;
  f.asset.meta.assetType = family;
  const { characterModelPreviewComponents, characterMeshPreviewRevision, needsCharacterMeshPreview, characterSuitPendingPreviewViews } = require('../shared/characterComponents.mjs');
  // Exercise both content hashes and legacy path-based preview signatures.
  f.asset.meta.characterManifest.files[0].sha256 = 'stable-content-hash';
  const images = ['front', 'left', 'right', 'back'].map(view => ({ uri: `Preview/${view}.png`, tags: [`view:${view}`, 'origin:rendered'] }));
  await fs.mkdir(path.join(f.asset.path, 'Preview'));
  for (const image of images) await fs.writeFile(path.join(f.asset.path, image.uri), 'existing image');
  const slots = Object.fromEntries(characterModelPreviewComponents(f.asset).map(part => {
    const kind = family === 'suit' ? 'staticMesh' : 'skeletalMesh';
    return [part.slot, { activeRevision: 'edited-version', revisions: [{ id: 'edited-version', files: part.files, name: part.name }],
      previewUri: images[0].uri, previewImages: images, previewRevision: 'edited-version', previewOrigin: 'rendered',
      meshPreviews: { [kind]: { previewUri: images[0].uri, previewImages: images, previewRevision: characterMeshPreviewRevision(part.files, kind) } } }];
  }));
  f.asset.meta.characterComponents = { slots, contentRevision: 'content-v2', previewRevision: 'content-v2', suitPreviewNeedsUpdate: false, autoPreviewPendingViews: [] };
  f.asset.meta.previews = { images };
  const oldUEPath = `/Game/Actual/${f.asset.name}/Mesh`;
  f.asset.meta.enginePath = oldUEPath;
  const receipts = { project: { targetRoot: oldUEPath, entries: { mesh: { key: 'mesh', lastSuccessPath: oldUEPath, livePath: oldUEPath } } } };
  f.asset.meta.characterUnrealExports = receipts;
  await fs.writeFile(f.asset.metaPath, JSON.stringify(f.asset.meta));
  for (const part of characterModelPreviewComponents(f.asset)) for (const kind of ['staticMesh', 'skeletalMesh']) assert.equal(needsCharacterMeshPreview(part, kind), false);
  await updateCharacterNames({ ...f, displayNameZh: '新角色', displayNameEn: 'NewHero', nameConfirmed: true, expectedName: '' });
  const renamed = await f.reload();
  assert.equal(renamed.meta.characterComponents.contentRevision, 'content-v2');
  assert.equal(renamed.meta.characterComponents.previewRevision, 'content-v2');
  assert.deepEqual(renamed.meta.characterComponents.autoPreviewPendingViews, []);
  assert.deepEqual(characterSuitPendingPreviewViews(renamed), []);
  assert.deepEqual(renamed.meta.previews.images, images);
  assert.equal(renamed.meta.enginePath, oldUEPath);
  assert.deepEqual(renamed.meta.characterUnrealExports, receipts);
  assert.ok(renamed.meta.character.ueNameSyncPending);
  assert.equal(Object.keys(renamed.meta.characterComponents.slots).every(slot => slot.includes('newhero')), true);
  for (const part of characterModelPreviewComponents(renamed)) {
    assert.equal(part.currentRevision, 'edited-version');
    for (const kind of ['staticMesh', 'skeletalMesh']) assert.equal(needsCharacterMeshPreview(part, kind), false, `${family}/${part.slot}/${kind}`);
    for (const image of part.previewImages) assert.equal(await fs.readFile(path.join(renamed.path, image.uri), 'utf8'), 'existing image');
    const kind = family === 'suit' ? 'staticMesh' : 'skeletalMesh';
    part.files[0].sha256 = 'actually-changed-content';
    assert.equal(needsCharacterMeshPreview(part, kind), true);
  }
});

test("status saves only metadata, persists across reload, and rejects stale or invalid requests", async t => {
  const f = await fixture(t);
  const original = await f.reload();
  const modelPath = original.modelFiles[0];
  const bytes = await fs.readFile(modelPath);
  await updateCharacterStatus({ ...f, expectedStatus: "wip", maturity: "needs_rig" });
  let updated = await f.reload();
  assert.equal(updated.meta.character.maturity, "needs_rig");
  assert.equal(updated.meta.characterManifest.maturity, "needs_rig");
  assert.deepEqual(updated.meta.characterManifest.files, original.meta.characterManifest.files);
  assert.equal(updated.meta.character.entityKey, original.meta.character.entityKey);
  assert.equal(updated.meta.createdAt, original.meta.createdAt);
  assert.deepEqual(await fs.readFile(modelPath), bytes);
  await assert.rejects(updateCharacterStatus({ ...f, expectedStatus: "wip", maturity: "approved" }), /其他人/);
  await assert.rejects(updateCharacterStatus({ ...f, expectedStatus: "needs_rig", maturity: "bad" }), /无效/);
  await updateCharacterStatus({ ...f, expectedStatus: "needs_rig", maturity: "approved" });
  updated = await f.reload();
  assert.equal(updated.meta.character.maturity, "approved");
  assert.match(updated.meta.characterUpdateHistory.at(-1).label, /制作状态/);
  await assert.rejects(updateCharacterStatus({ ...f, asset: { ...f.asset, assetType: "animation" }, expectedStatus: "approved", maturity: "wip" }), /不支持/);
});
const { listCharacterComponents, characterDisplayName, characterPreviewState, componentAssetRecord, expandCharacterCards, activeCharacterFiles, needsCharacterComponentPreview } = require("../shared/characterComponents.mjs");
const { prepareComponentReplacement, replaceCharacterComponent, updateCharacterComponentPreview, updateCharacterPreviewGallery, updateCharacterAutomaticPreviews, selectCharacterComponentRevision, resolveCharacterModelFile, resolveCharacterTextureFile } = require("../electron/services/characterComponents");
const { matchCharacterTextureReplacements, prepareCharacterPackageUpdate, updateCharacterPackage, restoreCharacterPackageVersion } = require("../electron/services/characterPackageUpdates");
const { resolveHistorySource, relinkHistorySource } = require("../electron/services/characterUpdateHistory");
const { validateCharacterImport } = require("../electron/services/characterImport");

async function fixture(t, suit = false) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-parts-test-"));
  const root = path.join(temp, "Library");
  const folder = path.join(root, suit ? "Character/Hero/outfit_fixture" : "Character/Monster/fixture");
  await fs.mkdir(folder, { recursive: true });
  const name = suit ? "M01_Heavy001_Stone" : "Test";
  const models = suit ? ["Upbody", "Downbody", "Head", "Arm"].map(part => `SK_${name}_${part}`) : ["SK_Test_01", "SK_Test_01_WP_Axe"];
  const files = models.map(model => ({ originalName: model + ".fbx", normalizedName: model + ".fbx", storedPath: `Mesh/${model}.fbx`, role: suit ? "model" : "skeletalMesh", componentRole: model.includes("_WP_") ? "weapon" : "", componentName: model.includes("_WP_") ? "Axe" : "" }));
  const texture = `T_${suit ? name + "_Upbody" : "Test_01_WP_Axe"}_D.tga`;
  files.push({ originalName: texture, normalizedName: texture, storedPath: `Texture/${texture}`, role: "texture" });
  for (const file of files) { await fs.mkdir(path.dirname(path.join(folder, file.storedPath)), { recursive: true }); await fs.writeFile(path.join(folder, file.storedPath), file.normalizedName); }
  const meta = { assetID: "parent", name, assetType: suit ? "suit" : "monster", category: suit ? "Male_01" : "3_Elite", createdAt: "2026-11-12T00:00:00Z",
    character: suit ? { gender: "Male", bodyCode: "01", suitClass: "Heavy", serial: "001", suitName: "Stone", confirmed: true }
      : { name: "Test", formIds: ["01"], entityKey: "monster:parent", confirmed: true },
    characterManifest: { files, fileCount: files.length }, previews: { images: [] } };
  const metaPath = path.join(folder, "asset_info.json");
  await fs.writeFile(metaPath, JSON.stringify(meta));
  const asset = { id: "parent", name, assetType: meta.assetType, source: "custom", path: folder, metaPath, meta, createdAt: meta.createdAt, modelFiles: files.filter(file => file.role !== "texture").map(file => path.join(folder, file.storedPath)) };
  const reload = async () => ({ ...asset, meta: JSON.parse(await fs.readFile(metaPath, "utf8")) });
  const analyzeModel = async () => {
    const skeletal = !suit;
    return { meshKind: skeletal ? "skeletalMesh" : "staticMesh", hasSkeleton: skeletal, hasSkin: skeletal,
      boneCount: skeletal ? 24 : 0, skinnedMeshCount: skeletal ? 1 : 0 };
  };
  const makeSource = async (selectedFiles, suffix = "-new") => {
    const sourceFolder = await fs.mkdtemp(path.join(temp, "source-"));
    for (const file of selectedFiles) await fs.writeFile(path.join(sourceFolder, file.normalizedName), file.normalizedName + suffix);
    return sourceFolder;
  };
  t.after(async () => {
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.match(path.basename(temp), /^assethive-parts-test-/);
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return { root, temp, asset, reload, makeSource, analyzeModel, note: "测试更新备注" };
}

test('missing suit parts remain upload destinations and can be added later without replacing existing parts', async t => {
  const f = await fixture(t, true);
  const { characterModelUpdateGroups, characterRigProgress } = require('../shared/characterComponents.mjs');
  const { inspectCharacterUpdateInput } = require('../electron/services/characterPackageUpdates');
  f.asset.meta.characterManifest.files = f.asset.meta.characterManifest.files.filter(file => !/_Head\./i.test(file.normalizedName));
  f.asset.modelFiles = f.asset.modelFiles.filter(file => !/_Head\./i.test(file));
  await fs.writeFile(f.asset.metaPath, JSON.stringify(f.asset.meta));
  assert.equal(listCharacterComponents(f.asset).length, 3);
  assert.equal(characterModelUpdateGroups(f.asset).length, 4);
  assert.equal(characterRigProgress(f.asset).needsAttention, true);
  const sourceFolder = await f.makeSource([{ normalizedName: 'working_Head.fbx' }]);
  const inspected = await inspectCharacterUpdateInput({ ...f, sourceFolder });
  assert.deepEqual(inspected.unmatchedFiles, []);
  assert.equal(inspected.replacements.length, 1);
  assert.match(inspected.replacements[0].storedPath, /^__new_character_mesh__:staticMesh:/);
  const options = { ...f, sourceFolder, replacements: inspected.replacements };
  const plan = await prepareCharacterPackageUpdate(options);
  await updateCharacterPackage({ ...options, token: plan.token, confirmWholePackage: true });
  const updated = await f.reload();
  assert.deepEqual(listCharacterComponents(updated).map(part => part.name.split('_').at(-1)), ['Head', 'Upbody', 'Downbody', 'Arm']);
  assert.ok(activeCharacterFiles(updated).some(file => file.normalizedName === 'SM_M01_Heavy001_Stone_Head.fbx'));
  assert.equal(activeCharacterFiles(updated).length, 5);
});

test("detail drop preserves destination identity and rejects invalid mappings", async t => {
  const f = await fixture(t, true);
  const texture = f.asset.meta.characterManifest.files.find(file => file.role === "texture");
  const folder = await f.makeSource([{ normalizedName: "replacement.tga" }]);
  const sourcePath = path.join(folder, "replacement.tga");
  const options = { ...f, sourcePaths: [sourcePath], replacements: [{ sourcePath, storedPath: texture.storedPath }] };
  const plan = await prepareCharacterPackageUpdate(options);
  assert.equal(plan.files[0].normalizedName, texture.normalizedName);
  assert.equal(plan.changes.filter(item => item.status === "retained").length, 4);
  await assert.rejects(prepareCharacterPackageUpdate({ ...options, replacements: [{ sourcePath, storedPath: "../unknown" }] }), /目标/);
  await assert.rejects(prepareCharacterPackageUpdate({ ...options, replacements: [{ sourcePath, storedPath: f.asset.meta.characterManifest.files[0].storedPath }] }), /格式/);
  await assert.rejects(updateCharacterPackage({ ...options, note: "", token: plan.token, confirmWholePackage: true, maturity: "needs_rig", expectedStatus: "wip" }), /备注/);
  await updateCharacterPackage({ ...options, token: plan.token, confirmWholePackage: true, maturity: "needs_rig", expectedStatus: "wip" });
  const updated = await f.reload();
  assert.equal(activeCharacterFiles(updated).length, 5);
  assert.ok(updated.meta.characterUpdateHistory.at(-1).sourcePaths.includes(sourcePath));
  assert.equal(updated.meta.characterUpdateHistory.at(-1).note, "测试更新备注");
  assert.equal(updated.meta.character.maturity, "needs_rig");
  const activeTexture = activeCharacterFiles(updated).find(file => file.normalizedName === texture.normalizedName);
  assert.match(activeTexture.storedPath.replace(/\\/g, "/"), new RegExp(`/Texture/${texture.normalizedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  assert.notEqual(path.resolve(f.asset.path, activeTexture.storedPath), path.resolve(sourcePath));
  assert.equal(await fs.readFile(sourcePath, "utf8"), "replacement.tga-new");
});

test("selective updates expose independent static and skeletal model slots and inspect FBX contents", async t => {
  const f = await fixture(t, true);
  const part = listCharacterComponents(f.asset)[0];
  const folder = await f.makeSource([{ normalizedName: "artist_export.fbx" }]);
  const sourcePath = path.join(folder, "artist_export.fbx");
  const skeletal = async () => ({ meshKind: "skeletalMesh", hasSkeleton: true, hasSkin: true, boneCount: 32, skinnedMeshCount: 1 });
  const plan = await prepareCharacterPackageUpdate({ ...f, slot: part.slot, sourcePaths: [sourcePath],
    replacements: [{ sourcePath, storedPath: "__new_character_mesh__:skeletalMesh" }], analyzeModel: skeletal });
  assert.equal(plan.files[0].role, "skeletalMesh");
  assert.equal(plan.files[0].normalizedName, `SK_${part.name.replace(/^(?:SK|SM)_/i, "")}.fbx`);
  const ownerOptions = { ...f, sourcePaths: [sourcePath], analyzeModel: skeletal,
    replacements: [{ sourcePath, storedPath: `__new_character_mesh__:skeletalMesh:${encodeURIComponent(part.slot)}` }] };
  const ownerPlan = await prepareCharacterPackageUpdate(ownerOptions);
  assert.equal(ownerPlan.files[0].role, "skeletalMesh");
  assert.ok(ownerPlan.retainedFiles.some(file => file.storedPath === part.files.find(file => file.role === "model" || file.role === "staticMesh").storedPath));
  const staticMesh = async () => ({ meshKind: "staticMesh", hasSkeleton: false, hasSkin: false, boneCount: 0, skinnedMeshCount: 0 });
  await assert.rejects(prepareCharacterPackageUpdate({ ...f, slot: part.slot, sourcePaths: [sourcePath],
    replacements: [{ sourcePath, storedPath: "__new_character_mesh__:skeletalMesh" }], analyzeModel: staticMesh }), /不能替换/);
  await updateCharacterPackage({ ...ownerOptions, token: ownerPlan.token, confirmWholePackage: true });
  const updated = await f.reload();
  const updatedPart = listCharacterComponents(updated).find(item => item.slot === part.slot);
  assert.deepEqual(updatedPart.meshKinds, { staticMesh: true, skeletalMesh: true });
  await assert.rejects(prepareCharacterPackageUpdate({ ...ownerOptions, asset: updated }), /已经存在/);
});

test('adding bound models accepts a reviewed plan after preview/history changes but rejects changed model bytes', async t => {
  const f = await fixture(t, true);
  const part = listCharacterComponents(f.asset)[0];
  const folder = await f.makeSource([{ normalizedName: 'artist_bound.fbx' }]);
  const sourcePath = path.join(folder, 'artist_bound.fbx');
  const options = { ...f, sourceFolder: folder, sourcePaths: [sourcePath],
    analyzeModel: async () => ({ meshKind: 'skeletalMesh', hasSkeleton: true, hasSkin: true }),
    replacements: [{ sourcePath, storedPath: `__new_character_mesh__:skeletalMesh:${encodeURIComponent(part.slot)}` }] };
  const plan = await prepareCharacterPackageUpdate(options);
  const meta = JSON.parse(await fs.readFile(f.asset.metaPath, 'utf8'));
  meta.updatedAt = '2099-01-01T00:00:00.000Z';
  meta.characterUpdateHistory = [{ label: '更新预览图' }];
  meta.characterUnrealExports = { checkedAt: meta.updatedAt };
  await fs.writeFile(f.asset.metaPath, JSON.stringify(meta));
  assert.equal((await prepareCharacterPackageUpdate(options)).token, plan.token);
  const bytes = await fs.readFile(sourcePath);
  await fs.writeFile(sourcePath, 'changed source');
  await assert.rejects(updateCharacterPackage({ ...options, token: plan.token, confirmWholePackage: true }), /重新检查/);
  await fs.writeFile(sourcePath, bytes);
  const reviewed = await prepareCharacterPackageUpdate(options);
  await updateCharacterPackage({ ...options, token: reviewed.token, confirmWholePackage: true });
  assert.equal(listCharacterComponents(await f.reload()).find(item => item.slot === part.slot).meshKinds.skeletalMesh, true);
});

test('character inspection accepts background polling and mutation waits for existing work', async () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
  const start = source.indexOf('async function waitForCharacterOperation(');
  const end = source.indexOf('\nasync function previewCustomAssetDeletion(', start);
  const state = { recycleInProgress: false, scanInProgress: true, activeExportCalls: 0, hasActiveBackgroundImport: () => false };
  const wait = new Function('state', `with (state) { ${source.slice(start, end)}; return waitForCharacterOperation; }`)(state);
  await wait(true);
  let finished = false;
  const pending = wait(false).then(() => { finished = true; });
  await new Promise(resolve => globalThis.setTimeout(resolve, 10));
  assert.equal(finished, false);
  state.scanInProgress = false;
  await pending;
  assert.equal(finished, true);
  state.recycleInProgress = true;
  await assert.rejects(wait(true), /删除角色/);
});

test('rigging downloads copy the current whole suit or selected part without changing library files', async t => {
  const f = await fixture(t, true);
  const { downloadCharacterRigFiles } = require('../electron/services/characterRigDownload');
  const [part] = listCharacterComponents(f.asset);
  const before = await fs.readFile(f.asset.metaPath, 'utf8');
  const single = await downloadCharacterRigFiles({ ...f, slot: part.slot, destination: f.temp });
  assert.equal(single.count, 1);
  assert.equal((await fs.readdir(path.join(single.path, 'Models'))).length, 1);
  assert.equal(await fs.stat(path.join(single.path, 'Textures')).catch(() => null), null);
  const whole = await downloadCharacterRigFiles({ ...f, destination: f.temp });
  assert.equal(whole.count, 4);
  assert.equal((await fs.readdir(path.join(whole.path, 'Models'))).length, 4);
  assert.notEqual(whole.path, single.path);
  for (const file of f.asset.meta.characterManifest.files.filter(file => file.role !== 'texture')) {
    const source = await fs.readFile(path.join(f.asset.path, file.storedPath));
    const copy = await fs.readFile(path.join(whole.path, file.role === 'texture' ? 'Textures' : 'Models', file.normalizedName));
    assert.deepEqual(copy, source);
  }
  assert.equal(await fs.readFile(f.asset.metaPath, 'utf8'), before);
  await assert.rejects(downloadCharacterRigFiles({ ...f, destination: f.asset.path }), /资源库以外/);
});

test('SK four-view completion and gallery edits preserve SM and suit images; revisions are independent', async t => {
  const f = await fixture(t, true);
  const { needsCharacterMeshPreview, characterMeshPreviewRevision } = await import('../shared/characterComponents.mjs');
  const meta = f.asset.meta;
  const staticFile = meta.characterManifest.files.find(file => /_Head\.fbx$/.test(file.normalizedName));
  const skFile = { ...staticFile, role: 'skeletalMesh', sha256: 'sk-v1', storedPath: 'Rig/' + staticFile.normalizedName };
  meta.characterManifest.files.push(skFile);
  await fs.mkdir(path.join(f.asset.path, 'Rig'));
  await fs.writeFile(path.join(f.asset.path, skFile.storedPath), 'rigged');
  const part = listCharacterComponents(f.asset)[0];
  meta.characterComponents = { schemaVersion: 1, slots: { [part.slot]: {
    previewUri: 'Preview/good-sm.png', previewOrigin: 'rendered-front', previewRevision: 'initial',
    previewImages: ['front', 'left', 'right', 'back'].map(view => ({ uri: view === 'front' ? 'Preview/good-sm.png' : `Preview/good-sm-${view}.png`, tags: ['preview', `view:${view}`, ...(view === 'front' ? ['cover'] : [])] }))
  } } };
  await fs.writeFile(f.asset.metaPath, JSON.stringify(meta));
  const before = listCharacterComponents(await f.reload())[0];
  assert.equal(needsCharacterMeshPreview(before, 'staticMesh'), false);
  assert.equal(needsCharacterMeshPreview({ ...before, meshPreviews: { ...before.meshPreviews,
    staticMesh: { ...before.meshPreviews.staticMesh, previewImages: before.meshPreviews.staticMesh.previewImages.slice(0, 1) } } }, 'staticMesh'), true);
  assert.equal(needsCharacterMeshPreview(before, 'skeletalMesh'), true);
  const images = [];
  for (const view of ['front', 'left', 'right', 'back']) {
    const sourcePath = path.join(f.temp, `sk_${view}.png`);
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ddd' } }).png().toFile(sourcePath);
    images.push({ view, sourcePath });
  }
  await updateCharacterComponentPreview({ ...f, asset: await f.reload(), slot: part.slot, automatic: true,
    meshKind: 'skeletalMesh', expectedRevision: characterMeshPreviewRevision(before.files, 'skeletalMesh'), expectedPreviewUri: '', images });
  const updated = await f.reload();
  const after = listCharacterComponents(updated)[0];
  assert.deepEqual(updated.meta.previews, meta.previews);
  assert.deepEqual(after.meshPreviews.staticMesh, before.meshPreviews.staticMesh);
  assert.equal(after.meshPreviews.skeletalMesh.previewImages.length, 4);
  assert.equal(needsCharacterMeshPreview(after, 'skeletalMesh'), false);
  const gallery = after.meshPreviews.skeletalMesh.previewImages.map((image, index) => ({ ...image,
    tags: [...image.tags.filter(tag => tag !== 'cover'), ...(index === 1 ? ['cover'] : [])] }));
  await updateCharacterPreviewGallery({ ...f, asset: updated, slot: part.slot, meshKind: 'skeletalMesh',
    expectedRevision: after.meshPreviews.skeletalMesh.previewRevision, images: gallery });
  const edited = listCharacterComponents(await f.reload())[0];
  assert.equal(edited.meshPreviews.skeletalMesh.previewUri, gallery[1].uri);
  assert.deepEqual(edited.meshPreviews.staticMesh, before.meshPreviews.staticMesh);
  const changed = { ...after, files: after.files.map(file => file.role === 'model' ? { ...file, sha256: 'sm-v2' } : file) };
  assert.equal(needsCharacterMeshPreview(changed, 'staticMesh'), true);
  assert.equal(needsCharacterMeshPreview(changed, 'skeletalMesh'), false);
});

test("texture batch matching accepts informal source names and binds unique map semantics to formal targets", async t => {
  const f = await fixture(t, true);
  const normalName = "T_M01_Heavy001_Stone_Upbody_N.tga";
  const normal = { originalName: normalName, normalizedName: normalName, storedPath: `Texture/${normalName}`, role: "texture" };
  f.asset.meta.characterManifest.files.push(normal);
  f.asset.meta.characterManifest.fileCount = f.asset.meta.characterManifest.files.length;
  await fs.writeFile(path.join(f.asset.path, normal.storedPath), "old-normal");
  await fs.writeFile(f.asset.metaPath, JSON.stringify(f.asset.meta));
  const part = listCharacterComponents(await f.reload()).find(part => /Upbody$/.test(part.name));
  const sourceFolder = await fs.mkdtemp(path.join(f.temp, "texture-batch-"));
  const baseColor = path.join(sourceFolder, "Stone_Upbody_BaseColor.tga");
  const sourceNormal = path.join(sourceFolder, "Stone_Upbody_Normal.tga");
  const unrelated = path.join(sourceFolder, "Thumbs.db");
  await fs.writeFile(baseColor, "new-color");
  await fs.writeFile(sourceNormal, "new-normal");
  await fs.writeFile(unrelated, "not-a-texture");
  const match = await matchCharacterTextureReplacements({ ...f, asset: await f.reload(), slot: part.slot, sourceFolder });
  assert.equal(match.replacements.length, 2);
  assert.deepEqual(new Set(match.replacements.map(item => item.storedPath)), new Set(["Texture/T_M01_Heavy001_Stone_Upbody_D.tga", normal.storedPath]));
  assert.deepEqual(match.unmatchedFiles, []);
  assert.deepEqual(match.conflictFiles, []);
  assert.deepEqual(match.excludedFiles, [unrelated]);
  const { inspectCharacterUpdateInput } = require('../electron/services/characterPackageUpdates');
  const wholeDrop = await inspectCharacterUpdateInput({ ...f, sourcePaths: [sourceFolder] });
  assert.equal(wholeDrop.textureOnly, true);
  assert.deepEqual(wholeDrop.replacements, match.replacements);
  const singleDrop = await inspectCharacterUpdateInput({ ...f, slot: part.slot, sourcePaths: [baseColor] });
  assert.equal(singleDrop.textureOnly, true);
  assert.equal(singleDrop.replacements.length, 1);
  const options = { ...f, sourcePaths: wholeDrop.replacements.map(item => item.sourcePath), replacements: wholeDrop.replacements };
  const updatePlan = await prepareCharacterPackageUpdate(options);
  assert.ok(updatePlan.retainedFiles.some(file => file.role === 'model'));
  await updateCharacterPackage({ ...options, token: updatePlan.token, confirmWholePackage: true });
  const after = await f.reload();
  const updatedColor = activeCharacterFiles(after).find(file => file.normalizedName.endsWith('_Upbody_D.tga'));
  assert.equal(await fs.readFile(path.join(after.path, updatedColor.storedPath), 'utf8'), 'new-color');
  assert.equal(await fs.readFile(baseColor, 'utf8'), 'new-color');
  const duplicate = path.join(sourceFolder, 'Stone_Upbody_Albedo.tga');
  await fs.writeFile(duplicate, 'conflicting-color');
  const conflict = await inspectCharacterUpdateInput({ ...f, sourcePaths: [baseColor, duplicate] });
  assert.equal(conflict.conflictFiles.length, 1);
  assert.equal(conflict.replacements.length, 0);
  const model = path.join(sourceFolder, 'SM_Test.fbx');
  await fs.writeFile(model, 'model');
  assert.equal((await inspectCharacterUpdateInput({ ...f, sourcePaths: [model, baseColor], analyzeModel: async () => ({ meshKind: 'staticMesh' }) })).textureOnly, false);
});

test('suit texture updates preserve numbered material groups after the suit is renamed', async t => {
  const f = await fixture(t, true);
  const { inspectCharacterUpdateInput } = require('../electron/services/characterPackageUpdates');
  const sources = [];
  for (const group of ['01', '02']) for (const map of ['D', 'N', 'ORM', 'A']) {
    const name = `T_M01_Heavy001_Stone_Upbody_${group}_${map}.tga`;
    const file = { originalName: name, normalizedName: name, storedPath: `Texture/${name}`, role: 'texture' };
    f.asset.meta.characterManifest.files.push(file);
    await fs.writeFile(path.join(f.asset.path, file.storedPath), 'unchanged');
    const sourcePath = path.join(f.temp, `T_F01_Medium001_ZhouSishi_upbody_${group}_${map}.tga`);
    await fs.writeFile(sourcePath, 'unchanged');
    sources.push(sourcePath);
  }
  await fs.writeFile(f.asset.metaPath, JSON.stringify(f.asset.meta));
  for (const inspect of [inspectCharacterUpdateInput, matchCharacterTextureReplacements]) {
    const result = await inspect({ ...f, sourcePaths: sources });
    assert.deepEqual(result.unmatchedFiles, []);
    assert.deepEqual(result.conflictFiles, []);
    assert.equal(result.replacements.length, 8);
    for (const row of result.replacements) assert.equal(path.basename(row.sourcePath).match(/upbody_(.+)$/i)[1], path.basename(row.storedPath).match(/Upbody_(.+)$/i)[1]);
  }
  const match = await inspectCharacterUpdateInput({ ...f, sourcePaths: sources });
  const plan = await prepareCharacterPackageUpdate({ ...f, sourcePaths: sources, replacements: match.replacements });
  assert.equal(plan.changes.filter(change => change.status === 'unchanged').length, 8);
  const unknown = path.join(f.temp, 'delivery_upbody_03_D.tga');
  await fs.writeFile(unknown, 'unknown-group');
  assert.deepEqual((await inspectCharacterUpdateInput({ ...f, sourcePaths: [unknown] })).unmatchedFiles, [unknown]);
  const newGroup = path.join(f.temp, 'T_F01_Medium001_ZhouSishi_Cape_D.tga');
  await fs.writeFile(newGroup, 'new-cape');
  const addition = await inspectCharacterUpdateInput({ ...f, sourcePaths: [newGroup] });
  assert.deepEqual(addition.unmatchedFiles, [newGroup], 'a new material group needs explicit confirmation');
  assert.equal(addition.rows[0].candidates.length, 1);
  const candidate = addition.rows[0].candidates[0];
  assert.ok(candidate.storedPath.startsWith('__new_character_texture__:'));
  assert.equal(candidate.name, 'T_M01_Heavy001_Stone_Cape_D.tga');
  const addedPlan = await prepareCharacterPackageUpdate({ ...f, sourcePaths: [newGroup], replacements: [{ sourcePath: newGroup, storedPath: candidate.storedPath }] });
  assert.equal(addedPlan.changes.filter(change => change.status === 'added').length, 1);
  assert.equal(addedPlan.changes.filter(change => change.status === 'changed').length, 0);
});

test('batch suit matches all four rigged parts with a different source suit name', async t => {
  const f = await fixture(t, true);
  for (const file of f.asset.meta.characterManifest.files) file.normalizedName = file.normalizedName.replace('_Hand.', '_Head.').replace('_Shoe.', '_Arm.');
  await fs.writeFile(f.asset.metaPath, JSON.stringify(f.asset.meta));
  const { inspectCharacterUpdateInput } = require('../electron/services/characterPackageUpdates');
  const folder = path.join(f.temp, 'bound-result');
  await fs.mkdir(folder);
  for (const part of ['Head', 'Upbody', 'Downbody', 'Arm']) await fs.writeFile(path.join(folder, `SK_F01_Medium001_ZhouSishi_${part}.FBX`), part);
  const analyzeModel = async () => ({ meshKind: 'skeletalMesh', hasSkin: true, skinnedMeshCount: 1 });
  const match = await inspectCharacterUpdateInput({ ...f, sourcePaths: [folder], analyzeModel });
  assert.equal(match.replacements.length, 4);
  assert.equal(new Set(match.replacements.map(row => row.storedPath)).size, 4);
  assert.deepEqual(match.unmatchedFiles, []);
  assert.deepEqual(match.conflictFiles, []);
  const plan = await prepareCharacterPackageUpdate({ ...f, sourcePaths: match.replacements.map(row => row.sourcePath), replacements: match.replacements, analyzeModel });
  assert.equal(plan.files.length, 4);
  assert.equal(plan.retainedFiles.filter(row => ['model', 'staticMesh'].includes(row.role)).length, 4);
});

test('batch update accepts mixed partial models and textures, excludes Maya; precise part targets stay scoped', async t => {
  const f = await fixture(t, true);
  const { inspectCharacterUpdateInput } = require('../electron/services/characterPackageUpdates');
  const sources = await fs.mkdtemp(path.join(f.temp, 'mixed-update-'));
  const model = path.join(sources, 'delivery_Upbody.fbx');
  const texture = path.join(sources, 'delivery_Upbody_BaseColor.tga');
  const maya = path.join(sources, 'working.ma');
  const orm = path.join(sources, 'delivery_Upbody_ORM.tga');
  await fs.writeFile(model, 'updated-model');
  await fs.writeFile(texture, 'updated-color');
  await fs.writeFile(maya, 'working-file');
  await fs.writeFile(orm, 'new-orm');
  const analyzeModel = async () => ({ meshKind: 'staticMesh' });
  const match = await inspectCharacterUpdateInput({ ...f, sourcePaths: [sources], analyzeModel });
  assert.equal(match.replacements.length, 3);
  assert.ok(match.excludedFiles.includes(maya));
  assert.ok(match.replacements.some(item => item.storedPath.startsWith('__new_character_texture__:')));
  assert.deepEqual(match.unmatchedFiles, []);
  const opts = { ...f, sourcePaths: match.replacements.map(item => item.sourcePath), replacements: match.replacements, analyzeModel };
  const plan = await prepareCharacterPackageUpdate(opts);
  assert.equal(plan.files.length, 3);
  assert.equal(plan.retainedFiles.filter(file => file.role === 'model').length, 3);
  const progress = [];
  await updateCharacterPackage({ ...opts, token: plan.token, confirmWholePackage: true,
    onProgress: (percent, message) => progress.push({ percent, message }) });
  const after = await f.reload();
  assert.equal(after.meta.characterComponents.suitPreviewNeedsUpdate, true, 'model updates must queue automatic suit views');
  assert.ok(progress.some(item => item.message.includes('3/3')));
  assert.equal(progress.at(-1).percent, 75);
  assert.ok(progress.every((item, index) => !index || item.percent >= progress[index - 1].percent));
  assert.ok(!activeCharacterFiles(after).some(file => file.normalizedName === 'working.ma'));
  assert.ok(activeCharacterFiles(after).some(file => file.normalizedName === 'T_M01_Heavy001_Stone_Upbody_ORM.tga'));
  assert.equal(await fs.readFile(model, 'utf8'), 'updated-model');
  const parts = listCharacterComponents(after);
  const upper = parts.find(part => /Upbody$/i.test(part.name));
  const other = parts.find(part => part.slot !== upper.slot);
  const arbitrary = path.join(sources, '样本.fbx');
  await fs.writeFile(arbitrary, 'targeted-model');
  const scoped = await inspectCharacterUpdateInput({ ...f, slot: upper.slot, sourcePaths: [arbitrary], analyzeModel });
  assert.equal(scoped.replacements.length, 1);
  assert.ok(scoped.rows[0].candidates.every(item => /Upbody/.test(item.name)));
  await assert.rejects(prepareCharacterPackageUpdate({ ...f, slot: upper.slot, sourcePaths: [arbitrary], analyzeModel,
    replacements: [{ sourcePath: arbitrary, storedPath: other.files.find(file => file.role === 'model').storedPath }] }), /当前部件/);
  const ambiguous = await inspectCharacterUpdateInput({ ...f, sourcePaths: [arbitrary], analyzeModel });
  assert.deepEqual(ambiguous.unmatchedFiles, [arbitrary]);
  const skeletal = await inspectCharacterUpdateInput({ ...f, sourcePaths: [model], analyzeModel: async () => ({ meshKind: 'skeletalMesh', hasSkeleton: true, hasSkin: true }) });
  assert.match(skeletal.replacements[0].storedPath, /^__new_character_mesh__:skeletalMesh:/);
});

test('renamed monster body and owned weapon auto-match by semantic role and mesh kind without target collisions', async t => {
  const f = await fixture(t);
  const { inspectCharacterUpdateInput } = require('../electron/services/characterPackageUpdates');
  const folder = await fs.mkdtemp(path.join(f.temp, 'executioner-update-'));
  const body = path.join(folder, 'SK_ShangExecutor.FBX');
  const weapon = path.join(folder, 'SK_ShangExecutor_Weapon.FBX');
  await fs.writeFile(body, 'body');
  await fs.writeFile(weapon, 'weapon');
  const analyzeModel = async () => ({ meshKind: 'skeletalMesh', hasSkeleton: true, hasSkin: true });
  const matched = await inspectCharacterUpdateInput({ ...f, sourcePaths: [body, weapon], analyzeModel });
  assert.deepEqual(matched.unmatchedFiles, []);
  assert.deepEqual(matched.conflictFiles, []);
  assert.equal(matched.replacements.length, 2);
  assert.equal(new Set(matched.replacements.map(item => item.storedPath)).size, 2);
  assert.match(matched.replacements.find(item => item.sourcePath === body).storedPath, /SK_Test_01\.fbx$/);
  assert.match(matched.replacements.find(item => item.sourcePath === weapon).storedPath, /SK_Test_01_WP_Axe\.fbx$/);

  const secondBody = path.join(folder, 'SK_Executioner.FBX');
  await fs.writeFile(secondBody, 'second-body');
  const occupied = await inspectCharacterUpdateInput({ ...f, sourcePaths: [body, secondBody], analyzeModel });
  assert.equal(occupied.replacements.length, 0);
  assert.equal(occupied.conflictFiles.length, 1);
  assert.deepEqual(new Set(occupied.conflictFiles[0].sourcePaths), new Set([body, secondBody]));

  const secondWeapon = { originalName: 'SK_Test_01_WP_Shield.fbx', normalizedName: 'SK_Test_01_WP_Shield.fbx',
    storedPath: 'Mesh/SK_Test_01_WP_Shield.fbx', role: 'skeletalMesh', componentRole: 'weapon', componentName: 'Shield' };
  f.asset.meta.characterManifest.files.push(secondWeapon);
  await fs.mkdir(path.dirname(path.join(f.asset.path, secondWeapon.storedPath)), { recursive: true });
  await fs.writeFile(path.join(f.asset.path, secondWeapon.storedPath), 'shield');
  await fs.writeFile(f.asset.metaPath, JSON.stringify(f.asset.meta));
  const ambiguous = await inspectCharacterUpdateInput({ ...f, sourcePaths: [weapon], analyzeModel });
  assert.deepEqual(ambiguous.unmatchedFiles, [weapon]);
});

test('monster body face budget prefers SK over matching SM and excludes weapons and LODs', () => {
  const { monsterBodyMetrics } = require('../shared/characterComponents.mjs');
  const metrics = monsterBodyMetrics([
    { normalizedName: 'SM_Executioner.fbx', storedPath: 'Mesh/SM_Executioner.fbx', role: 'staticMesh', triangleCount: 213515 },
    { normalizedName: 'SK_Executioner.fbx', storedPath: 'Mesh/SK_Executioner.fbx', role: 'skeletalMesh', triangleCount: 355605 },
    { normalizedName: 'SK_Executioner_Weapon.fbx', storedPath: 'Mesh/Weapon/SK_Executioner_Weapon.fbx', role: 'skeletalMesh', componentRole: 'weapon', triangleCount: 248000 },
    { normalizedName: 'SK_Executioner_LOD1.fbx', storedPath: 'Mesh/SK_Executioner_LOD1.fbx', role: 'skeletalMesh', triangleCount: 120000 },
  ]);
  assert.deepEqual(metrics, { modelCount: 1, knownTriangleCount: 355605, unknownModelCount: 0,
    totalTriangleCount: 355605, overBudget: true });
});

test('rig upload step completes per part, stays complete for textures, and reopens after static model updates', async t => {
  const f = await fixture(t, true);
  const { characterRigProgress } = require('../shared/characterComponents.mjs');
  const upper = listCharacterComponents(f.asset).find(part => /Upbody$/i.test(part.name));
  const partState = asset => characterRigProgress(componentAssetRecord(asset, listCharacterComponents(asset).find(part => part.slot === upper.slot)));
  assert.equal(partState(f.asset).complete, false);
  assert.equal(partState(f.asset).staticReady, true);
  const sk = path.join(f.temp, 'rig-result.fbx');
  await fs.writeFile(sk, 'rig-v1');
  const skAnalysis = async () => ({ meshKind: 'skeletalMesh', hasSkeleton: true, hasSkin: true });
  let options = { ...f, slot: upper.slot, sourcePaths: [sk], analyzeModel: skAnalysis,
    replacements: [{ sourcePath: sk, storedPath: '__new_character_mesh__:skeletalMesh' }] };
  let plan = await prepareCharacterPackageUpdate(options);
  await updateCharacterPackage({ ...options, token: plan.token, confirmWholePackage: true });
  let updated = await f.reload();
  assert.equal(partState(updated).complete, true);
  assert.equal(updated.meta.characterComponents.suitPreviewNeedsUpdate, false, 'SK-only uploads must not invalidate static suit views');
  assert.equal(characterPreviewState({ ...updated, previewImage: 'existing-suit-view.png' }), 'current', 'SK uploads must not report the unchanged suit views as stale');
  assert.equal(characterRigProgress(updated).uploaded, 1);
  assert.equal(characterRigProgress(updated).complete, false);
  const texture = activeCharacterFiles(updated).find(file => file.role === 'texture');
  const textureSource = path.join(f.temp, 'new-texture.tga');
  await fs.writeFile(textureSource, 'texture-only-update');
  options = { ...f, sourcePaths: [textureSource], replacements: [{ sourcePath: textureSource, storedPath: texture.storedPath }] };
  plan = await prepareCharacterPackageUpdate(options);
  await updateCharacterPackage({ ...options, token: plan.token, confirmWholePackage: true });
  assert.equal(partState(await f.reload()).complete, true);
  const sm = path.join(f.temp, 'changed-model.fbx');
  await fs.writeFile(sm, 'sm-v2');
  options = { ...f, slot: upper.slot, sourcePaths: [sm], analyzeModel: async () => ({ meshKind: 'staticMesh' }) };
  plan = await prepareComponentReplacement(options);
  await replaceCharacterComponent({ ...options, token: plan.token });
  updated = await f.reload();
  assert.equal(partState(updated).stale, 1);
  assert.equal(partState(updated).complete, false);
  assert.equal(partState(updated).pendingReview, 1);
  const { reviewCharacterRig } = require('../electron/services/characterRigReview');
  const { characterRigReviewSignature } = require('../shared/characterComponents.mjs');
  const reviewSignature = asset => characterRigReviewSignature(componentAssetRecord(asset, listCharacterComponents(asset).find(part => part.slot === upper.slot)));
  await assert.rejects(reviewCharacterRig({ ...f, slot: upper.slot, needsRigging: false, expectedRevision: 'old' }), /已更新/);
  await reviewCharacterRig({ ...f, slot: upper.slot, needsRigging: false, expectedRevision: reviewSignature(updated) });
  updated = await f.reload();
  assert.equal(partState(updated).complete, true);
  assert.equal(partState(updated).pendingReview, 0);
  assert.ok(updated.meta.characterUpdateHistory.some(entry => entry.label === '确认无需重新绑定'));
  await fs.writeFile(sm, 'sm-v3');
  options = { ...f, slot: upper.slot, sourcePaths: [sm], analyzeModel: async () => ({ meshKind: 'staticMesh' }) };
  plan = await prepareComponentReplacement(options);
  await replaceCharacterComponent({ ...options, token: plan.token });
  updated = await f.reload();
  assert.equal(partState(updated).pendingReview, 1, 'a later model change must reopen the decision');
  await reviewCharacterRig({ ...f, slot: upper.slot, needsRigging: true, expectedRevision: reviewSignature(updated) });
  updated = await f.reload();
  assert.equal(partState(updated).pendingReview, 0);
  assert.equal(partState(updated).stale, 1);
  await fs.writeFile(sk, 'rig-v2');
  const currentSk = listCharacterComponents(updated).find(part => part.slot === upper.slot).files.find(file => file.role === 'skeletalMesh');
  options = { ...f, slot: upper.slot, sourcePaths: [sk], analyzeModel: skAnalysis,
    replacements: [{ sourcePath: sk, storedPath: currentSk.storedPath }] };
  plan = await prepareCharacterPackageUpdate(options);
  await updateCharacterPackage({ ...options, token: plan.token, confirmWholePackage: true });
  assert.equal(partState(await f.reload()).complete, true);
});

test("suit updates queue automatic four-view refresh and preserve the custom cover", async t => {
  const f = await fixture(t, true);
  const previewDir = path.join(f.asset.path, "Preview");
  await fs.mkdir(previewDir, { recursive: true });
  const meta = f.asset.meta;
  meta.previews = { images: [] };
  for (const view of ["front", "left", "right", "back"]) {
    const uri = `Preview/old_${view}.png`;
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#333" } }).png().toFile(path.join(f.asset.path, uri));
    meta.previews.images.push({ uri, tags: ["preview", `view:${view}`, "origin:auto", ...(view === "front" ? ["cover"] : [])] });
  }
  meta.previewImage = "Preview/old_front.png";
  meta.detailImage = meta.previewImage;
  meta.previews.images[0].tags = meta.previews.images[0].tags.filter(tag => tag !== 'cover');
  meta.previews.images.push({ uri: 'Preview/custom.png', tags: ['preview', 'cover', 'origin:manual'] });
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#eee' } }).png().toFile(path.join(previewDir, 'custom.png'));
  meta.previewImage = 'Preview/custom.png';
  meta.detailImage = meta.previewImage;
  await fs.writeFile(f.asset.metaPath, JSON.stringify(meta));
  const current = await f.reload();
  const texture = current.meta.characterManifest.files.find(file => file.role === "texture");
  const sourceFolder = await f.makeSource([texture]);
  const sourcePaths = [path.join(sourceFolder, texture.normalizedName)];
  const plan = await prepareCharacterPackageUpdate({ ...f, asset: current, sourcePaths });
  await updateCharacterPackage({ ...f, asset: current, sourcePaths, token: plan.token, confirmWholePackage: true });
  const pending = await f.reload();
  assert.equal(pending.meta.characterComponents.autoPreviewPendingViews, undefined);
  assert.equal(pending.meta.characterComponents.suitPreviewNeedsUpdate, true);
  assert.deepEqual(pending.meta.previews, current.meta.previews);
  const images = [];
  for (const view of ['front', 'left', 'right', 'back']) {
    const sourcePath = path.join(f.temp, `new_${view}.png`);
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#777" } }).png().toFile(sourcePath);
    images.push({ sourcePath, view });
  }
  const { updateCharacterPreviewBatch } = require('../electron/services/characterComponents');
  const result = await updateCharacterPreviewBatch({ ...f, asset: pending,
    previewBatch: [{ expectedRevision: pending.meta.characterComponents.contentRevision, images }] });
  assert.deepEqual(result.previewErrors, []);
  const updated = await f.reload();
  assert.equal(updated.meta.characterComponents.autoPreviewPendingViews, undefined);
  assert.equal(updated.meta.characterComponents.previewRevision, updated.meta.characterComponents.contentRevision);
  assert.equal(updated.meta.characterComponents.suitPreviewNeedsUpdate, false);
  assert.ok(updated.meta.previews.images.every(image => !image.uri.includes('old_')));
  assert.equal(updated.meta.previewImage, 'Preview/custom.png');
  assert.deepEqual(updated.meta.previews.images.find(image => image.uri === 'Preview/custom.png'), meta.previews.images.at(-1));
  const stale = await updateCharacterPreviewBatch({ ...f, asset: updated,
    previewBatch: [{ expectedRevision: pending.meta.characterComponents.contentRevision, images }] });
  assert.equal(stale.previewErrors.length, 1, 'already completed batches must not overwrite newer gallery content');
});

test("single texture package update retains models and records component time and external provenance", async t => {
  const f = await fixture(t, true);
  const before = listCharacterComponents(f.asset);
  const texture = f.asset.meta.characterManifest.files.find(file => file.role === "texture");
  const sourceFolder = await f.makeSource([texture]);
  const sourcePaths = [path.join(sourceFolder, texture.normalizedName)];
  const plan = await prepareCharacterPackageUpdate({ ...f, sourcePaths });
  assert.equal(plan.changes.filter(item => item.status === "retained").length, 4);
  await updateCharacterPackage({ ...f, sourcePaths, token: plan.token, confirmWholePackage: true });
  const updated = await f.reload();
  assert.equal(activeCharacterFiles(updated).length, 5);
  const after = listCharacterComponents(updated);
  const changed = after.find(part => part.name.endsWith("Upbody"));
  assert.equal(changed.updatedAt, updated.meta.characterManifest.contentUpdatedAt);
  assert.equal(after.find(part => part.name.endsWith("Downbody")).updatedAt, before.find(part => part.name.endsWith("Downbody")).updatedAt);
  assert.match(updated.meta.characterManifest.lastUpdateSummary, /上装.*贴图更新/);
  const entry = updated.meta.characterUpdateHistory.at(-1);
  assert.deepEqual(entry.sourcePaths, sourcePaths);
  const { resolveHistorySource } = require("../electron/services/characterUpdateHistory");
  assert.equal(await resolveHistorySource(updated, f.root, entry.id, 0), sourcePaths[0]);
  await fs.rename(sourcePaths[0], sourcePaths[0] + ".moved");
  await assert.rejects(resolveHistorySource(updated, f.root, entry.id, 0), /已移动/);
  assert.deepEqual((await f.reload()).meta.characterUpdateHistory.at(-1).sourcePaths, sourcePaths);
});

test("character updates show and exclude files outside the package allowlist", async t => {
  const f = await fixture(t, true);
  const texture = f.asset.meta.characterManifest.files.find(file => file.role === "texture");
  const sourceFolder = await f.makeSource([texture]);
  const ztl = path.join(sourceFolder, "WorkingSculpt.ztl");
  await fs.writeFile(ztl, "source-only");
  const plan = await prepareCharacterPackageUpdate({ ...f, sourceFolder });
  assert.deepEqual(plan.excludedFiles, [ztl]);
  assert.equal(plan.files.some(file => /\.ztl$/i.test(file.sourcePath)), false);
});

test("identity collision scopes separate Hair Face bodies and asset families", () => {
  const { characterIdentity } = require("../electron/services/characterUpdateHistory");
  const fields = { gender: "Male", bodyCode: "01", serial: "001", variant: "Hair" };
  const hair = characterIdentity("suit", fields);
  assert.ok(hair);
  assert.notEqual(hair, characterIdentity("suit", { ...fields, variant: "Face" }));
  assert.notEqual(hair, characterIdentity("suit", { ...fields, gender: "Female" }));
  assert.equal(characterIdentity("suit", { ...fields, serial: "" }), "");
  assert.notEqual(characterIdentity("monster", { name: "Test", formIds: ["01"] }), characterIdentity("monster", { name: "Test", formIds: ["02"] }));
  assert.notEqual(characterIdentity("npc", { category: "Merchant", serial: "001" }), characterIdentity("weapon", { category: "Merchant", serial: "001" }));
});

test("Monster body is the form card; weapon is one part, textures and LODs are not cards", async t => {
  const f = await fixture(t);
  assert.equal(characterDisplayName(f.asset), "SK_Test_01");
  const [part] = listCharacterComponents(f.asset);
  assert.equal(listCharacterComponents(f.asset).length, 1);
  assert.equal(part.role, "weapon");
  assert.equal(part.files.length, 2);
  const card = componentAssetRecord(f.asset, part);
  assert.equal(card.previewImage, null);
  assert.equal(characterPreviewState(card), "missing");
  assert.equal(card.modelFiles.length, 1);
  const second = { ...f.asset, id: "second", meta: { ...f.asset.meta, character: { ...f.asset.meta.character, formIds: ["02"] }, characterManifest: { files: [] } } };
  assert.deepEqual(expandCharacterCards([f.asset, second]).map(item => item.id), ["parent", "second"]);
});

test("Suit has four slots, not one slot per LOD or texture", async t => {
  const f = await fixture(t, true);
  f.asset.meta.characterManifest.files.push({ ...f.asset.meta.characterManifest.files[0], normalizedName: "SK_M01_Heavy001_Stone_Upbody_LOD1.fbx", storedPath: "Mesh/Upbody_LOD1.fbx" });
  assert.equal(listCharacterComponents(f.asset).length, 4);
  const errors = validateCharacterImport({ assetType: "suit", assetName: f.asset.name, category: "Male_01", characterFields: f.asset.meta.character,
    packageFiles: ["Upbody", "Downbody", "Hand", "Shoe", "Head"].map(part => `SK_${f.asset.name}_${part}.fbx`), previewPaths: {} });
  assert.ok(errors.some(error => error.includes("最多 4")));
});

for (const family of ['monster', 'npc']) test(`${family} body and owned weapon isolate resources and four-view galleries`, async t => {
  const f = await fixture(t);
  const { characterModelPreviewComponents, characterMeshAssetRecord, characterMeshPreviewRevision } = require('../shared/characterComponents.mjs');
  f.asset.assetType = family;
  f.asset.meta.assetType = family;
  f.asset.previewImage = 'artist-cover.png';
  await fs.writeFile(f.asset.metaPath, JSON.stringify(f.asset.meta));
  const parts = characterModelPreviewComponents(f.asset);
  assert.equal(parts.length, 2);
  const body = parts.find(part => part.role !== 'weapon');
  const weapon = parts.find(part => part.role === 'weapon');
  assert.equal(body.files.length, 1);
  assert.equal(weapon.files.length, 2);
  assert.equal(expandCharacterCards([f.asset]).length, 1);
  const sourcePath = path.join(f.temp, 'view.png');
  await sharp({ create: { width: 16, height: 16, channels: 3, background: '#123456' } }).png().toFile(sourcePath);
  for (const part of parts) await updateCharacterComponentPreview({ ...f, slot: part.slot, meshKind: 'skeletalMesh', automatic: true,
    expectedRevision: characterMeshPreviewRevision(part.files, 'skeletalMesh'), expectedPreviewUri: '',
    images: ['front', 'left', 'right', 'back'].map(view => ({ view, sourcePath })) });
  const updated = await f.reload();
  const cards = characterModelPreviewComponents(updated).map(part => characterMeshAssetRecord(updated, part, 'skeletalMesh'));
  for (const card of cards) {
    assert.equal(card.previewImages.length, 4);
    assert.equal(card.modelFiles.length, 1);
    assert.equal(card.meta.componentView.visibleMeshKind, 'skeletalMesh');
  }
  assert.notEqual(cards[0].previewImage, cards[1].previewImage);
  assert.equal(updated.previewImage, 'artist-cover.png');
  assert.equal(characterMeshAssetRecord(updated, characterModelPreviewComponents(updated)[0], 'staticMesh').previewImage, null);
  const sourceFolder = await f.makeSource(body.files);
  const plan = await prepareCharacterPackageUpdate({ ...f, asset: updated, slot: body.slot, sourceFolder });
  assert.ok(plan.files.length > 0);
  assert.ok(plan.files.every(file => !file.normalizedName.includes('_WP_')));
});

test("Suit parts and cards follow Head, Upbody, Downbody, Arm without changing the source manifest", async t => {
  const f = await fixture(t, true);
  const files = ["Arm", "Downbody", "Head", "Upbody"].map(part => ({ role: "model", normalizedName: `SK_${f.asset.name}_${part}.fbx`, storedPath: `Mesh/${part}.fbx` }));
  f.asset.meta.characterManifest.files = files;
  const original = JSON.stringify(files);
  const expected = ["Head", "Upbody", "Downbody", "Arm"];
  assert.deepEqual(listCharacterComponents(f.asset).map(part => part.name.split("_").at(-1)), expected);
  assert.deepEqual(expandCharacterCards([f.asset]).slice(1).map(part => part.name.split("_").at(-1)), expected);
  assert.equal(JSON.stringify(files), original);
});

test("part replacement retains original bytes and switches only the selected slot", async t => {
  const f = await fixture(t, true);
  const part = listCharacterComponents(f.asset).find(part => /Upbody$/.test(part.name));
  const sourceFolder = await f.makeSource(part.files);
  const options = { ...f, slot: part.slot, sourceFolder };
  const plan = await prepareComponentReplacement(options);
  assert.ok(plan.changes.some(item => item.status === "changed"));
  await replaceCharacterComponent({ ...options, token: plan.token });
  const updated = await f.reload();
  const parts = listCharacterComponents(updated).sort((a, b) => Number(b.slot === part.slot) - Number(a.slot === part.slot));
  assert.notEqual(parts[0].currentRevision, "initial");
  assert.equal(parts[1].currentRevision, "initial");
  assert.equal(await fs.readFile(path.join(f.asset.path, part.files[0].storedPath), "utf8"), part.files[0].normalizedName);
  assert.equal(parts[0].revisions.length, 2);
  assert.match(updated.meta.identity.contentFingerprint, /^sha256:/);
  assert.equal(updated.meta.importHistory.at(-1).nextFingerprint, updated.meta.identity.contentFingerprint);
  assert.ok(updated.meta.modelFiles.some(file => file.includes("Parts")));
  assert.equal(updated.meta.textureEntries[0].textureType, "Diffuse");
  assert.equal(activeCharacterFiles(updated).filter(file => file.storedPath.startsWith("Parts/")).length, 2);
  await selectCharacterComponentRevision({ ...f, asset: updated, slot: part.slot, expectedRevision: parts[0].currentRevision, revisionId: "initial" });
  assert.equal(listCharacterComponents(await f.reload())[0].currentRevision, "initial");
  assert.ok(!(await f.reload()).meta.modelFiles.some(file => file.includes("Parts")));
  assert.notEqual((await f.reload()).meta.identity.contentFingerprint, updated.meta.identity.contentFingerprint);
});

test("whole Suit update keeps four slots and hashes LODs under their parent model", async t => {
  const f = await fixture(t, true);
  const sourceFolder = await f.makeSource([...f.asset.meta.characterManifest.files, {
    normalizedName: "SK_M01_Heavy001_Stone_Upbody_LOD1.fbx"
  }]);
  const plan = await prepareCharacterPackageUpdate({ ...f, sourceFolder });
  await updateCharacterPackage({ ...f, sourceFolder, token: plan.token, confirmWholePackage: true });
  const updated = await f.reload();
  assert.equal(listCharacterComponents(updated).length, 4);
  assert.equal(Object.keys(updated.meta.modelSlots).length, 4);
  assert.equal(updated.meta.modelLods.length, 1);
  assert.equal(Object.keys(updated.meta.identity.modelFingerprints).length, 4);
  assert.equal(updated.meta.modelLods[0].lod, 1);
  assert.equal(updated.meta.assetID, f.asset.id);
});

test("same-library file updates and rollback keep source identity but refresh content identity", async t => {
  const f = await fixture(t);
  const before = f.asset.meta;
  before.identity = { sourceAssetId: "external-fixture", contentFingerprint: "sha256:old-fixture" };
  await fs.writeFile(f.asset.metaPath, JSON.stringify(before));
  const sourceFolder = await f.makeSource(before.characterManifest.files);
  const plan = await prepareCharacterPackageUpdate({ ...f, sourceFolder });
  await updateCharacterPackage({ ...f, sourceFolder, token: plan.token, confirmWholePackage: true });
  const updated = await f.reload();
  assert.equal(updated.meta.identity.sourceAssetId, "external-fixture");
  assert.notEqual(updated.meta.identity.contentFingerprint, "sha256:old-fixture");
  await restoreCharacterPackageVersion({ ...f, asset: updated, revisionId: updated.meta.characterPackageHistory[0].id, expectedRevision: updated.meta.characterComponents.contentRevision });
  const restored = await f.reload();
  assert.equal(restored.meta.identity.sourceAssetId, "external-fixture");
  assert.notEqual(restored.meta.identity.contentFingerprint, updated.meta.identity.contentFingerprint);
});

test("Monster weapon replacement accepts arbitrary upload names but rejects duplicate models and mismatched textures", async t => {
  const f = await fixture(t);
  const [part] = listCharacterComponents(f.asset);
  const renamedFolder = await f.makeSource([{ normalizedName: "SK_Other_01_WP_Axe.fbx" }]);
  const renamed = await prepareComponentReplacement({ ...f, slot: part.slot, sourceFolder: renamedFolder });
  assert.equal(renamed.files.find(file => file.normalizedName.endsWith(".fbx")).normalizedName, part.name + ".fbx");
  for (const names of [["SK_Test_01_WP_Axe.fbx", "SK_Test_01_WP_Axe_final.fbx"], ["SK_Test_01_WP_Axe.fbx", "T_Test_02_WP_Axe_D.tga"]]) {
    const sourceFolder = await f.makeSource(names.map(normalizedName => ({ normalizedName })));
    await assert.rejects(prepareComponentReplacement({ ...f, slot: part.slot, sourceFolder }));
  }
});

test("unchanged parts do not create a version and stale confirmation cannot publish", async t => {
  const f = await fixture(t);
  const [part] = listCharacterComponents(f.asset);
  const sourceFolder = await f.makeSource(part.files, "");
  const plan = await prepareComponentReplacement({ ...f, slot: part.slot, sourceFolder });
  assert.equal(plan.unchanged, true);
  assert.equal((await replaceCharacterComponent({ ...f, slot: part.slot, sourceFolder, token: plan.token })).unchanged, true);
  await fs.writeFile(path.join(sourceFolder, part.files[0].normalizedName), "changed-after-preview");
  await assert.rejects(replaceCharacterComponent({ ...f, slot: part.slot, sourceFolder, token: plan.token }), /变化/);
  assert.equal((await f.reload()).meta.characterComponents, undefined);
});

test("manual preview is independent and becomes stale after part update", async t => {
  const f = await fixture(t);
  const [part] = listCharacterComponents(f.asset);
  const image = path.join(f.temp, "preview.png");
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "#444" } }).png().toFile(image);
  await updateCharacterComponentPreview({ ...f, slot: part.slot, expectedRevision: "initial", previewPath: image });
  assert.equal(listCharacterComponents(await f.reload())[0].previewState, "current");
  await updateCharacterComponentPreview({ ...f, expectedRevision: "initial", previewPath: image });
  const sourceFolder = await f.makeSource(part.files);
  const plan = await prepareComponentReplacement({ ...f, slot: part.slot, sourceFolder });
  await replaceCharacterComponent({ ...f, slot: part.slot, sourceFolder, token: plan.token });
  const updated = await f.reload();
  assert.equal(listCharacterComponents(updated)[0].previewState, "stale");
  assert.equal(characterPreviewState({ ...updated, previewImage: "present.png" }), "stale");
});

test("automatic front covers refresh generated versions but never overwrite manual previews", async t => {
  const f = await fixture(t);
  const [part] = listCharacterComponents(f.asset);
  assert.equal(needsCharacterComponentPreview(part), true);
  const previewPath = path.join(f.temp, "front.png");
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "#444" } }).png().toFile(previewPath);
  const options = { ...f, slot: part.slot, previewPath, expectedRevision: "initial" };
  await updateCharacterComponentPreview({ ...options, automatic: true, expectedPreviewUri: "" });
  const generated = listCharacterComponents(await f.reload())[0];
  assert.equal(generated.previewOrigin, "rendered-front");
  assert.equal(needsCharacterComponentPreview(generated), false);
  const sourceFolder = await f.makeSource(part.files);
  const plan = await prepareComponentReplacement({ ...f, slot: part.slot, sourceFolder });
  await replaceCharacterComponent({ ...f, slot: part.slot, sourceFolder, token: plan.token });
  const changed = listCharacterComponents(await f.reload())[0];
  assert.equal(needsCharacterComponentPreview(changed), true);
  await assert.rejects(updateCharacterComponentPreview({ ...options, automatic: true, expectedRevision: changed.currentRevision, expectedPreviewUri: "wrong" }), /变化/);
  await updateCharacterComponentPreview({ ...options, expectedRevision: changed.currentRevision });
  const manual = listCharacterComponents(await f.reload())[0];
  assert.equal(manual.previewOrigin, "manual");
  await assert.rejects(updateCharacterComponentPreview({ ...options, expectedRevision: changed.currentRevision, automatic: true, expectedPreviewUri: manual.previewUri }), /不覆盖/);
  assert.equal(listCharacterComponents(await f.reload())[0].previewUri, manual.previewUri);
});

test("character card keeps real hover name without copy controls; detail name is selectable and copyable", async () => {
  const source = await fs.readFile(path.join(__dirname, "../src/ui/App.tsx"), "utf8");
  const card = source.slice(source.indexOf("const AssetCard = memo"), source.indexOf("const AssetCard = memo") + source.slice(source.indexOf("const AssetCard = memo")).indexOf("{savingProgress >= 0 && ("));
  assert.ok(card.includes('className="character-card-name"'));
  assert.ok(card.includes('title={cardAssetName}'));
  assert.ok(!card.includes('card-name-copy'));
  assert.ok(!card.includes('onCopyName'));
  for (const control of ["character-card-chips", "character-update-btn", "cardParts.map", "返回主体", "待补预览"]) assert.ok(!card.includes(control), control);
  assert.ok(!source.includes('t("删除整套及所属部件", "Delete Package and Its Parts")'));
  assert.ok(card.includes('characterInfo.family === "monster" && !componentView'));
  assert.ok(card.includes('className="character-card-category"'));
  assert.ok(source.includes('<div className="character-part-fullname"><span>{part.name}</span></div>'));
  assert.ok(source.includes('className="detail-name-copy"'));
  assert.ok(source.includes('copyAssetName(characterDisplayName(selectedAsset))'));
  assert.ok(!source.includes('copyCharacterPartName'));
  assert.ok(!source.includes('Package Files and Archive Paths'));
});

test("character preview gallery locks four directional slots, deletes extras, and moves the cover atomically", async t => {
  const f = await fixture(t, true);
  const previewDir = path.join(f.asset.path, "Preview");
  await fs.mkdir(previewDir, { recursive: true });
  for (const name of ["front.png", "left.png", "right.png", "back.png", "custom.png"]) {
    await sharp({ create: { width: 12, height: 12, channels: 3, background: name === "front.png" ? "#336699" : "#996633" } }).png().toFile(path.join(previewDir, name));
  }
  const meta = (await f.reload()).meta;
  meta.previews = { images: [
    { uri: "Preview/front.png", tags: ["preview", "view:front", "cover"] },
    { uri: "Preview/left.png", tags: ["preview", "view:left"] },
    { uri: "Preview/right.png", tags: ["preview", "view:right"] },
    { uri: "Preview/back.png", tags: ["preview", "view:back"] },
    { uri: "Preview/custom.png", tags: ["preview"] }
  ] };
  meta.previewImage = "Preview/front.png";
  meta.detailImage = "Preview/front.png";
  await fs.writeFile(f.asset.metaPath, JSON.stringify(meta));
  const replacement = path.join(f.temp, "replacement.png");
  await sharp({ create: { width: 16, height: 10, channels: 3, background: "#229944" } }).png().toFile(replacement);
  const expectedRevision = characterGalleryRevision(meta);
  // A background UE status write must not invalidate an open gallery.
  meta.updatedAt = new Date().toISOString();
  meta.characterUnrealExports = { project: { checkedAt: meta.updatedAt } };
  await fs.writeFile(f.asset.metaPath, JSON.stringify(meta));
  await updateCharacterPreviewGallery({ ...f, asset: await f.reload(), expectedRevision, images: [
    { uri: "Preview/front.png", tags: ["preview", "view:front"] },
    { uri: "Preview/left.png", sourcePath: replacement, tags: ["preview", "view:left", "cover"] },
    { uri: "Preview/right.png", tags: ["preview", "view:right"] },
    { uri: "Preview/back.png", tags: ["preview", "view:back"] }
  ] });
  const updated = await f.reload();
  assert.equal(updated.meta.previews.images.length, 4);
  assert.equal(updated.meta.previews.images[0].uri, "Preview/front.png");
  assert.equal(updated.meta.previews.images[1].tags.includes("view:left"), true);
  assert.equal(updated.meta.previews.images[1].tags.includes("cover"), true);
  assert.equal(updated.meta.previewImage, updated.meta.previews.images[1].uri);
  assert.equal(updated.meta.characterUpdateHistory.at(-1).label, "预览图库更新");
  assert.equal(await fs.stat(path.join(f.asset.path, updated.meta.previewImage)).then(() => true), true);
  assert.equal(await fs.stat(path.join(previewDir, "custom.png")).then(() => true, () => false), false);
  assert.equal(await fs.stat(replacement).then(() => true), true);
  const coverImages = updated.meta.previews.images.map((image, index) => ({ ...image, tags: [...image.tags.filter(tag => tag !== 'cover'), ...(index === 2 ? ['cover'] : [])] }));
  const coverBytes = await fs.readFile(path.join(f.asset.path, coverImages[2].uri));
  await updateCharacterPreviewGallery({ ...f, asset: updated, expectedRevision: characterGalleryRevision(updated.meta), images: coverImages });
  const afterCover = await f.reload();
  assert.equal(afterCover.meta.previewImage, coverImages[2].uri);
  assert.equal(afterCover.meta.characterUpdateHistory.at(-1).label, '更换主图');
  assert.deepEqual(await fs.readFile(path.join(f.asset.path, coverImages[2].uri)), coverBytes);
  await assert.rejects(updateCharacterPreviewGallery({ ...f, asset: updated, expectedRevision: characterGalleryRevision(updated.meta), images: updated.meta.previews.images }), /预览图库已变化/);
  await assert.rejects(updateCharacterPreviewGallery({ ...f, asset: updated, expectedRevision: updated.meta.characterComponents.previewGalleryRevision, images: updated.meta.previews.images.slice(0, 3) }), /四个预览槽位/);
});

test('history summaries describe the actual operation and preserve user notes', () => {
  assert.equal(characterHistorySummary({ label: '资源更新', files: [{ name: 'T_Test_D.tga' }] }), '更新贴图');
  assert.equal(characterHistorySummary({ label: '上装资源更新', files: [{ name: 'SM_Test.fbx' }, { name: 'T_Test_D.tga' }] }), '上装 · 更新模型和贴图');
  assert.equal(characterHistorySummary({ label: '资源更新', note: '调整袖口', files: [{ name: 'SM_Test.fbx' }] }), '更新模型');
  assert.equal(characterHistorySummary({ label: '发送到 UE', note: '过时的上次备注', changes: [{ name: 'T_Test_D', status: 'success', action: 'restore' }, { name: 'SM_Test', status: 'unchanged' }] }), '重新导入贴图到 UE');
  assert.equal(characterHistorySummary({ label: '模型类型规范化：Static / SM' }), '整理静态模型命名（SM）');
  assert.equal(characterHistorySummary({ label: '检测到 UE 资源删除', files: [{ name: 'SM_Test', status: 'missing' }] }), 'UE 中的模型已删除');
});

test("component preview gallery uses the same four locked slots as parent assets", async t => {
  const f = await fixture(t, true);
  const part = listCharacterComponents(f.asset)[0];
  const images = [];
  for (const view of ["front", "left", "right", "back"]) {
    const sourcePath = path.join(f.temp, `${view}.png`);
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#556677" } }).png().toFile(sourcePath);
    images.push({ sourcePath, tags: ["preview", `view:${view}`, ...(view === "front" ? ["cover"] : [])] });
  }
  await updateCharacterPreviewGallery({ ...f, slot: part.slot, expectedRevision: part.currentRevision, images });
  const updated = await f.reload();
  const updatedPart = listCharacterComponents(updated).find(item => item.slot === part.slot);
  assert.equal(updatedPart.previewImages.length, 4);
  assert.equal(updatedPart.previewUri, updatedPart.previewImages[0].uri);
});

test("outfit history keeps external source paths and can relink a missing source without pointing into the library", async t => {
  const f = await fixture(t, true);
  const meta = (await f.reload()).meta;
  meta.characterUpdateHistory = [{ id: "history-1", at: new Date().toISOString(), label: "上装资源更新", sourcePaths: [path.join(f.temp, "missing.fbx")] }];
  await fs.writeFile(f.asset.metaPath, JSON.stringify(meta));
  const replacement = path.join(f.temp, "moved.fbx");
  await fs.writeFile(replacement, "source");
  await relinkHistorySource({ ...f, asset: await f.reload(), historyId: "history-1", sourceIndex: 0, sourcePath: replacement });
  const updated = await f.reload();
  assert.equal(updated.meta.characterUpdateHistory[0].sourcePaths[0], replacement);
  assert.equal(updated.meta.characterUpdateHistory.at(-1).label, "历史来源重新定位");
  assert.equal(await resolveHistorySource(updated, f.root, "history-1", 0), replacement);
  await assert.rejects(relinkHistorySource({ ...f, asset: updated, historyId: "history-1", sourceIndex: 0, sourcePath: path.join(f.asset.path, updated.meta.characterManifest.files[0].storedPath) }), /管理副本/);
});

test("preview manager exposes every image with delete, replace, selection, and set-cover controls", async () => {
  const source = await fs.readFile(path.join(__dirname, "../src/ui/App.tsx"), "utf8");
  assert.ok(source.includes('className="character-preview-manager-grid"'));
  assert.ok(source.includes('className="character-preview-manager-delete"'));
  assert.ok(source.includes('replaceCharacterPreviewManagerImage(image.id)'));
  assert.ok(source.includes('setCharacterPreviewManagerCover'));
  assert.ok(source.includes('addCharacterPreviewManagerImage'));
  assert.ok(source.includes('t("＋ 加入新图片", "+ Add New Image")'));
  assert.ok(!source.includes('if (!image && view === "front")'));
  assert.ok(source.includes('bridge.updateCharacter("updateCharacterGallery"'));
});

test("outfit header opens chronological external-source history with relink controls", async () => {
  const source = await fs.readFile(path.join(__dirname, "../src/ui/App.tsx"), "utf8");
  assert.ok(source.includes('className="character-history-open"'));
  assert.ok(source.includes('t("更新历史", "Update History")'));
  assert.ok(source.includes('bridge.updateCharacter("relinkCharacterHistory"'));
  assert.ok(source.includes('className="character-last-update-row"'));
  assert.ok(source.includes('className="character-name-edit"'));
  assert.ok(source.includes('bridge.updateCharacter("updateCharacterNames"'));
  assert.ok(source.includes('t("我已核对中文名和英文名", "I have checked the Chinese and English names")'));
  assert.ok(!source.includes('t("整套历史版本（包含当时的部件关联）"'));
});

test("model filenames wrap in full above a separate location action", async () => {
  const source = await fs.readFile(path.join(__dirname, "../src/ui/App.tsx"), "utf8");
  const css = await fs.readFile(path.join(__dirname, "../src/ui/styles.css"), "utf8");
  const filename = css.match(/\.character-model-filename\s*\{([^}]+)\}/)[1];
  const action = css.match(/\.character-model-action\s*\{([^}]+)\}/)[1];
  assert.match(filename, /white-space:\s*normal/);
  assert.match(filename, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(filename, /ellipsis|overflow:\s*hidden/);
  assert.match(action, /grid-column:\s*2/);
  assert.match(action, /justify-self:\s*start/);
  assert.ok(source.includes('t("打开位置", "Show in Folder")'));
});

test("part full names align with short names through shared grid columns and remain selectable", async () => {
  const css = await fs.readFile(path.join(__dirname, "../src/ui/styles.css"), "utf8");
  assert.match(css, /\.character-part-entry\s*\{[^}]*display:\s*grid/);
  assert.match(css, /\.character-part-entry \.character-part-link\s*\{[^}]*grid-template-columns:\s*subgrid/);
  assert.match(css, /\.character-part-fullname\s*\{[^}]*grid-column:\s*2\s*\/\s*-1/);
  assert.match(css, /\.character-part-fullname > span\s*\{[^}]*user-select:\s*text/);
});

test("expanded texture filenames have a quiet location action without truncation", async () => {
  const source = await fs.readFile(path.join(__dirname, "../src/ui/App.tsx"), "utf8");
  const css = await fs.readFile(path.join(__dirname, "../src/ui/styles.css"), "utf8");
  assert.ok(source.includes('<span className="character-texture-file-action">{t("打开位置", "Show in Folder")}</span>'));
  assert.match(css, /\.character-texture-file-name\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.character-texture-file-action\s*\{[^}]*white-space:\s*nowrap/);
});

test("character update actions precede facts; owner navigation sits beside part update and deletion stays in the context menu", async () => {
  const source = await fs.readFile(path.join(__dirname, "../src/ui/App.tsx"), "utf8");
  const detail = source.slice(source.indexOf('className="detail-list character-detail"'), source.indexOf('className="bottom-actions"', source.indexOf('className="detail-list character-detail"')));
  assert.ok(detail.indexOf('openCharacterUpdate(selectedAsset)') < detail.indexOf('t("角色资产结构"'));
  assert.ok(detail.includes('t("更新此资产", "Update This Asset")'));
  assert.ok(detail.indexOf('openCharacterUpdate(selectedAsset)') < detail.indexOf('changeCharacterPreview(selectedAsset)'));
  assert.equal(detail.split('changeCharacterPreview(selectedAsset)').length - 1, 1);
  assert.ok(!detail.includes('selectedPartView && <button className="browse-btn" disabled={busy} onClick={() => { void changeCharacterPreview'));
  assert.ok(detail.indexOf('t("返回套装"') > detail.indexOf('openCharacterUpdate(selectedAsset)'));
  assert.ok(detail.indexOf('t("返回套装"') < detail.indexOf('t("角色资产结构"'));
  assert.ok(detail.indexOf('t("返回套装"') < detail.indexOf('t("相关资产"'));
  assert.ok(!detail.includes('deleteCustomAsset('));
  assert.ok(source.includes('deleteCustomAsset(target)'));
  assert.ok(source.includes('target.meta?.componentView || componentParentId(target.id) !== target.id'));
});

test("character update dialog separates batch inspection from targeted managed replacements", async () => {
  const source = await fs.readFile(path.join(__dirname, "../src/ui/App.tsx"), "utf8");
  const css = await fs.readFile(path.join(__dirname, "../src/ui/styles.css"), "utf8");
  assert.ok(source.includes('"Batch Update"'));
  assert.ok(source.includes('"Targeted Update"'));
  assert.ok(source.includes('"Model Files (Static)"'));
  assert.ok(source.includes('"Model Files (Skeletal)"'));
  assert.ok(source.includes('"Material / Texture Files"'));
  assert.ok(source.includes('"Choose Files"'));
  assert.ok(source.includes('"Batch Match Textures"'));
  assert.ok(!source.includes('"Choose Texture Folder"'));
  assert.ok(!source.includes('"Choose Whole Folder and Inspect"'));
  assert.ok(source.includes('className="character-update-intro"'));
  assert.match(css, /\.character-update-intro\s*\{[^}]*font-size:\s*11px/);
  assert.match(css, /\.character-update-drop\s*\{[^}]*flex-direction:\s*column/);
  assert.ok(source.includes('t("套装规格/编号", "Suit Spec / Serial")'));
  assert.match(css, /\.character-detail-facts > span\s*\{[^}]*min-height:\s*50px/);
  assert.match(css, /\.character-status-select \.dark-select-trigger\s*\{[^}]*height:\s*20px/);
  assert.ok(source.includes('className={enginePath ? "character-engine-path" : "character-engine-path character-engine-not-imported"}'));
  assert.ok(source.includes('className="character-engine-copy" disabled={!enginePath}'));
  assert.match(css, /\.character-engine-path\s*\{[^}]*user-select:\s*text/);
  assert.ok(source.includes('"Needs Assignment"'));
  assert.ok(source.includes('"Conflicts"'));
  assert.ok(source.includes('"Any source name or location; confirmation writes to the formal managed path"'));
  assert.ok(source.includes('setCharacterUpdateSections([])'));
  assert.ok(source.includes('setCharacterUpdateMode(componentUpdate ? "selective" : "whole")'));
  assert.ok(source.includes('setCharacterUpdateSelectedFiles([])'));
  assert.ok(source.includes('toggleCharacterUpdateSectionFiles'));
  assert.ok(source.includes('character-update-select-all'));
  assert.ok(source.includes('characterUpdateNote.trim()'));
  assert.ok(source.includes('更新备注 · 必填'));
  assert.ok(source.includes('__new_character_mesh__:${role}'));
  assert.ok(source.includes('!characterUpdateTarget.meta.componentView && <div className="character-update-maturity"'));
  assert.ok(source.includes('className="character-preview-reloading">reloading</div>'));
  assert.ok(source.includes('"origin:manual"'));
  assert.ok(!source.includes('New Preview (Optional)'));
});

test("character component cards render existing previews directly with independent SM and SK slot hover", async () => {
  const source = await fs.readFile(path.join(__dirname, "../src/ui/App.tsx"), "utf8");
  const css = await fs.readFile(path.join(__dirname, "../src/ui/styles.css"), "utf8");
  assert.ok(source.includes('const slotLabel = kind === "staticMesh" ? "SM" : "SK"'));
  assert.ok(source.includes('className={`character-component-mesh-card${slot?.hasModel ? " populated" : " empty"}${meshSelected ? " mesh-selected" : ""}`}'));
  assert.ok(source.includes('cardAssetName.replace(/^(?:SM|SK)_/i, `${slotLabel}_`)'));
  assert.ok(source.includes('className="character-component-mesh-tag"'));
  assert.ok(source.includes('className="character-component-mesh-name"'));
  assert.ok(source.includes('className="loaded character-component-mesh-preview" src={getPreviewUrl(slotPath)}'));
  assert.match(css, /\.character-component-mesh-card:hover\s*\{[^}]*border-color:\s*#2da8ff/);
  assert.match(css, /\.character-component-mesh-tag\s*\{[^}]*min-width:\s*28px[^}]*font-size:\s*10px/);
  assert.match(css, /img\.character-component-mesh-preview\s*\{[^}]*opacity:\s*1/);
});

test("model location resolves the active library version, not original import files or superseded models", async t => {
  const f = await fixture(t);
  const [part] = listCharacterComponents(f.asset);
  assert.equal(await resolveCharacterModelFile({ ...f, storedPath: part.files[0].storedPath }), path.join(f.asset.path, part.files[0].storedPath));
  const sourceFolder = await f.makeSource(part.files);
  const plan = await prepareComponentReplacement({ ...f, slot: part.slot, sourceFolder });
  await replaceCharacterComponent({ ...f, slot: part.slot, sourceFolder, token: plan.token });
  const updated = await f.reload();
  const current = listCharacterComponents(updated)[0].files[0];
  assert.equal(await resolveCharacterModelFile({ ...f, asset: updated, storedPath: current.storedPath }), path.join(f.asset.path, current.storedPath));
  await assert.rejects(resolveCharacterModelFile({ ...f, storedPath: part.files[0].storedPath }), /当前版本/);
  await assert.rejects(resolveCharacterModelFile({ ...f, storedPath: path.join(sourceFolder, part.files[0].normalizedName) }), /当前版本/);
});

test("texture location accepts only active owned textures, including component revisions", async t => {
  const f = await fixture(t);
  const [part] = listCharacterComponents(f.asset);
  const original = part.files.find(file => file.role === "texture");
  assert.equal(await resolveCharacterTextureFile({ ...f, storedPath: original.storedPath }), path.join(f.asset.path, original.storedPath));
  await assert.rejects(resolveCharacterTextureFile({ ...f, storedPath: part.files[0].storedPath }), /当前版本/);
  const sourceFolder = await f.makeSource(part.files);
  const plan = await prepareComponentReplacement({ ...f, slot: part.slot, sourceFolder });
  await replaceCharacterComponent({ ...f, slot: part.slot, sourceFolder, token: plan.token });
  const updated = await f.reload();
  const current = listCharacterComponents(updated)[0].files.find(file => file.role === "texture");
  assert.equal(await resolveCharacterTextureFile({ ...f, storedPath: current.storedPath }), path.join(f.asset.path, current.storedPath));
  await assert.rejects(resolveCharacterTextureFile({ ...f, storedPath: original.storedPath }), /当前版本/);
  await assert.rejects(resolveCharacterTextureFile({ ...f, storedPath: path.join(sourceFolder, original.normalizedName) }), /当前版本/);
  await fs.unlink(path.join(f.asset.path, current.storedPath));
  await assert.rejects(resolveCharacterTextureFile({ ...f, storedPath: current.storedPath }), /不存在|ENOENT/);
});

test("texture location rejects linked and escaping paths even when listed in metadata", async t => {
  const f = await fixture(t);
  const texture = f.asset.meta.characterManifest.files.find(file => file.role === "texture");
  await fs.writeFile(path.join(f.temp, "outside.tga"), "backup");
  await fs.symlink(f.temp, path.join(f.asset.path, "linked"), "junction");
  texture.storedPath = "linked/outside.tga";
  await fs.writeFile(f.asset.metaPath, JSON.stringify(f.asset.meta));
  await assert.rejects(resolveCharacterTextureFile({ ...f, storedPath: texture.storedPath }), /链接|联接/);
  texture.storedPath = "../../outside.tga";
  await fs.writeFile(f.asset.metaPath, JSON.stringify(f.asset.meta));
  await assert.rejects(resolveCharacterTextureFile({ ...f, storedPath: texture.storedPath }), /不属于/);
});

test("model location rejects textures, missing files, links and paths outside the owner", async t => {
  const f = await fixture(t);
  const files = f.asset.meta.characterManifest.files;
  await assert.rejects(resolveCharacterModelFile({ ...f, storedPath: files.at(-1).storedPath }), /当前版本/);
  await fs.unlink(path.join(f.asset.path, files[0].storedPath));
  await assert.rejects(resolveCharacterModelFile({ ...f, storedPath: files[0].storedPath }), /不存在/);
  await fs.symlink(f.temp, path.join(f.asset.path, "linked"), "junction");
  files[0].storedPath = "linked/source.fbx";
  await fs.writeFile(f.asset.metaPath, JSON.stringify(f.asset.meta));
  await assert.rejects(resolveCharacterModelFile({ ...f, storedPath: files[0].storedPath }), /链接|联接/);
  files[0].storedPath = "../../outside.fbx";
  await fs.writeFile(f.asset.metaPath, JSON.stringify(f.asset.meta));
  await assert.rejects(resolveCharacterModelFile({ ...f, storedPath: files[0].storedPath }), /不属于/);
});

test("whole update retains omitted resources, preserves ID/form and supports whole-package rollback", async t => {
  const f = await fixture(t);
  const onlyBody = f.asset.meta.characterManifest.files.slice(0, 1);
  const sourceFolder = await f.makeSource(onlyBody);
  const plan = await prepareCharacterPackageUpdate({ ...f, sourceFolder });
  assert.equal(plan.changes.filter(item => item.status === "retained").length, 2);
  await assert.rejects(updateCharacterPackage({ ...f, sourceFolder, token: plan.token }), /确认/);
  await updateCharacterPackage({ ...f, sourceFolder, token: plan.token, confirmWholePackage: true });
  const updated = await f.reload();
  assert.equal(updated.meta.assetID, "parent");
  assert.deepEqual(updated.meta.character.formIds, ["01"]);
  assert.equal(updated.meta.character.entityKey, "monster:parent");
  assert.equal(listCharacterComponents(updated).length, 1);
  assert.equal(updated.meta.characterPackageHistory.length, 1);
  assert.equal(await fs.readFile(path.join(f.asset.path, onlyBody[0].storedPath), "utf8"), onlyBody[0].normalizedName);
  await restoreCharacterPackageVersion({ ...f, asset: updated, revisionId: updated.meta.characterPackageHistory[0].id, expectedRevision: updated.meta.characterComponents.contentRevision });
  assert.equal(listCharacterComponents(await f.reload()).length, 1);
});

test("whole Monster update cannot change form; identical package does not create version", async t => {
  const f = await fixture(t);
  const differentForm = await f.makeSource([{ normalizedName: "SK_Test_02.fbx" }]);
  await assert.rejects(prepareCharacterPackageUpdate({ ...f, sourceFolder: differentForm }), /形态/);
  const sourceFolder = await f.makeSource(f.asset.meta.characterManifest.files, "");
  const plan = await prepareCharacterPackageUpdate({ ...f, sourceFolder });
  assert.equal(plan.unchanged, true);
  await updateCharacterPackage({ ...f, sourceFolder, token: plan.token, confirmWholePackage: true });
  assert.equal((await f.reload()).meta.characterPackageHistory, undefined);
});

for (const kind of ['Hair', 'Face', 'monster', 'npc', 'weapon']) {
  test(`${kind} reuses model matching, rigging, naming and automatic preview lifecycle`, async t => {
    const f = await fixture(t);
    const { characterModelGroups, characterRigProgress } = require('../shared/characterComponents.mjs');
    const { inspectCharacterUpdateInput } = require('../electron/services/characterPackageUpdates');
    const family = ['Hair', 'Face'].includes(kind) ? 'suit' : kind;
    const subject = family === 'suit' ? `F01_${kind}017` : family === 'monster' ? 'Example_01' : 'Example';
    const file = { originalName: 'SK_WorkingModel.fbx', normalizedName: `SM_${subject}.fbx`, storedPath: `Mesh/SM_${subject}.fbx`, role: 'staticMesh' };
    await fs.writeFile(path.join(f.asset.path, file.storedPath), 'static-model');
    f.asset.assetType = family; f.asset.name = subject;
    f.asset.meta = { ...f.asset.meta, assetID: 'Example-stable-id', assetType: family, name: subject,
      character: { gender: 'Female', bodyCode: '01', variant: family === 'suit' ? kind : '', serial: '017', name: 'Example', formIds: ['01'], entityKey: 'monster:Example', displayNameZh: '旧名' },
      characterManifest: { files: [file], fileCount: 1 },
      previews: { images: [{ uri: 'front.png', tags: ['view:front', 'origin:auto'] }, { uri: 'left.png', tags: ['view:left', 'origin:manual'] }] } };
    f.asset.id = 'Example-stable-id';
    await fs.writeFile(f.asset.metaPath, JSON.stringify(f.asset.meta));
    assert.equal(characterModelGroups(f.asset).length, 1);
    assert.equal(characterRigProgress(f.asset).staticReady, true);
    const source = await f.makeSource([{ normalizedName: 'SK_WorkingModel.fbx' }]);
    const inspected = await inspectCharacterUpdateInput({ ...f, sourcePaths: [source] });
    assert.equal(inspected.unmatchedFiles.length, 0);
    assert.match(inspected.replacements[0].storedPath, /^__new_character_mesh__:skeletalMesh:/);
    const options = { ...f, sourcePaths: [source], replacements: inspected.replacements };
    const plan = await prepareCharacterPackageUpdate(options);
    await updateCharacterPackage({ ...options, token: plan.token, confirmWholePackage: true });
    const updated = await f.reload();
    assert.equal(characterRigProgress(updated).complete, true);
    assert.equal(activeCharacterFiles(updated).filter(item => /Mesh$/.test(item.role)).length, 2);
    assert.equal(listCharacterComponents(updated).length, 0, 'root model must not become an outfit part');
    assert.deepEqual(updated.meta.characterComponents.autoPreviewPendingViews, ['front']);
    assert.equal(updated.meta.previews.images[1].uri, 'left.png');
    assert.equal(updated.meta.characterUpdateHistory.at(-1).note, f.note);
    const rendered = path.join(f.temp, 'rendered-front.png');
    await sharp({ create: { width: 16, height: 16, channels: 3, background: '#456789' } }).png().toFile(rendered);
    assert.equal(characterPreviewState({ ...updated, previewImage: 'front.png' }), 'stale');
    const batch = await require('../electron/services/characterComponents').updateCharacterPreviewBatch({ ...f, asset: updated,
      previewBatch: [{ expectedRevision: updated.meta.characterComponents.contentRevision, images: [{ view: 'front', sourcePath: rendered }] }] });
    assert.deepEqual(batch.previewErrors, []);
    const previewed = await f.reload();
    assert.equal(characterPreviewState({ ...previewed, previewImage: previewed.meta.previewImage }), 'current');
    assert.equal(previewed.meta.previews.images.find(image => image.tags.includes('view:left')).uri, 'left.png');
    assert.notEqual(previewed.meta.previews.images.find(image => image.tags.includes('view:front')).uri, 'front.png');
    await updateCharacterNames({ ...f, asset: updated, displayNameZh: '新名', displayNameEn: 'OfficialName', nameConfirmed: true, expectedName: '旧名', expectedAssetName: updated.meta.name });
    const renamed = await f.reload();
    assert.equal(renamed.meta.assetID, 'Example-stable-id');
    assert.equal(renamed.meta.character.entityKey, 'monster:Example');
    assert.equal(renamed.meta.character.serial, '017');
    assert.deepEqual(renamed.meta.character.formIds, ['01']);
    assert.equal(renamed.meta.name, family === 'suit' ? subject : updated.meta.name.replace('Example', 'OfficialName'));
    assert.ok(activeCharacterFiles(renamed).some(item => item.originalName === 'SK_WorkingModel.fbx'));
    assert.equal(await fs.readFile(path.join(source, 'SK_WorkingModel.fbx'), 'utf8'), 'SK_WorkingModel.fbx-new');
  });
}

for (const family of ["npc", "weapon"]) {
  test(`${family} whole-package update and version restore preserve identity and source files`, async t => {
    const f = await fixture(t);
    const name = family === "npc" ? "Scholar017_MoonReader" : "Spear023_SilverFang";
    const model = family === "npc" ? "SK_MoonReader.fbx" : "SK_Spear023_SilverFang.fbx";
    const file = { originalName: model, normalizedName: model, storedPath: `Mesh/SkeletalMesh/${model}`, role: "skeletalMesh" };
    await fs.mkdir(path.dirname(path.join(f.asset.path, file.storedPath)), { recursive: true });
    await fs.writeFile(path.join(f.asset.path, file.storedPath), "old-model");
    f.asset.assetType = family;
    f.asset.name = name;
    f.asset.meta = { ...f.asset.meta, name, assetType: family, category: family === "npc" ? "Scholar" : "Spear",
      character: { name: family === "npc" ? "MoonReader" : "SilverFang", serial: family === "npc" ? "017" : "023" },
      characterManifest: { files: [file], fileCount: 1 } };
    await fs.writeFile(f.asset.metaPath, JSON.stringify(f.asset.meta));
    const sourceFolder = await f.makeSource([file]);
    const plan = await prepareCharacterPackageUpdate({ ...f, sourceFolder });
    await updateCharacterPackage({ ...f, sourceFolder, token: plan.token, confirmWholePackage: true });
    const updated = await f.reload();
    assert.equal(updated.meta.assetID, "parent");
    assert.equal(updated.meta.name, name);
    assert.ok(updated.meta.characterManifest.contentUpdatedAt);
    assert.equal(await fs.readFile(path.join(sourceFolder, model), "utf8"), model + "-new");
    await restoreCharacterPackageVersion({ ...f, asset: updated, revisionId: updated.meta.characterPackageHistory[0].id, expectedRevision: updated.meta.characterComponents.contentRevision });
    assert.equal((await f.reload()).meta.characterManifest.files[0].storedPath, file.storedPath);
  });
}

test("whole update reports superseded part updates, reuses unchanged bytes and retains part history in package snapshot", async t => {
  const f = await fixture(t);
  const [part] = listCharacterComponents(f.asset);
  const partSource = await f.makeSource(part.files);
  const partPlan = await prepareComponentReplacement({ ...f, slot: part.slot, sourceFolder: partSource });
  await replaceCharacterComponent({ ...f, slot: part.slot, sourceFolder: partSource, token: partPlan.token });
  const sourceFolder = await f.makeSource(f.asset.meta.characterManifest.files, "");
  const plan = await prepareCharacterPackageUpdate({ ...f, sourceFolder });
  assert.equal(plan.replacedComponentCount, 1);
  await updateCharacterPackage({ ...f, sourceFolder, token: plan.token, confirmWholePackage: true });
  const updated = await f.reload();
  assert.ok(updated.meta.characterPackageHistory[0].snapshot.characterComponents.slots[part.slot].revisions.length);
  assert.equal(updated.meta.characterManifest.files[0].storedPath, f.asset.meta.characterManifest.files[0].storedPath);
});

test("list projection preserves character names, relation groups, forms, texture groups and component revisions without changing environment records", async t => {
  const f = await fixture(t);
  const { toAssetListRecord } = require("../electron/services/assetListRecord");
  const record = toAssetListRecord({ ...f.asset, meta: { ...f.asset.meta, characterImportGroupId: "linked-suit-and-weapon", characterMetrics: { totalTriangleCount: 1234, overBudget: false, analyzedAt: "2026-11-13T00:00:00.000Z" } } });
  assert.equal(characterDisplayName(record), "SK_Test_01");
  assert.deepEqual(record.meta.character.formIds, ["01"]);
  assert.equal(record.meta.characterManifest.files.filter(file => file.role === "texture").length, 1);
  assert.equal(record.meta.characterMetrics.totalTriangleCount, 1234);
  assert.equal(record.meta.characterImportGroupId, "linked-suit-and-weapon");
  assert.equal(listCharacterComponents(record).length, 1);
  assert.equal(Object.hasOwn(toAssetListRecord({ ...f.asset, assetType: "animation" }).meta, "character"), false);
  assert.equal(Object.hasOwn(toAssetListRecord({ ...f.asset, assetType: "3d" }).meta, "character"), false);
});
test('Face and HairCard share SM/SK previews and rig indicators but do not create catalog part cards', () => {
  const api = require('../shared/characterComponents.mjs');
  for (const variant of ['Face','Hair']) {
    const files = ['staticMesh','skeletalMesh'].map((role,i)=>({role,normalizedName:`${i?'SK':'SM'}_M01_${variant}001.fbx`,storedPath:`Mesh/${i?'SK':'SM'}_M01_${variant}001.fbx`,rigNeedsUpdate:!!i}));
    const asset={id:'owner',name:`M01_${variant}001`,assetType:'suit',path:'C:/library',meta:{character:{variant},characterManifest:{files}}};
    assert.equal(api.characterModelPreviewComponents(asset).length,1);
    assert.deepEqual(api.characterModelPreviewComponents(asset)[0].meshKinds,{staticMesh:true,skeletalMesh:true});
    assert.equal(api.characterRigProgress(asset).needsAttention,true);
    assert.equal(api.expandCharacterCards([asset]).length,1);
    files[1].rigNeedsUpdate=false;
    assert.equal(api.characterRigProgress(asset).complete,true);
    asset.meta.characterManifest.files=[{role:'model',normalizedName:'M01_Hair001_Groom.abc',storedPath:'Mesh/M01_Hair001_Groom.abc'}];
    assert.equal(api.characterModelPreviewComponents(asset).length,0);
    assert.equal(api.characterRigProgress(asset).total,0);
  }
});

test('Groom missing preview schedules once and protects an existing manual cover', () => {
  const {characterGroomPendingPreviewViews:pending}=require('../shared/characterComponents.mjs');
  const asset={assetType:'suit',meta:{character:{variant:'Hair'},characterManifest:{files:[{role:'model',normalizedName:'hair.abc',storedPath:'hair.abc'}]}}};
  assert.equal(pending(asset).length,4);
  asset.meta.previewImage='Preview/manual.png';
  assert.deepEqual(pending(asset),[]);
});
test('an existing Groom without images can save its first automatic views once', async t => {
  const f=await fixture(t,true);
  f.asset.meta.character.variant='Hair';
  f.asset.meta.characterManifest.files=[{role:'model',normalizedName:'hair.abc',storedPath:'Mesh/hair.abc'}];
  await fs.writeFile(path.join(f.asset.path,'Mesh/hair.abc'),'groom');
  await fs.writeFile(f.asset.metaPath,JSON.stringify(f.asset.meta));
  const image=path.join(f.root,'sample.png');
  await sharp({create:{width:16,height:16,channels:3,background:'#8899aa'}}).png().toFile(image);
  const action=require('../electron/services/characterComponents').updateCharacterAutomaticPreviews;
  const images=['front','left','right','back'].map(view=>({view,sourcePath:image}));
  const options={...f,asset:await f.reload(),expectedRevision:'initial',images};
  assert.equal((await action(options)).ok,true);
  const updated=await f.reload();
  assert.equal(updated.meta.previews.images.length,4);
  assert.ok(updated.meta.previewImage);
  await assert.rejects(()=>action({...options,asset:updated}),/过期|变化/);
});
