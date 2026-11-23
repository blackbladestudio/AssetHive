const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { setImmediate } = require("node:timers");
const { Buffer } = require("node:buffer");
const { gzipSync } = require("node:zlib");
const { createCacheProcess } = require("../electron/services/cacheProcess");
const { DatabaseSync } = require("node:sqlite");
const ts = require("typescript");
const { createAssetMetadata } = require("../electron/services/assetMetadata");
const { toAssetListRecord } = require("../electron/services/assetListRecord");

const source = fsSync.readFileSync(path.join(__dirname, "../electron/main.js"), "utf8");
const ast = ts.createSourceFile("main.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function declarations(names) {
  return names.map(name => {
    const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert.ok(node, name);
    return node.getText(ast);
  }).join("\n");
}

test("successful UE and Blender export requests leave legacy metadata bytes and timestamps unchanged", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-export-readonly-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const metaPath = path.join(root, "asset_info.json");
  await fs.writeFile(metaPath, JSON.stringify({ assetID: "asset", exportCount: 4, lastExportedAt: "2025-01-01" }));
  const before = await fs.readFile(metaPath), beforeStat = await fs.stat(metaPath);
  const asset = { id: "asset", source: "custom", metaPath, meta: JSON.parse(before) };
  const handlers = new Map(), calls = [];
  const context = vm.createContext({ index: [asset], settings: {}, appUpdates: null, activeExportCalls: 0,
    componentParentId: require('../shared/characterComponents.mjs').componentParentId,
    isCharacterUEAsset: require('../electron/services/characterSuitExport').isCharacterUEAsset,
    isAnimationUEAsset: require('../electron/services/animationUnrealExport').isAnimationUEAsset,
    recycleInProgress: false, filterRecycledIndex: async () => {},
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, refreshAssetById: async () => asset,
    exportToUnreal: async assets => { calls.push(assets); return { ok: true, exportedAssetIds: ["asset"], results: [{ status: "success" }] }; },
    exportToBlender: async assets => { calls.push(assets); return { ok: true, exportedAssetIds: ["asset"], results: [{ status: "success" }] }; },
    setMainWindowTaskbarProgress() {}, writeLog() {} });
  const start = source.indexOf("  const handleAssetExport =");
  const end = source.indexOf('  ipcMain.handle("assets:openFolder",', start);
  assert.ok(start > 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  for (const target of ["Unreal", "Blender"]) {
    const result = await handlers.get(`assets:exportTo${target}`)({ sender: { send() {} } }, { assetIds: ["asset"] });
    assert.equal(result.ok, true);
  }
  assert.equal(calls.length, 2);
  assert.deepEqual(await fs.readFile(metaPath), before);
  assert.equal((await fs.stat(metaPath)).mtimeMs, beforeStat.mtimeMs);
  assert.equal(asset.meta.exportCount, 4);
  assert.equal(context.activeExportCalls, 0);
});

