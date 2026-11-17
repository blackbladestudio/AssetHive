const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const sharp = require("sharp");
const { createCacheProcess } = require("../electron/services/cacheProcess");
const { createSharedDerivedCache } = require("../electron/services/sharedDerivedCache");
const storage = require("../electron/services/derivedCacheProcess");
const { gzipSync } = require("node:zlib");

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-shared-cache-"));
  const root = path.join(directory, "Library");
  await fs.mkdir(root);
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}));
  const clients = [];
  t.after(() => clients.forEach(client => client.dispose()));
  return {
    directory, root,
    client(name, options = {}) {
      const client = createSharedDerivedCache({ libraryRoot: root, localRoot: path.join(directory, name), ...options });
      clients.push(client);
      return client;
    },
    asset: (id = "rock") => ({ id, name: id, source: "custom", path: path.join(root, id),
      metaPath: path.join(root, id, "asset_info.json"), previewImage: path.join(root, id, "Preview", "preview.png"),
      modelFiles: [path.join(root, id, "mesh.fbx"), "lod1.fbx"], favorite: true,
      previewSkeletonPath: path.join(directory, "Private", "skeleton.fbx"),
      meta: { previews: { relativeSize: "1:1" } } })
  };
}

test("snapshot paths rebase across drive mappings and omit personal/local data", () => {
  const firstRoot = path.resolve("first-library");
  const secondRoot = path.resolve("second-library");
  const encoded = storage.encodeSnapshot(firstRoot, [{ id: "a", path: path.join(firstRoot, "Rock"),
    metaPath: path.join(firstRoot, "Rock", "asset_info.json"), favorite: true,
    previewImage: path.resolve("private-user-preview.png"), modelFiles: [path.join(firstRoot, "Rock", "a.fbx")] }]);
  assert.equal(encoded.assets[0].favorite, undefined);
  assert.equal(encoded.assets[0].previewImage, null);
  const [restored] = storage.decodeSnapshot(secondRoot, encoded);
  assert.equal(restored.path, path.join(secondRoot, "Rock"));
  assert.equal(restored.metaPath, path.join(secondRoot, "Rock", "asset_info.json"));
  assert.deepEqual(restored.modelFiles, [path.join(secondRoot, "Rock", "a.fbx")]);
  assert.equal(restored.favorite, false);
  encoded.assets[0].metaPath = "../../outside.json";
  assert.equal(storage.decodeSnapshot(secondRoot, encoded), null);
});

test("legacy startup fields restore from one local memo without probing asset files or accepting another library", async t => {
  const f = await fixture(t);
  const memoPath = path.join(f.directory, "local.memo.json.gz");
  const asset = { ...f.asset("apg0erw"), name: "SM_Env_ZGNC_AItest_A", standardAssetTags: ["Dressing"] };
  await fs.writeFile(memoPath, gzipSync(JSON.stringify({ version: 2, root: f.root, assets: [{ record: asset }] })));
  const before = await fs.readFile(memoPath);
  const records = await storage.readScanMemoRecords({ memoPath, root: f.root });
  assert.equal(records[0].name, asset.name);
  assert.deepEqual(records[0].standardAssetTags, ["Dressing"]);
  assert.equal(await fs.stat(asset.metaPath).catch(() => null), null, "the source asset need not exist for cached search");
  assert.equal(await storage.readScanMemoRecords({ memoPath, root: path.join(f.directory, "Other") }), null);
  assert.equal(await storage.readScanMemoRecords({ memoPath: path.join(f.directory, "missing"), root: f.root }), null);
  assert.deepEqual(await fs.readFile(memoPath), before);
});

test("unknown, stale and future snapshots are ignored", () => {
  const valid = { version: 1, generatedAt: Date.now(), assets: [] };
  assert.deepEqual(storage.decodeSnapshot("library", valid), []);
  for (const patch of [{ version: 2 }, { generatedAt: 0 }, { generatedAt: Date.now() + 86400000 }]) {
    assert.equal(storage.decodeSnapshot("library", { ...valid, ...patch }), null);
  }
});

