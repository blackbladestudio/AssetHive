const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const { gzipSync } = require("node:zlib");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// 安装 sharp 计数器之后再加载扫描器：扫描器在模块加载时捕获 sharp 引用。
let sharpCalls = 0;
try {
  const sharpPath = require.resolve("sharp");
  const realSharp = require(sharpPath);
  function countingSharp(...args) {
    sharpCalls += 1;
    return realSharp(...args);
  }
  Object.assign(countingSharp, realSharp);
  require.cache[sharpPath].exports = countingSharp;
} catch {
  // sharp 不可用时跳过图片读取断言。
}

const { scanLibrary: scanReadOnly, scanLibraryInWorker } = require("../electron/services/assetScanner");

// These existing cases exercise the legacy maintenance memo/backfill contract.
// Ordinary read-only behavior and per-client local memos are covered below.
const scanLibrary = (root, options = {}) => scanReadOnly(root, {
  maintenance: true, writeSharedMemo: true, ...options
});

async function localMemoFixture(t) {
  const local = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-local-scan-"));
  t.after(() => fs.rm(local, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}));
  return local;
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/v8/AwAJoAP+2GZ4WQAAAABJRU5ErkJggg==",
  "base64"
);

const MEMO_DIR = ".assethive";
const MEMO_GZ = "custom-index.json.gz";
const MEMO_JSON = "custom-index.json";

async function makeAsset(root, name, options = {}) {
  const withResolution = options.withResolution !== false;
  const withAnalysis = options.withAnalysis !== false;
  const assetDir = path.join(root, "Environment", "3D Assets", "Props", name);
  await fs.mkdir(path.join(assetDir, "Preview"), { recursive: true });
  const textureName = `T_Diffuse_${name}.png`;
  await fs.writeFile(path.join(assetDir, textureName), PNG_1X1);
  await fs.writeFile(path.join(assetDir, `${name}.fbx`), Buffer.alloc(64, 1));
  await fs.writeFile(path.join(assetDir, `Preview/${name}_thumb.png`), PNG_1X1);
  await fs.writeFile(path.join(assetDir, `Preview/${name}.jpg`), PNG_1X1);
  const textureEntries = [{ textureType: "Diffuse", slot: "diffuse", uri: textureName, path: textureName, areaIndex: 1 }];
  if (withResolution) {
    textureEntries[0].width = 1;
    textureEntries[0].height = 1;
    textureEntries[0].resolution = "1px";
  }
  const meta = {
    schemaVersion: "1.0",
    id: name,
    assetID: name,
    name,
    source: "custom",
    assetType: "3d",
    asset_type: "3d",
    topCategory: "environment",
    standardAssetTags: ["Props"],
    category: "Props",
    tags: ["props", "3d"],
    categories: ["environment", "3d", "props"],
    semanticTags: { name, asset_type: "3d", contains: ["props"], theme: ["props"], descriptive: [], state: [], subject_matter: "props", environment: [] },
    previews: { images: [{ uri: `${name}.jpg` }], relativeSize: "1x1" },
    components: [],
    modelFiles: [`${name}.fbx`],
    modelSlots: { model: `${name}.fbx` },
    textureFiles: [textureName],
    textureSlots: { diffuse: textureName },
    textureEntries,
    normalMapFormat: "dx",
    scanInformation: { dimensions: { x: 1.2, y: 0.8, z: 0.6 }, dimensionsSource: "measured" },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    json: { uri: "asset_info.json", contentLength: 0 }
  };
  if (withAnalysis) {
    meta.textureAnalysis = {
      version: 1,
      status: "analyzed",
      smallAsset: true,
      uses4KTexture: false,
      requiresReview: false,
      dimensions: { x: 1.2, y: 0.8, z: 0.6 },
      dimensionsSource: "measured",
      maxDimensionMeters: 1.2,
      sizeThresholdMeters: 5,
      textureThresholdPixels: 4096,
      maxTextureDimension: 1,
      textureCount: 1,
      inspectedTextureCount: 1,
      unreadableTextureCount: 0,
      fourKTextureCount: 0,
      fourKTextureFiles: [],
      textureFingerprint: "seeded",
      dimensionFingerprint: "1.2|0.8|0.6",
      analyzedAt: "2026-09-01T00:00:00.000Z"
    };
  }
  await fs.writeFile(path.join(assetDir, "asset_info.json"), JSON.stringify(meta, null, 2));
  return assetDir;
}

