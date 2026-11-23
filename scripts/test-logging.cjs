const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { createRendererDiagnostics, startLocalCrashReporting } = require("../electron/services/rendererDiagnostics");

test("Crashpad startup keeps dumps local and tolerates initialization failure", () => {
  const app = { getPath: name => `test/${name}` };
  const reporter = { start: options => assert.deepEqual(options, { uploadToServer: false }) };
  assert.deepEqual(startLocalCrashReporting(app, reporter), { dumpDirectory: "test/crashDumps", uploadToServer: false });
  assert.deepEqual(startLocalCrashReporting(app, { start() { throw new Error("test failure"); } }), {
    dumpDirectory: null, error: "test failure"
  });
});

test("renderer crash retains bounded pre-crash diagnostics after Electron drops the renderer metrics", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-crash-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  const webContents = new EventEmitter();
  let crashed = false;
  let metricsCalls = 0;
  webContents.isDestroyed = () => false;
  webContents.isCrashed = () => crashed;
  webContents.getOSProcessId = () => 42;
  const renderer = { pid: 42, type: "Tab", memory: { workingSetSize: 450_000, privateBytes: 500_000 } };
  const gpu = { pid: 43, type: "GPU", memory: { workingSetSize: 50_000 } };
  const logs = [];
  const diagnostics = createRendererDiagnostics({
    app: {
      getPath: () => root,
      getVersion: () => "2.3.4",
      getGPUFeatureStatus: () => ({ webgl: "enabled" }),
      getAppMetrics: () => { metricsCalls++; return crashed ? [gpu] : [renderer, gpu]; }
    },
    webContents,
    crashReporting: { dumpDirectory: path.join(root, "Crashpad"), uploadToServer: false },
    getActivity: () => ({ scanInProgress: true, assetCount: 30_734 }),
    writeLog: (...args) => logs.push(args)
  });
  webContents.emit("dom-ready");
  diagnostics.recordEvent("old warning");
  for (let i = 0; i < 13; i++) t.mock.timers.tick(15_000);
  for (let i = 0; i < 30; i++) diagnostics.recordEvent("recent warning", { line: i });
  diagnostics.recordCharacterPreview({ stage: "render", modelCount: 3, textureCount: 5, viewCount: 4,
    imageSize: 768, skeletonPreview: false, path: "input.fbx" });
  diagnostics.recordCharacterPreview({ stage: "unexpected", modelCount: 3 });

  crashed = true;
  diagnostics.recordIncident("render-process-gone", { reason: "crashed", exitCode: -36861 }, { persist: true });
  const [level, event, report] = logs[0];
  assert.equal(level, "ERROR");
  assert.equal(event, "render-process-gone");
  if (process.platform === "win32") assert.equal(report.exitCodeHex, "0xFFFF7003");
  assert.equal(report.rendererPid, 42);
  assert.equal(report.recentSamples.length, 12);
  assert.deepEqual(report.recentSamples.at(-1).processes[0].memory, renderer.memory);
  assert.deepEqual(report.processes.map(process => process.pid), [43]);
  assert.equal(report.activity.scanInProgress, true);
  assert.equal(report.recentEvents.length, 24);
  assert.equal(report.recentEvents[0].line, 7);
  assert.deepEqual(report.recentEvents.at(-1), {
    at: new Date(195_000).toISOString(), event: "character-preview", stage: "render", modelCount: 3,
    textureCount: 5, viewCount: 4, imageSize: 768, skeletonPreview: false
  });
  const reportFile = path.join(root, "Log", "last-renderer-crash.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(reportFile, "utf8")), JSON.parse(JSON.stringify(report)));
  diagnostics.recordIncident("window unresponsive", {});
  assert.equal(JSON.parse(fs.readFileSync(reportFile, "utf8")).reason, "crashed");
  const previousCalls = metricsCalls;
  webContents.emit("destroyed");
  crashed = false;
  t.mock.timers.tick(15_000);
  assert.equal(metricsCalls, previousCalls);
});

