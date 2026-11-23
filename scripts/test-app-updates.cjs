const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { Buffer } = require("node:buffer");
const { EventEmitter } = require("node:events");
const { createAppUpdateController } = require("../electron/services/appUpdateController");
const { saveUpdateResponse, verifyCachedUpdatePackage } = require("../electron/services/updatePackage");
const { windowsPackageType, pickWindowsUpdateAsset, findLocalUpdatePackage, detectWindowsInstallation } = require("../electron/services/windowsUpdate");

const windowsAssets = [
  { name: "AssetHive-2.2.10-Windows-setup.exe", browser_download_url: "https://example.test/wrapper" },
  { name: "AssetHive-2.2.10-win64.msi", browser_download_url: "https://example.test/msi" },
  { name: "AssetHive-2.2.10-setup-win64.exe", browser_download_url: "https://example.test/exe" },
  { name: "AssetHive-2.2.10-portable-win64.zip", browser_download_url: "https://example.test/zip" }
];

test("Windows releases stay within their installer family, including the MSI EXE wrapper", () => {
  assert.equal(pickWindowsUpdateAsset(windowsAssets, "exe"), windowsAssets[2]);
  assert.equal(pickWindowsUpdateAsset(windowsAssets, "msi"), windowsAssets[1]);
  assert.equal(pickWindowsUpdateAsset(windowsAssets, "portable"), windowsAssets[3]);
  assert.equal(pickWindowsUpdateAsset([windowsAssets[0]], "msi"), windowsAssets[0]);
  assert.equal(pickWindowsUpdateAsset([windowsAssets[0], windowsAssets[1], windowsAssets[3]], "exe"), null);
  assert.equal(pickWindowsUpdateAsset([windowsAssets[2]], "msi"), null);
  assert.equal(pickWindowsUpdateAsset(windowsAssets, ""), null);
  assert.equal(windowsPackageType("AssetHive-2.2.10-setup-arm64.exe"), "");
  assert.equal(windowsPackageType("AssetHive-2.2.10-setup-win64.exe.sha256"), "");
});