async function makeLibrary(t, count, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-scan-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => {}));
  const dirs = [];
  for (let index = 0; index < count; index += 1) {
    dirs.push(await makeAsset(root, `asset_${String(index).padStart(3, "0")}`, options));
  }
  return { root, dirs };
}

async function scanWithTiming(root) {
  const timing = {};
  const index = await scanLibrary(root, {
    onProgress: () => {},
    onRecord: () => {},
    onTiming: (payload) => Object.assign(timing, payload)
  });
  return { index, timing };
}

async function removeMemo(root) {
  await fs.rm(path.join(root, MEMO_DIR), { recursive: true, force: true }).catch(() => {});
}

test("scan memo is stored gzipped and unchanged scans do not rewrite it", async (t) => {
  const { root, dirs } = await makeLibrary(t, 8);
  await removeMemo(root);
  await scanWithTiming(root);

  const memoPath = path.join(root, MEMO_DIR, MEMO_GZ);
  const firstMemo = await fs.stat(memoPath);
  assert.ok(firstMemo.size > 0, "the scan memo must be written");
  await assert.rejects(fs.stat(path.join(root, MEMO_DIR, MEMO_JSON)), "the legacy uncompressed memo must not be created");

  const statTargets = [];
  const originalStat = fs.stat;
  fs.stat = async function patched(target, ...rest) {
    statTargets.push(String(target));
    return originalStat.call(this, target, ...rest);
  };
  let timing;
  try {
    ({ timing } = await scanWithTiming(root));
  } finally {
    fs.stat = originalStat;
  }

  const secondMemo = await fs.stat(memoPath);
  assert.equal(secondMemo.mtimeMs, firstMemo.mtimeMs, "an unchanged library must not rewrite the memo");
  assert.equal(timing.cacheHits, dirs.length, "every unchanged asset must reuse the memo");
  assert.equal(timing.rebuilt, 0, "no asset should be rebuilt");

  const metaStats = statTargets.filter((target) => path.basename(target).toLowerCase() === "asset_info.json");
  assert.equal(metaStats.length, dirs.length, "each asset is validated with exactly one meta stat");
  const assetDirStat = statTargets.filter((target) => dirs.some((dir) => dir.toLowerCase() === String(target).toLowerCase()));
  assert.equal(assetDirStat.length, 0, "cached scans must not stat asset directories");
});

test("cold scan resolves referenced files from the directory listing and reuses metadata analysis", async (t) => {
  const { root, dirs } = await makeLibrary(t, 6);
  await removeMemo(root);
  sharpCalls = 0;

  const statTargets = [];
  const originalStat = fs.stat;
  fs.stat = async function patched(target, ...rest) {
    statTargets.push(String(target));
    return originalStat.call(this, target, ...rest);
  };
  let index;
  try {
    ({ index } = await scanWithTiming(root));
  } finally {
    fs.stat = originalStat;
  }

  assert.equal(index.length, dirs.length);
  const textureStats = statTargets.filter((target) => /\.png$/i.test(target) || /\.fbx$/i.test(target));
  assert.equal(textureStats.length, 0, "metadata-referenced textures/models must not be stat'ed one by one");
  assert.equal(sharpCalls, 0, "persisted texture analysis must be reused without opening images");
});

