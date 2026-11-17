const { transactionalFs: fs } = require("./assetFileTransaction");
const fsSync = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function flushFailure(error, target) {
  return Object.assign(new Error(
    `文件刷盘失败，未替换原文件。请检查保存位置的连接、可用空间及写入权限后重试。\n路径：${target}\n${error.message}`,
    { cause: error }
  ), { code: error.code, syscall: error.syscall, path: target });
}

// Never truncate the destination. Interrupted writes leave only an ignored .tmp
// file; readers continue to see the previous complete document until rename.
async function writeFileAtomic(filePath, text) {
  const target = path.resolve(filePath);
  for (let writeAttempt = 0; ; writeAttempt += 1) {
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, text, { encoding: "utf8", flag: "wx", flush: true });
      for (let attempt = 0; ; attempt += 1) {
        try {
          await fs.rename(temporary, target);
          return;
        } catch (error) {
          if (attempt >= 3 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
          await new Promise((resolve) => globalThis.setTimeout(resolve, 40 * (attempt + 1)));
        }
      }
    } catch (error) {
      if (error?.syscall !== "fsync") throw error;
      if (writeAttempt >= 3 || !["UNKNOWN", "EIO", "EBUSY", "EAGAIN", "ETIMEDOUT", "ECONNRESET"].includes(error.code)) {
        throw flushFailure(error, target);
      }
      // A share may fail after receiving the bytes but before acknowledging the
      // flush. Retry the full write to a fresh file, and require a successful
      // flush before publishing it. Never downgrade to an unflushed overwrite.
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100 * (writeAttempt + 1)));
  }
}

function writeFileAtomicSync(filePath, text) {
  const target = path.resolve(filePath);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fsSync.writeFileSync(temporary, text, { encoding: "utf8", flag: "wx", flush: true });
    fsSync.renameSync(temporary, target);
  } catch (error) {
    if (error?.syscall === "fsync") throw flushFailure(error, target);
    throw error;
  } finally {
    try { fsSync.rmSync(temporary, { force: true }); } catch {}
  }
}

module.exports = { writeFileAtomic, writeFileAtomicSync };
