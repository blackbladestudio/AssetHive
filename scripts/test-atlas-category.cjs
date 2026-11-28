const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { gzipSync, gunzipSync } = require("node:zlib");
const ts = require("typescript");
const sharp = require("sharp");
const { normalizeAssetType, resolveMegascansCategory } = require("../electron/services/megascansCategory");
const { normalizeAssetType: normalizeSyncedType, getSyncedTopCategory } = require("../electron/services/libraryMetadataSync");
const { scanLibrary, searchAssets } = require("../electron/services/assetScanner");
const { runImportJob, validateImported } = require("../electron/services/megascansBatchImport");
const { loadApplicationServices } = require("./application-service-harness.cjs");
const { buildDrafts } = require("./import-draft-harness.cjs");
const { createThreeDCoatBridge } = require("../electron/services/threeDCoat");
const { buildExportAssets } = require("../electron/services/unrealExporter");

const mainSource = fsSync.readFileSync(path.join(__dirname, "../electron/main.js"), "utf8");
const rendererSource = fsSync.readFileSync(path.join(__dirname, "../src/ui/App.tsx"), "utf8");
const rendererAst = ts.createSourceFile("App.tsx", rendererSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function findRendererNode(predicate) {
  let found;
  function visit(node) {
    if (!found && predicate(node)) found = node;
    if (!found) ts.forEachChild(node, visit);
  }
  visit(rendererAst);
  assert.ok(found, "renderer declaration must exist");
  return found;
}

function rendererFunction(name, scope = {}) {
  scope = { getCharacterNavigationSelection: () => null, getAnimationNavigationSelection: () => null, characterCategoryOptions: () => [], ...scope };
  if (name === "mapNodeIdToAssetTypes") {
    const table = findRendererNode(node => ts.isVariableDeclaration(node) && node.name.getText(rendererAst) === "NAVIGATION_ASSET_TYPES");
    scope.NAVIGATION_ASSET_TYPES = new Function(`return ${table.initializer.getText(rendererAst)}`)();
  }
  const node = findRendererNode(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  const code = ts.transpileModule(node.getText(rendererAst), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(scope), `${code}; return ${name};`)(...Object.values(scope));
}

async function fixture(t) {
  const parent = path.resolve(__dirname, "../.tmp/atlas-tests");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "case-"));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(parent));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return root;
}

test("Atlas aliases, category parsing and import drafts stay separate from Decals", async () => {
  const start = mainSource.indexOf("function normalizeMegascansImportAssetType(");
  const end = mainSource.indexOf("function collectMegascansStringValues(", start);
  const normalizeDropType = new Function(`${mainSource.slice(start, end)}; return normalizeMegascansImportAssetType;`)();
  for (const alias of ["atlas", "atlases", "Atlases"]) {
    assert.equal(normalizeAssetType(alias), "atlas");
    assert.equal(normalizeSyncedType(alias), "atlas");
    assert.equal(normalizeDropType(alias), "atlas");
  }
  assert.equal(normalizeDropType("decals"), "decal");
  assert.equal(getSyncedTopCategory("atlas"), "environment");
  const meta = { assetCategories: { atlas: { fern: {} } } };
  assert.equal(resolveMegascansCategory(meta, "atlas"), "Fern");
  assert.equal(resolveMegascansCategory(meta, "decal"), "");
  const { drafts } = await buildDrafts(["D:\\AtlasSource\\Leaf_Diffuse.png"], {
    metadata: { name: "Leaf", assetType: "atlas", category: "Fern", standardAssetTags: ["Megascans"], tags: ["Atlas", "leaf"] }
  });
  assert.equal(drafts[0].form.assetType, "atlas");
  assert.ok(drafts[0].form.tagsText.includes("ThirdParty"));
  assert.ok(!drafts[0].form.tagsText.split(/,\s*/).includes("Atlas"));
});