test("snapshot decoding rejects duplicate IDs and unsafe model paths", async t => {
  const f = await fixture(t);
  const encoded = storage.encodeSnapshot(f.root, [f.asset()]);
  encoded.assets[0].modelFiles.push({ assetPath: "../../outside.fbx" }, { assetPath: "C:outside.fbx" });
  assert.deepEqual(storage.decodeSnapshot(f.root, encoded)[0].modelFiles, [path.join(f.root, "rock", "mesh.fbx"), "lod1.fbx"]);
  assert.equal(storage.decodeSnapshot(f.root, { ...encoded, assets: [...encoded.assets, ...encoded.assets] }), null);
  encoded.assets[0].modelFiles = {};
  assert.equal(storage.decodeSnapshot(f.root, encoded), null);
});

test("many obsolete clients do not hide a usable snapshot; file probes have bounded parallelism", async t => {
  const f = await fixture(t);
  const client = f.client("alice");
  assert.equal(await client.publishSnapshot([f.asset()]), true);
  const directory = path.join(client.sharedDir, "Snapshots");
  for (let i = 0; i < 24; i++) {
    const file = path.join(directory, i.toString(16).padStart(24, "0") + ".json.gz");
    await fs.writeFile(file, "broken");
    await fs.utimes(file, new Date(), new Date(Date.now() + 1000));
  }
  const original = fs.stat;
  let active = 0;
  let maximum = 0;
  let probes = 0;
  fs.stat = async function (file, ...args) {
    if (path.dirname(String(file)) !== directory) return original.call(this, file, ...args);
    active++; maximum = Math.max(maximum, active); probes++;
    try { await delay(10); return await original.call(this, file, ...args); }
    finally { active--; }
  };
  try { assert.equal((await storage.readSnapshot({ sharedDir: client.sharedDir, root: f.root }))[0].id, "rock"); }
  finally { fs.stat = original; }
  assert.equal(probes, 25);
  assert.ok(maximum > 1 && maximum <= 8);
});

test("thumbnail deadlines and circuit breakers cannot disable snapshot restoration", async t => {
  const f = await fixture(t);
  const writer = f.client("writer");
  assert.equal(await writer.publishSnapshot([f.asset()]), true);
  const reader = f.client("reader", { sharedTimeoutMs: 1 });
  const preview = path.join(f.root, "preview.png");
  await sharp({ create: { width: 20, height: 20, channels: 3, background: "red" } }).png().toFile(preview);
  assert.notEqual(await reader.thumbnail(preview), preview);
  assert.equal((await reader.readSnapshot())[0].id, "rock");
});

test("separate clients publish complete snapshots without touching legacy caches", async t => {
  const f = await fixture(t);
  const legacy = ["HiveIndex.sqlite", ".assethive/custom-index.json", ".assethive/custom-index.json.gz", "rock/Preview/preview_thumb.png"];
  for (const relative of legacy) {
    const file = path.join(f.root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `legacy:${relative}`);
  }
  const clients = [f.client("alice"), f.client("bob"), f.client("carol")];
  assert.ok(clients[0].sharedDir.startsWith(f.root + path.sep));
  const published = await Promise.all(clients.map((client, index) => client.publishSnapshot([f.asset(`rock-${index}`)])));
  assert.deepEqual(published, [true, true, true]);
  const snapshot = await clients[0].readSnapshot();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].favorite, false);
  assert.equal(snapshot[0].previewSkeletonPath, null);
  const files = await fs.readdir(path.join(clients[0].sharedDir, "Snapshots"));
  assert.equal(files.length, 3, "each writer owns a separate file");
  for (const relative of legacy) assert.equal(await fs.readFile(path.join(f.root, relative), "utf8"), `legacy:${relative}`);
  assert.equal(await clients[1].publishSnapshot([]), true);
  assert.deepEqual(await clients[0].readSnapshot(), [], "an empty complete snapshot must not resurrect deleted assets");
});

