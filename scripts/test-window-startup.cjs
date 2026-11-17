const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { createStartupWindow } = require("../electron/services/startupWindow");
const { startupScanDelay } = require("../electron/services/scanTiming");

const source = fs.readFileSync(path.join(__dirname, "../electron/main.js"), "utf8");
const start = source.indexOf("  const rendererLoadStartedAt = Date.now();");
const end = source.indexOf('  win.webContents.on("render-process-gone"', start);
assert.ok(start >= 0 && end > start);
const startup = source.slice(start, end);

function fixture({ autoScan = false, hasCache = false } = {}) {
  let elapsed = 0;
  const timers = new Set();
  const calls = { shown: 0, watching: 0, periodic: 0, scans: 0, splashFinished: 0, logs: [], dialogs: [] };
  const win = new EventEmitter();
  win.webContents = new EventEmitter();
  win.loadURL = async () => {};
  win.isDestroyed = () => false;
  win.isVisible = () => calls.shown > 0;
  win.show = () => { calls.shown++; };
  const scope = {
    win, ipcMain: new EventEmitter(), process: { env: {} }, app: { isPackaged: false },
    startupWindow: { finish: () => { calls.splashFinished++; } }, startupWindows: new Map(),
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
    startPeriodicScan: () => { calls.periodic++; },
    shouldAutoScanOnStartup: () => autoScan,
    startupScanDelay, getScanClientId: () => "startup-test-client",
    index: hasCache ? [{ id: "cached" }] : [],
    waitForLibraryCacheRestore: async () => {},
    performScan: async () => { calls.scans++; },
    dialog: { showMessageBox: async (_win, options) => { calls.dialogs.push(options); } }
  };
  new Function("scope", "with (scope) { " + startup + " }")(scope);
  return {
    win, calls, timers, ipcMain: scope.ipcMain,
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

test("slow renderer stays hidden past three seconds and shows on first paint", () => {
  const f = fixture();
  f.advance(3000);
  assert.equal(f.calls.shown, 0);
  assert.equal(f.calls.logs.at(-1)[2].durationMs, 3000);
  f.advance(27000);
  f.win.emit("ready-to-show");
  assert.equal(f.calls.shown, 1);
  assert.equal(f.calls.splashFinished, 1);
  assert.equal(f.calls.watching, 1);
  assert.equal(f.calls.periodic, 1);
  assert.equal(f.calls.logs.at(-1)[2].durationMs, 27000);
});

test("staggered startup scans begin only after the window is shown and the delay expires", async () => {
  for (const hasCache of [false, true]) {
    const f = fixture({ autoScan: true, hasCache });
    assert.equal(f.calls.scans, 0);
    f.win.emit("ready-to-show");
    assert.equal(f.calls.shown, 1);
    assert.equal(f.calls.scans, 0);
    const delay = startupScanDelay("startup-test-client", hasCache);
    assert.equal([...f.timers][0].delay, delay);
    f.advance(delay - 1);
    assert.equal(f.calls.scans, 0);
    f.advance(delay);
    await Promise.resolve();
    assert.equal(f.calls.scans, 1);
  }
});

test("load completion cannot expose a window before its first paint", () => {
  const f = fixture();
  f.win.webContents.emit("did-finish-load");
  assert.equal(f.calls.shown, 0);
  f.win.emit("ready-to-show");
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
  assert.equal(f.calls.logs.length, 1);
});

test("failed loads still report the error and cancel the waiting timer", async () => {
  const f = fixture();
  f.win.webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", "http://localhost:5173");
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.dialogs.length, 1);
  assert.equal(f.calls.splashFinished, 1);
  assert.match(f.calls.dialogs[0].message, /ERR_CONNECTION_REFUSED/);
});

function splashFixture() {
  const calls = { cancelled: 0, errors: [] };
  const ipcMain = new EventEmitter();
  const mainWindow = new EventEmitter();
  mainWindow.webContents = new EventEmitter();
  mainWindow.isDestroyed = () => false;
  const windows = [];
  class Window extends EventEmitter {
    constructor(options) {
      super();
      windows.push(this);
      this.options = options;
      this.webContents = new EventEmitter();
      this.shown = 0;
      this.destroyed = false;
    }
    async loadFile(file, options) { this.file = file; this.query = options.query; }
    isDestroyed() { return this.destroyed; }
    show() { this.shown++; }
    focus() { this.focused = true; }
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  const controller = createStartupWindow({ BrowserWindow: Window, ipcMain, mainWindow, language: "en",
    onCancel: () => { calls.cancelled++; }, onError: error => calls.errors.push(error) });
  const splash = windows[0];
  return { calls, ipcMain, mainWindow, splash, controller };
}

test("startup animation loads locally and waits for its own first paint", () => {
  const f = splashFixture();
  assert.equal(path.basename(f.splash.file), "startup.html");
  assert.equal(f.splash.query.lang, "en");
  assert.equal(f.splash.options.webPreferences.nodeIntegration, false);
  f.controller.focus();
  assert.equal(f.splash.shown, 0);
  f.splash.emit("ready-to-show");
  assert.equal(f.splash.shown, 1);
  f.controller.focus();
  assert.equal(f.splash.focused, true);
});

test("startup close accepts only its own renderer and preserves main close handling", () => {
  const f = splashFixture();
  f.ipcMain.emit("startup:cancel", { sender: {} });
  assert.equal(f.calls.cancelled, 0);
  f.ipcMain.emit("startup:cancel", { sender: f.splash.webContents });
  assert.equal(f.calls.cancelled, 1);
  let prevented = false;
  f.splash.emit("close", { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.calls.cancelled, 2);
});

test("main first paint disposes the animation without cancelling startup or flashing a late splash", () => {
  const f = splashFixture();
  f.controller.finish();
  f.controller.finish();
  f.splash.emit("ready-to-show");
  assert.equal(f.splash.destroyed, true);
  assert.equal(f.splash.shown, 0);
  assert.equal(f.calls.cancelled, 0);
  assert.equal(f.ipcMain.listenerCount("startup:cancel"), 0);
  assert.equal(f.mainWindow.listenerCount("closed"), 0);
});

test("closing or crashing the main renderer always removes the loading animation", () => {
  for (const event of ["closed", "render-process-gone"]) {
    const f = splashFixture();
    (event === "closed" ? f.mainWindow : f.mainWindow.webContents).emit(event);
    assert.equal(f.splash.destroyed, true);
    assert.equal(f.ipcMain.listenerCount("startup:cancel"), 0);
  }
});

test("a second launch focuses the loading window without revealing the unfinished main window", () => {
  const start = source.indexOf("function showMainWindow() {");
  const end = source.indexOf("\nfunction confirmQuitAfterImport", start);
  let focused = 0;
  const win = { id: 1, isDestroyed: () => false, show: () => { throw new Error("main window is not ready"); } };
  const scope = {
    quitting: false,
    BrowserWindow: { getAllWindows: () => [win] },
    startupWindows: new Map([[1, { focus: () => { focused++; } }]])
  };
  new Function("scope", "with (scope) { " + source.slice(start, end) + " showMainWindow(); }")(scope);
  assert.equal(focused, 1);
});