test("real Bridge import archives Atlas under Environment/Atlases and the scanner repairs stale Decal cache", async t => {
  const root = await fixture(t);
  const library = path.join(root, "Library");
  const services = await loadApplicationServices(root);
  for (const type of ["atlas", "decal"]) {
    const id = `${type}fixture`;
    const source = path.join(library, ".megascans", "originals", id);
    await fs.mkdir(source, { recursive: true });
    await sharp({ create: { width: 8, height: 8, channels: 4, background: "#40802080" } }).png().toFile(path.join(source, "albedo.png"));
    await fs.writeFile(path.join(source, `${id}.json`), JSON.stringify({
      id, name: id, type, source: "quixel", assetCategories: { [type]: { fern: {} } }, maps: [{ type: "albedo", uri: "albedo.png" }]
    }));
    const result = await runImportJob({ id, source, library }, {
      readMetadata: services.readMegascansDropMetadata,
      importAsset: payload => services.importCustomAsset(payload, null)
    });
    assert.equal(result.ok, true);
    assert.equal(path.basename(path.dirname(result.assetPath)), type === "atlas" ? "Atlases" : "Decals");
    const metadata = await validateImported(result.assetPath, id);
    assert.equal(metadata.assetType, type);
    assert.equal(metadata.topCategory, "environment");
    assert.equal(metadata.category, type === "atlas" ? "Fern" : "Vegetation");
  }
  const scanMemoPath = path.join(root, "local-memo.json.gz");
  const initial = await scanLibrary(library, { scanMemoPath });
  assert.deepEqual(initial.map(asset => asset.assetType).sort(), ["atlas", "decal"]);
  const memo = JSON.parse(gunzipSync(await fs.readFile(scanMemoPath)));
  const entry = memo.assets.find(entry => entry.record.assetType === "atlas");
  entry.record.assetType = "decal";
  const metadataBefore = await fs.readFile(entry.metaPath);
  await fs.writeFile(scanMemoPath, gzipSync(JSON.stringify(memo)));
  const rescanned = await scanLibrary(library, { scanMemoPath, incrementalScan: true, pollShard: -1 });
  assert.deepEqual(rescanned.map(asset => asset.assetType).sort(), ["atlas", "decal"]);
  assert.equal(searchAssets(rescanned, { assetTypes: ["atlas"] }).length, 1);
  const repaired = JSON.parse(gunzipSync(await fs.readFile(scanMemoPath)));
  assert.equal(repaired.assets.find(item => item.record.id === entry.record.id).record.assetType, "atlas");
  assert.deepEqual(await fs.readFile(entry.metaPath), metadataBefore, "scanning leaves shared metadata untouched");
  // A transient metadata failure must retain the last cached card while the
  // classification repair is retried, including during incremental scans.
  repaired.assets.find(item => item.record.id === entry.record.id).record.assetType = "decal";
  await fs.writeFile(scanMemoPath, gzipSync(JSON.stringify(repaired)));
  await fs.writeFile(entry.metaPath, "corrupt fixture metadata");
  const warnings = [];
  const failedScan = await scanLibrary(library, { scanMemoPath, incrementalScan: true, onWarning: warning => warnings.push(warning) });
  assert.ok(warnings.length > 0);
  assert.equal(failedScan.length, 2, "a failed classification repair does not remove the cached asset");
  await fs.writeFile(entry.metaPath, metadataBefore);
});

test("navigation, favorites and import destinations expose an independent Atlas type", () => {
  const mapTypes = rendererFunction("mapNodeIdToAssetTypes");
  assert.deepEqual(mapTypes("atlases"), ["atlas"]);
  assert.deepEqual(mapTypes("fav-atlas"), ["atlas"]);
  assert.ok(mapTypes("environment").includes("atlas"));
  const tree = findRendererNode(node => ts.isVariableDeclaration(node) && node.name.getText(rendererAst) === "categoryTree");
  const nodes = new Function(`return ${tree.initializer.getText(rendererAst)}`)();
  assert.ok(nodes[0].children.find(node => node.id === "environment").children.some(node => node.id === "atlases"));
  const dirs = findRendererNode(node => ts.isVariableDeclaration(node) && node.name.getText(rendererAst) === "defaultImportRelativeDirByAssetType");
  assert.equal(new Function(`return ${dirs.initializer.getText(rendererAst)}`)().atlas, "Environment\\Atlases");
});

