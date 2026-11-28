const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { setImmediate } = require('node:timers');
const { createScanSchedule, RECONCILE_INTERVAL_MS } = require("../electron/services/scanSchedule");

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-schedule-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const file = path.join(directory, "library.scan.json");
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const options = { root: "library-a", reason: "periodic", hasCache: true, idle: true };
  return {
    file, options, now, schedule: createScanSchedule(file, now),
    advance: (milliseconds) => { clock += milliseconds; }
  };
}

test("full reconciliation is due after 24 hours; incremental checks never postpone it", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.schedule.plan(f.options)).incremental, false);
  await f.schedule.complete(f.options.root, false, true);
  f.advance(30 * 60 * 1000);
  assert.equal((await f.schedule.plan(f.options)).incremental, true, "30 minutes no longer forces a full scan");
  await f.schedule.complete(f.options.root, true, true);
  f.advance(RECONCILE_INTERVAL_MS - 30 * 60 * 1000 - 1);
  assert.equal((await f.schedule.plan(f.options)).incremental, true);
  f.advance(1);
  assert.equal((await f.schedule.plan(f.options)).incremental, false);
});

test("restart keeps the last full timestamp and shard; startup requires a restored cache", async (t) => {
  const f = await fixture(t);
  await f.schedule.complete(f.options.root, false, true);
  f.advance(60_000);
  await f.schedule.complete(f.options.root, true, true);
  const restarted = createScanSchedule(f.file, f.now);
  const options = { ...f.options, reason: "startup" };
  const plan = await restarted.plan(options);
  assert.equal(plan.incremental, true);
  assert.equal(plan.pollShard, 1);
  assert.equal((await restarted.plan({ ...options, hasCache: false })).incremental, false);
  f.advance(RECONCILE_INTERVAL_MS);
  assert.equal((await restarted.plan(options)).incremental, false);
});

test("due reconciliation waits for idle while incremental discovery continues", async (t) => {
  const f = await fixture(t);
  await f.schedule.complete(f.options.root, false, true);
  f.advance(RECONCILE_INTERVAL_MS);
  const busy = await f.schedule.plan({ ...f.options, idle: false });
  assert.equal(busy.incremental, true);
  assert.equal(busy.deferred, true);
  await f.schedule.complete(f.options.root, true, true);
  assert.equal((await f.schedule.plan(f.options)).incremental, false);
});

test("manual operations and changed libraries still force full discovery", async (t) => {
  const f = await fixture(t);
  await f.schedule.complete(f.options.root, false, true);
  for (const reason of ["manual-rescan", "clear-cache", "settings-change"]) {
    assert.equal((await f.schedule.plan({ ...f.options, reason, idle: false })).incremental, false);
  }
  assert.equal((await f.schedule.plan({ ...f.options, root: "library-b" })).incremental, false);
});

test("failed scans do not mark a full check complete or advance its shard", async (t) => {
  const f = await fixture(t);
  await f.schedule.complete(f.options.root, false, true);
  f.advance(RECONCILE_INTERVAL_MS);
  await f.schedule.complete(f.options.root, false, false);
  const restarted = createScanSchedule(f.file, f.now);
  assert.equal((await restarted.plan(f.options)).incremental, false);
  await restarted.complete(f.options.root, true, false);
  assert.equal((await restarted.plan(f.options)).pollShard, 0);
});

test("corrupt or future schedule state falls back to full discovery", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file, "{incomplete");
  assert.equal((await createScanSchedule(f.file, f.now).plan(f.options)).incremental, false);
  await fs.writeFile(f.file, JSON.stringify({ version: 1, root: f.options.root, lastReconciledAt: f.now() + 1 }));
  assert.equal((await createScanSchedule(f.file, f.now).plan(f.options)).incremental, false);
});

