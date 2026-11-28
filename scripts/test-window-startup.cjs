const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { setImmediate, setTimeout: delay } = require("node:timers/promises");
const { createStartupView } = require("../electron/services/startupView");

const source = fs.readFileSync(path.join(__dirname, "../electron/main.js"), "utf8");
const start = source.indexOf("  const rendererLoadStartedAt = Date.now();");
const end = source.indexOf('  win.webContents.on("render-process-gone"', start);
assert.ok(start >= 0 && end > start);
const startup = source.slice(start, end);

function fixture({ autoScan = false, libraryPath = "library", restoreCache = async () => true, scan = async () => {} } = {}) {
  let elapsed = 0;
  const timers = new Set();
  const calls = { shown: 0, rendererLoads: 0, watching: 0, periodic: [], disposed: 0, logs: [], dialogs: [], scans: [], rendererMessages: [] };
  const win = new EventEmitter();
  win.webContents = new EventEmitter();
  win.webContents.send = (...args) => calls.rendererMessages.push(args);
  win.loadURL = async () => { calls.rendererLoads++; };
  win.isDestroyed = () => false;
  win.isVisible = () => calls.shown > 0;
  win.isMinimized = () => false;
  win.isFocused = () => false;
  win.show = () => { calls.shown++; };
  const scope = {
    win, ipcMain: new EventEmitter(), process: { env: {} }, app: { isPackaged: false }, quitting: false,
    settings: { uiLanguage: "zh", customLibraryPath: libraryPath }, index: [],
    diagnostics: { recordEvent() {} },
    WebContentsView: class {},
    createStartupView: options => {
      let settle;
      const ready = new Promise(resolve => { settle = resolve; });
      calls.view = {
        onLoaded: () => { options.onLoaded(); settle(); },
        onError: error => { options.onError(error); settle(); }
      };
      return { ready, dispose: () => { calls.disposed++; settle(); } };
    },
    Date: { now: () => elapsed },
    globalThis: {
      setTimeout: (callback, delay) => {
        const timer = { callback, delay, unref() {} };
        timers.add(timer);
        return timer;
      },
      clearTimeout: timer => timers.delete(timer)
    },
    writeLog: (...args) => calls.logs.push(args),
    startWatching: () => { calls.watching++; },
    startPeriodicScan: (_win, options) => calls.periodic.push(options),
    shouldAutoScanOnStartup: () => autoScan,
    waitForLibraryCacheRestore: restoreCache,
    performScan: async (_win, options) => { calls.scans.push(options); await scan(); },
    dialog: { showMessageBox: async (_win, options) => { calls.dialogs.push(options); } }
  };
  const renderer = new Function("scope", "with (scope) { " + startup +
    "return { loadRenderer, getStartupLibrary: () => startupLibraryReady }; }")(scope);
  return {
    win, calls, timers, ipcMain: scope.ipcMain, ...renderer,
    mount: () => scope.ipcMain.emit("app:startupMilestone", { sender: win.webContents }, { stage: "ui-mounted" }),
    advance: ms => {
      elapsed = ms;
      for (const timer of [...timers]) {
        if (timer.delay <= ms) {
          timers.delete(timer);
          timer.callback();
        }
      }
    }
  };
}

test("the startup page opens before the app renderer begins loading", async () => {
  const f = fixture();
  const loading = f.loadRenderer();
  assert.equal(f.calls.rendererLoads, 0);
  f.calls.view.onLoaded();
  assert.equal(f.calls.shown, 1);
  await loading;
  assert.equal(f.calls.rendererLoads, 1);
});

test("a failed local startup page falls back to loading the app", async () => {
  const f = fixture();
  const loading = f.loadRenderer();
  f.calls.view.onError(new Error("unavailable"));
  await loading;
  assert.equal(f.calls.rendererLoads, 1);
  assert.equal(f.calls.shown, 0);
  f.mount();
  assert.equal(f.calls.shown, 1);
});

