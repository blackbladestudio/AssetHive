const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { startupScanDelay, periodicScanDelay } = require("../electron/services/scanTiming");
const { CHANGE_CHECK_INTERVAL_MS } = require("../electron/services/scanSchedule");

test("startup spreads cached clients while keeping cold first cards within a short delay", () => {
  const cached = new Set();
  for (let index = 0; index < 50; index++) {
    const client = `machine-${index}|local-user|library`;
    const coldDelay = startupScanDelay(client, false);
    const warmDelay = startupScanDelay(client, true);
    assert.ok(coldDelay >= 1200 && coldDelay < 4200);
    assert.ok(warmDelay >= 1200 && warmDelay < 31200);
    assert.equal(warmDelay, startupScanDelay(client, true));
    cached.add(warmDelay);
  }
  assert.ok(cached.size > 40, "simultaneously opened clients must not share a single startup deadline");
});

test("change polls stay near four seconds and vary by client and by round", () => {
  const deadlines = new Set();
  for (let index = 0; index < 50; index++) {
    const client = `client-${index}`;
    const first = periodicScanDelay(client, CHANGE_CHECK_INTERVAL_MS, () => 0);
    const next = periodicScanDelay(client, CHANGE_CHECK_INTERVAL_MS, () => 1);
    assert.ok(first >= 3600 && next <= 4400);
    assert.notEqual(first, next);
    deadlines.add(first);
  }
  assert.ok(deadlines.size > 40);
  for (const interval of [100, 1000, 4000, 300000]) {
    const value = periodicScanDelay("test", interval, () => 0.5);
    assert.ok(Math.abs(value - interval) <= interval * 0.1);
  }
});

test("production scan timer serializes startup, adapts to focus and stops when no windows remain", async () => {
  const source = await fs.readFile(path.join(__dirname, "../electron/main.js"), "utf8");
  const start = source.indexOf("function startPeriodicScan(");
  const end = source.indexOf("\nfunction startWatching(", start);
  assert.ok(start >= 0 && end > start);
  const timers = new Set();
  const scans = [];
  const declarations = source.match(/^const (?:PERIODIC_SCAN_INTERVAL_MS|BACKGROUND_SCAN_INTERVAL_MS) = .*;$/gm);
  assert.equal(declarations.length, 2);
  let destroyed = false;
  const win = { isDestroyed: () => destroyed };
  const foregroundWindows = new Set([win]);
  let releaseScan;
  let now = 10000;
  const context = vm.createContext({
    process: { env: {} }, CHANGE_CHECK_INTERVAL_MS, ENABLE_PERIODIC_SCAN: true,
    Date: { now: () => now },
    startupScanDelay, foregroundWindows, index: [{ id: "cached" }],
    periodicScanDelay: (client, interval) => periodicScanDelay(client, interval, () => 0.5),
    getScanClientId: () => "alice",
    getLibraryRootPath: () => "library",
    maintainLibraryChangeJournals: async () => null,
    BrowserWindow: { getAllWindows: () => [] },
    performScan: (_win, options) => {
      scans.push(options.reason);
      return new Promise(resolve => { releaseScan = resolve; });
    },
    writeLog: () => {},
    globalThis: {
      setTimeout: (callback, delay) => { const timer = { callback, delay, unref() {} }; timers.add(timer); return timer; },
      clearTimeout: timer => timers.delete(timer)
    }
  });
  vm.runInContext(`${declarations.join("\n")}\nlet periodicScanTimer = null, startupScanPending = false, automaticScanRunning = false, lastAutomaticScanAt = 0;
    ${source.slice(start, end)}`, context);
  const fire = () => {
    assert.equal(timers.size, 1);
    const [timer] = timers;
    timers.delete(timer);
    return timer.callback();
  };
  context.startPeriodicScan(win, { startup: true });
  assert.equal(scans.length, 0);
  const [startup] = timers;
  assert.equal(startup.delay, startupScanDelay("alice", true));
  context.startPeriodicScan(win, { immediate: true });
  assert.equal([...timers][0], startup, "focus must preserve the startup delay");
  const first = fire();
  assert.deepEqual(scans, ["startup"]);
  context.startPeriodicScan(win, { immediate: true });
  assert.equal(timers.size, 0, "a pending scan must not overlap a focus-triggered check");
  releaseScan();
  await first;
  assert.ok([...timers][0].delay >= 3600 && [...timers][0].delay <= 4400);
  foregroundWindows.clear();
  context.startPeriodicScan(win);
  assert.equal(timers.size, 1);
  assert.ok([...timers][0].delay >= 27000 && [...timers][0].delay <= 33000);
  foregroundWindows.add(win);
  context.startPeriodicScan(win, { immediate: true });
  assert.equal([...timers][0].delay, CHANGE_CHECK_INTERVAL_MS, "rapid focus changes must not add more share traffic");
  now += 10000;
  context.startPeriodicScan(win, { immediate: true });
  assert.equal([...timers][0].delay, 0);
  const catchup = fire();
  assert.deepEqual(scans, ["startup", "periodic"]);
  releaseScan();
  await catchup;
  destroyed = true;
  await fire();
  assert.equal(timers.size, 0);
  assert.equal(scans.length, 2);
});

test("clearing this client's cache removes the local memo and never the old shared indexes", async () => {
  const source = await fs.readFile(path.join(__dirname, "../electron/main.js"), "utf8");
  const start = source.indexOf("async function clearAssetCaches() {");
  const end = source.indexOf("\nasync function waitForScanIdle(", start);
  assert.ok(start >= 0 && end > start);
  const local = path.join(os.tmpdir(), "assethive-client-cache-fixture");
  const removed = [];
  let disposed = 0;
  const context = vm.createContext({ path,
    closeLibraryDb: () => {}, LIBRARY_JSON_CACHE_FILE_NAME: "HiveIndex.json",
    getDataFilePath: name => path.join(local, name),
    getLibraryJsonCachePath: () => path.join(local, "LibraryCache", "library.json"),
    getLibrarySqlCachePath: () => path.join(local, "LibraryCache", "library.sqlite"),
    getFallbackLibrarySqlCachePath: () => path.join(local, "HiveIndex.sqlite"),
    getCustomLibraryIndexPaths: () => { throw new Error("must not touch the shared memo"); },
    fs: { stat: async () => ({}), rm: async file => removed.push(file) },
    clearRuntimeCaches: async () => ({ removed: [], failed: [] }), writeLog: () => {},
    sharedDerivedCache: { dispose: () => disposed++ }
  });
  vm.runInContext(`let index = [{ id: 'visible' }], librarySelectionGeneration = 0, libraryCacheRestorePromise = null;
    ${source.slice(start, end)}`, context);
  assert.equal((await context.clearAssetCaches()).ok, true);
  assert.equal(disposed, 1);
  assert.equal(vm.runInContext("index[0].id", context), "visible", "clearing disk caches keeps the visible snapshot");
  assert.ok(removed.includes(path.join(local, "LibraryCache", "library.memo.json.gz")));
  assert.ok(removed.every(file => file.startsWith(local + path.sep)));
});
