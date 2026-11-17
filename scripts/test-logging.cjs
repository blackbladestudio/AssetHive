const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

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