test("warm startup waits for the snapshot but leaves reconciliation to the background", async () => {
  let restore;
  const cache = new Promise(resolve => { restore = resolve; });
  const f = fixture({ autoScan: true, restoreCache: () => cache });
  f.calls.view.onLoaded();
  await f.loadRenderer();
  const library = f.getStartupLibrary();
  assert.ok(library);
  assert.equal(f.calls.rendererLoads, 1);
  assert.equal(f.calls.disposed, 0);
  restore(true);
  await library;
  assert.deepEqual(f.calls.scans, []);
  f.mount();
  assert.deepEqual(f.calls.periodic, [{ startup: true }]);
});

test("cold startup waits for one initial scan and schedules only periodic checks afterward", async () => {
  let finishScan;
  const scan = new Promise(resolve => { finishScan = resolve; });
  const f = fixture({ autoScan: true, restoreCache: async () => false, scan: () => scan });
  f.calls.view.onLoaded();
  await f.loadRenderer();
  const library = f.getStartupLibrary();
  let libraryLoaded = false;
  void library.then(() => { libraryLoaded = true; });
  await setImmediate();
  assert.equal(libraryLoaded, false);
  assert.equal(f.calls.disposed, 0);
  const [{ onFinished, ...scanOptions }] = f.calls.scans;
  assert.deepEqual(scanOptions, { reason: "startup", force: true, coldStartup: true });
  onFinished({ active: false, phase: "failed", progress: 0 });
  assert.deepEqual(f.calls.rendererMessages, []);
  finishScan();
  await library;
  f.mount();
  assert.deepEqual(f.calls.rendererMessages, [["assets:scanProgress", { active: false, phase: "failed", progress: 0, startup: true }]]);
  assert.deepEqual(f.calls.periodic, [{ startup: false }]);
});

test("an unconfigured library or disabled startup scanning does not force a cold scan", async () => {
  for (const options of [{ autoScan: true, libraryPath: "" }, { autoScan: false, restoreCache: async () => false }]) {
    const f = fixture(options);
    f.calls.view.onLoaded();
    await f.loadRenderer();
    await f.getStartupLibrary();
    assert.deepEqual(f.calls.scans, []);
  }
});

test("a slow renderer leaves the startup view visible until the UI has painted", () => {
  const f = fixture();
  f.calls.view.onLoaded();
  f.advance(3000);
  assert.equal(f.calls.shown, 1);
  assert.equal(f.calls.disposed, 0);
  assert.equal(f.calls.logs.at(-1)[2].durationMs, 3000);
  f.advance(27000);
  f.win.emit("ready-to-show");
  assert.equal(f.calls.disposed, 0);
  f.mount();
  assert.equal(f.calls.shown, 1);
  assert.equal(f.calls.disposed, 1);
  assert.equal(f.calls.watching, 1);
  assert.deepEqual(f.calls.periodic, [{ startup: false }]);
  assert.equal(f.calls.logs.at(-1)[2].durationMs, 27000);
});

test("animation foreground state follows the native window through minimize, restore and focus changes", () => {
  const start = source.indexOf("  const publishForegroundState =");
  const end = source.indexOf("  const diagnostics =", start);
  assert.ok(start >= 0 && end > start);
  const win = new EventEmitter();
  const state = { visible: false, minimized: false, focused: false };
  const foreground = [];
  win.isDestroyed = () => false;
  win.isVisible = () => state.visible;
  win.isMinimized = () => state.minimized;
  win.isFocused = () => state.focused;
  win.webContents = { ipc: new EventEmitter(), isDestroyed: () => false, send: (channel, active) => {
    assert.equal(channel, "window:foregroundChanged");
    foreground.push(active);
  } };
  const foregroundWindows = new Set();
  const warmup = [];
  const reschedule = [];
  new Function("win", "foregroundWindows", "sharedDerivedCache", "periodicScanTimer", "startPeriodicScan", source.slice(start, end))(
    win, foregroundWindows, { setNormalWarmupPaused: value => warmup.push(value) },
    {}, (_window, options) => reschedule.push(options.immediate)
  );
  win.webContents.ipc.emit("window:requestForeground");
  for (const [event, patch] of [
    ["show", { visible: true }], ["focus", { focused: true }], ["minimize", { minimized: true }],
    ["blur", { focused: false }], ["restore", { minimized: false }], ["focus", { focused: true }],
    ["blur", { focused: false }], ["focus", { focused: true }], ["hide", { visible: false }]
  ]) {
    Object.assign(state, patch);
    win.emit(event);
  }
  assert.deepEqual(foreground, [false, false, true, false, false, false, true, false, true, false]);
  assert.deepEqual(warmup, foreground.map(active => !active));
  assert.deepEqual(reschedule, [true, false, true, false, true, false]);
  Object.assign(state, { visible: true });
  win.emit("focus");
  assert.equal(foregroundWindows.has(win), true);
  win.emit("closed");
  assert.equal(warmup.at(-1), true);
  assert.equal(foregroundWindows.has(win), false);
});

