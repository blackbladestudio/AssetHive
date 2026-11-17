const path = require("node:path");
const fs = require("node:fs");

const LOG_MAX_BYTES = 4 * 1024 * 1024;
const LOG_TRIM_TO_BYTES = 2 * 1024 * 1024;

let app = null;
let logFileDescriptor = null;
let activeLogFilePath = "";
let lastLogTrimCheckAt = 0;
let crashHooksInstalled = false;

function getLogFilePath() {
  const basePath = app.isPackaged ? app.getPath("userData") : app.getAppPath();
  return path.join(basePath, "Log", "assethive.log");
}

function getConfiguredLogFilePath() {
  return getLogFilePath();
}

function openLogFile(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  return fs.openSync(targetPath, "a");
}

function closeLogFile() {
  if (logFileDescriptor !== null) {
    try { fs.closeSync(logFileDescriptor); } catch {}
    logFileDescriptor = null;
  }
}

function toLogPayload(payload) {
  if (payload === undefined) {
    return "";
  }
  try {
    return ` ${JSON.stringify(payload)}`;
  } catch {
    return " [unserializable]";
  }
}

function writeToStdout(line) {
  try { process.stdout.write(`${line}\n`); } catch {}
}

// 日志行订阅：主进程用它把每一行转发给渲染进程的「输出日志」窗口。
// 这里只做转发、不做缓冲（缓冲交给渲染层），并且订阅者异常一律吞掉 ——
// 日志窗口是观测工具，任何情况下都不能影响写日志本身或主流程。
const lineListeners = new Set();

function onLogLine(listener) {
  if (typeof listener !== "function") {
    return () => {};
  }
  lineListeners.add(listener);
  return () => lineListeners.delete(listener);
}

function notifyLogLine(line) {
  for (const listener of lineListeners) {
    try { listener(line); } catch { /* 订阅者异常不影响写日志 */ }
  }
}

// 清空日志文件：截断已打开的描述符，保持追加写入不中断（不删文件、不换路径）。
function clearLogFile() {
  if (logFileDescriptor === null || !activeLogFilePath) {
    return false;
  }
  try {
    fs.ftruncateSync(logFileDescriptor, 0);
    return true;
  } catch (error) {
    writeToStdout(`[${new Date().toISOString()}] [WARN] log clear failed: ${error?.message || String(error)}`);
    return false;
  }
}

function writeLog(level, message, payload) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}${toLogPayload(payload)}`;
  writeToStdout(line);
  notifyLogLine(line);
  if (logFileDescriptor === null) return;
  try {
    fs.writeSync(logFileDescriptor, `${line}\n`);
  } catch (error) {
    closeLogFile();
    writeToStdout(`[${new Date().toISOString()}] [WARN] log file write failed: ${error?.message || String(error)}`);
    const fallbackPath = path.join(app.getPath("userData"), "Log", "assethive.log");
    if (activeLogFilePath !== fallbackPath) {
      try {
        logFileDescriptor = openLogFile(fallbackPath);
        activeLogFilePath = fallbackPath;
        fs.writeSync(logFileDescriptor, `${line}\n`);
        writeToStdout(`[${new Date().toISOString()}] [INFO] log file switched to ${fallbackPath}`);
      } catch (fallbackError) {
        closeLogFile();
        writeToStdout(`[${new Date().toISOString()}] [WARN] fallback log file unavailable: ${fallbackError?.message || String(fallbackError)}`);
        return;
      }
    } else {
      return;
    }
  }
  const now = Date.now();
  if (!lastLogTrimCheckAt || now - lastLogTrimCheckAt > 60000) {
    lastLogTrimCheckAt = now;
    trimLogFileIfNeeded();
  }
}

function trimLogFileIfNeeded() {
  if (logFileDescriptor === null || !activeLogFilePath) return;
  try {
    const stats = fs.fstatSync(logFileDescriptor);
    if (stats.size <= LOG_MAX_BYTES) return;
    const content = fs.readFileSync(activeLogFilePath);
    const start = Math.max(0, content.length - LOG_TRIM_TO_BYTES);
    let trimmed = content.subarray(start);
    const firstNewline = trimmed.indexOf(0x0a);
    if (firstNewline >= 0 && firstNewline + 1 < trimmed.length) {
      trimmed = trimmed.subarray(firstNewline + 1);
    }
    closeLogFile();
    fs.writeFileSync(activeLogFilePath, trimmed);
    logFileDescriptor = openLogFile(activeLogFilePath);
    writeLog("INFO", "log trimmed successfully", {
      previousBytes: stats.size,
      newBytes: trimmed.length
    });
  } catch (error) {
    writeToStdout(`[${new Date().toISOString()}] [WARN] log trim failed: ${error?.message || String(error)}`);
    if (logFileDescriptor === null) {
      try { logFileDescriptor = openLogFile(activeLogFilePath); } catch {}
    }
  }
}

function setupLogger() {
  const preferredPath = getConfiguredLogFilePath();
  const fallbackPath = path.join(app.getPath("userData"), "Log", "assethive.log");
  closeLogFile();
  activeLogFilePath = "";
  for (const candidate of new Set([preferredPath, fallbackPath])) {
    try {
      logFileDescriptor = openLogFile(candidate);
      activeLogFilePath = candidate;
      break;
    } catch (error) {
      writeToStdout(`[${new Date().toISOString()}] [WARN] log file unavailable: ${candidate}: ${error?.message || String(error)}`);
    }
  }
  lastLogTrimCheckAt = 0;
  writeLog("INFO", "log initialized", {
    logFilePath: activeLogFilePath || null,
    appVersion: app.getVersion?.() || null,
    electron: process.versions.electron,
    node: process.versions.node,
    pid: process.pid
  });

  if (!crashHooksInstalled) {
    crashHooksInstalled = true;
    process.on("uncaughtException", (error) => {
      writeLog("FATAL", "uncaughtException", {
        name: error?.name,
        message: error?.message,
        stack: error?.stack
      });
    });
    process.on("unhandledRejection", (reason) => {
      writeLog("FATAL", "unhandledRejection", {
        reason: String(reason),
        stack: reason?.stack
      });
    });
  }
}

function refreshLoggerPath() {
  const desiredPath = getConfiguredLogFilePath();
  if (String(activeLogFilePath || "").toLowerCase() === desiredPath.toLowerCase()) {
    return false;
  }
  setupLogger();
  writeLog("INFO", "log path refreshed", { logFilePath: activeLogFilePath });
  return true;
}

function getActiveLogFilePath() {
  return activeLogFilePath;
}

function init(options) {
  app = options.app;
}

module.exports = {
  init,
  writeLog,
  setupLogger,
  refreshLoggerPath,
  trimLogFileIfNeeded,
  getConfiguredLogFilePath,
  getLogFilePath,
  getActiveLogFilePath,
  onLogLine,
  clearLogFile,
  closeLogFile
};
