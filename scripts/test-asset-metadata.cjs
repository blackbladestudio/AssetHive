const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  ASSET_METADATA_FILE_NAME,
  ASSET_METADATA_SCHEMA_VERSION,
  createAssetMetadata,
  validateAssetMetadata,
  writeAssetMetadata,
  writeAssetMetadataSync,
  updateAssetMetadataFile
} = require("../electron/services/assetMetadata");
const { writeFileAtomic, writeFileAtomicSync } = require("../electron/services/atomicFile");
const fsSync = require("node:fs");
const { spawnSync } = require("node:child_process");

// Windows may delay removing recently closed files. Bound cleanup retries and
// keep persistent failures visible instead of suppressing teardown errors.

test("saving metadata removes blank slots and preserves missing file references", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-empty-slots-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const missingModel = path.join(root, "missing.fbx");
  const missingTexture = path.join(root, "missing.png");
  const input = { id: "empty-slots", name: "Slots", assetType: "3d",
    modelSlots: { Mesh: missingModel, Mesh02: "   " }, textureSlots: { Normal: missingTexture, Diffuse: "" },
    modelFiles: [missingModel, ""], textureFiles: [missingTexture, " "],
    modelVariants: [{ file: missingModel, variantKey: "01" }, { file: "" }],
    modelLods: [{ file: missingModel, lod: 1 }, { file: " " }],
    textureEntries: [{ uri: missingTexture, textureType: "Normal", areaIndex: 2, materialRole: "atlas", width: 4096 }, { uri: " ", textureType: "Diffuse" }],
    components: [{ type: "model", uri: missingModel }, { type: "texture", uri: missingTexture },
      { type: "model", uri: "" }, { type: "texture", uri: " " }, { type: "custom", value: "keep" }] };
  const before = globalThis.structuredClone(input);
  const { metaPath } = await writeAssetMetadata(root, input);
  const saved = JSON.parse(await fs.readFile(metaPath, "utf8"));
  assert.deepEqual(saved.modelSlots, { Mesh: missingModel });
  assert.deepEqual(saved.textureSlots, { Normal: missingTexture });
  assert.deepEqual(saved.modelFiles, [missingModel]);
  assert.deepEqual(saved.textureFiles, [missingTexture]);
  assert.deepEqual(saved.modelVariants, [input.modelVariants[0]]);
  assert.deepEqual(saved.modelLods, [input.modelLods[0]]);
  assert.deepEqual(saved.textureEntries, [input.textureEntries[0]]);
  assert.deepEqual(saved.components, [input.components[0], input.components[1], input.components[4]]);
  assert.deepEqual(input, before);
});

test("metadata unifies standalone opacity aliases without dropping texture metadata or renaming compound maps", () => {
  const legacyEntry = { textureType: "OpacityMasked", areaIndex: 2, materialRole: "billboard", uri: "old.png", width: 4096, sourceWidth: 8192, compressed: true };
  const legacyComponent = { type: "texture", slot: "002_OpacityMask", uri: "old.png", areaIndex: 2, materialRole: "billboard" };
  for (const slots of [
    { OpacityMasked: "old.png", Opacity: "chosen.png" },
    { Opacity: "chosen.png", OpacityMasked: "old.png" }
  ]) {
    const meta = createAssetMetadata({ id: "opacity-test", name: "Sample", assetType: "3dplant",
      textureSlots: { ...slots, "002_OpacityMask|billboard": "billboard.png", AlbedoOpacityMasked: "packed.png" },
      textureEntries: [legacyEntry, { textureType: "OpacityMaskRoughnessTranslucency", uri: "ort.png" }],
      components: [legacyComponent, { type: "model", slot: "OpacityMask", uri: "mesh.fbx" }] });
    assert.deepEqual(meta.textureSlots, { Opacity: "chosen.png", "002_Opacity|billboard": "billboard.png", AlbedoOpacityMasked: "packed.png" });
    assert.deepEqual(meta.textureEntries[0], { ...legacyEntry, textureType: "Opacity" });
    assert.deepEqual(meta.components[0], { ...legacyComponent, slot: "002_Opacity" });
    assert.equal(meta.textureEntries[1].textureType, "OpacityMaskRoughnessTranslucency");
    assert.equal(meta.components[1].slot, "OpacityMask");
    assert.deepEqual(createAssetMetadata(meta), meta);
    assert.equal(legacyEntry.textureType, "OpacityMasked");
    assert.equal(legacyComponent.slot, "002_OpacityMask");
  }
});

