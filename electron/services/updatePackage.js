const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { createHash } = require("node:crypto");
const { Buffer } = require("node:buffer");
const { ReadableStream } = require("node:stream/web");
const { setTimeout: delay } = require("node:timers/promises");
const path = require("node:path");

const DOWNLOAD_SAMPLE_BYTES = 2 * 1024 * 1024;
const MIRROR_DELAY_MS = 1000;

async function* replaySample(chunks, reader) {
  try {
    yield* chunks;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function sampleDownload(candidate, headers, expectedSize, timeoutMs, fetchResponse) {
  const { url, controller } = candidate;
  const startedAt = globalThis.performance.now();
  const timeoutError = new Error("下载更新包超时");
  const timer = globalThis.setTimeout(() => controller.abort(timeoutError), timeoutMs);
  let reader;
  try {
    const response = await fetchResponse(url, { headers, signal: controller.signal });
    if (response.status !== 200 || !response.body) throw new Error(`无法下载更新包（HTTP ${response.status}）`);
    const contentLength = Number(response.headers.get("content-length"));
    if (expectedSize > 0 && contentLength > 0 && contentLength !== expectedSize) {
      throw new Error("下载源返回的更新包大小不匹配");
    }
    const sampleSize = Math.min(DOWNLOAD_SAMPLE_BYTES, expectedSize || contentLength || DOWNLOAD_SAMPLE_BYTES);
    reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (received < sampleSize) {
      const { done, value } = await reader.read();
      if (done) throw new Error("下载中断：更新包长度不完整");
      chunks.push(value);
      received += value.byteLength;
    }
    return {
      candidate,
      response: new globalThis.Response(ReadableStream.from(replaySample(chunks, reader)), { headers: response.headers }),
      sampleMs: Math.round(globalThis.performance.now() - startedAt)
    };
  } catch (error) {
    controller.abort();
    reader?.releaseLock();
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

async function downloadUpdatePackage(urls, targetFilePath, metadata, {
  headers, onProgress, timeoutMs, fetchResponse = fetch
}) {
  const candidates = urls.map(url => ({ url, controller: new globalThis.AbortController() }));
  try {
    const downloads = candidates.map(async (candidate, index) => {
      // A healthy direct connection can finish sampling before the mirrors start.
      if (index > 0) await delay(MIRROR_DELAY_MS, undefined, { signal: candidate.controller.signal });
      return sampleDownload(candidate, headers, Number(metadata.size) || 0, timeoutMs, fetchResponse);
    });
    const selected = await Promise.any(downloads).catch(error => {
      throw error.errors?.[0] || new Error("未找到可下载更新包的线路");
    });
    for (const candidate of candidates) {
      if (candidate !== selected.candidate) candidate.controller.abort();
    }
    await saveUpdateResponse(selected.response, targetFilePath, metadata, onProgress);
    return { host: new globalThis.URL(selected.candidate.url).hostname, sampleMs: selected.sampleMs };
  } finally {
    for (const candidate of candidates) candidate.controller.abort();
  }
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyCachedUpdatePackage(filePath, version) {
  try {
    const receipt = JSON.parse(await fs.readFile(`${filePath}.complete.json`, "utf8"));
    if (!receipt.version || (version != null && receipt.version !== version)
      || !Number.isSafeInteger(receipt.size) || receipt.size <= 0
      || !/^[a-f0-9]{64}$/.test(receipt.sha256 || "")) {
      return { ok: false, reason: "更新包缺少有效的下载完成记录，请重新下载" };
    }
    const integrity = await verifyUpdatePackageIntegrity(filePath, receipt.size);
    if (!integrity.ok) return integrity;
    if (await hashFile(filePath) !== receipt.sha256) {
      return { ok: false, reason: "更新包内容已损坏，请重新下载" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "无法确认更新包下载完整，请重新下载" };
  }
}

// An interrupted process may leave .part files, but never a reusable package.
async function saveUpdateResponse(response, targetFilePath, metadata, onProgress) {
  const partialPath = `${targetFilePath}.part`;
  const receiptPath = `${targetFilePath}.complete.json`;
  const receiptPartialPath = `${receiptPath}.part`;
  await fs.mkdir(path.dirname(targetFilePath), { recursive: true });
  await fs.rm(receiptPath, { force: true });
  const reader = response.body.getReader();
  let handle;
  try {
    const contentLength = Number(response.headers.get("content-length")) || 0;
    const expectedSize = Number(metadata?.size) || contentLength;
    if (!metadata?.version || expectedSize <= 0) throw new Error("无法确认更新包大小或版本，请稍后重新下载");
    handle = await fs.open(partialPath, "w");
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      let offset = 0;
      while (offset < value.length) {
        const { bytesWritten } = await handle.write(value, offset, value.length - offset);
        if (!bytesWritten) throw new Error("更新包写入失败");
        offset += bytesWritten;
      }
      loaded += value.length;
      if (loaded > expectedSize) throw new Error("更新包大小超过预期，请重新下载");
      onProgress?.({ progress: Math.min(99, Math.round(loaded / expectedSize * 100)), loaded, total: expectedSize });
    }
    await handle.sync();
    await handle.close();
    handle = null;
    if (contentLength > 0 && loaded !== contentLength) throw new Error("下载中断：更新包长度不完整");
    const integrity = await verifyUpdatePackageIntegrity(partialPath, expectedSize);
    if (!integrity.ok) throw new Error(integrity.reason);
    const sha256 = await hashFile(partialPath);
    if (metadata.digest && metadata.digest !== `sha256:${sha256}`) throw new Error("更新包 SHA-256 校验失败");
    await fs.writeFile(receiptPartialPath, JSON.stringify({ version: metadata.version, size: loaded, sha256 }));
    await fs.rename(partialPath, targetFilePath);
    // Publish the completion record last, after the verified package is in place.
    await fs.rename(receiptPartialPath, receiptPath);
  } finally {
    if (handle) await handle.close();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    await fs.rm(partialPath, { force: true }).catch(() => {});
    await fs.rm(receiptPartialPath, { force: true }).catch(() => {});
  }
}

module.exports = { downloadUpdatePackage, saveUpdateResponse, verifyCachedUpdatePackage };

async function isValidWindowsExecutable(filePath) {
  const handle = await fs.open(filePath, "r").catch(() => null);
  if (!handle) {
    return false;
  }
  try {
    const buffer = Buffer.alloc(2);
    const { bytesRead } = await handle.read(buffer, 0, 2, 0);
    if (bytesRead < 2) {
      return false;
    }
    return buffer[0] === 0x4d && buffer[1] === 0x5a;
  } finally {
    await handle.close();
  }
}

/**
 * 校验下载的更新包完整性：
 * 1. 文件大小与 GitHub API 返回的 expectedSize 比对（如果提供）
 * 2. .exe 文件检查 PE 头（MZ 魔数）
 * 3. .zip 文件检查 ZIP 头（PK 魔数）
 */
async function verifyUpdatePackageIntegrity(filePath, expectedSize) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    return { ok: false, reason: "文件不存在或不是有效文件" };
  }
  if (expectedSize && Number.isFinite(expectedSize) && expectedSize > 0) {
    if (stat.size !== expectedSize) {
      return { ok: false, reason: `文件大小不匹配（期望 ${expectedSize}，实际 ${stat.size}）` };
    }
  }
  const lowerPath = filePath.replace(/\.part$/, "").toLowerCase();
  if (lowerPath.endsWith(".exe")) {
    if (!await isValidWindowsExecutable(filePath)) {
      return { ok: false, reason: "不是有效的 Windows 可执行文件（PE 头校验失败）" };
    }
  } else if (lowerPath.endsWith(".zip")) {
    const handle = await fs.open(filePath, "r").catch(() => null);
    if (!handle) {
      return { ok: false, reason: "无法读取文件" };
    }
    try {
      const buffer = Buffer.alloc(4);
      const { bytesRead } = await handle.read(buffer, 0, 4, 0);
      if (bytesRead < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
        return { ok: false, reason: "不是有效的 ZIP 文件（PK 头校验失败）" };
      }
    } finally {
      await handle.close();
    }
  }
  return { ok: true };
}