test("development and packaged runs write logs, with a writable fallback and size limit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-logging-"));
  const script = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.env.LOG_TEST_ROOT;
    const logger = require(path.join(process.cwd(), "electron", "logManager.js"));
    const devRoot = path.join(root, "dev");
    const userRoot = path.join(root, "user");
    logger.init({ app: { isPackaged: false, getAppPath: () => devRoot, getPath: () => userRoot } });
    logger.setupLogger();
    logger.writeLog("ERROR", "development renderer failure", { detail: "sample" });
    assert.match(fs.readFileSync(path.join(devRoot, "Log", "assethive.log"), "utf8"), /development renderer failure/);

    logger.init({ app: { isPackaged: true, getVersion: () => "2.2.6", getAppPath: () => devRoot, getPath: () => userRoot } });
    logger.setupLogger();
    logger.writeLog("ERROR", "packaged renderer failure");
    const packagedPath = path.join(userRoot, "Log", "assethive.log");
    assert.equal(logger.getActiveLogFilePath(), packagedPath);
    assert.match(fs.readFileSync(packagedPath, "utf8"), /"appVersion":"2.2.6"/);
    assert.match(fs.readFileSync(packagedPath, "utf8"), /packaged renderer failure/);

    const blockedPath = path.join(root, "blocked");
    fs.writeFileSync(blockedPath, "file, not directory");
    logger.init({ app: { isPackaged: false, getAppPath: () => blockedPath, getPath: () => userRoot } });
    logger.setupLogger();
    logger.writeLog("ERROR", "fallback renderer failure");
    assert.equal(logger.getActiveLogFilePath(), packagedPath);
    assert.match(fs.readFileSync(packagedPath, "utf8"), /fallback renderer failure/);

    fs.appendFileSync(packagedPath, "long entry\\n".repeat(440000));
    logger.trimLogFileIfNeeded();
    logger.writeLog("INFO", "after trim");
    const trimmed = fs.readFileSync(packagedPath, "utf8");
    assert.ok(Buffer.byteLength(trimmed) < 4 * 1024 * 1024);
    assert.match(trimmed, /after trim/);
  `;
  try {
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, LOG_TEST_ROOT: root },
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 「输出日志」窗口的契约：实时行订阅 / 取消订阅 / 订阅者异常不影响写日志 / 清空后仍能继续写。
// 这几条是界面能实时显示输出的全部依赖，改 logManager 时必须有回归保护。
test("output log window API: live subscription, listener resilience, and clear", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assethive-logwindow-"));
  const script = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.env.LOG_TEST_ROOT;
    const logger = require(path.join(process.cwd(), "electron", "logManager.js"));
    const devRoot = path.join(root, "dev");
    logger.init({ app: { isPackaged: false, getAppPath: () => devRoot, getPath: () => root } });
    logger.setupLogger();

    const seen = [];
    const unsubscribe = logger.onLogLine((line) => seen.push(line));
    logger.writeLog("INFO", "hello window", { n: 1 });
    assert.ok(seen.some((line) => /hello window/.test(line)), "订阅者必须收到实时日志行");
    unsubscribe();
    const beforeUnsubscribe = seen.length;
    logger.writeLog("WARN", "after unsubscribe");
    assert.equal(seen.length, beforeUnsubscribe, "取消订阅后不应再收到日志行");

    // 观测工具不能影响主流程：订阅者抛异常时写日志必须照常成功。
    const unsubscribeThrowing = logger.onLogLine(() => { throw new Error("listener boom"); });
    logger.writeLog("ERROR", "listener resilience");
    unsubscribeThrowing();
    const logPath = logger.getActiveLogFilePath();
    assert.match(fs.readFileSync(logPath, "utf8"), /listener resilience/);

    // 清空 = 截断已打开的句柄：清空后仍要能继续写入（不换文件、不中断追加）。
    assert.equal(logger.clearLogFile(), true, "清空应成功");
    assert.equal(fs.readFileSync(logPath, "utf8"), "", "清空后文件应为空");
    logger.writeLog("INFO", "after clear");
    assert.match(fs.readFileSync(logPath, "utf8"), /after clear/);

    // 未初始化（无句柄）时必须安全返回 false，供 IPC 回一条可读的提示而不是抛错。
    logger.closeLogFile();
    assert.equal(logger.clearLogFile(), false);
  `;
  try {
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, LOG_TEST_ROOT: root },
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