test("metadata backfills refresh the memo mtime so the next scan is a cache hit", async (t) => {
  const { root, dirs } = await makeLibrary(t, 5, { withResolution: false, withAnalysis: false });
  await removeMemo(root);

  const first = await scanWithTiming(root);
  assert.equal(first.index.length, dirs.length);
  assert.equal(first.timing.rebuilt, dirs.length, "the first scan rebuilds every asset");
  assert.equal(first.timing.metaWrites, dirs.length, "missing resolution/analysis is backfilled into asset_info.json");

  const second = await scanWithTiming(root);
  assert.equal(second.timing.cacheHits, dirs.length, "assets backfilled during a scan must be cache hits on the next scan");
  assert.equal(second.timing.rebuilt, 0);
  assert.equal(second.timing.metaWrites, 0);
});

test("mixed standard and legacy metadata assets are all discovered, including UTF-8 BOM", async (t) => {
  const { root, dirs } = await makeLibrary(t, 2);
  const standard = path.join(dirs[1], "asset_info.json");
  const raw = await fs.readFile(standard, "utf8");
  await fs.writeFile(path.join(dirs[1], "legacy.json"), `\uFEFF${raw}`);
  await fs.rm(standard);
  const { index } = await scanWithTiming(root);
  assert.equal(index.length, 2);
  assert.ok(index.some((asset) => asset.metaPath.endsWith("legacy.json")));
});

test("legacy packages retain unreferenced nested media discovery alongside standard assets", async (t) => {
  const { root } = await makeLibrary(t, 1);
  const dir = path.join(root, "Legacy");
  await fs.mkdir(path.join(dir, "Textures", "2K"), { recursive: true });
  await fs.writeFile(path.join(dir, "old.json"), JSON.stringify({ id: "legacy-nested", name: "Legacy nested", assetType: "surface" }));
  await fs.writeFile(path.join(dir, "Textures", "2K", "diffuse.png"), PNG_1X1);
  const result = await scanWithTiming(root);
  assert.equal(result.index.length, 2);
  assert.equal(result.index.find((asset) => asset.id === "legacy-nested").textureFiles.length, 1);
});

test("metadata restored with an older timestamp invalidates the cached card", async (t) => {
  const { root, dirs } = await makeLibrary(t, 1);
  await scanWithTiming(root);
  const target = path.join(dirs[0], "asset_info.json");
  const meta = JSON.parse(await fs.readFile(target, "utf8"));
  meta.name = "restored asset";
  await fs.writeFile(target, JSON.stringify(meta));
  await fs.utimes(target, new Date(0), new Date(0));
  const result = await scanWithTiming(root);
  assert.equal(result.index[0].name, "restored asset");
  assert.equal(result.timing.rebuilt, 1);
});

test("failed subtree retains its cached cards, while confirmed deletions disappear", async (t) => {
  const { root, dirs } = await makeLibrary(t, 3);
  await scanWithTiming(root);
  await fs.rm(dirs[2], { recursive: true, force: true });
  const original = fs.readdir;
  const warnings = [];
  fs.readdir = async function (target, ...args) {
    if (String(target) === dirs[1]) throw Object.assign(new Error("share unavailable"), { code: "EACCES" });
    return original.call(this, target, ...args);
  };
  try {
    const result = await scanLibrary(root, { onWarning: (warning) => warnings.push(warning) });
    assert.equal(result.length, 2, "a failed read is not a deletion");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].path, dirs[1]);
  } finally {
    fs.readdir = original;
  }
  const recovered = await scanWithTiming(root);
  assert.equal(recovered.index.length, 2);
  assert.equal(recovered.timing.cacheHits, 2);
});

test("transient share reads retry, persistent metadata errors preserve the previous card", async (t) => {
  const { root, dirs } = await makeLibrary(t, 1);
  const target = path.join(dirs[0], "asset_info.json");
  const originalStat = fs.stat;
  let attempts = 0;
  fs.stat = async function (file, ...args) {
    if (String(file) === target && attempts++ < 2) throw Object.assign(new Error("network busy"), { code: "EBUSY" });
    return originalStat.call(this, file, ...args);
  };
  try {
    assert.equal((await scanWithTiming(root)).index.length, 1);
    assert.equal(attempts, 3);
  } finally {
    fs.stat = originalStat;
  }
  await fs.writeFile(target, "{incomplete");
  const warnings = [];
  const retained = await scanLibrary(root, { onWarning: (warning) => warnings.push(warning) });
  assert.equal(retained.length, 1);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].path, target);
});