test("partial/corrupt snapshots fall back; failed replacement preserves the previous file", async t => {
  const f = await fixture(t);
  const client = f.client("alice");
  await client.publishSnapshot([f.asset()]);
  const directory = path.join(client.sharedDir, "Snapshots");
  const [name] = await fs.readdir(directory);
  const before = await fs.readFile(path.join(directory, name));
  await fs.writeFile(path.join(directory, "b".repeat(24) + ".json.gz"), "broken");
  await fs.writeFile(path.join(directory, "c".repeat(24) + ".json.gz.123.tmp"), "half-written");
  assert.equal((await client.readSnapshot())[0].id, "rock");
  const invalid = f.asset();
  invalid.metaPath = path.join(f.directory, "outside.json");
  assert.equal(await client.publishSnapshot([invalid]), false);
  assert.equal(await client.publishSnapshot([f.asset(), f.asset()]), false, "duplicate IDs cannot replace a complete snapshot");
  assert.deepEqual(await fs.readFile(path.join(directory, name)), before);
  // A destination occupied by a directory simulates an unreplaceable/locked name.
  await fs.mkdir(path.join(directory, "d".repeat(24) + ".json.gz"));
  await assert.rejects(storage.writeSnapshot({ sharedDir: client.sharedDir, root: f.root, writer: "d".repeat(24), assets: [f.asset()] }));
  assert.deepEqual(await fs.readFile(path.join(directory, name)), before);
});

test("thumbnails are copied locally, keep alpha, share across users and invalidate on source edits", async t => {
  const f = await fixture(t);
  const alice = f.client("alice");
  const bob = f.client("bob");
  const preview = path.join(f.root, "preview.png");
  const makeImage = color => sharp({ create: { width: 1024, height: 512, channels: 4, background: color } }).png().toFile(preview);
  await makeImage({ r: 100, g: 10, b: 20, alpha: 0.5 });
  const first = await alice.thumbnail(preview);
  assert.notEqual(first, preview);
  assert.ok(first.startsWith(path.join(f.directory, "alice")));
  const localProbe = await storage.probeThumbnail({ sourcePath: preview, root: f.root, localDir: path.join(f.directory, "probe") });
  const sharedFile = path.join(alice.sharedDir, "Thumbnails", localProbe.key.slice(0, 2), `${localProbe.key}.png`);
  for (let attempt = 0; attempt < 100 && !(await fs.stat(sharedFile).catch(() => null)); attempt++) await delay(20);
  assert.deepEqual(await fs.readFile(sharedFile), await fs.readFile(first));
  const second = await bob.thumbnail(preview);
  assert.ok(second.startsWith(path.join(f.directory, "bob")));
  assert.deepEqual(await fs.readFile(second), await fs.readFile(first));
  const meta = await sharp(second).metadata();
  assert.equal(meta.width, 512);
  assert.equal(meta.height, 256);
  assert.equal(meta.hasAlpha, true);
  await fs.rename(alice.sharedDir, alice.sharedDir + "-offline");
  assert.equal(await bob.thumbnail(preview), second, "warm local hits must not require the shared cache");
  await makeImage({ r: 0, g: 255, b: 0, alpha: 0.8 });
  const changed = await bob.thumbnail(preview);
  assert.notEqual(changed, second);
  assert.notDeepEqual(await fs.readFile(changed), await fs.readFile(second));
  assert.deepEqual((await fs.readdir(f.root)).sort(), [".assethive", "preview.png"], "do not create legacy _thumb files");
});