test("production scan routing uses the persisted deadline and defers full work during import", async (t) => {
  const f = await fixture(t);
  const source = await fs.readFile(path.join(__dirname, "../electron/main.js"), "utf8");
  const start = source.indexOf("async function performScan(");
  const end = source.indexOf("\nasync function clearAssetCaches(", start);
  assert.ok(start > 0 && end > start);
  const modes = [];
  const asset = { id: "a", source: "custom", metaPath: "asset_info.json", favorite: false };
  const saves = [];
  const publications = [];
  const warmed = [];
  let importing = false;
  let recoveries = 0;
  let expectedConcurrency = 4;
  const context = vm.createContext({ process,
    recycleInProgress: false, activeExportCalls: 0,
    settings: { customLibraryPath: "library-a" },
    getLibraryRootPath: () => "library-a", waitForLibraryCacheRestore: async () => {},
    normalizeComparePath: (value) => value, getLibrarySqlCachePath: () => f.file.replace(/\.scan.json$/, ".sqlite"),
    createScanSchedule: (file) => createScanSchedule(file, f.now),
    scheduleUnrealWorkspaceCheck: () => {},
    hasActiveBackgroundImport: () => importing, powerMonitor: { getSystemIdleTime: () => 120 },
    ensureLibraryEditsRecovered: async () => { recoveries++; },
    statOrNull: async () => ({ isDirectory: () => true }),
    loadFavoriteIds: async () => new Set(), loadFavoriteMetaTokens: async () => new Set(),
    applyFavoriteIds: () => {}, saveIndexSnapshot: async (_assets, options) => { saves.push(options); return true; },
    publishSharedIndexSnapshot: () => publications.push(true),
    getSharedDerivedCache: () => ({ warmAssets: (assets, options) => warmed.push({ assets, options }) }),
    scanLibraryInWorker: async (_root, options) => {
      assert.equal(recoveries, 0, "scanning must not roll back/edit asset files");
      assert.equal(options.maintenance, false);
      assert.equal(options.writeSharedMemo, false);
      assert.equal(options.scanMemoPath, f.file.replace(/\.scan.json$/, ".memo.json.gz"));
      assert.equal(options.concurrency, expectedConcurrency);
      modes.push(options.incrementalScan); options.onRecord({ ...asset }); return [{ ...asset }];
    },
    writeLog: (level, _message, payload) => { assert.notEqual(level, "ERROR", JSON.stringify(payload)); }
  });
  vm.runInContext(`let index = [], scanInProgress = false, pendingScanRequest = null;
    let librarySelectionGeneration = 0, activeScanGeneration = 0;
    let lastWatcherScanAt = 0, lastScanSnapshotRoot = '', scanIndexAuthoritative = false, sharedIndexComplete = false;
    let sharedSnapshotVersion = 0, sharedPublishedVersion = 0;
    const libraryScanSchedules = new Map(), WATCH_SCAN_COOLDOWN_MS = 1000;
    ${source.slice(start, end)}`, context);
  await context.performScan(null, { reason: "startup" });
  f.advance(30 * 60 * 1000);
  await context.performScan(null, { reason: "periodic" });
  assert.equal(saves.length, 1, "unchanged polling can skip a clean shared snapshot");
  vm.runInContext("sharedSnapshotVersion++", context);
  await context.performScan(null, { reason: "periodic" });
  assert.equal(saves.length, 1, "shared publication does not rewrite the durable local index");
  assert.ok(publications.length > 0);
  assert.equal(saves.at(-1).publishShared, true);
  assert.ok(warmed.some(call => call.options?.replace && call.assets.length === 1));
  f.advance(RECONCILE_INTERVAL_MS);
  importing = true;
  const scansBeforeImport = modes.length;
  await context.performScan(null, { reason: "periodic" });
  assert.equal(modes.length, scansBeforeImport, 'foreground import pauses automatic discovery entirely');
  importing = false;
  await context.performScan(null, { reason: "periodic" });
  assert.deepEqual(modes, [false, true, false]);
  expectedConcurrency = 8;
  await context.performScan(null, { reason: "manual-rescan", force: true });
  assert.equal(modes.at(-1), false, "manual rescans still fully validate the library without granting write permission");
});