test("read-only metadata backfills cannot hide otherwise readable assets", async (t) => {
  const { root, dirs } = await makeLibrary(t, 2, { withResolution: false, withAnalysis: false });
  const before = await Promise.all(dirs.map((dir) => fs.readFile(path.join(dir, "asset_info.json"), "utf8")));
  const warnings = [];
  const original = fs.writeFile;
  fs.writeFile = async function (target, ...args) {
    if (path.basename(String(target)).startsWith("asset_info.json")) throw Object.assign(new Error("read-only share"), { code: "EACCES" });
    return original.call(this, target, ...args);
  };
  try {
    const result = await scanLibrary(root, { onWarning: (warning) => warnings.push(warning) });
    assert.equal(result.length, dirs.length);
    assert.ok(warnings.length > 0);
    assert.ok(warnings.every((warning) => warning.operation === "metadata-write" && warning.code === "EACCES"));
    assert.deepEqual(await Promise.all(dirs.map((dir) => fs.readFile(path.join(dir, "asset_info.json"), "utf8"))), before);
  } finally {
    fs.writeFile = original;
  }
});

test("cold scan reuses the discovery listing instead of enumerating each asset twice", async (t) => {
  const { root, dirs } = await makeLibrary(t, 8);
  const original = fs.readdir;
  let reads = 0;
  fs.readdir = async function (target, ...args) {
    if (dirs.includes(String(target))) reads += 1;
    return original.call(this, target, ...args);
  };
  try {
    assert.equal((await scanWithTiming(root)).index.length, dirs.length);
    assert.equal(reads, dirs.length);
  } finally {
    fs.readdir = original;
  }
});

test("unavailable library root rejects instead of reporting a successful empty scan", async (t) => {
  const { root } = await makeLibrary(t, 0);
  await assert.rejects(scanLibrary(path.join(root, "offline")), { code: "ENOENT" });
});

test("nested texture references use one directory read rather than one stat per map", async (t) => {
  const { root, dirs } = await makeLibrary(t, 1);
  const textures = path.join(dirs[0], "Textures");
  await fs.mkdir(textures);
  const metaPath = path.join(dirs[0], "asset_info.json");
  const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
  meta.assetType = meta.asset_type = "surface";
  meta.textureFiles = [];
  for (let i = 0; i < 16; i += 1) {
    const name = `map_${i}.png`;
    await fs.writeFile(path.join(textures, name), PNG_1X1);
    meta.textureFiles.push(`Textures/${name}`);
  }
  await fs.writeFile(metaPath, JSON.stringify(meta));
  const originalRead = fs.readdir;
  const originalStat = fs.stat;
  let reads = 0;
  let stats = 0;
  fs.readdir = async function (target, ...args) {
    if (String(target) === textures) reads += 1;
    return originalRead.call(this, target, ...args);
  };
  fs.stat = async function (target, ...args) {
    if (path.dirname(String(target)) === textures) stats += 1;
    return originalStat.call(this, target, ...args);
  };
  try {
    const { index } = await scanWithTiming(root);
    assert.equal(index[0].textureFiles.filter((file) => file.includes("/Textures/")).length, 16);
    assert.equal(stats, 0);
    assert.equal(reads, 1);
  } finally {
    fs.readdir = originalRead;
    fs.stat = originalStat;
  }
});

test("manual refresh rebuilds cards even when metadata stat and top-level names are unchanged", async (t) => {
  const { root, dirs } = await makeLibrary(t, 1);
  await scanWithTiming(root);
  const target = path.join(dirs[0], "Preview", "asset_000_thumb.png");
  await fs.rm(target);
  const timing = {};
  const index = await scanLibrary(root, { refreshMetadata: true, onTiming: (value) => Object.assign(timing, value) });
  assert.equal(index.length, 1);
  assert.notEqual(index[0].previewImage, target.replaceAll("\\", "/"));
  assert.equal(timing.cacheHits, 0);
  assert.equal(timing.rebuilt, 1);
  const next = await scanWithTiming(root);
  assert.equal(next.index[0].previewImage, index[0].previewImage, "refreshed nested files must remain correct on the next cached scan");
});