test("Surface metadata drops the Tile standard tag while retaining the Tile category", () => {
  const meta = createAssetMetadata({ id: "tile-test", name: "Sample", assetType: "surface",
    category: "Tile", standardAssetTags: ["Tile"] });
  assert.deepEqual(meta.standardAssetTags, []);
  assert.equal(meta.category, "Tile");
  assert.ok(meta.tags.includes("Tile"));
});

test("canonical metadata merges legacy source standards into ThirdParty without losing source tags", () => {
  for (const assetType of ["3d", "3dplant", "surface", "decal"]) {
    for (const source of ["Megascans", "PBRMAX"]) {
      const meta = createAssetMetadata({ id: "source-test", name: "Sample", assetType,
        standardAssetTags: [source, "ThirdParty"], tags: ["custom"] });
      assert.deepEqual(meta.standardAssetTags, ["ThirdParty"]);
      assert.ok(meta.tags.includes(source));
      assert.ok(meta.tags.includes("custom"));
      assert.ok(meta.semanticTags.contains.includes(source));
      assert.deepEqual(createAssetMetadata(meta).tags, meta.tags);
    }
  }
});

test("interrupted metadata write keeps the previous complete document", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-metadata-interrupted-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const target = path.join(directory, "asset_info.json");
  const original = JSON.stringify({ assetID: "keep", notes: "previous durable metadata" });
  await fs.writeFile(target, original);
  const result = spawnSync(process.execPath, ["-e", `
    const fs = require('node:fs/promises');
    const write = fs.writeFile;
    fs.writeFile = async (file) => { await write(file, '{partial', { flag: 'wx' }); process.exit(23); };
    require(${JSON.stringify(require.resolve("../electron/services/atomicFile"))}).writeFileAtomic(process.argv[1], '{}');
  `, target]);
  assert.equal(result.status, 23, result.stderr.toString());
  assert.equal(await fs.readFile(target, "utf8"), original);
});

test("failed metadata replacement preserves original bytes and cleans the temporary file", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-metadata-failed-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const target = path.join(directory, "asset_info.json");
  await fs.writeFile(target, '{"keep":true}');
  const rename = fs.rename;
  fs.rename = async () => { throw Object.assign(new Error("SMB disconnected"), { code: "EIO" }); };
  try {
    await assert.rejects(writeFileAtomic(target, '{"keep":false}'), /SMB disconnected/);
    assert.equal(await fs.readFile(target, "utf8"), '{"keep":true}');
    assert.deepEqual(await fs.readdir(directory), ["asset_info.json"]);
  } finally { fs.rename = rename; }

  const renameSync = fsSync.renameSync;
  fsSync.renameSync = () => { throw new Error("sync replacement failed"); };
  try {
    assert.throws(() => writeFileAtomicSync(target, "{}"), /sync replacement failed/);
    assert.equal(await fs.readFile(target, "utf8"), '{"keep":true}');
    assert.deepEqual(await fs.readdir(directory), ["asset_info.json"]);
  } finally { fsSync.renameSync = renameSync; }
});