test("read-only/unavailable shared cache still generates a local thumbnail; bad thumbnails are ignored", async t => {
  const f = await fixture(t);
  const client = f.client("alice");
  const preview = path.join(f.root, "preview.png");
  await sharp({ create: { width: 30, height: 20, channels: 3, background: "red" } }).png().toFile(preview);
  // ENOTDIR behaves like a share that cannot be written, without platform ACLs.
  await fs.mkdir(path.dirname(client.sharedDir), { recursive: true });
  await fs.writeFile(client.sharedDir, "unavailable");
  const local = await client.thumbnail(preview);
  assert.notEqual(local, preview);
  assert.equal((await sharp(local).metadata()).width, 30);
  assert.equal(await client.readSnapshot(), null);
  await fs.rm(client.sharedDir);
  const probe = await storage.probeThumbnail({ sourcePath: preview, root: f.root, localDir: path.join(f.directory, "empty") });
  const corrupt = path.join(client.sharedDir, "Thumbnails", probe.key.slice(0, 2), `${probe.key}.png`);
  await fs.mkdir(path.dirname(corrupt), { recursive: true });
  await fs.writeFile(corrupt, "broken image");
  assert.equal(await storage.readThumbnail({ sharedDir: client.sharedDir, localDir: path.join(f.directory, "reader"), key: probe.key }), null);
});

test("warmup awaits verified shared publication, repairs corruption and updates same-path previews", async t => {
  const f = await fixture(t);
  const client = f.client("maintenance");
  const preview = path.join(f.root, "preview.png");
  const make = color => sharp({ create: { width: 700, height: 350, channels: 4, background: color } }).png().toFile(preview);
  await make({ r: 80, g: 160, b: 90, alpha: 0.5 });
  const first = await client.warmThumbnail(preview, { verify: true });
  assert.equal(first.status, "published");
  assert.equal((await sharp(first.file).metadata()).hasAlpha, true);
  assert.equal((await client.warmThumbnail(preview, { verify: true })).status, "cached");
  await fs.writeFile(first.file, "broken");
  assert.equal((await client.warmThumbnail(preview, { verify: true })).status, "published");
  assert.equal((await sharp(first.file).metadata()).width, 512);
  await make({ r: 5, g: 10, b: 240, alpha: 0.7 });
  const changed = await client.warmThumbnail(preview, { verify: true });
  assert.equal(changed.status, "published");
  assert.notEqual(changed.key, first.key);
  const reader = f.client("new-user");
  assert.deepEqual(await fs.readFile(await reader.thumbnail(preview)), await fs.readFile(changed.file));
});

test("one bad source does not stop warmup; cached local files still publish to the share", async t => {
  const f = await fixture(t);
  const client = f.client("maintenance");
  assert.equal((await client.warmThumbnail(path.join(f.root, "missing.png"))).status, "failed");
  assert.equal((await client.warmThumbnail(path.join(f.directory, "outside.png"))).reason, "outside-library");
  assert.equal((await client.warmThumbnail(path.join(f.root, "motion.mp4"))).reason, "motion-preview");
  const preview = path.join(f.root, "preview.png");
  await sharp({ create: { width: 64, height: 64, channels: 3, background: "red" } }).png().toFile(preview);
  const localDir = path.join(f.directory, "local-existing");
  const probe = await storage.probeThumbnail({ sourcePath: preview, root: f.root, localDir });
  const local = await storage.renderThumbnail({ ...probe, sourcePath: preview, localDir });
  const result = await storage.warmThumbnail({ sourcePath: preview, root: f.root, localDir, sharedDir: client.sharedDir, verify: true });
  assert.equal(result.status, "published");
  assert.deepEqual(await fs.readFile(result.file), await fs.readFile(local));
  assert.equal((await client.warmThumbnail(preview, { verify: true })).status, "cached");
});