test("Atlas cards export to Unreal while folder-only types keep independent folder actions", () => {
  const isFolderOnlyAsset = rendererFunction("isFolderOnlyAsset");
  const assets = [{ id: "atlas", assetType: "atlas", path: "D:\\Library\\Atlas" }, { id: "imperfection", assetType: "imperfection", path: "D:\\Library\\Dust" }, { id: "decal", assetType: "decal" }, { id: "missing", assetType: "atlas" }];
  const attributes = [];
  (function visit(node) {
    if (ts.isJsxAttribute(node) && ["exportDisabled", "exportDimmed", "exportTitle"].includes(node.name.text)) attributes.push(node);
    ts.forEachChild(node, visit);
  })(rendererAst);
  assert.equal(attributes.length, 6, "overview and list cards are covered");
  for (const target of ["unreal", "blender", "3dcoat"]) {
    const scope = { allAssets: assets, isFolderOnlyAsset, isBlenderTarget: target === "blender", isThreeDCoatTarget: target === "3dcoat",
      supportsBlenderExport: rendererFunction("supportsBlenderExport"), supportsThreeDCoatExport: asset => asset?.assetType === "decal", canExport: true, exportUnavailableTitle: "Disconnected",
      bridgeAvailable: true, t: (_zh, en) => en,
      canOpenAnimationExport: target === "unreal", isAnimationExportRecord: asset => asset?.assetType === "animation",
      folderAssetExportUnavailableTitle: "Atlas disabled", blenderAssetUnavailableTitle: "Blender disabled",
      threeDCoatAssetUnavailableTitle: "3DCoat disabled", threeDCoatSingleSelectionTitle: "single only" };
    const unavailable = rendererFunction("getAssetExportUnavailableTitle", scope);
    const atlasUnavailable = target === "unreal" ? undefined : target === "blender" ? "Blender disabled" : "3DCoat disabled";
    assert.equal(unavailable(["atlas"]), atlasUnavailable);
    assert.equal(unavailable(["decal", "atlas"]), target === "3dcoat" ? "single only" : atlasUnavailable);
    assert.equal(unavailable(["imperfection"]), "Atlas disabled");
    assert.equal(unavailable(["decal"]), undefined, "existing Decal export stays enabled");
    const disconnected = rendererFunction("getAssetExportUnavailableTitle", { ...scope, canExport: false, allAssets: [...assets, { id: "clip", assetType: "animation" }] });
    assert.equal(disconnected(["clip"]), target === "unreal" ? undefined : target === "blender" ? "Blender disabled" : "3DCoat disabled",
      "animations open the Unreal dialog before the editor connects");
    assert.equal(disconnected(["decal"]), "Disconnected");
    for (const asset of assets) {
      for (const available of [true, false]) {
        const state = { ...scope, asset, busy: !available, isExporting: !available, canExport: available, importingAssetIds: [],
          assetCanExport: item => available || (scope.canOpenAnimationExport && scope.isAnimationExportRecord(item)) };
        for (const attribute of attributes) {
          const value = new Function(...Object.keys(state), `return ${attribute.initializer.expression.getText(rendererAst)}`)(...Object.values(state));
          const targetUnavailable = target === "blender" && !scope.supportsBlenderExport(asset) ? "Blender disabled"
            : target === "3dcoat" && !scope.supportsThreeDCoatExport(asset) ? "3DCoat disabled" : undefined;
          const expected = attribute.name.text === "exportTitle"
            ? (isFolderOnlyAsset(asset) ? "Open folder" : targetUnavailable || (available ? undefined : "Disconnected"))
            : (isFolderOnlyAsset(asset) ? !asset.path : !available || Boolean(targetUnavailable));
          assert.equal(value, expected);
        }
      }
    }
  }
});

test("Atlas quick actions enter the software export route without requiring a model", () => {
  const opened = [];
  const exported = [];
  const scope = {
    allAssets: [
      { id: "first", assetType: "atlas", path: "D:\\Library\\First" },
      { id: "second", assetType: "atlases", path: "D:\\Library\\Second" },
      { id: "missing", assetType: "atlas" },
      { id: "decal", assetType: "decal" }
    ],
    isFolderOnlyAsset: rendererFunction("isFolderOnlyAsset"), bridgeAvailable: true,
    bridge: { openFolder: folder => opened.push(folder) },
    runImport: ids => exported.push(ids)
  };
  const action = rendererFunction("runQuickAssetAction", scope);
  action("second");
  action("missing");
  assert.deepEqual(opened, []);
  assert.deepEqual(exported, [["second"], ["missing"]]);
  rendererFunction("runQuickAssetAction", { ...scope, bridgeAvailable: false })("first");
  assert.equal(opened.length, 0);
  action("decal");
  assert.deepEqual(exported, [["second"], ["missing"], ["first"], ["decal"]]);
});

