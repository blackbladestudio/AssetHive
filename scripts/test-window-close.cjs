const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../electron/main.js"), "utf8");

function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, startMarker + " exists");
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, endMarker + " follows " + startMarker);
  return source.slice(start, end);
}

const confirmSource = extract("function confirmQuitAfterImport(", '\napp.on("before-quit"');
const finishSource = extract("function finishImportBeforeQuit()", "\nfunction showMainWindow");
const closeSource = extract('  win.on("close", (event) => {', "\n  });") + "\n  });";
const beforeQuitSource = extract('app.on("before-quit", (event) => {', "\n});") + "\n});";

function fixture({ active = false, decision = 0 } = {}) {
  const calls = { prevented: 0, quit: 0, dialogs: 0 };
  let onClose;
  let onBeforeQuit;
  const scope = {
    quitting: false,
    quitAfterImport: false,
    quitForceExitTimer: null,
    forcedExits: 0,
    exitTimer: null,
    globalThis: { setTimeout: (callback, delay) => {
      scope.exitTimer = { callback, delay };
      return { unref() {} };
    } },
    hasActiveBackgroundImport: () => active,
    writeLog: () => {},
    dialog: {
      showMessageBoxSync: (_win, options) => {
        calls.dialogs++;
        assert.match(options.detail, /当前资产处理完成/);
        return decision;
      }
    },
    BrowserWindow: { getFocusedWindow: () => scope.win, getAllWindows: () => [scope.win] },
    app: {
      on: (name, handler) => { if (name === "before-quit") onBeforeQuit = handler; },
      exit: () => { scope.forcedExits++; },
      quit: () => { calls.quit++; }
    },
    win: { on: (name, handler) => { if (name === "close") onClose = handler; } }
  };
  new Function("scope", "with (scope) { " + confirmSource + finishSource + closeSource + beforeQuitSource + " scope.finish = finishImportBeforeQuit; }")(scope);
  const event = { preventDefault: () => { calls.prevented++; } };
  return {
    calls, scope,
    close: () => onClose(event),
    beforeQuit: () => onBeforeQuit(event),
    finish: () => scope.finish(),
    setActive: (value) => { active = value; }
  };
}