test("transient fsync failures retry fresh flushed files before publishing metadata", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-metadata-flush-retry-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const target = path.join(directory, "asset_info.json");
  const previous = '{"keep":"previous"}';
  const next = '{"keep":"new完整元数据"}';
  await fs.writeFile(target, previous);
  const write = fs.writeFile;
  const attempts = [];
  fs.writeFile = async (file, data, options) => {
    attempts.push(file);
    assert.equal(options.flush, true);
    assert.equal(options.flag, "wx");
    assert.equal(await fs.readFile(target, "utf8"), previous);
    if (attempts.length <= 2) {
      await write(file, data, { ...options, flush: false });
      throw Object.assign(new Error("UNKNOWN: unknown error, fsync"), { code: "UNKNOWN", syscall: "fsync" });
    }
    return write(file, data, options);
  };
  try { await writeFileAtomic(target, next); }
  finally { fs.writeFile = write; }
  assert.equal(attempts.length, 3);
  assert.equal(new Set(attempts).size, 3);
  assert.equal(await fs.readFile(target, "utf8"), next);
  assert.deepEqual(await fs.readdir(directory), ["asset_info.json"]);
});

test("persistent fsync failures stay bounded, identify the target, and preserve old metadata", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-metadata-flush-failed-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const target = path.join(directory, "asset_info.json");
  const previous = '{"keep":true}';
  await fs.writeFile(target, previous);
  const write = fs.writeFile;
  let attempts = 0;
  const failure = Object.assign(new Error("UNKNOWN: unknown error, fsync"), { code: "UNKNOWN", syscall: "fsync" });
  fs.writeFile = async (file, data, options) => {
    attempts++;
    await write(file, data, { ...options, flush: false });
    throw failure;
  };
  try {
    await assert.rejects(writeFileAtomic(target, "{}"), error => {
      assert.equal(error.cause, failure);
      assert.equal(error.code, "UNKNOWN");
      assert.equal(error.syscall, "fsync");
      assert.equal(error.path, target);
      assert.ok(error.message.includes(target));
      assert.ok(error.message.includes("未替换原文件"));
      return true;
    });
  } finally { fs.writeFile = write; }
  assert.equal(attempts, 4);
  assert.equal(await fs.readFile(target, "utf8"), previous);
  assert.deepEqual(await fs.readdir(directory), ["asset_info.json"]);
});

test("disk-full, permission and ordinary write errors fail without flush retries", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-metadata-write-failed-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const target = path.join(directory, "asset_info.json");
  const previous = '{"keep":true}';
  await fs.writeFile(target, previous);
  const write = fs.writeFile;
  for (const [code, syscall] of [["ENOSPC", "fsync"], ["EACCES", "fsync"], ["ENOTSUP", "fsync"], ["UNKNOWN", "write"]]) {
    let attempts = 0;
    const failure = Object.assign(new Error(`${code}: ${syscall}`), { code, syscall });
    fs.writeFile = async () => { attempts++; throw failure; };
    try { await assert.rejects(writeFileAtomic(target, "{}"), error => error.code === code && error.syscall === syscall); }
    finally { fs.writeFile = write; }
    assert.equal(attempts, 1);
    assert.equal(await fs.readFile(target, "utf8"), previous);
    assert.deepEqual(await fs.readdir(directory), ["asset_info.json"]);
  }
});

test("synchronous fsync failure identifies the target and preserves the previous file", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-metadata-sync-flush-failed-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const target = path.join(directory, "asset_info.json");
  await fs.writeFile(target, '{"keep":true}');
  const write = fsSync.writeFileSync;
  fsSync.writeFileSync = (file, data, options) => {
    assert.equal(options.flush, true);
    write(file, data, { ...options, flush: false });
    throw Object.assign(new Error("UNKNOWN: unknown error, fsync"), { code: "UNKNOWN", syscall: "fsync" });
  };
  try { assert.throws(() => writeFileAtomicSync(target, "{}"), error => error.path === target && error.message.includes(target)); }
  finally { fsSync.writeFileSync = write; }
  assert.equal(await fs.readFile(target, "utf8"), '{"keep":true}');
  assert.deepEqual(await fs.readdir(directory), ["asset_info.json"]);
});