test("minimized startup finishes loading without restoring the window", async () => {
  const f = fixture({ autoScan: true });
  f.calls.view.onLoaded();
  f.win.isVisible = () => false;
  f.win.isMinimized = () => true;
  await f.loadRenderer();
  await f.getStartupLibrary();
  f.mount();
  assert.equal(f.calls.shown, 1);
  assert.equal(f.calls.rendererLoads, 1);
  assert.equal(f.calls.disposed, 1);
  assert.deepEqual(f.calls.periodic, [{ startup: true }]);
});

test("startup joins the automatic timer once the app is mounted", () => {
  const f = fixture({ autoScan: true });
  assert.deepEqual(f.calls.periodic, []);
  f.mount();
  f.mount();
  assert.equal(f.calls.shown, 1);
  assert.deepEqual(f.calls.periodic, [{ startup: true }]);
});

test("the native window stays hidden if neither the startup view nor the UI is ready", () => {
  const f = fixture();
  f.win.webContents.emit("did-finish-load");
  assert.equal(f.calls.shown, 0);
  f.win.emit("ready-to-show");
  assert.equal(f.calls.shown, 0);
  f.mount();
  assert.equal(f.calls.shown, 1);
  f.win.webContents.emit("did-finish-load");
  assert.equal(f.calls.shown, 1);
  assert.equal(f.timers.size, 0);
});

test("startup timings accept only this window's known milestones and unsubscribe on close", () => {
  const f = fixture();
  const channel = "app:startupMilestone";
  const logs = f.calls.logs.length;
  f.ipcMain.emit(channel, { sender: {} }, { stage: "ui-mounted" });
  f.ipcMain.emit(channel, { sender: f.win.webContents }, { stage: "unknown" });
  assert.equal(f.calls.logs.length, logs);
  f.advance(500);
  f.ipcMain.emit(channel, { sender: f.win.webContents }, { stage: "modules-ready", navigation: { responseEndMs: 100 } });
  assert.deepEqual(f.calls.logs.at(-1)[2], { stage: "modules-ready", durationMs: 500, navigation: { responseEndMs: 100 } });
  f.win.emit("closed");
  assert.equal(f.ipcMain.listenerCount(channel), 0);
});

test("closing during startup cancels the loading warning", () => {
  const f = fixture();
  f.win.emit("closed");
  assert.equal(f.timers.size, 0);
  f.advance(3000);
  assert.equal(f.calls.shown, 0);
  assert.equal(f.calls.logs.length, 0);
});

test("failed loads still report the error and cancel the waiting timer", async () => {
  const f = fixture();
  f.win.webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", "http://localhost:5173", false);
  f.win.webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "http://localhost:5173", true);
  assert.equal(f.calls.disposed, 0);
  f.win.webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", "http://localhost:5173", true);
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.dialogs.length, 1);
  assert.equal(f.calls.disposed, 1);
  assert.match(f.calls.dialogs[0].message, /ERR_CONNECTION_REFUSED/);
});