async function scanPublicationFixture(initial, worker, schedulePlan) {
  const source = await fs.readFile(path.join(__dirname, "../electron/main.js"), "utf8");
  const start = source.indexOf("async function performScan(");
  const end = source.indexOf("\nasync function clearAssetCaches(", start);
  const events = [], snapshots = [], publications = [];
  const foregroundWindows = new Set();
  let clock = 10000;
  const context = vm.createContext({
    path, process, foregroundWindows, index: initial, settings: { customLibraryPath: "library-a" },
    recycleInProgress: false, activeExportCalls: 0,
    Date: { now: () => clock },
    getLibraryRootPath: () => context.settings.customLibraryPath,
    waitForLibraryCacheRestore: async () => {}, ensureLibraryEditsRecovered: async () => {},
    normalizeComparePath: value => value, getLibrarySqlCachePath: () => "local/library.sqlite",
    createScanSchedule: () => ({ plan: async () => schedulePlan || ({ incremental: true, pollShard: 0 }), complete: async () => {} }),
    scheduleUnrealWorkspaceCheck: () => {},
    hasActiveBackgroundImport: () => false, powerMonitor: { getSystemIdleTime: () => 120 },
    statOrNull: async () => ({ isDirectory: () => true }),
    loadFavoriteIds: async () => new Set(), loadFavoriteMetaTokens: async () => new Set(), applyFavoriteIds: () => {},
    toAssetListRecord: value => value,
    saveIndexSnapshot: async assets => { snapshots.push(Array.from(assets)); return true; },
    publishSharedIndexSnapshot: () => publications.push(Array.from(context.index)),
    getSharedDerivedCache: () => ({ warmAssets() {} }),
    scanLibraryInWorker: async (_root, options) => worker({ context, options, advance: () => { clock += 1500; } }),
    writeLog: (level, _message, payload) => assert.notEqual(level, "ERROR", JSON.stringify(payload))
  });
  vm.runInContext(`let scanInProgress = false, pendingScanRequest = null;
    let librarySelectionGeneration = 0, activeScanGeneration = 0;
    let lastWatcherScanAt = 0, lastScanSnapshotRoot = '', scanIndexAuthoritative = false, sharedIndexComplete = false;
    let sharedSnapshotVersion = 0, sharedPublishedVersion = 0;
    const libraryScanSchedules = new Map(), WATCH_SCAN_COOLDOWN_MS = 1000;
    ${source.slice(start, end)}`, context);
  const window = { isDestroyed: () => false, webContents: { send: (channel, payload) => events.push({ channel, payload }) } };
  foregroundWindows.add(window);
  return { context, events, snapshots, publications, background: () => foregroundWindows.delete(window),
    run: () => context.performScan(window, { reason: "periodic" }) };
}

test('automatic polling yields to deletion and UE export, then resumes on the next tick', async () => {
  let scans = 0;
  const f = await scanPublicationFixture([], () => { scans++; return []; });
  f.context.recycleInProgress = true;
  await f.run(); assert.equal(scans, 0); assert.equal(f.events.length, 0);
  f.context.recycleInProgress = false; f.context.activeExportCalls = 1;
  await f.run(); assert.equal(scans, 0);
  f.context.activeExportCalls = 0;
  await f.run(); assert.equal(scans, 1);
});

test("imports completed during scan survive every partial publication, final IDs and the persisted snapshot", async () => {
  const old = { id: "existing", name: "Existing" };
  const imported = ["A", "B", "C"].map(id => ({ id, name: `Imported ${id}` }));
  const f = await scanPublicationFixture([old], ({ context, options, advance }) => {
    context.index.push(imported[0]);
    options.onRecord({ ...old, name: "Scanned" });
    assert.ok(context.index.some(asset => asset.id === "A"), "the first partial batch must retain the new import");
    context.index.push(...imported.slice(1));
    advance();
    options.onRecord({ ...old, name: "Scanned again" });
    for (const asset of imported) assert.ok(context.index.includes(asset), `partial scan lost import ${asset.id}`);
    return [{ ...old }]; // Discovery finished before any of the imports existed.
  });
  await f.run();
  assert.deepEqual(Array.from(f.context.index, asset => asset.id).sort(), ["A", "B", "C", "existing"]);
  assert.deepEqual(f.snapshots.at(-1).map(asset => asset.id).sort(), ["A", "B", "C", "existing"]);
  const completion = f.events.find(event => event.payload.complete).payload;
  assert.deepEqual(Array.from(completion.ids).sort(), ["A", "B", "C", "existing"]);
});

test("a background scan persists the full index and sends only lightweight refresh notices", async () => {
  const old = { id: "old" };
  const added = { id: "added" };
  const f = await scanPublicationFixture([old], ({ options }) => {
    options.onRecord(added);
    return [old, added];
  });
  f.background();
  await f.run();
  assert.deepEqual(Array.from(f.context.index, value => value.id), ["old", "added"]);
  assert.deepEqual(f.snapshots[0].map(value => value.id), ["old", "added"]);
  const changes = f.events.filter(event => event.channel === "assets:change");
  assert.ok(changes.length > 0);
  assert.ok(changes.every(({ payload }) => !payload.records && !payload.ids && payload.count === 2));
  assert.ok(f.events.some(({ channel, payload }) => channel === "assets:scanProgress" && payload.phase === "done"));
});