test("new and legacy SQLite caches round-trip full and incremental saves without export counters", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-cache-columns-"));
  let context;
  t.after(async () => { context?.closeLibraryDb(); await fs.rm(root, { recursive: true, force: true }); });
  const cachePath = path.join(root, "index.sqlite");
  context = vm.createContext({ DatabaseSync, fsSync, path, toAssetListRecord, createCacheProcess, recordLibraryChanges: async () => {},
    getLibraryRootPath: () => path.join(root, "Library"), getLibrarySqlCachePath: () => cachePath,
    statOrNull: file => fs.stat(file).catch(() => null), applyUserFavorites: async () => {},
    writeLog(level, message, detail) { assert.notEqual(level, "WARN", `${message} ${JSON.stringify(detail)}`); },
    setImmediate });
  vm.runInContext(`let libraryDb = null, libraryDbPath = ""; ${declarations([
    "ensureLibraryDbSchema", "closeLibraryDb", "getLibraryDb", "extractAssetRelativeSize", "toSqlCacheAssetRow",
    "saveLibrarySqlCache", "applyLibrarySqlCacheChanges", "loadLocalScanMemoRecords", "loadLibrarySqlCache"
  ])}`, context);
  const asset = { id: "asset", name: "Original", source: "custom", exportCount: 7, lastExportedAt: "2025-01-01",
    path: path.join(root, "Library", "asset"), metaPath: path.join(root, "Library", "asset", "asset_info.json"),
    standardAssetTags: ["Dressing"], animationAffiliation: "Hero", modelFiles: ["mesh.fbx"],
    meta: { assetID: "original-id", slug: "3d_sm_env_zgnc_aitest_a", category: "Building",
      identity: { sourceKind: "pbrmax", sourceAssetId: "00312" }, scanInformation: { dimensions: { x: 1, y: 2, z: 3 } } } };
  for (const legacy of [false, true]) {
    const db = context.getLibraryDb();
    if (legacy) db.exec("ALTER TABLE assets ADD COLUMN exportCount INTEGER; ALTER TABLE assets ADD COLUMN lastExportedAt TEXT;");
    await context.saveLibrarySqlCache([asset]);
    await context.applyLibrarySqlCacheChanges({ upsertAssets: [{ ...asset, name: "Updated" }] });
    const records = await context.loadLibrarySqlCache();
    assert.equal(records.length, 1);
    assert.equal(records[0].name, "Updated");
    assert.equal(records[0].exportCount, undefined);
    assert.equal(records[0].lastExportedAt, undefined);
    assert.deepEqual(Array.from(records[0].standardAssetTags), ["Dressing"]);
    assert.equal(records[0].meta.slug, asset.meta.slug);
    assert.equal(records[0].meta.category, "Building");
    assert.equal(records[0].meta.assetID, "original-id");
    assert.equal(records[0].meta.identity.sourceAssetId, "00312");
    assert.equal(records[0].meta.scanInformation.dimensions.z, 3);
    if (!legacy) assert.equal(db.prepare("PRAGMA table_info(assets)").all().some(row => /exportcount|lastexportedat/i.test(row.name)), false);
  }
  const db = context.getLibraryDb();
  db.exec("UPDATE assets SET listRecordJson = NULL;");
  const memoPath = cachePath.replace(/\.sqlite$/, ".memo.json.gz");
  await fs.writeFile(memoPath, gzipSync(JSON.stringify({ version: 2, root: path.join(root, "Library"), assets: [{ record: asset }] })));
  const memoBefore = await fs.readFile(memoPath);
  const restored = await context.loadLibrarySqlCache();
  assert.equal(restored[0].name, "Updated", "legacy memo must not undo newer SQLite names or membership");
  assert.deepEqual(Array.from(restored[0].standardAssetTags), ["Dressing"]);
  assert.equal(restored[0].meta.slug, asset.meta.slug);
  assert.deepEqual(await fs.readFile(memoPath), memoBefore);
});

test("recorded animation covers are saved through the derived cache without changing the asset index", async () => {
  const archive = path.resolve("library", "Animation");
  const modelPath = path.join(archive, "AS_Walk.fbx");
  const localCover = path.resolve("local-cache", "cover.webm");
  const asset = {
    id: "AS_Walk", name: "Walk", source: "custom", assetType: "animation", path: archive, metaPath: modelPath,
    modelFiles: [modelPath], meta: { identity: { contentFingerprint: "unchanged" } }
  };
  const writes = [];
  const before = JSON.stringify(asset);
  const context = vm.createContext({
    index: [asset], librarySelectionGeneration: 1, recycleInProgress: false, Buffer, ArrayBuffer,
    normalizePath: file => file.replaceAll("\\", "/"), normalizeComparePath: file => path.resolve(file).toLowerCase(),
    getSharedDerivedCache: () => ({ saveAnimationPreview: async (...args) => { writes.push(args); return localCover; } })
  });
  vm.runInContext(declarations(["cacheAnimationPreview"]), context);
  const bytes = new ArrayBuffer(32);
  const key = "a".repeat(64);
  assert.equal(await context.cacheAnimationPreview({ assetId: asset.id, modelPath: `${modelPath}.fbx`, key, bytes }), "");
  assert.equal(await context.cacheAnimationPreview({ assetId: asset.id, modelPath, key, bytes }), localCover.replaceAll("\\", "/"));
  assert.deepEqual(writes, [[modelPath, key, Buffer.from(bytes)]]);
  assert.equal(context.index[0], asset);
  assert.equal(JSON.stringify(asset), before);
});

test("new metadata omits export tracking while legacy fields are preserved without a migration", () => {
  const metadata = createAssetMetadata({ assetID: "new", name: "New", assetType: "3d" });
  assert.equal(metadata.exportCount, undefined);
  assert.equal(metadata.lastExportedAt, undefined);
  assert.equal(createAssetMetadata({ ...metadata, exportCount: 9 }).exportCount, 9);
});