test("automatic warmAssets publishes unseen/new previews and same-path edits for a new user", async t => {
  const f = await fixture(t);
  const source = await fs.readFile(require.resolve("../electron/services/sharedDerivedCache"), "utf8");
  const loaded = { exports: {} };
  new Function("require", "module", source)(name => name === "./thumbnailWarmup"
    ? { createThumbnailWarmup: options => require("../electron/services/thumbnailWarmup").createThumbnailWarmup({ ...options, initialDelayMs: 0, delayMs: 1 }) }
    : name.startsWith(".") ? require(path.resolve(__dirname, "../electron/services", name)) : require(name), loaded);
  const progress = [];
  const cache = loaded.exports.createSharedDerivedCache({ libraryRoot: f.root, localRoot: path.join(f.directory, "automatic"),
    onWarmProgress: result => progress.push(result) });
  t.after(() => cache.dispose());
  const [first, added] = ["first.png", "new.png"].map(name => path.join(f.root, name));
  const make = (file, background) => sharp({ create: { width: 80, height: 80, channels: 4, background } }).png().toFile(file);
  await make(first, "red");
  cache.warmAssets([{ previewImage: first }], { replace: true });
  for (let i = 0; i < 300 && progress.length < 1; i++) await delay(10);
  assert.equal(progress[0]?.result.status, "published");
  await make(added, "green");
  cache.warmAssets([{ previewImage: added }], { priority: true });
  for (let i = 0; i < 300 && progress.length < 2; i++) await delay(10);
  assert.equal(progress[1]?.sourcePath, added);
  await make(first, "blue");
  cache.warmAssets([{ previewImage: first }], { priority: true });
  for (let i = 0; i < 300 && progress.length < 3; i++) await delay(10);
  assert.equal(progress[2]?.result.status, "published");
  assert.notEqual(progress[2].result.key, progress[0].result.key);
  const reader = f.client("new-user");
  assert.deepEqual(await fs.readFile(await reader.thumbnail(first)), await fs.readFile(progress[2].result.file));
  assert.deepEqual(await fs.readFile(await reader.thumbnail(added)), await fs.readFile(progress[1].result.file));
});

test("a hung cache process cannot starve main-process filesystem work and has a bounded deadline", async t => {
  const f = await fixture(t);
  const workerPath = path.join(f.directory, "hung.cjs");
  await fs.writeFile(workerPath, "process.on('message', () => { require('node:fs/promises').stat = () => new Promise(() => {}); });");
  let failures = 0;
  const worker = createCacheProcess({ workerPath, timeoutMs: 250, cooldownMs: 60000, concurrency: 2, onFailure: () => failures++ });
  t.after(() => worker.dispose());
  const started = Date.now();
  const pending = worker.run("readSnapshot", {});
  const second = worker.run("probeThumbnail", {});
  const queued = worker.run("writeSnapshot", {});
  await fs.writeFile(path.join(f.directory, "main-still-responsive"), "ok");
  assert.deepEqual(await Promise.all([pending, second, queued]), [null, null, null]);
  assert.ok(Date.now() - started < 1500);
  assert.equal(failures, 1);
  assert.equal(await worker.run("readSnapshot", {}), null, "the cooldown must not retry a stalled share");
});

test("cache process bounds concurrency and routes out-of-order replies correctly", async t => {
  const f = await fixture(t);
  const workerPath = path.join(f.directory, "parallel.cjs");
  await fs.writeFile(workerPath, `let active = 0, peak = 0;
    process.on('message', async ({ id, args }) => {
      peak = Math.max(peak, ++active);
      await require('node:timers/promises').setTimeout(args.delay);
      active--;
      process.send({ id, ok: true, result: { name: args.name, peak } });
    });`);
  const worker = createCacheProcess({ workerPath, timeoutMs: 3000, concurrency: 2 });
  t.after(() => worker.dispose());
  const order = [];
  const results = await Promise.all([200, 5, 5, 5].map((ms, index) =>
    worker.run("probe", { delay: ms, name: index }).then(result => { order.push(result.name); return result; })));
  assert.deepEqual(results.map(result => result.name), [0, 1, 2, 3]);
  assert.deepEqual(order, [1, 2, 3, 0]);
  assert.equal(Math.max(...results.map(result => result.peak)), 2);
});