test("desktop IPC accepts Atlas and mixed Unreal requests while retaining other type boundaries", async () => {
  const assets = [{ id: "atlas", assetType: "atlas" }, { id: "imperfection", assetType: "imperfection" }, { id: "displacement", assetType: "displacement" }, { id: "decal", assetType: "decal" }];
  const handlers = new Map();
  let calls = 0;
  const context = vm.createContext({ index: assets, settings: {}, appUpdates: null, activeExportCalls: 0,
    componentParentId: require('../shared/characterComponents.mjs').componentParentId,
    isCharacterUEAsset: require('../electron/services/characterSuitExport').isCharacterUEAsset,
    isAnimationUEAsset: require('../electron/services/animationUnrealExport').isAnimationUEAsset,
    recycleInProgress: false, filterRecycledIndex: async () => {},
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    refreshAssetById: async id => assets.find(asset => asset.id === id),
    exportToUnreal: async () => { calls++; return { ok: true }; }, exportToBlender: async () => { calls++; return { ok: true }; },
    setMainWindowTaskbarProgress() {}, writeLog() {} });
  const start = mainSource.indexOf("  const handleAssetExport =");
  vm.runInContext(mainSource.slice(start, mainSource.indexOf('  ipcMain.handle("assets:openFolder",', start)), context);
  for (const target of ["Unreal", "Blender"]) {
    const handler = handlers.get(`assets:exportTo${target}`);
    const beforeCalls = calls;
    for (const assetIds of [["displacement"], ["decal", "displacement"], ["imperfection"], ["decal", "imperfection"]]) {
      const result = await handler({ sender: { send() {} } }, { assetIds });
      assert.equal(result.ok, false);
      assert.match(result.message, /Imperfections|Displacements/);
    }
    assert.equal(calls, beforeCalls);
    for (const assetIds of [["atlas"], ["decal", "atlas"]]) {
      const result = await handler({ sender: { send() {} } }, { assetIds });
      assert.equal(result.ok, target === "Unreal");
      if (target === "Blender") assert.match(result.message, /Atlases/);
    }
    assert.equal((await handler({ sender: { send() {} } }, { assetIds: ["decal"] })).ok, true);
    assert.equal(context.activeExportCalls, 0);
  }
  assert.equal(calls, 4);
});

test("Atlas Unreal jobs retain standalone opacity and displacement, pack ORM and ignore all models", async t => {
  const root = await fixture(t);
  const entries = [];
  for (const areaIndex of [1, 2]) {
    for (const textureType of ["Diffuse", "Normal", "AO", "Roughness", "Metalness", "Opacity", "Displacement"]) {
      const uri = `Leaf_${areaIndex}_${textureType}.png`;
      await sharp({ create: { width: 8, height: 8, channels: 3, background: "#408080" } }).png().toFile(path.join(root, uri));
      entries.push({ textureType, areaIndex, uri });
    }
  }
  const model = path.join(root, "legacy.fbx");
  await fs.writeFile(model, "legacy model must never be exported");
  for (const assetType of ["atlas", "atlases"]) {
    const [job] = await buildExportAssets([{
      id: "atlasfixture", name: "Leaf", path: root, assetType, source: "custom",
      modelFiles: [model], textureFiles: entries.map(entry => path.join(root, entry.uri)),
      meta: { textureEntries: entries, modelFiles: [model], modelVariants: [{ file: model, variantKey: "01" }] }
    }]);
    assert.equal(job.exportRootPath, "/Game/Environment/Asset");
    assert.equal(job.categoryFolder, "Objects");
    assert.equal(job.assetFolderName, "Leaf_atlasfixture");
    assert.deepEqual(job.standardAssetTags, ["ThirdParty"]);
    assert.deepEqual(job.zionTags, []);
    assert.deepEqual(job.modelFiles, []);
    assert.deepEqual(job.modelVariants, []);
    assert.deepEqual(job.modelLods, []);
    assert.equal(job.materialGroups.length, 2);
    for (const group of job.materialGroups) {
      assert.deepEqual(group.textureSlots.map(slot => slot.slot).sort(), ["Albedo", "Displacement", "Normal", "ORM", "Opacity"]);
      assert.equal(group.textureSlots.find(slot => slot.slot === "Displacement").compression, "Displacement");
      assert.ok(group.textureSlots.every(slot => fsSync.existsSync(slot.file)));
    }
  }
});

