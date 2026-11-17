const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { setImmediate } = require("node:timers/promises");
const test = require("node:test");
const { planLibraryWatch } = require("../electron/services/libraryWatchPolicy");
const { startLibraryWatch } = require("../electron/services/libraryWatchService");

test("UNC libraries never query drives or register recursive watchers", async () => {
  const roots = ["\\\\fileshare\\share\\Artist", "//fileshare/share/Artist", "\\\\?\\UNC\\fileshare\\share\\Artist"];
  const plan = await planLibraryWatch(roots, { platform: "win32", readDriveTypes: () => assert.fail("UNC needs no drive query") });
  assert.deepEqual(plan.watchPaths, []);
  assert.deepEqual(plan.skipped.map(item => item.path), roots);
  assert.ok(plan.skipped.every(item => item.reason === "network"));
});

test("mapped and extended mapped drives are excluded while local drive types retain live updates", async () => {
  const roots = ["Z:\\Artist", "z:/Other", "\\\\?\\Z:\\Artist", "C:\\Assets", "D:\\Assets"];
  const plan = await planLibraryWatch(roots, { platform: "win32", readDriveTypes: async drives => {
    assert.deepEqual(drives, ["Z:\\", "C:\\", "D:\\"]);
    return new Map([["Z:\\", "Network"], ["C:\\", "Fixed"], ["D:\\", "Removable"]]);
  } });
  assert.deepEqual(plan.watchPaths, roots.slice(3));
  assert.deepEqual(plan.skipped.map(item => item.path), roots.slice(0, 3));
  assert.ok(plan.skipped.every(item => item.reason === "network"));
});

test("unknown, offline and unverified Windows drives use periodic scans instead of recursive watches", async () => {
  for (const readDriveTypes of [async () => new Map([["Z:\\", "NoRootDirectory"]]), async () => new Map(), async () => { throw new Error("PowerShell blocked"); }]) {
    const plan = await planLibraryWatch(["Z:\\Artist"], { platform: "win32", readDriveTypes });
    assert.deepEqual(plan.watchPaths, []);
    assert.equal(plan.skipped[0].reason, "unresolved-drive");
  }
});

test("POSIX local libraries do not invoke Windows drive discovery", async () => {
  const plan = await planLibraryWatch(["/srv/assets"], { platform: "linux", readDriveTypes: () => assert.fail("Windows query on POSIX") });
  assert.deepEqual(plan.watchPaths, ["/srv/assets"]);
});

async function serviceFixture(readDriveTypes) {
  const workers = [], logs = [];
  class Worker extends EventEmitter {
    constructor(file, options) { super(); this.options = options; this.terminated = 0; workers.push(this); }
    unref() {}
    terminate() { this.terminated++; return Promise.resolve(0); }
  }
  const context = vm.createContext({ __dirname: path.resolve(__dirname, "../electron/services"), console, module: { exports: {} },
    require: name => {
      if (name === "node:worker_threads") return { Worker };
      if (name === "./libraryWatchPolicy") return { planLibraryWatch: paths => planLibraryWatch(paths, { platform: "win32", readDriveTypes }) };
      if (name === "../logManager") return { writeLog: (...args) => logs.push(args) };
      return require(name);
    } });
  vm.runInContext(await fs.readFile(path.resolve(__dirname, "../electron/services/libraryWatchService.js"), "utf8"), context);
  return { ...context.module.exports, workers, logs };
}

test("a mapped NAS library never starts the Chokidar worker", async () => {
  const f = await serviceFixture(async () => new Map([["Z:\\", "Network"]]));
  const watch = f.startLibraryWatch(["Z:\\Artist"], () => assert.fail("network watcher callback"));
  const ready = await watch.ready;
  assert.equal(ready.directories, 0);
  assert.equal(f.workers.length, 0);
  assert.equal(f.logs[0][2].reason, "network");
  await watch.close();
});

test("closing during drive discovery prevents a stale watcher from starting", async () => {
  let release;
  const f = await serviceFixture(() => new Promise(resolve => { release = resolve; }));
  const watch = f.startLibraryWatch(["C:\\Assets"], () => {});
  await watch.close();
  release(new Map([["C:\\", "Fixed"]]));
  await setImmediate();
  assert.equal((await watch.ready).type, "closed");
  assert.equal(f.workers.length, 0);
});

test("switching from a local library to mapped NAS closes the old worker and starts no replacement", async () => {
  const f = await serviceFixture(async () => new Map([["C:\\", "Fixed"], ["Z:\\", "Network"]]));
  const local = f.watchLibrary(["C:\\Assets"], () => {});
  await setImmediate();
  assert.equal(f.workers.length, 1);
  f.workers[0].emit("message", { type: "ready", directories: 1, entries: 1 });
  await local.ready;
  const network = f.watchLibrary(["Z:\\Artist"], () => {});
  await network.ready;
  assert.equal(f.workers[0].terminated, 1);
  assert.equal(f.workers.length, 1);
  await f.stopLibraryWatch();
});

test("Windows drive discovery identifies the actual local workspace without WMI", { skip: process.platform !== "win32" }, async () => {
  const root = path.resolve(__dirname, "..");
  assert.deepEqual((await planLibraryWatch([root])).watchPaths, [root]);
});

test("a real local library still reports metadata edits after watcher readiness", { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-watch-local-"));
  const file = path.join(root, "asset_info.json");
  await fs.writeFile(file, '{"name":"original"}');
  let resolveChange;
  const changed = new Promise(resolve => { resolveChange = resolve; });
  const watch = startLibraryWatch([root], payload => resolveChange(payload), { debounceMs: 200 });
  t.after(async () => { await watch.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const ready = await watch.ready;
  assert.ok(ready.directories > 0, "local watcher must start");
  await fs.writeFile(file, '{"name":"edited"}');
  const payload = await changed;
  assert.ok(payload.changes.some(item => path.resolve(item.path) === file));
});

test("disabling live updates stops the existing watcher before any new library is watched", async () => {
  const source = await fs.readFile(path.resolve(__dirname, "../electron/main.js"), "utf8");
  const start = source.indexOf("function startWatching(window) {");
  const end = source.indexOf("\nfunction shouldAutoScanOnStartup(", start);
  let stopped = 0;
  const context = vm.createContext({ settings: { customLibraryPath: "C:\\Assets" }, ENABLE_WATCH_AUTO_SCAN: false,
    stopLibraryWatch: () => { stopped++; }, watchLibrary: () => assert.fail("watching is disabled") });
  vm.runInContext(source.slice(start, end), context);
  context.startWatching({});
  assert.equal(stopped, 1);
});