test("slow renders and hung publishers do not block local or shared thumbnail hits", async t => {
  const f = await fixture(t);
  const workerPath = path.join(f.directory, "delayed-cache.cjs");
  const rendering = path.join(f.directory, "rendering");
  const publishing = path.join(f.directory, "publishing");
  await fs.writeFile(workerPath, `const storage = require(${JSON.stringify(require.resolve("../electron/services/derivedCacheProcess"))});
    process.on('message', async ({ id, operation, args }) => {
      try {
        if (operation === 'writeThumbnail') {
          await require('node:fs/promises').writeFile(${JSON.stringify(publishing)}, 'started');
          return; // Simulate an unresponsive SMB writer.
        }
        if (operation === 'renderThumbnail' && args.sourcePath.endsWith('slow.png')) {
          await require('node:fs/promises').writeFile(${JSON.stringify(rendering)}, 'started');
          await require('node:timers/promises').setTimeout(1000);
        }
        if (operation === 'renderThumbnail' && args.sourcePath.endsWith('shared.png')) throw new Error('shared hit must not regenerate');
        process.send({ id, ok: true, result: await storage[operation](args) });
      } catch (error) { process.send({ id, ok: false, error: error.message }); }
    });`);
  const source = await fs.readFile(require.resolve("../electron/services/sharedDerivedCache"), "utf8");
  const loaded = { exports: {} };
  new Function("require", "module", source)(name => name === "./cacheProcess"
    ? { createCacheProcess: options => createCacheProcess({ ...options, workerPath }) }
    : name.startsWith(".") ? require(path.resolve(__dirname, "../electron/services", name)) : require(name), loaded);
  const client = loaded.exports.createSharedDerivedCache({ libraryRoot: f.root, localRoot: path.join(f.directory, "reader"),
    sharedTimeoutMs: 3000, sourceTimeoutMs: 5000 });
  t.after(() => client.dispose());
  const [warm, slow, shared] = ["warm.png", "slow.png", "shared.png"].map(name => path.join(f.root, name));
  for (const file of [warm, slow, shared]) {
    await sharp({ create: { width: 64, height: 64, channels: 4, background: "red" } }).png().toFile(file);
  }
  const local = await client.thumbnail(warm);
  const probe = await storage.probeThumbnail({ sourcePath: shared, root: f.root, localDir: path.join(f.directory, "writer") });
  const generated = await storage.renderThumbnail({ ...probe, sourcePath: shared, localDir: path.join(f.directory, "writer") });
  await storage.writeThumbnail({ sharedDir: client.sharedDir, localFile: generated, key: probe.key });
  let slowFinished = false;
  const pending = client.thumbnail(slow).then(result => { slowFinished = true; return result; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fs.stat(rendering).catch(() => null) && await fs.stat(publishing).catch(() => null)) break;
    await delay(10);
  }
  assert.ok(await fs.stat(rendering));
  assert.ok(await fs.stat(publishing));
  assert.equal(await client.thumbnail(warm), local);
  const sharedHit = await client.thumbnail(shared);
  assert.notEqual(sharedHit, shared);
  assert.deepEqual(await fs.readFile(sharedHit), await fs.readFile(generated));
  assert.equal(slowFinished, false, "cached cards must finish while the unrelated render is still running");
  assert.notEqual(await pending, slow);
});