test("memo replacement failure retains the last complete memo", async (t) => {
  const { root, dirs } = await makeLibrary(t, 1);
  await scanWithTiming(root);
  const memoPath = path.join(root, MEMO_DIR, MEMO_GZ);
  const before = await fs.readFile(memoPath);
  const metaPath = path.join(dirs[0], "asset_info.json");
  const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
  await fs.writeFile(metaPath, JSON.stringify({ ...meta, name: "Updated card" }));
  const original = fs.rename;
  fs.rename = async () => { throw Object.assign(new Error("another writer holds the file"), { code: "EBUSY" }); };
  try {
    const result = await scanWithTiming(root);
    assert.equal(result.index[0].name, "Updated card");
    assert.equal(result.timing.memoWritten, false);
    assert.deepEqual(await fs.readFile(memoPath), before);
  } finally {
    fs.rename = original;
  }
});

test("polling verifies one shard, discovers new folders and removes confirmed deletions", async (t) => {
  const { root, dirs } = await makeLibrary(t, 60);
  await scanWithTiming(root);
  await fs.rm(dirs[0], { recursive: true, force: true });
  await makeAsset(root, "new_asset");
  const original = fs.stat;
  let metaStats = 0;
  fs.stat = async function (target, ...args) {
    if (String(target).endsWith("asset_info.json")) metaStats += 1;
    return original.call(this, target, ...args);
  };
  const timing = {};
  try {
    const result = await scanLibrary(root, {
      incrementalScan: true, pollShard: 0,
      onTiming: (value) => Object.assign(timing, value)
    });
    assert.equal(result.length, 60);
    assert.ok(result.some((record) => record.name === "new_asset"));
    assert.ok(!result.some((record) => record.name === "asset_000"));
    assert.ok(metaStats < 20, `poll must not stat all 60 metadata files (got ${metaStats})`);
    assert.ok(timing.reused > 40);
    assert.equal(timing.mode, "incremental-poll");
  } finally {
    fs.stat = original;
  }
});

test("six polling shards eventually refresh every externally edited asset", async (t) => {
  const { root, dirs } = await makeLibrary(t, 18);
  await scanWithTiming(root);
  for (const dir of dirs) {
    const target = path.join(dir, "asset_info.json");
    const meta = JSON.parse(await fs.readFile(target, "utf8"));
    await fs.writeFile(target, JSON.stringify({ ...meta, name: `edited-${meta.name}` }));
  }
  let result;
  for (let pollShard = 0; pollShard < 6; pollShard += 1) {
    result = await scanLibrary(root, { incrementalScan: true, pollShard });
    assert.equal(result.length, 18);
  }
  assert.ok(result.every((record) => record.name.startsWith("edited-")));
});

test("incremental polling falls back to discovery when no usable memo exists", async (t) => {
  const { root } = await makeLibrary(t, 3);
  const result = await scanLibrary(root, { incrementalScan: true, pollShard: 2 });
  assert.equal(result.length, 3);
});

test("unchanged incremental polls do not rewrite the shared memo", async (t) => {
  const { root } = await makeLibrary(t, 12);
  await scanWithTiming(root);
  const memoPath = path.join(root, MEMO_DIR, MEMO_GZ);
  const before = await fs.stat(memoPath);
  const timing = {};
  await scanLibrary(root, { incrementalScan: true, pollShard: 0, onTiming: (value) => Object.assign(timing, value) });
  assert.equal((await fs.stat(memoPath)).mtimeMs, before.mtimeMs);
  assert.equal(timing.rebuilt, 0);
  assert.equal(timing.memoWritten, false);
});