test("Atlas export reports missing textures without requiring a model", async () => {
  await assert.rejects(buildExportAssets([{ id: "empty-atlas", assetType: "atlas", textureFiles: [], meta: {} }]), /Atlas资产缺少可用纹理/);
});

test("3DCoat rejects Atlas before preparing files even if legacy metadata contains a model", async t => {
  const supportsThreeDCoatExport = rendererFunction("supportsThreeDCoatExport", { THREE_DCOAT_MODEL_PATTERN: /\.(fbx|obj|stl|ply)$/i });
  for (const assetType of ["atlas", "atlases"]) {
    assert.equal(supportsThreeDCoatExport({ assetType, modelFiles: ["legacy.fbx"] }), false);
  }
  assert.equal(supportsThreeDCoatExport({ assetType: "3d", modelFiles: ["model.fbx"] }), true);
  const root = await fixture(t);
  const bridge = createThreeDCoatBridge({
    userDataDir: root, documentsDir: root,
    getAsset: async () => ({ id: "atlas", assetType: "atlas", modelFiles: ["D:\\AtlasSource\\Legacy.fbx"] })
  });
  await assert.rejects(bridge.importAsset({ assetId: "atlas" }), { code: "UNSUPPORTED_ASSET_TYPE" });
});


test("Imperfections navigation, import destination and folder actions are independent of Surfaces", () => {
  const mapTypes = rendererFunction("mapNodeIdToAssetTypes");
  assert.deepEqual(mapTypes("imperfections"), ["imperfection"]);
  assert.deepEqual(mapTypes("fav-imperfection"), ["imperfection"]);
  assert.ok(mapTypes("environment").includes("imperfection"));
  const tree = findRendererNode(node => ts.isVariableDeclaration(node) && node.name.getText(rendererAst) === "categoryTree");
  const nodes = new Function(`return ${tree.initializer.getText(rendererAst)}`)();
  assert.ok(nodes[0].children.find(node => node.id === "environment").children.some(node => node.id === "imperfections"));
  const dirs = findRendererNode(node => ts.isVariableDeclaration(node) && node.name.getText(rendererAst) === "defaultImportRelativeDirByAssetType");
  assert.equal(new Function(`return ${dirs.initializer.getText(rendererAst)}`)().imperfection, "Environment\\Imperfections");
  const opened = [];
  rendererFunction("runQuickAssetAction", { allAssets: [{ id: "dust", assetType: "imperfection", path: "D:\\Dust" }],
    isFolderOnlyAsset: rendererFunction("isFolderOnlyAsset"), bridgeAvailable: true, bridge: { openFolder: file => opened.push(file) },
    runImport: () => assert.fail("Imperfections must not enter software export") })("dust");
  assert.deepEqual(opened, ["D:\\Dust"]);
  const options = findRendererNode(node => ts.isVariableDeclaration(node) && node.name.getText(rendererAst) === "subCategoryOptionsByAssetType");
  assert.deepEqual(new Function("characterCategoryOptions", `return ${options.initializer.getText(rendererAst)}`)(() => []).imperfection,
    ["Damage", "Dirt", "Fingerprint", "Frost", "Grain", "Grunge", "Leakage", "Metal", "Rubber", "Stain", "Stone", "Wipe Mark", "Other"]);
});


test("Imperfections renderer category filters ignore descriptive tags", () => {
  const matches = rendererFunction("assetMatchesCategoryThemes", { normalizeThemeToken: rendererFunction("normalizeThemeToken") });
  assert.equal(matches({ assetType: "imperfection", themes: ["metal"], tags: ["damage"] }, ["Damage"]), false);
  assert.equal(matches({ assetType: "imperfection", themes: ["fingerprint", "damage"], tags: [] }, ["Damage"]), true);
  assert.equal(matches({ assetType: "surface", themes: ["metal"], tags: ["damage"] }, ["Damage"]), true);
});