async function restoreFixture(overrides = {}) {
  const source = await fs.readFile(path.join(__dirname, "../electron/main.js"), "utf8");
  const start = source.indexOf("function restoreSelectedLibraryCache() {");
  const end = source.indexOf("\n// 启动扫描等待", start);
  assert.ok(start > 0 && end > start);
  const events = [];
  let shares = 0;
  const context = vm.createContext({ Date, clearTimeout: () => {},
    settings: { customLibraryPath: "Library" }, getLibraryRootPath: () => "Library",
    getLibrarySqlCachePath: () => "local.sqlite", getLibraryJsonCachePath: () => "local.json", statOrNull: async () => null,
    loadLibrarySqlCache: async () => null, loadLibraryJsonCache: async () => null,
    getSharedDerivedCache: () => ({ readSnapshot: async () => { shares++; return [{ id: "shared" }]; } }),
    applyUserFavorites: async assets => assets.forEach(asset => { asset.favorite = true; }),
    stopLibraryScans: () => events.push("stop-scan"), stopLibraryWatch: () => {}, closeLibraryDb: () => {},
    backfillMissingRelativeSize: async () => events.push("metadata"), purgeMissingAssetsFromIndex: async () => events.push("purge"),
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: () => events.push("cards") } }] },
    writeLog: (level, message, detail) => { assert.notEqual(level, "WARN", `${message}: ${JSON.stringify(detail)}`); },
    ...overrides
  });
  vm.runInContext(`let index = [], scanInProgress = false, scanIndexAuthoritative = false;
    let sharedIndexComplete = false, sharedSnapshotVersion = 0, sharedPublishedVersion = -1;
    let librarySelectionGeneration = 0, activeScanGeneration = 0, pendingScanRequest = null;
    let pendingIndexSaveTimer = 0, sharedDerivedCache = null, libraryCacheRestorePromise = null;
    ${source.slice(start, end)}`, context);
  return { context, events, shares: () => shares };
}

test("cold startup restores shared cards before any network metadata probes", async () => {
  const f = await restoreFixture();
  await f.context.restoreLibraryIndexCache();
  assert.equal(vm.runInContext("index[0].id", f.context), "shared");
  assert.equal(vm.runInContext("index[0].favorite", f.context), true);
  assert.deepEqual(f.events, ["cards"]);
});

test("local snapshots appear without repeating network probes and corrupt local caches use shared fallback", async () => {
  const local = await restoreFixture({ loadLibrarySqlCache: async () => [{ id: "local" }] });
  await local.context.restoreLibraryIndexCache();
  assert.equal(local.shares(), 0);
  assert.deepEqual(local.events, ["cards"]);
  const corrupt = await restoreFixture({ statOrNull: async () => ({ isFile: () => true }) });
  await corrupt.context.restoreLibraryIndexCache();
  assert.equal(vm.runInContext("index[0].id", corrupt.context), "shared");
});

test("selecting a library restores its shared cache while an old scan is still terminating", async () => {
  const f = await restoreFixture();
  vm.runInContext("index = [{ id: 'old' }]; scanInProgress = true; scanIndexAuthoritative = true;", f.context);
  f.context.restoreSelectedLibraryCache();
  await vm.runInContext("libraryCacheRestorePromise", f.context);
  assert.equal(vm.runInContext("index[0].id", f.context), "shared");
  assert.deepEqual(f.events, ["stop-scan", "cards", "cards"]);
  assert.equal(f.shares(), 1);
});

test("an existing empty local database takes precedence over older shared snapshots", async () => {
  const f = await restoreFixture({ loadLibrarySqlCache: async () => [] });
  await f.context.restoreLibraryIndexCache();
  assert.equal(f.shares(), 0);
  assert.equal(vm.runInContext("index.length", f.context), 0);
});

test("an existing empty JSON fallback also takes precedence over shared snapshots", async () => {
  const f = await restoreFixture({ loadLibraryJsonCache: async () => [] });
  await f.context.restoreLibraryIndexCache();
  assert.equal(f.shares(), 0);
  assert.equal(vm.runInContext("index.length", f.context), 0);
});

test("a late shared response cannot overwrite a scan or a changed library", async () => {
  for (const changed of ["scanIndexAuthoritative = true; index = [{ id: 'scanned' }];",
    "getLibraryRootPath = () => 'OtherLibrary';", "librarySelectionGeneration += 2;",
    "scanInProgress = true;"]) {
    let deliver;
    const response = new Promise(resolve => { deliver = resolve; });
    const f = await restoreFixture({ getSharedDerivedCache: () => ({ readSnapshot: () => response }) });
    const restoring = f.context.restoreLibraryIndexCache();
    await delay(0);
    vm.runInContext(changed, f.context);
    deliver([{ id: "stale" }]);
    await restoring;
    assert.notEqual(vm.runInContext("index[0]?.id", f.context), "stale");
    assert.deepEqual(f.events, []);
  }
});