test("an unchanged background scan does not request a full refresh on restore", async () => {
  const asset = { id: "existing", name: "Existing", favorite: false };
  const f = await scanPublicationFixture([asset], ({ options }) => {
    const record = { ...asset };
    options.onRecord(record);
    return [record];
  });
  vm.runInContext("lastScanSnapshotRoot = 'library-a'", f.context);
  f.background();
  await f.run();
  assert.equal(f.snapshots.length, 0);
  assert.ok(f.events.some(({ channel, payload }) => channel === "assets:scanProgress" && payload.phase === "done"));
  assert.ok(f.events.every(({ channel }) => channel !== "assets:change"));

  f.context.loadFavoriteIds = async () => new Set([asset.id]);
  await f.run();
  assert.equal(f.snapshots[0][0].favorite, true);
  assert.ok(f.events.some(({ channel }) => channel === "assets:change"));
});

test("quiet four-second polls start no worker or progress event and retain snapshot authority", async () => {
  const asset = { id: "existing", name: "Existing" };
  const f = await scanPublicationFixture([asset], () => assert.fail("quiet poll started a scan worker"),
    { incremental: true, pollShard: 0, skip: true, changedDirectories: [] });
  vm.runInContext("sharedIndexComplete = true", f.context);
  await f.run();
  assert.equal(f.events.length, 0);
  assert.equal(f.snapshots.length, 0);
  assert.equal(vm.runInContext("sharedIndexComplete", f.context), true);
  vm.runInContext("sharedSnapshotVersion++", f.context);
  await f.run();
  assert.deepEqual(f.publications.at(-1), [asset], "pending internal edits publish without rewriting the local database");
  assert.equal(f.snapshots.length, 0);
});

test('failed shared publications are single flight and back off without local snapshot rewrites', async () => {
  const source = await fs.readFile(path.join(__dirname, '../electron/main.js'), 'utf8');
  const start = source.indexOf('function publishSharedIndexSnapshot(');
  const end = source.indexOf('\nfunction scheduleIndexSnapshotSave(', start);
  let clock = 1000, calls = 0, release;
  const context = vm.createContext({
    index: [{ id: 'monster' }], Date: { now: () => clock },
    getLibraryRootPath: () => 'library', toAssetListRecord: value => value, writeLog() {},
    getSharedDerivedCache: () => ({ publishSnapshot: () => { calls++; return new Promise(resolve => { release = resolve; }); } })
  });
  vm.runInContext(`let sharedPublishedVersion = -1, sharedSnapshotVersion = 1, librarySelectionGeneration = 0;
    let sharedPublishInFlight = false, sharedPublishRetryAt = 0; ${source.slice(start, end)}`, context);
  context.publishSharedIndexSnapshot(); context.publishSharedIndexSnapshot();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  release(false); await new Promise(resolve => setImmediate(resolve));
  for (let poll = 0; poll < 14; poll++) { clock += 4000; context.publishSharedIndexSnapshot(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1, 'four-second polling must not keep serializing 30k records');
  clock += 4001; context.publishSharedIndexSnapshot();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  release(true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(vm.runInContext('sharedPublishedVersion', context), 1);
});

test("local edits and deletions take precedence over stale scan records while confirmed external removals still disappear", async () => {
  const original = [{ id: "edit", name: "Old" }, { id: "delete", name: "Delete" }, { id: "gone", name: "Already removed on disk" }];
  const edited = { id: "edit", name: "Saved edit" };
  const f = await scanPublicationFixture(original, ({ context, options, advance }) => {
    options.onRecord({ ...original[0] });
    context.index = context.index.filter(asset => asset.id !== "delete");
    context.index[context.index.findIndex(asset => asset.id === "edit")] = edited;
    advance();
    options.onRecord({ ...original[0] });
    assert.equal(context.index.find(asset => asset.id === "edit"), edited);
    assert.equal(context.index.some(asset => asset.id === "delete"), false);
    advance();
    options.onRecord({ ...original[1] });
    assert.equal(context.index.some(asset => asset.id === "delete"), false);
    return original.slice(0, 2).map(asset => ({ ...asset }));
  });
  await f.run();
  assert.deepEqual(Array.from(f.context.index, asset => asset.name), ["Saved edit"]);
  assert.deepEqual(f.snapshots.at(-1).map(asset => asset.name), ["Saved edit"]);
  const updates = f.events.filter(event => event.payload.records).flatMap(event => Array.from(event.payload.records));
  assert.equal(updates.filter(asset => asset.id === "edit").at(-1).name, "Saved edit");
  assert.equal(updates.some(asset => asset.id === "delete"), false);
});
