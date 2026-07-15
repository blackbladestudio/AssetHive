const path = require("node:path");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");

const LOG_MAX_BYTES = 4 * 1024 * 1024;
const LOG_TRIM_TO_BYTES = 2 * 1024 * 1024;

let app = null;
let getSettings = () => ({});
let logStream = null;
let activeLogFilePath = "";
let logTrimInProgress = false;
let lastLogTrimCheckAt = 0;
let crashHooksInstalled = false;

function getLogFilePath() {
  return path.join(app.getPath("userData"), "Log", "assethive.log");
}

function getFallbackLogFilePath() {
  return path.join(app.getPath("temp"), "AssetHive", "Log", "assethive.log");
}

function getConfiguredLogFilePath() {
  const settings = getSettings() || {};
  const configured = String(settings.unrealLogPath || "").trim();
  if (!configured) {
    return getLogFilePath();
  }
  const resolved = path.resolve(configured);
  const ext = path.extname(resolved).toLowerCase();
  if (ext === ".log" || ext === ".txt") {
    return resolved;
  }
  return path.join(resolved, "assethive.log");
}

function openLogStream(targetPath) {
  fsSync.mkdirSync(path.dirname(targetPath), { recursive: true });
  return fsSync.createWriteStream(targetPath, { flags: "a" });
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

function writeLog(level, message, payload) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}${toLogPayload(payload)}`;
  if (logStream) {
    logStream.write(`${line}\n`);
  }
  process.stdout.write(`${line}\n`);
  if (!logTrimInProgress) {
    const now = Date.now();
    if (!lastLogTrimCheckAt || now - lastLogTrimCheckAt > 60000) {
      lastLogTrimCheckAt = now;
      trimLogFileIfNeeded();
    }
  }
}

async function trimLogFileIfNeeded() {
  if (!activeLogFilePath || logTrimInProgress) {
    return;
  }
  try {
    const stats = await fs.stat(activeLogFilePath);
    if (!stats || stats.size <= LOG_MAX_BYTES) {
      return;
    }

    logTrimInProgress = true;
    writeLog("INFO", "starting log trim (async)", { currentSize: stats.size });

    if (logStream) {
      logStream.end();
      logStream = null;
    }

    const content = await fs.readFile(activeLogFilePath);
    const start = Math.max(0, content.length - LOG_TRIM_TO_BYTES);
    let trimmed = content.subarray(start);
    const firstNewline = trimmed.indexOf(0x0a);
    if (firstNewline >= 0 && firstNewline + 1 < trimmed.length) {
      trimmed = trimmed.subarray(firstNewline + 1);
    }

    await fs.writeFile(activeLogFilePath, trimmed);
    logStream = fsSync.createWriteStream(activeLogFilePath, { flags: "a" });

    writeLog("INFO", "log trimmed successfully", {
      previousBytes: stats.size,
      newBytes: trimmed.length
    });
  } catch (error) {
    process.stdout.write(`[${new Date().toISOString()}] [WARN] log trim failed: ${error?.message}\n`);
    if (!logStream && activeLogFilePath) {
      logStream = fsSync.createWriteStream(activeLogFilePath, { flags: "a" });
    }
  } finally {
    logTrimInProgress = false;
  }
}

function setupLogger() {
  let logFilePath = getConfiguredLogFilePath();
  let nextStream = null;
  try {
    nextStream = openLogStream(logFilePath);
  } catch {
    logFilePath = getFallbackLogFilePath();
    nextStream = openLogStream(logFilePath);
  }
  if (logStream && logStream !== nextStream) {
    try {
      logStream.end();
    } catch {}
  }
  logStream = nextStream;
  activeLogFilePath = logFilePath;
  trimLogFileIfNeeded();
  writeLog("INFO", "log initialized", {
    logFilePath,
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
      writeLog("FATAL", "unhandledRejection", { reason: String(reason) });
    });
  }
}

function refreshLoggerPath() {
  const desiredPath = getConfiguredLogFilePath();
  if (String(activeLogFilePath || "").toLowerCase() === String(desiredPath || "").toLowerCase()) {
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
  getSettings = options.getSettings || (() => ({}));
}

module.exports = {
  init,
  writeLog,
  setupLogger,
  refreshLoggerPath,
  trimLogFileIfNeeded,
  getConfiguredLogFilePath,
  getLogFilePath,
  getActiveLogFilePath
};