test("Displacements navigation, favorites, import destination and folder actions stay independent of Surfaces", () => {
  const mapTypes = rendererFunction("mapNodeIdToAssetTypes");
  assert.deepEqual(mapTypes("displacements"), ["displacement"]);
  assert.deepEqual(mapTypes("fav-displacement"), ["displacement"]);
  assert.ok(mapTypes("environment").includes("displacement"));
  const tree = findRendererNode(node => ts.isVariableDeclaration(node) && node.name.getText(rendererAst) === "categoryTree");
  const nodes = new Function(`return ${tree.initializer.getText(rendererAst)}`)();
  const node = nodes[0].children.find(node => node.id === "environment").children.find(node => node.id === "displacements");
  assert.deepEqual(node.children, [], "Bridge Displacements has no category branches");
  const dirs = findRendererNode(node => ts.isVariableDeclaration(node) && node.name.getText(rendererAst) === "defaultImportRelativeDirByAssetType");
  assert.equal(new Function(`return ${dirs.initializer.getText(rendererAst)}`)().displacement, "Environment\\Displacements");
  assert.deepEqual(rendererFunction("getRequiredTextureTypesForAssetType")("displacement"), ["Displacement"]);
  assert.deepEqual(rendererFunction("getDefaultTextureTypesForAssetType")("displacement"), ["Displacement", "Normal", "Bump"]);
  const opened = [];
  rendererFunction("runQuickAssetAction", { allAssets: [{ id: "height", assetType: "displacement", path: "D:/Height" }],
    isFolderOnlyAsset: rendererFunction("isFolderOnlyAsset"), bridgeAvailable: true, bridge: { openFolder: file => opened.push(file) },
    runImport: () => assert.fail("Displacements must open their folder") })("height");
  assert.deepEqual(opened, ["D:/Height"]);
});

test("Bridge Displacement takes precedence over its legacy Surface category throughout actual import and cache refresh", async t => {
  const { isDisplacementMetadata } = require("../electron/services/displacementClassification");
  const sourceMeta = { id: "scipchxp", name: "Horizontally Grooved Concrete Displacement", source: "quixel",
    categories: ["surface", "displacement", "concrete"], assetCategories: { displacement: {} },
    semanticTags: { asset_type: "displacement" }, maps: [{ type: "displacement", uri: "height.png" }, { type: "normal", uri: "normal.png" }] };
  for (const alias of ["displacement", "Displacements"]) {
    assert.equal(normalizeAssetType(alias), "displacement");
    assert.equal(normalizeSyncedType(alias), "displacement");
  }
  assert.equal(getSyncedTopCategory("displacement"), "environment");
  assert.equal(isDisplacementMetadata({ type: "surface", assetCategories: { displacement: {} } }), true);
  assert.equal(isDisplacementMetadata({ type: "surface", categories: sourceMeta.categories }), true);
  assert.equal(isDisplacementMetadata({ type: "surface", tags: ["displacement"], maps: sourceMeta.maps }), false,
    "an ordinary PBR Surface does not become a Displacement because it has a height map or tag");
  const root = await fixture(t), library = path.join(root, "Library"), source = path.join(library, ".megascans/originals/scipchxp");
  await fs.mkdir(source, { recursive: true });
  for (const name of ["height.png", "normal.png"]) {
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#808080" } }).png().toFile(path.join(source, name));
  }
  await fs.writeFile(path.join(source, "scipchxp.json"), JSON.stringify(sourceMeta));
  const services = await loadApplicationServices(root);
  const metadata = await services.readMegascansDropMetadata([path.join(source, "scipchxp.json")]);
  assert.equal(metadata.assetType, "displacement");
  const { drafts } = await buildDrafts([path.join(source, "height.png"), path.join(source, "normal.png")], { metadata });
  assert.equal(drafts[0].form.assetType, "displacement");
  assert.ok(!drafts[0].form.tagsText.split(/,\s*/).includes("displacement"));
  const result = await runImportJob({ id: "scipchxp", source, library }, {
    readMetadata: services.readMegascansDropMetadata, importAsset: payload => services.importCustomAsset(payload, null)
  });
  assert.equal(result.ok, true);
  assert.equal(path.basename(path.dirname(result.assetPath)), "Displacements");
  const meta = await validateImported(result.assetPath, "scipchxp");
  assert.equal(meta.assetType, "displacement");
  assert.equal(meta.topCategory, "environment");
  assert.deepEqual(meta.sourceClassification.assetCategories, { displacement: {} });
  assert.deepEqual(meta.textureEntries.map(entry => entry.textureType).sort(), ["Displacement", "Normal"]);
  const scanMemoPath = path.join(root, "memo.json.gz");
  await scanLibrary(library, { scanMemoPath });
  const memo = JSON.parse(gunzipSync(await fs.readFile(scanMemoPath)));
  memo.assets[0].record.assetType = "surface";
  await fs.writeFile(scanMemoPath, gzipSync(JSON.stringify(memo)));
  const before = await fs.readFile(path.join(result.assetPath, "asset_info.json"));
  const rescanned = await scanLibrary(library, { scanMemoPath, incrementalScan: true, pollShard: -1 });
  assert.equal(searchAssets(rescanned, { assetTypes: ["displacement"] }).length, 1);
  assert.equal(searchAssets(rescanned, { assetTypes: ["surface"] }).length, 0);
  assert.deepEqual(await fs.readFile(path.join(result.assetPath, "asset_info.json")), before);
});


