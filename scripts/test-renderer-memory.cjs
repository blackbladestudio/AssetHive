const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { setImmediate } = require("node:timers/promises");
const ts = require("typescript");
const { toAssetListRecord, toAssetIndexRecord } = require("../electron/services/assetListRecord");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "electron/main.js"), "utf8");
const app = fs.readFileSync(path.join(root, "src/ui/App.tsx"), "utf8");
const ast = ts.createSourceFile("App.tsx", app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const syncExports = {};
new Function("exports", ts.transpileModule(fs.readFileSync(path.join(root, "src/ui/assetIndexSync.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText)(syncExports);
const fixture = {
  id: "stone", assetID: "alternate-id", name: "Stone", source: "custom", path: "Library/stone", metaPath: "Library/stone/asset_info.json",
  assetType: "3d", tags: ["rock", "forest"], themes: ["forest"], favorite: true, colorTags: ["gray"],
  preview: "preview.png", previewImage: "preview.png", detailImage: "detail.png", createdAt: "2026-11-08",
  meta: { assetID: "search-id", slug: "search-slug", category: "Rock", previews: { relativeSize: "3x1" },
    semanticTags: { subject_matter: "rock", theme: ["forest"], color: "brown" },
    scanInformation: { dimensions: { x: 3, y: 2, z: 1 } }, colors: ["green"],
    textureEntries: Array.from({ length: 100 }, (_, i) => ({ path: `texture_${i}.png`, width: 4096, height: 4096 })) },
  modelFiles: ["mesh.fbx"], textureFiles: Array.from({ length: 100 }, (_, i) => `texture_${i}.png`),
  textureAnalysis: { textures: Array.from({ length: 100 }, (_, i) => ({ path: `texture_${i}.png` })) }
};

test("list snapshots omit file inventories while preserving grid, search and filter behavior", () => {
  const compact = toAssetListRecord(fixture);
  for (const field of ["textureFiles"]) assert.equal(compact[field], undefined);
  assert.equal(compact.meta.textureEntries, undefined);
  assert.deepEqual(compact.modelFiles, fixture.modelFiles);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(fixture).length / 4);
  assert.equal(compact.meta.assetID, "search-id");
  assert.equal(compact.meta.slug, "search-slug");
  assert.equal(compact.meta.previews.relativeSize, "3x1");
  assert.equal(compact.favorite, true);
  const names = ["getAssetDimensions", "getAssetColorTags", "getAssetSubCategory"];
  const functions = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) functions.push(node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const code = ts.transpileModule(functions.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const api = new Function(`${code}; return { ${names.join(",")} };`)();
  for (const name of names) assert.deepEqual(api[name](compact), api[name](fixture));
  assert.equal(fixture.meta.textureEntries.length, 100, "projection must not alter the main process index");
});

test("legacy size metadata and partial startup records remain usable", () => {
  const compact = toAssetListRecord({ id: "legacy", relativeSize: "2x1", meta: { meta: [
    { key: "length", value: "200 cm" }, { key: "width", value: "1 m" }, { key: "height", value: "50 cm" },
    { key: "unrelated", value: "x".repeat(10000) }
  ] } });
  assert.equal(compact.meta.previews.relativeSize, "2x1");
  assert.equal(compact.meta.meta.length, 3);
  assert.ok(toAssetListRecord({ id: "cached" }).meta);
  for (const invalid of [null, undefined, {}, { id: " " }]) assert.equal(toAssetListRecord(invalid), null);
});

test("BlackBlade list records retain animation, Zion, collision and batch plant export fields", () => {
  const asset = { ...fixture, topCategory: "animation", standardAssetTags: ["Grass"], zionTags: ["Hero"],
    zionExportSubfolder: "Plants/Grass", animationAffiliation: "Hero", hasCollision: true,
    previewSkeletonPath: "rig.fbx", previewSkeletalMeshPath: "body.fbx", exportCount: 3,
    meta: { ...fixture.meta, nativePlantWind: { mode: "audited", largeUnusedData: "x".repeat(10000) },
      identity: { sourceKind: "megascans", sourceAssetId: "external-id", contentFingerprint: "x".repeat(10000) } }
  };
  const compact = toAssetListRecord(asset);
  for (const key of ["topCategory", "standardAssetTags", "zionTags", "zionExportSubfolder", "animationAffiliation",
    "hasCollision", "previewSkeletonPath", "previewSkeletalMeshPath", "modelFiles"]) {
    assert.deepEqual(compact[key], asset[key], key);
  }
  assert.equal(compact.meta.nativePlantWind, true);
  assert.equal(compact.exportCount, undefined, "legacy counters do not enter card records");
  assert.deepEqual(compact.meta.identity, { sourceKind: "megascans", sourceAssetId: "external-id" });
  assert.equal(compact.textureAnalysis?.textures, undefined);
});

test("resident records release source metadata while retaining inventories, identity and list semantics", () => {
  const original = { ...fixture, meta: { ...fixture.meta,
    identity: { sourceKind: "megascans", sourceKey: "megascans:stone", contentFingerprint: "sha256", modelFingerprints: { Mesh: "hash" } },
    components: [{ data: "x".repeat(100000) }], importHistory: [{ data: "x".repeat(100000) }] } };
  const resident = toAssetIndexRecord(original);
  assert.equal(resident.meta.components, undefined);
  assert.equal(resident.meta.importHistory, undefined);
  assert.equal(resident.meta.textureEntries, undefined);
  assert.equal(resident.textureFiles, original.textureFiles);
  assert.equal(resident.meta.identity, original.meta.identity);
  assert.deepEqual(toAssetListRecord(resident), toAssetListRecord(original));
  assert.equal(original.meta.components.length, 1, "source JSON must not be changed");
  const legacy = { ...fixture, meta: { ...fixture.meta, modelSlots: { Mesh: "mesh.fbx" }, modelLods: [{ lod: 1, file: "lod1.fbx" }] } };
  for (const key of ["textureEntries", "modelSlots", "modelLods"]) assert.equal(toAssetIndexRecord(legacy).meta[key], legacy.meta[key]);
  for (const assetType of ["animation", "hdri"]) assert.equal(toAssetIndexRecord({ ...original, assetType }).meta, original.meta);
  const metadataOnly = { ...fixture, topCategory: undefined, textureAnalysis: undefined,
    meta: { ...fixture.meta, topCategory: "animation", animationAffiliation: "Hero", textureAnalysis: { maxTextureDimension: 4096 } } };
  assert.deepEqual(toAssetListRecord(toAssetIndexRecord(metadataOnly)), toAssetListRecord(metadataOnly));
});

test("detail reads coalesce and only the selected asset retains full metadata", async () => {
  let callback;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "refreshAssetFromDisk") callback = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const code = ts.transpileModule(`const refresh = ${callback.getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;
  let release, calls = 0, all = [toAssetListRecord(fixture)], filtered = all, detail;
  const scope = { bridgeAvailable: true,
    bridge: { getAssetById: () => { calls++; return new Promise(resolve => { release = resolve; }); } },
    detailReadsRef: { current: new Map() }, detailLibraryRef: { current: "library-a" }, selectedAssetIdRef: { current: fixture.id },
    setAllAssets: value => { all = value(all); }, setAssets: value => { filtered = value(filtered); },
    setSelectedAssetDetails: value => { detail = value; }
  };
  const refresh = new Function("scope", `with (scope) { ${code}; return refresh; }`)(scope);
  const first = refresh(fixture.id), second = refresh(fixture.id);
  assert.equal(first, second);
  assert.equal(calls, 1);
  release({ ok: true, asset: fixture, listAsset: toAssetListRecord(fixture) });
  assert.equal(await first, fixture, "editing still receives full details");
  assert.equal(detail, fixture);
  assert.equal(all[0].meta.textureEntries, undefined);
  assert.equal(filtered[0].textureFiles, undefined);
  assert.equal(scope.detailReadsRef.current.size, 0);
  detail = null;
  const late = refresh(fixture.id);
  scope.selectedAssetIdRef.current = "another-asset";
  release({ ok: true, asset: fixture, listAsset: toAssetListRecord(fixture) });
  await late;
  assert.equal(detail, null, "a late response cannot retain the previous selection");
  const obsolete = refresh(fixture.id);
  scope.detailLibraryRef.current = "library-b";
  release({ ok: true, asset: fixture, listAsset: toAssetListRecord(fixture) });
  assert.equal(await obsolete, undefined, "a previous library's detail request must be discarded");
});

test("index, rescan and search IPC replies use compact records; detail replies keep file lists", async () => {
  const start = main.indexOf('  ipcMain.handle("assets:getIndex",');
  const end = main.indexOf('  const handleAssetExport =', start);
  const handlers = new Map();
  let startupLibrary = null;
  let deletionCheck = null;
  let deletionChecks = 0;
  vm.runInNewContext(main.slice(start, end), {
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    isCharacterAssetType: require('../electron/services/characterImport').isCharacterAssetType,
    index: [fixture, null], toAssetListRecord, searchAssets: () => [fixture], refreshAssetById: async () => fixture,
    mainWindow: { getStartupLibrary: () => startupLibrary },
    writeLog: () => {},
    recycleInProgress: false, filterRecycledIndex: async () => { deletionChecks++; await deletionCheck; }, librarySelectionGeneration: 0,
    BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] }, performScan: async () => {},
    hydrateIndexPreviewFields: async () => [fixture]
  });
  for (const channel of ["assets:getIndex", "assets:rescan", "assets:search"]) {
    const records = await handlers.get(channel)({}, {});
    assert.equal(records.length, 1);
    assert.equal(records[0].textureFiles, undefined);
    assert.equal(records[0].meta.textureEntries, undefined);
  }
  assert.equal((await handlers.get("assets:getById")({}, fixture.id)).asset, fixture);

  let releaseDeletionCheck;
  deletionCheck = new Promise(resolve => { releaseDeletionCheck = resolve; });
  let normalReplied = false;
  const normalIndex = handlers.get("assets:getIndex")({}, {}).then(records => { normalReplied = true; return records; });
  const checksAfterNormalRead = deletionChecks;
  const passiveIndex = handlers.get("assets:getIndex")({}, { preferMemory: true });
  await setImmediate();
  assert.equal(normalReplied, false, "explicit reads still check the shared deletion journal");
  assert.equal(deletionChecks, checksAfterNormalRead, "window recovery must bypass a blocked deletion check");
  releaseDeletionCheck();
  assert.equal((await passiveIndex)[0].id, fixture.id);
  await normalIndex;

  let release;
  startupLibrary = new Promise(resolve => { release = resolve; });
  let replied = false;
  const initialIndex = handlers.get("assets:getIndex")({}, { preferMemory: true }).then(records => { replied = true; return records; });
  await setImmediate();
  assert.equal(replied, false, "the first list cannot return before the startup snapshot");
  release();
  assert.equal((await initialIndex)[0].id, fixture.id);
});

test("overlapping detail requests share fresh, parallel deletion checks within one library", async () => {
  const removed = { id: "removed" };
  const requests = [];
  let handler;
  const context = vm.createContext({
    settings: { customLibraryPath: "library-a" }, librarySelectionGeneration: 0, index: [fixture, removed],
    ipcMain: { handle: (_, callback) => { handler = callback; } },
    toAssetListRecord, refreshAssetById: async id => context.index.find(asset => asset.id === id),
    listRecycledAssets: (root, { concurrency }) => {
      assert.equal(concurrency, 8);
      const read = Promise.withResolvers();
      requests.push({ root, read, permanentStarted: false });
      return read.promise;
    },
    listPermanentlyDeletedAssets: async root => {
      const request = requests.at(-1);
      assert.equal(request.root, root);
      request.permanentStarted = true;
      return [{ assetId: removed.id }];
    }
  });
  const filter = main.slice(main.indexOf("async function filterRecycledIndex("), main.indexOf("async function syncRecycleIndex("));
  const start = main.indexOf("  let detailDeletionCheck =");
  const end = main.indexOf('  ipcMain.handle("character:suitUnrealStatus",', start);
  vm.runInContext(filter + main.slice(start, end), context);

  const first = handler({}, fixture.id);
  const second = handler({}, removed.id);
  assert.equal(requests.length, 1, "overlapping card and edit reads share the journal check");
  assert.equal(requests[0].permanentStarted, true, "permanent deletion logs also start before recycle journals finish");
  requests[0].read.resolve([]);
  assert.equal((await first).asset, fixture);
  assert.equal((await second).asset, null);

  const later = handler({}, fixture.id);
  assert.equal(requests.length, 2, "a subsequent request reads the journals again");
  context.settings.customLibraryPath = "library-b";
  context.librarySelectionGeneration++;
  const current = handler({}, fixture.id);
  assert.equal(requests[2].root, "library-b");
  requests[1].read.resolve([{ assetId: fixture.id }]);
  assert.equal((await later).asset, null, "discard the check from the previous library");
  const concurrent = handler({}, fixture.id);
  assert.equal(requests.length, 3, "the old check cannot clear the current library's pending check");
  requests[2].read.resolve([]);
  assert.equal((await current).asset, fixture, "old deletion records cannot filter the current library");
  assert.equal((await concurrent).asset, fixture);
});

test("abandoned startup reads cannot leave duplicate library subscriptions", async () => {
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect"
      && node.arguments[0]?.getText(ast).includes("async function init()")) effect = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(effect);
  const code = ts.transpileModule(`const effect = ${effect.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const stage of ["settings", "index", "version", "complete"]) {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    let subscriptions = 0, removals = 0, reads = 0, activitySubscriptions = 0, ready = false;
    const wait = async (name, result) => { if (stage === name) await pending; return result; };
    const scope = { bridgeAvailable: true, createAssetIndexSync: syncExports.createAssetIndexSync,
      window: { setTimeout: () => 1, clearTimeout() {} },
      isWindowForeground: () => false,
      subscribeToWindowForeground: () => { activitySubscriptions++; return () => { activitySubscriptions--; }; },
      defaultSettings: { exportResolution: "4k" }, normalizeExportResolutionValue: value => value, normalizeDecalExportMode: value => value, normalizePlantExportMode: value => value,
      normalizeBlenderDecimationRatio: value => value,
      bridge: { getSettings: () => wait("settings", {}), getAssetIndex: () => { reads++; return wait("index", [fixture]); },
        getAppVersion: () => wait("version", { ok: true, version: "2.1.0" }),
        onAssetChange: () => { subscriptions++; return () => { removals++; }; } },
      setSettings() {}, setAllAssets() {}, setAssets() {}, setStatus() {}, setAppVersion() {}, setSettingsLoaded(value) { ready = value; }
    };
    const run = new Function("scope", `with (scope) { ${code}; return effect; }`)(scope);
    const cleanup = run();
    await setImmediate();
    assert.equal(ready, stage === "version" || stage === "complete", "version lookup must not gate the initial list");
    cleanup(); release(); await setImmediate();
    assert.equal(subscriptions, 1, "subscribe before settings, index and version reads");
    assert.equal(removals, subscriptions, stage);
    assert.equal(activitySubscriptions, 0, "unmount removes the window activity listener");
    assert.equal(reads, stage === "settings" ? 0 : 1, "startup reads the index once");
  }
});