function viewFixture() {
  const calls = { closedWindow: 0, minimizedWindow: 0, loaded: 0, errors: [], views: [], messages: [] };
  let resolveLoad, rejectLoad;
  const mainWindow = new EventEmitter();
  let size = [1280, 800];
  mainWindow.contentView = {
    addChildView: view => calls.views.push(view),
    removeChildView: view => calls.views.splice(calls.views.indexOf(view), 1)
  };
  mainWindow.close = () => { calls.closedWindow++; };
  mainWindow.minimize = () => { calls.minimizedWindow++; };
  mainWindow.getContentSize = () => size;
  mainWindow.isDestroyed = () => mainWindow.destroyed;
  class View {
    constructor(options) {
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.ipc = new EventEmitter();
      this.webContents.loadFile = (file, options) => {
        this.file = file;
        this.query = options.query;
        return new Promise((resolve, reject) => { resolveLoad = resolve; rejectLoad = reject; });
      };
      this.webContents.send = (...args) => calls.messages.push(args);
      this.webContents.isDestroyed = () => this.destroyed;
      this.webContents.close = () => { this.destroyed = true; };
    }
    setBackgroundColor() {}
    setBounds(bounds) { this.bounds = bounds; }
  }
  const controller = createStartupView({ WebContentsView: View, mainWindow, language: "en",
    onLoaded: () => { calls.loaded++; }, onError: error => calls.errors.push(error) });
  return { calls, mainWindow, view: calls.views[0], controller, resolveLoad, rejectLoad, resize: (...next) => {
    size = next;
    mainWindow.emit("resize");
  } };
}

test("startup animation loads locally in the main window, resizes and uses the loaded language", async () => {
  const f = viewFixture();
  assert.equal(path.basename(f.view.file), "startup.html");
  assert.equal(f.view.query.lang, "en");
  assert.equal(f.view.options.webPreferences.nodeIntegration, false);
  assert.deepEqual(f.view.bounds, { x: 0, y: 0, width: 1280, height: 800 });
  f.resize(900, 500);
  assert.deepEqual(f.view.bounds, { x: 0, y: 0, width: 900, height: 500 });
  f.controller.setLanguage("zh");
  assert.equal(f.calls.loaded, 0);
  f.resolveLoad();
  await Promise.resolve();
  assert.deepEqual(f.calls.messages, [["startup:language", "zh"]]);
  assert.equal(f.calls.loaded, 1);
});

test("the startup view delegates minimize and close to its native window", () => {
  const f = viewFixture();
  f.view.webContents.ipc.emit("startup:minimize");
  assert.equal(f.calls.minimizedWindow, 1);
  assert.equal(f.calls.closedWindow, 0);
  f.view.webContents.ipc.emit("startup:cancel");
  assert.equal(f.calls.closedWindow, 1);
});

test("handoff detaches the visible startup view before closing its renderer", async () => {
  const f = viewFixture();
  f.resolveLoad();
  await f.controller.ready;
  f.controller.dispose();
  assert.deepEqual(f.calls.views, []);
  assert.equal(f.view.destroyed, undefined);
  await delay(75);
  assert.equal(f.view.destroyed, true);
});

test("a fast app can remove the view before load completes without a late flash", async () => {
  const f = viewFixture();
  f.controller.dispose();
  f.controller.dispose();
  f.resolveLoad();
  await Promise.resolve();
  assert.equal(f.view.destroyed, true);
  assert.equal(f.calls.loaded, 0);
  assert.equal(f.calls.closedWindow, 0);
  assert.deepEqual(f.calls.views, []);
  assert.equal(f.mainWindow.listenerCount("resize"), 0);
  assert.equal(f.mainWindow.listenerCount("closed"), 0);
});

test("closing the main window closes the view even when the native window is already destroyed", () => {
  const f = viewFixture();
  f.mainWindow.destroyed = true;
  f.mainWindow.emit("closed");
  assert.equal(f.view.destroyed, true);
});

test("a failed startup view detaches without preventing the main UI from loading", async () => {
  const f = viewFixture();
  f.rejectLoad(new Error("unavailable"));
  await setImmediate();
  assert.equal(f.view.destroyed, true);
  assert.deepEqual(f.calls.views, []);
  assert.equal(f.calls.errors[0].message, "unavailable");
});

test("a second launch focuses the same window once it has content", () => {
  const start = source.indexOf("function showMainWindow() {");
  const end = source.indexOf("\nfunction confirmQuitAfterImport", start);
  let focused = 0;
  let visible = false;
  const win = { isDestroyed: () => false, isMinimized: () => false, isVisible: () => visible, focus: () => { focused++; } };
  const scope = {
    quitting: false,
    BrowserWindow: { getAllWindows: () => [win] }
  };
  const show = new Function("scope", "with (scope) { " + source.slice(start, end) + " return showMainWindow; }")(scope);
  show();
  assert.equal(focused, 0);
  visible = true;
  show();
  assert.equal(focused, 1);
});