test("legacy Bridge Displacements refresh into their own category without changing directories or metadata", async t => {
  const { isDisplacementMetadata } = require("../electron/services/displacementClassification");
  const { scanLibraryInWorker } = require("../electron/services/assetScanner");
  const { getResidentMemoPath } = require("../electron/services/residentScanMemo");
  const root = await fixture(t), library = path.join(root, "Library"), dir = path.join(library, "Environment/Surfaces/megascans_scipchxp");
  await fs.mkdir(dir, { recursive: true });
  const legacy = { assetID: "rqfqier", name: "Horizontally Grooved Concrete Displacement", assetType: "surface", asset_type: "surface",
    topCategory: "environment", category: "Concrete", tags: ["surface", "tileabledisplacement", "displacement"],
    identity: { sourceKind: "megascans", sourceAssetId: "scipchxp", contentFingerprint: "preserved" }, textureFiles: ["height.png"] };
  assert.equal(isDisplacementMetadata(legacy, { legacy: true }), true);
  assert.equal(isDisplacementMetadata({ ...legacy, tags: ["displacement"] }, { legacy: true }), false);
  assert.equal(isDisplacementMetadata({ ...legacy, identity: { sourceKind: "custom" } }, { legacy: true }), false);
  await fs.writeFile(path.join(dir, "asset_info.json"), JSON.stringify(legacy));
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "#808080" } }).png().toFile(path.join(dir, "height.png"));
  const scanMemoPath = path.join(root, "memo.json.gz");
  await scanLibrary(library, { scanMemoPath });
  const memo = JSON.parse(gunzipSync(await fs.readFile(scanMemoPath)));
  memo.assets[0].record.assetType = "surface";
  await fs.writeFile(scanMemoPath, gzipSync(JSON.stringify(memo)));
  const sourceBytes = await fs.readFile(path.join(dir, "asset_info.json")), memoBytes = await fs.readFile(scanMemoPath);
  const records = await scanLibraryInWorker(library, { scanMemoPath, residentIndex: true, incrementalScan: true, pollShard: -1 });
  assert.equal(records[0].id, "rqfqier");
  assert.equal(records[0].assetType, "displacement");
  assert.equal(records[0].path.replaceAll("\\", "/"), dir.replaceAll("\\", "/"));
  const resident = JSON.parse(gunzipSync(await fs.readFile(getResidentMemoPath(scanMemoPath))));
  assert.equal(resident.assets[0].record.assetType, "displacement");
  assert.deepEqual(await fs.readFile(path.join(dir, "asset_info.json")), sourceBytes);
  assert.deepEqual(await fs.readFile(scanMemoPath), memoBytes, "resident scanning preserves the legacy full memo");
});