test("worker forwards partial-scan diagnostics and keeps unreadable cached assets", async (t) => {
  const { root, dirs } = await makeLibrary(t, 2);
  await scanWithTiming(root);
  await fs.writeFile(path.join(dirs[0], "asset_info.json"), "{incomplete");
  const warnings = [];
  const records = [];
  const result = await scanLibraryInWorker(root, {
    onWarning: (warning) => warnings.push(warning),
    onRecord: (record) => records.push(record)
  });
  assert.equal(result.length, 2);
  assert.equal(records.length, 2);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].operation, "asset");
});

test("normal and manual-refresh scans leave metadata and old shared indexes byte-for-byte unchanged", async t => {
  const { root, dirs } = await makeLibrary(t, 3, { withResolution: false, withAnalysis: false });
  const local = await localMemoFixture(t);
  const scanMemoPath = path.join(local, "library.memo.json.gz");
  await fs.mkdir(path.join(root, MEMO_DIR), { recursive: true });
  const legacyJson = path.join(root, MEMO_DIR, MEMO_JSON);
  const legacyGz = path.join(root, MEMO_DIR, MEMO_GZ);
  const payload = JSON.stringify({ version: 2, root, assets: [] });
  await fs.writeFile(legacyJson, payload);
  await fs.writeFile(legacyGz, gzipSync(payload));
  const protectedFiles = [...dirs.map(dir => path.join(dir, "asset_info.json")), legacyJson, legacyGz];
  const before = await Promise.all(protectedFiles.map(async file => ({ bytes: await fs.readFile(file), mtime: (await fs.stat(file)).mtimeMs })));
  const warnings = [];
  const originalWrite = fs.writeFile;
  const writes = [];
  fs.writeFile = async function (target, ...args) {
    writes.push(path.resolve(String(target)));
    return originalWrite.call(this, target, ...args);
  };
  try {
    // A refresh bypasses stale records but never grants maintenance permission.
    const records = await scanReadOnly(root, { refreshMetadata: true, writeSharedMemo: true, scanMemoPath,
      onWarning: value => warnings.push(value) });
    assert.equal(records.length, dirs.length);
    assert.ok(records.every(record => record.textureAnalysis), "analysis is still available to cards in memory");
    assert.ok(writes.length > 0, "the caller's local memo must be persisted");
    assert.ok(writes.every(file => file.startsWith(local + path.sep)), "normal scans may only write their local memo");
  } finally { fs.writeFile = originalWrite; }
  assert.deepEqual(warnings, []);
  for (const [index, file] of protectedFiles.entries()) {
    assert.deepEqual(await fs.readFile(file), before[index].bytes);
    assert.equal((await fs.stat(file)).mtimeMs, before[index].mtime);
  }
  const timing = {};
  await scanReadOnly(root, { scanMemoPath, onTiming: value => Object.assign(timing, value) });
  assert.equal(timing.cacheHits, dirs.length, "unpersisted metadata analysis must still be reusable through the local memo");
  assert.equal(timing.metaWrites, 0);
  assert.equal(timing.memoWritten, false);
});

test("two simultaneous scan workers have separate local memos and never backfill shared metadata", async t => {
  const { root, dirs } = await makeLibrary(t, 5, { withResolution: false, withAnalysis: false });
  const local = await localMemoFixture(t);
  const before = await Promise.all(dirs.map(dir => fs.readFile(path.join(dir, "asset_info.json"))));
  const results = await Promise.all(["alice", "bob"].map(client => scanLibraryInWorker(root, {
    scanMemoPath: path.join(local, `${client}.memo.json.gz`), concurrency: 2, refreshMetadata: true
  })));
  assert.ok(results.every(records => records.length === dirs.length));
  for (const [index, dir] of dirs.entries()) {
    assert.deepEqual(await fs.readFile(path.join(dir, "asset_info.json")), before[index]);
  }
  assert.deepEqual((await fs.readdir(local)).sort(), ["alice.memo.json.gz", "bob.memo.json.gz"]);
  await assert.rejects(fs.stat(path.join(root, MEMO_DIR)), { code: "ENOENT" });
});