test("shared download cache never reuses a different installer type", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-update-types-"));
  try {
    for (const asset of windowsAssets) {
      const content = asset.name.endsWith(".zip") ? Buffer.from("PKupdate") : Buffer.from("MZupdate");
      await saveUpdateResponse(new globalThis.Response(content), path.join(dir, asset.name), { version: "2.2.10", size: content.length });
    }
    for (const type of ["exe", "msi", "portable"]) {
      assert.equal(windowsPackageType(await findLocalUpdatePackage(dir, "2.2.10", type)), type);
      assert.equal(await findLocalUpdatePackage(dir, "2.2.11", type), "");
    }
    await fs.rm(path.join(dir, windowsAssets[2].name));
    assert.equal(await findLocalUpdatePackage(dir, "2.2.10", "exe"), "");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("installation markers preserve custom machine and current-user install scopes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-install-type-"));
  try {
    for (const [type, scope] of [["exe", "user"], ["exe", "machine"], ["msi", "machine"]]) {
      await fs.writeFile(path.join(dir, "assethive-install.ini"), `[Install]\r\nType=${type}\r\nScope=${scope}\r\n`);
      assert.deepEqual(await detectWindowsInstallation(dir), { type, scope });
    }
    await fs.writeFile(path.join(dir, "assethive-install.ini"), "[Install]\nType=msi\nScope=user\n");
    await assert.rejects(detectWindowsInstallation(dir), /安装类型记录无效/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function windowsMainUpdateFixture(type, assets = windowsAssets) {
  const main = await fs.readFile(path.join(__dirname, "../electron/main.js"), "utf8");
  const scope = {
    app: { isPackaged: true, getVersion: () => "2.2.9", getPath: () => "D:\\Custom App\\AssetHive.exe" },
    normalizeVersionTag: value => value, compareVersions: () => 1,
    APP_UPDATE_REPO_CANDIDATES: [],
    fetchLatestAppRelease: async () => ({ version: "2.2.10", assets }),
    getAppInstallation: async () => ({ type, scope: "machine" }),
    getUpdateStorageContext: () => ({ appRootPath: "D:\\Custom App", updateDir: "D:\\Cache" }),
    findLocalUpdatePackage: async (_dir, _version, installType) => { assert.equal(installType, type); return ""; },
    pickWindowsUpdateAsset, windowsPackageType, path, process,
    BrowserWindow: { getAllWindows: () => [] },
    fs: { mkdir: async () => {}, stat: async () => ({ isFile: () => true }), copyFile: async () => {} },
    verifyCachedUpdatePackage: async () => ({ ok: true }),
    downloadReleaseAsset: async url => { scope.downloadedUrl = url; },
    globalThis: { setTimeout: () => {} },
    require: () => ({ spawn: (_file, args) => {
      scope.spawnArgs = args;
      const child = new EventEmitter();
      child.unref = () => {};
      globalThis.queueMicrotask(() => child.emit("spawn"));
      return child;
    } })
  };
  for (const [name, end] of [
    ["checkAppUpdateRelease", '  ipcMain.handle("app:getVersion"'],
    ["downloadAppUpdateRelease", "  appUpdates = createAppUpdateController({"],
    ["launchDownloadedUpdatePackage", "async function downloadReleaseAsset("]
  ]) {
    const start = main.indexOf(`async function ${name}(`);
    assert.ok(start >= 0);
    scope[name] = new Function("scope", "with (scope) { " + main.slice(start, main.indexOf(end, start)) + `; return ${name}; }`)(scope);
  }
  return scope;
}

test("manual/background release entry points select the matching installer and refuse cross-type fallback", async () => {
  for (const [type, asset] of [["exe", windowsAssets[2]], ["msi", windowsAssets[1]]]) {
    const f = await windowsMainUpdateFixture(type);
    assert.equal((await f.checkAppUpdateRelease()).downloadUrl, asset.browser_download_url);
    assert.equal((await f.downloadAppUpdateRelease()).ok, true);
    assert.equal(f.downloadedUrl, asset.browser_download_url);
  }
  const f = await windowsMainUpdateFixture("exe", windowsAssets.slice(0, 2));
  assert.equal((await f.checkAppUpdateRelease()).updateReady, false);
  assert.equal((await f.downloadAppUpdateRelease()).ok, false);
  assert.equal(f.downloadedUrl, undefined);
});

test("install entry rejects stale cross-type packages and passes original scope to the helper", async () => {
  const f = await windowsMainUpdateFixture("exe");
  for (const asset of [windowsAssets[0], windowsAssets[1], windowsAssets[3]]) {
    const result = await f.launchDownloadedUpdatePackage(asset.name);
    assert.equal(result.ok, false);
    assert.equal(result.invalidPackage, true);
    assert.equal(f.spawnArgs, undefined);
  }
  assert.equal((await f.launchDownloadedUpdatePackage(windowsAssets[2].name)).ok, true);
  assert.equal(f.spawnArgs[f.spawnArgs.indexOf("--install-type") + 1], "exe");
  assert.equal(f.spawnArgs[f.spawnArgs.indexOf("--install-scope") + 1], "machine");
  assert.equal(f.spawnArgs[f.spawnArgs.indexOf("--target") + 1], "D:\\Custom App");
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(options = {}) {
  const calls = { checks: 0, downloads: 0, prompts: 0, launches: 0, errors: [] };
  let busy = false;
  const release = { ok: true, hasUpdate: true, latestVersion: "2.2.5", updateReady: false, localPackagePath: "" };
  const downloaded = { ...release, updateReady: true, filePath: "cached/setup.exe" };
  const controller = createAppUpdateController({
    checkRelease: async () => { calls.checks++; return release; },
    downloadRelease: async () => { calls.downloads++; return downloaded; },
    isBusy: () => busy,
    prompt: async () => { calls.prompts++; return false; },
    launch: async () => { calls.launches++; return { ok: true }; },
    onError: error => calls.errors.push(error.message),
    ...options
  });
  return { controller, calls, release, downloaded, setBusy: value => { busy = value; } };
}

test("discovery downloads in the background without prompting during download", async () => {
  const pending = deferred();
  const f = fixture({ downloadRelease: () => pending.promise });
  await f.controller.tick(0);
  assert.equal(f.calls.prompts, 0);
  const download = f.controller.download();
  assert.equal((await f.controller.install("cached/setup.exe")).busy, true);
  pending.resolve(f.downloaded);
  await download;
  await f.controller.tick(2000);
  assert.equal(f.calls.prompts, 1);
});

test("waits for all import/export activity and defers the same version once", async () => {
  const f = fixture();
  f.setBusy(true);
  await f.controller.check();
  await f.controller.download();
  await f.controller.tick(0);
  assert.equal(f.calls.prompts, 0);
  f.setBusy(false);
  await f.controller.tick(2000);
  await f.controller.tick(4000);
  assert.equal(f.calls.prompts, 1);
  f.release.latestVersion = "2.2.6";
  f.release.updateReady = true;
  f.release.localPackagePath = "cached/new.exe";
  await f.controller.check();
  await f.controller.tick(6000);
  assert.equal(f.calls.prompts, 2);
});

test("cached complete package prompts without downloading again", async () => {
  const f = fixture();
  Object.assign(f.release, { updateReady: true, localPackagePath: "cached/setup.exe" });
  await f.controller.tick(0);
  assert.equal(f.calls.downloads, 0);
  assert.equal(f.calls.prompts, 1);
});

test("manual and automatic checks/downloads share one request", async () => {
  const check = deferred();
  const download = deferred();
  let checks = 0;
  let downloads = 0;
  const f = fixture({
    checkRelease: () => { checks++; return check.promise; },
    downloadRelease: () => { downloads++; return download.promise; }
  });
  const first = f.controller.check();
  assert.equal(first, f.controller.check());
  check.resolve(f.release);
  await first;
  const active = f.controller.download();
  assert.equal(active, f.controller.download());
  await f.controller.check();
  assert.deepEqual([checks, downloads], [1, 1]);
  download.resolve(f.downloaded);
  await active;
});

test("a task starting during the prompt postpones installation until idle", async () => {
  const answer = deferred();
  const opened = deferred();
  let prompts = 0;
  const f = fixture({ prompt: () => { prompts++; opened.resolve(); return prompts === 1 ? answer.promise : false; } });
  Object.assign(f.release, { updateReady: true, localPackagePath: "cached/setup.exe" });
  const tick = f.controller.tick(0);
  await opened.promise;
  f.setBusy(true);
  answer.resolve(true);
  await tick;
  assert.equal(f.calls.launches, 0);
  f.setBusy(false);
  await f.controller.tick(2000);
  assert.equal(prompts, 2);
});

test("install lock covers verification/extraction and blocks double installation", async () => {
  const launch = deferred();
  const f = fixture({ launch: () => launch.promise });
  const installing = f.controller.install("cached/setup.exe");
  assert.equal(f.controller.isInstalling(), true);
  assert.equal((await f.controller.install("cached/setup.exe")).busy, true);
  launch.resolve({ ok: false, message: "spawn failed" });
  await installing;
  assert.equal(f.controller.isInstalling(), false);
  f.setBusy(true);
  assert.equal((await f.controller.install("cached/setup.exe")).busy, true);
});

test("download/check failures stay quiet and retry at the next scheduled check", async () => {
  let checks = 0;
  const f = fixture({ checkRelease: async () => { checks++; throw new Error("offline"); } });
  await f.controller.tick(0);
  await f.controller.tick(2000);
  assert.equal(checks, 1);
  await f.controller.tick(30 * 60 * 1000);
  assert.equal(checks, 2);
  assert.equal(f.calls.prompts, 0);
});

test("invalid package restores the download action while a busy rejection preserves the cache", async () => {
  const states = [];
  const f = fixture({
    onState: state => states.push({ ...state }),
    launch: async () => ({ ok: false, invalidPackage: true, message: "corrupt package" })
  });
  Object.assign(f.release, { updateReady: true, localPackagePath: "cached/setup.exe" });
  await f.controller.check();
  f.setBusy(true);
  await f.controller.install("cached/setup.exe");
  assert.equal(states.at(-1).updateReady, true);
  f.setBusy(false);
  await f.controller.install("cached/setup.exe");
  assert.equal(states.at(-1).updateReady, false);
  assert.equal(states.at(-1).localPackagePath, "");
});

test("no visible window does not defer the update", async () => {
  let visible = false;
  let prompts = 0;
  const f = fixture({ prompt: async () => { prompts++; return visible ? false : null; } });
  Object.assign(f.release, { updateReady: true, localPackagePath: "cached/setup.exe" });
  await f.controller.tick(0);
  visible = true;
  await f.controller.tick(2000);
  assert.equal(prompts, 2);
});

test("preview check does not automatically download", async () => {
  const f = fixture({ autoDownload: false });
  await f.controller.check();
  assert.equal(f.calls.downloads, 0);
});

test("stop prevents an outstanding prompt from installing", async () => {
  const answer = deferred();
  const f = fixture({ prompt: () => answer.promise });
  Object.assign(f.release, { updateReady: true, localPackagePath: "cached/setup.exe" });
  const tick = f.controller.tick(0);
  await Promise.resolve();
  f.controller.stop();
  answer.resolve(true);
  await tick;
  assert.equal(f.calls.launches, 0);
});

async function updateWindowFixture() {
  const main = await fs.readFile(path.join(__dirname, "../electron/main.js"), "utf8");
  const preload = await fs.readFile(path.join(__dirname, "../electron/preload.js"), "utf8");
  const renderer = (await fs.readFile(path.join(__dirname, "../src/ui/App.tsx"), "utf8")).replace(/\r\n/g, "\n");
  const events = new EventEmitter();
  const handlers = new Map();
  const release = {
    ok: true, hasUpdate: true, updateReady: true, localPackagePath: "cached/setup.exe",
    latestVersion: "2.2.9", releaseNotes: "更新内容", packageSize: 1024
  };
  const state = {
    appUpdates: null, bridgeAvailable: true, appUpdateState: {}, open: false,
    visible: true, loading: false, active: false, launches: 0, prompts: 0,
    activeExportCalls: 0, quitAfterImport: false, quitting: false,
    createAppUpdateController, app: { isPackaged: false },
    checkAppUpdateRelease: async () => release,
    downloadAppUpdateRelease: async () => { throw new Error("package already cached"); },
    launchDownloadedUpdatePackage: async () => { state.launches++; return { ok: true }; },
    hasActiveBackgroundImport: () => state.active,
    writeLog: () => {},
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    BrowserWindow: { getAllWindows: () => [{
      isDestroyed: () => false, isVisible: () => state.visible,
      webContents: {
        isLoadingMainFrame: () => state.loading,
        send: (channel, payload) => {
          if (payload.showPrompt) state.prompts++;
          events.emit(channel, {}, payload);
        }
      }
    }] },
    useEffect: callback => { state.cleanup = callback(); },
    setAppUpdateState: updater => { state.appUpdateState = updater(state.appUpdateState); },
    setAppUpdateMode: value => { state.mode = value; },
    setAppUpdateBusy: value => { state.updateBusy = value; },
    setAppUpdateMessage: value => { state.message = value; },
    setUpdatePageOpen: value => { state.open = value; },
    importSaving: false, isExporting: false, busy: false, t: zh => zh
  };
  new Function("require", preload)(() => ({
    contextBridge: { exposeInMainWorld: (_name, bridge) => { state.bridge = bridge; } },
    ipcRenderer: {
      send: channel => assert.equal(channel, "app:startupMilestone"),
      on: (channel, callback) => events.on(channel, callback),
      removeListener: (channel, callback) => events.removeListener(channel, callback),
      invoke: (channel, payload) => handlers.get(channel)({}, payload)
    }
  }));
  const effectStart = renderer.indexOf("  useEffect(() => {\n    if (!bridgeAvailable || !bridge.onAppUpdateState)");
  assert.ok(effectStart >= 0);
  const effect = renderer.slice(effectStart, renderer.indexOf("\n  useEffect(", effectStart + 1));
  new Function("scope", "with (scope) { " + effect + " }")(state);
  const mainStart = main.indexOf("  appUpdates = createAppUpdateController({");
  assert.ok(mainStart >= 0);
  new Function("scope", "with (scope) { " + main.slice(mainStart, main.indexOf('  ipcMain.handle("plugins:installFromGithub"', mainStart)) + " }")(state);
  const installStart = renderer.indexOf("  async function installDownloadedUpdatePackage()");
  assert.ok(installStart >= 0);
  state.install = new Function("scope", "with (scope) { " + renderer.slice(installStart, effectStart) + "; return installDownloadedUpdatePackage; }")(state);
  return state;
}

test("automatic update opens the shared custom page once and installs through its existing action", async () => {
  const f = await updateWindowFixture();
  await f.appUpdates.tick(0);
  assert.equal(f.open, true);
  assert.equal(f.appUpdateState.latestVersion, "2.2.9");
  assert.equal(f.appUpdateState.releaseNotes, "更新内容");
  assert.equal(f.appUpdateState.packageSize, 1024);
  assert.equal(f.appUpdateState.localPackagePath, "cached/setup.exe");
  assert.equal(f.appUpdateState.updateReady, true);
  assert.equal(f.launches, 0);
  f.open = false;
  await f.appUpdates.tick(2000);
  assert.equal(f.open, false);
  assert.equal(f.prompts, 1);
  await f.install();
  assert.equal(f.launches, 1);
  f.cleanup();
});

test("custom update prompt waits for idle and a visible loaded window; state sync alone stays quiet", async () => {
  const f = await updateWindowFixture();
  f.active = true;
  await f.appUpdates.tick(0);
  assert.equal(f.appUpdateState.updateReady, true);
  assert.equal(f.open, false);
  f.active = false;
  f.visible = false;
  await f.appUpdates.tick(2000);
  f.visible = true;
  f.loading = true;
  await f.appUpdates.tick(4000);
  assert.equal(f.prompts, 0);
  f.loading = false;
  await f.appUpdates.tick(6000);
  assert.equal(f.open, true);
  assert.equal(f.prompts, 1);
  f.cleanup();
});

test("partial and modified downloads cannot be reused", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-update-test-"));
  try {
    const file = path.join(dir, "update.zip");
    const content = Buffer.from("PKcomplete-update");
    await saveUpdateResponse(new globalThis.Response(content), file, { version: "2.2.5", size: content.length });
    assert.equal((await verifyCachedUpdatePackage(file, "2.2.5")).ok, true);
    assert.equal((await verifyCachedUpdatePackage(file, "2.2.6")).ok, false);
    await fs.writeFile(file, Buffer.from("PKcorrupt--update"));
    assert.equal((await verifyCachedUpdatePackage(file, "2.2.5")).ok, false);
    await assert.rejects(saveUpdateResponse(new globalThis.Response(Buffer.from("PKpartial")), file, { version: "2.2.5", size: 100 }));
    assert.equal((await verifyCachedUpdatePackage(file, "2.2.5")).ok, false);
    await assert.rejects(fs.stat(file + ".part"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("export preparation stays busy and reports a per-asset read failure before releasing", async () => {
  const source = await fs.readFile(path.join(__dirname, "../electron/main.js"), "utf8");
  const start = source.indexOf('  const handleAssetExport =');
  const end = source.indexOf('  ipcMain.handle("assets:openFolder"', start);
  const preparing = deferred();
  let handler;
  const scope = {
    ipcMain: { handle: (name, callback) => { if (name === "assets:exportToUnreal") handler = callback; } },
    appUpdates: { isInstalling: () => false }, activeExportCalls: 0,
    recycleInProgress: false, filterRecycledIndex: async () => {},
    componentParentId: id => id, isCharacterUEAsset: () => false, isAnimationUEAsset: () => false,
    index: [{ id: "asset" }], refreshAssetById: () => preparing.promise,
    settings: {}, writeLog() {}, setMainWindowTaskbarProgress() {},
    exportToUnreal: async assets => {
      assert.equal(scope.activeExportCalls, 1);
      return { ok: false, results: assets.map(asset => ({ assetId: asset.id, status: "failed", message: asset.exportError })) };
    }
  };
  new Function("scope", "with (scope) { " + source.slice(start, end) + " }")(scope);
  const exporting = handler({}, { assetIds: ["asset"] });
  await Promise.resolve(); // The recycle-index check precedes asset preparation.
  assert.equal(scope.activeExportCalls, 1);
  preparing.reject(new Error("read failed"));
  const result = await exporting;
  assert.equal(result.ok, false);
  assert.equal(result.results[0].message, "read failed");
  assert.equal(scope.activeExportCalls, 0);
  scope.appUpdates.isInstalling = () => true;
  assert.equal((await handler({}, {})).ok, false);
  assert.equal(scope.activeExportCalls, 0);
});