test("overlapping long and short metadata writes publish complete JSON without trailing bytes", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-metadata-concurrent-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const target = path.join(directory, "asset_info.json");
  await fs.writeFile(target, "{}");
  const write = fs.writeFile;
  let release;
  let opened;
  const blocked = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { opened = resolve; });
  fs.writeFile = async (file, data, options) => {
    if (data.includes('"slow"')) {
      // Simulate a suspended write after open/truncate. With direct overwrite,
      // the other writer would share this destination and leave a stale tail.
      const handle = await fs.open(file, options.flag);
      opened();
      await blocked;
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    } else await write.call(fs, file, data, options);
  };
  let slow;
  try {
    slow = writeFileAtomic(target, JSON.stringify({ slow: "x".repeat(50000) }));
    await started;
    await writeFileAtomic(target, '{"short":true}');
    assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), { short: true });
    release();
    await slow;
    assert.equal(JSON.parse(await fs.readFile(target, "utf8")).slow.length, 50000);
    assert.deepEqual(await fs.readdir(directory), ["asset_info.json"]);
  } finally {
    release();
    try { await slow; } finally { fs.writeFile = write; }
  }
});

test("overlapping backfills merge current fields and keep JSON contentLength accurate", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-metadata-merge-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const { metaPath } = await writeAssetMetadata(directory, { assetID: "merge", name: "Merge", assetType: "3d" });
  await Promise.all([
    updateAssetMetadataFile(metaPath, (meta) => ({ ...meta, scanInformation: { dimensions: { x: 1, y: 2, z: 3 } } })),
    updateAssetMetadataFile(metaPath, (meta) => ({ ...meta, textureAnalysis: { version: 1 } })),
    updateAssetMetadataFile(metaPath, (meta) => ({ ...meta, customRevision: 2 }))
  ]);
  const raw = await fs.readFile(metaPath, "utf8");
  const meta = JSON.parse(raw);
  assert.equal(meta.scanInformation.dimensions.x, 1);
  assert.equal(meta.textureAnalysis.version, 1);
  assert.equal(meta.customRevision, 2);
  assert.equal(meta.json.contentLength, Buffer.byteLength(raw));
  await fs.writeFile(metaPath, "{broken");
  await assert.rejects(updateAssetMetadataFile(metaPath, () => ({})), SyntaxError);
  assert.equal(await fs.readFile(metaPath, "utf8"), "{broken");
});

test("asset metadata standard writes asset_info.json with canonical fields", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-metadata-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const createdAt = "2026-09-18T01:00:00.000Z";
  const metadata = createAssetMetadata({
    assetID: "props_zg_ding_ab12cd3",
    name: "ZG Ding",
    slug: "props_zg_ding_ab12cd3",
    assetType: "3d",
    topCategory: "3D Assets",
    standardAssetTags: ["Props"],
    zionTags: ["HeroProp"],
    hasCollision: false,
    category: "Props",
    tags: ["Interior"],
    components: [],
    modelFiles: [],
    modelSlots: {},
    modelLods: [{ file: "SM_ZG_Ding_LOD1.fbx", slot: "Mesh", variantKey: "01", variantNumber: 1, lod: 1 }],
    textureFiles: [],
    textureSlots: {},
    textureEntries: [],
    normalMapFormats: { 1: "dx" },
    createdAt
  }, { now: createdAt });

  assert.equal(metadata.schemaVersion, ASSET_METADATA_SCHEMA_VERSION);
  assert.equal(metadata.id, metadata.assetID);
  assert.equal(metadata.asset_type, metadata.assetType);
  assert.equal(metadata.json.uri, ASSET_METADATA_FILE_NAME);
  assert.deepEqual(metadata.standardAssetTags, ["Props"]);
  assert.deepEqual(metadata.zionTags, ["HeroProp"]);
  assert.equal(metadata.modelLods[0].lod, 1);
  assert.equal(metadata.hasCollision, false);
  assert(metadata.tags.includes("HeroProp"));
  assert(metadata.tags.includes("Props"));
  assert(metadata.tags.includes("3d"));
  assert(metadata.tags.includes("Props"));
  assert.equal(validateAssetMetadata(metadata).ok, true);

  const written = await writeAssetMetadata(directory, metadata, { now: createdAt });
  assert.equal(path.basename(written.metaPath), ASSET_METADATA_FILE_NAME);

  const text = await fs.readFile(written.metaPath, "utf8");
  const saved = JSON.parse(text);
  assert.equal(saved.schemaVersion, ASSET_METADATA_SCHEMA_VERSION);
  assert.equal(saved.json.uri, ASSET_METADATA_FILE_NAME);
  assert.equal(saved.json.contentLength, Buffer.byteLength(text, "utf8"));
  assert.equal(saved.hasCollision, false);
  assert.equal(saved.modelLods[0].variantKey, "01");
  assert.equal(saved.createdAt, createdAt);
  assert.equal(saved.updatedAt, createdAt);
  assert.equal(validateAssetMetadata(saved).ok, true);
});