test("normal scanning preserves an edit made after it read the old metadata", async t => {
  const { root, dirs } = await makeLibrary(t, 1, { withResolution: false, withAnalysis: false });
  const target = path.join(dirs[0], "asset_info.json");
  const original = fs.readFile;
  let edited = false;
  fs.readFile = async function (file, ...args) {
    const old = await original.call(this, file, ...args);
    if (!edited && path.resolve(String(file)) === target) {
      edited = true;
      await fs.writeFile(target, JSON.stringify({ ...JSON.parse(String(old)), name: "Another user's edit", tags: ["keep-user-tag"] }));
    }
    return old;
  };
  try { await scanReadOnly(root, { refreshMetadata: true }); }
  finally { fs.readFile = original; }
  const current = JSON.parse(await fs.readFile(target, "utf8"));
  assert.equal(edited, true);
  assert.equal(current.name, "Another user's edit");
  assert.deepEqual(current.tags, ["keep-user-tag"]);
  assert.equal(current.textureAnalysis, undefined);
});

test("incomplete metadata and missing asset media preserve cached cards instead of confirming deletion", async t => {
  const { root, dirs } = await makeLibrary(t, 2);
  const local = await localMemoFixture(t);
  const scanMemoPath = path.join(local, "library.memo.json.gz");
  const before = await scanReadOnly(root, { scanMemoPath });
  await fs.writeFile(path.join(dirs[0], "asset_info.json"), "{}");
  for (const name of await fs.readdir(dirs[1])) {
    if (/\.(fbx|png)$/i.test(name)) await fs.rm(path.join(dirs[1], name));
  }
  for (const name of await fs.readdir(path.join(dirs[1], "Preview"))) await fs.rm(path.join(dirs[1], "Preview", name));
  const warnings = [];
  const after = await scanReadOnly(root, { scanMemoPath, refreshMetadata: true, onWarning: warning => warnings.push(warning) });
  assert.deepEqual(after.map(a => a.id).sort(), before.map(a => a.id).sort());
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every(warning => warning.operation !== "metadata-write"));
});

test("normal scans cap metadata and directory discovery concurrency, including oversized requests", async t => {
  const { root, dirs } = await makeLibrary(t, 14);
  for (const concurrency of [2, undefined, 100]) {
    let reads = 0, peakReads = 0, listings = 0, peakListings = 0;
    const originalRead = fs.readFile;
    const originalList = fs.readdir;
    fs.readFile = async function (file, ...args) {
      if (path.basename(String(file)) !== "asset_info.json") return originalRead.call(this, file, ...args);
      reads++; peakReads = Math.max(peakReads, reads);
      try {
        await new Promise(resolve => globalThis.setTimeout(resolve, 12));
        return await originalRead.call(this, file, ...args);
      } finally { reads--; }
    };
    fs.readdir = async function (file, ...args) {
      if (!dirs.includes(String(file))) return originalList.call(this, file, ...args);
      listings++; peakListings = Math.max(peakListings, listings);
      try {
        await new Promise(resolve => globalThis.setTimeout(resolve, 12));
        return await originalList.call(this, file, ...args);
      } finally { listings--; }
    };
    try { assert.equal((await scanReadOnly(root, { concurrency })).length, dirs.length); }
    finally { fs.readFile = originalRead; fs.readdir = originalList; }
    const limit = concurrency === undefined ? 4 : Math.min(8, concurrency);
    assert.ok(peakReads > 1 && peakReads <= limit, `metadata peak ${peakReads}, cap ${limit}`);
    assert.ok(peakListings > 1 && peakListings <= limit, `directory peak ${peakListings}, cap ${limit}`);
  }
});

test("an in-library local memo path cannot turn a normal scan into a shared writer", async t => {
  const { root, dirs } = await makeLibrary(t, 1);
  const file = path.join(dirs[0], "asset_info.json");
  const before = await fs.readFile(file);
  await assert.rejects(scanReadOnly(root, { scanMemoPath: file }), /outside the asset library/);
  assert.deepEqual(await fs.readFile(file), before);
});