test("idle window close quits without a tray", () => {
  assert.doesNotMatch(source, /new Tray\(|createTray\(/);
  const f = fixture();
  f.close();
  assert.deepEqual(f.calls, { prevented: 1, quit: 1, dialogs: 0 });
});

test("cancelling close keeps the import queue and window open", () => {
  const f = fixture({ active: true });
  f.close();
  f.setActive(false);
  f.finish();
  assert.deepEqual(f.calls, { prevented: 1, quit: 0, dialogs: 1 });
  assert.equal(f.scope.quitAfterImport, false);
});

test("confirmed close waits for the current asset and then quits", () => {
  const f = fixture({ active: true, decision: 1 });
  f.close();
  f.finish();
  assert.deepEqual(f.calls, { prevented: 1, quit: 0, dialogs: 1 });
  f.close();
  assert.equal(f.calls.dialogs, 1);
  f.setActive(false);
  f.finish();
  assert.equal(f.calls.quit, 1);
});

test("system quit during import also waits for the current asset", () => {
  const f = fixture({ active: true, decision: 1 });
  f.beforeQuit();
  assert.deepEqual(f.calls, { prevented: 1, quit: 0, dialogs: 1 });
  f.setActive(false);
  f.finish();
  f.beforeQuit();
  assert.equal(f.calls.quit, 1);
  assert.equal(f.scope.quitting, true);
});

test("main process rejects a later asset after close was confirmed", async () => {
  const handlerSource = extract('  ipcMain.handle("assets:importCustom", async (event, payload) => {', '\n  ipcMain.handle("assets:updateCustom"');
  let handler;
  const scope = {
    quitAfterImport: true,
    recycleInProgress: false,
    writeLog: () => {},
    ipcMain: { handle: (_name, callback) => { handler = callback; } }
  };
  new Function("scope", "with (scope) { " + handlerSource + " }")(scope);
  const result = await handler({}, { assetName: "Next" });
  assert.equal(result.ok, false);
  assert.match(result.message, /后续资产/);
});

test("a second launch cannot reopen windows while quitting", () => {
  let created = 0;
  const scope = {
    quitting: true,
    BrowserWindow: { getAllWindows: () => { throw new Error("must not reopen"); } },
    createWindow: () => { created++; }
  };
  const body = extract("function showMainWindow()", "\nfunction confirmQuitAfterImport");
  new Function("scope", "with (scope) { " + body + " showMainWindow(); }")(scope);
  assert.equal(created, 0);
  const creation = extract("function createWindow()", '\n  const appIconPath');
  assert.equal(new Function("quitting", creation + "\n throw new Error('must not create'); } return createWindow();")(true), undefined);
});

test("stalled quit forces exit after five seconds but active imports never arm it", () => {
  const active = fixture({ active: true });
  active.beforeQuit();
  assert.equal(active.scope.exitTimer, null);
  const idle = fixture();
  idle.beforeQuit();
  assert.equal(idle.scope.exitTimer.delay, 5000);
  assert.equal(idle.scope.forcedExits, 0);
  idle.scope.exitTimer.callback();
  assert.equal(idle.scope.forcedExits, 1);
});

function recoveryFixture({ active = false, exports = 0, response = 0, showDialog } = {}) {
  const calls = { quit: 0, relaunch: 0, dialogs: [], logs: [] };
  let handler;
  const scope = {
    quitting: false, rendererRecoveryPending: false, activeExportCalls: exports,
    hasActiveBackgroundImport: () => active,
    index: [{ id: "cached" }],
    diagnostics: { recordIncident: (...args) => calls.logs.push(args) },
    app: { quit: () => { calls.quit++; }, relaunch: () => { calls.relaunch++; } },
    win: { isDestroyed: () => false, webContents: { on: (_name, callback) => { handler = callback; } } },
    dialog: { showMessageBox: async (_win, options) => {
      calls.dialogs.push(options);
      return showDialog ? showDialog(scope) : { response };
    } }
  };
  const body = extract('  win.webContents.on("render-process-gone"', '\n  win.on("unresponsive"');
  new Function("scope", "with (scope) { " + body + " }")(scope);
  return { calls, scope, fail: () => handler({}, { reason: "launch-failed", exitCode: 65 }) };
}

test("renderer launch failure lets the user restart or exit the old process", async () => {
  for (const response of [0, 1]) {
    const f = recoveryFixture({ response });
    await f.fail();
    assert.deepEqual(f.calls.logs[0], ["render-process-gone", { reason: "launch-failed", exitCode: 65, assetCount: 1 }, { persist: true }]);
    assert.equal(f.calls.quit, 1);
    assert.equal(f.calls.relaunch, response === 0 ? 1 : 0);
    assert.deepEqual(f.calls.dialogs[0].buttons, ["重新启动", "关闭软件"]);
    assert.equal(f.scope.rendererRecoveryPending, false);
  }
});

test("renderer recovery preserves imports and exports, including work started during the dialog", async () => {
  for (const options of [{ active: true }, { exports: 1 }, {
    showDialog: async scope => { scope.activeExportCalls = 1; return { response: 0 }; }
  }]) {
    const f = recoveryFixture(options);
    await f.fail();
    assert.equal(f.calls.quit, 0);
    assert.equal(f.calls.relaunch, 0);
  }
});

test("repeated launch failures share one dialog and quitting shows none", async () => {
  let finishDialog;
  const f = recoveryFixture({ showDialog: () => new Promise(resolve => { finishDialog = resolve; }) });
  const first = f.fail();
  await f.fail();
  assert.equal(f.calls.dialogs.length, 1);
  finishDialog({ response: 1 });
  await first;
  f.scope.quitting = true;
  await f.fail();
  assert.equal(f.calls.dialogs.length, 1);
});