test("asset metadata updates preserve createdAt and advance updatedAt", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-metadata-update-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const first = writeAssetMetadataSync(directory, {
    assetID: "surface_rock_abc1234",
    name: "Rock",
    assetType: "surface",
    category: "Rock",
    standardAssetTags: [],
    zionTags: ["Environment"],
    normalMapFormat: "opengl",
    normalMapFormats: { 1: "opengl" }
  }, { now: "2026-09-18T01:00:00.000Z" });

  const updated = writeAssetMetadataSync(directory, {
    ...first.meta,
    name: "Rock Updated",
    tags: [...first.meta.tags, "Updated"]
  }, { updatedAt: "2026-09-18T02:00:00.000Z" });

  assert.equal(updated.meta.createdAt, "2026-09-18T01:00:00.000Z");
  assert.equal(updated.meta.updatedAt, "2026-09-18T02:00:00.000Z");
  assert.equal(updated.meta.name, "Rock Updated");
  assert.equal(updated.meta.tags.includes("Updated"), true);
  assert.deepEqual(updated.meta.zionTags, ["Environment"]);
  assert.equal(updated.meta.normalMapFormat, "opengl");
  assert.equal(validateAssetMetadata(updated.meta).ok, true);
});

test("asset metadata rejects incomplete canonical identity", () => {
  assert.throws(() => createAssetMetadata({ name: "Missing ID", assetType: "3d" }), /assetID/);
  assert.throws(() => createAssetMetadata({ assetID: "missing-name", assetType: "3d" }), /name/);
  assert.throws(() => createAssetMetadata({ assetID: "missing-type", name: "Missing Type" }), /assetType/);
});
test("asset metadata keeps zionTags backward compatible with schemaVersion 1.0", () => {
  const metadata = createAssetMetadata({
    assetID: "legacy_surface_0001",
    name: "Legacy Surface",
    assetType: "surface",
    category: "Rock",
    normalMapFormats: {}
  });
  assert.deepEqual(metadata.zionTags, []);
  const legacy = { ...metadata };
  delete legacy.zionTags;
  assert.equal(validateAssetMetadata(legacy).ok, true);
});

test("animation metadata stays in memory and does not require a sidecar file name", () => {
  const metadata = createAssetMetadata({
    assetID: "animabc1",
    name: "AS_Walk_F",
    slug: "AS_Walk_F",
    assetType: "animation",
    topCategory: "animation",
    category: "基础移动",
    animationAffiliation: "主角",
    zionTags: ["基础移动"],
    modelFiles: ["Z:\\Artist\\AssetLibrary\\Animation\\Hero\\Male_01\\WP00_Unarm\\Locomotion\\AS_Walk_F.fbx"],
    modelSlots: { Mesh: "Z:\\Artist\\AssetLibrary\\Animation\\Hero\\Male_01\\WP00_Unarm\\Locomotion\\AS_Walk_F.fbx" }
  }, { now: "2026-09-21T01:00:00.000Z" });

  assert.equal(metadata.animationAffiliation, "主角");
  assert(metadata.tags.includes("主角"));
  assert(metadata.tags.includes("基础移动"));
  assert.equal(validateAssetMetadata(metadata).ok, true);
  assert.equal(metadata.json.uri, ASSET_METADATA_FILE_NAME);
});
