// Resumable maintenance: read assets, publish only derived thumbnails/snapshot.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createSharedDerivedCache } = require("../electron/services/sharedDerivedCache");
const { scanLibraryInWorker } = require("../electron/services/assetScanner");
const { writeFileAtomic } = require("../electron/services/atomicFile");
const { toAssetListRecord } = require("../electron/services/assetListRecord");

async function main() {
  const root = process.argv[2];
  assert.ok(root && path.isAbsolute(root), "Pass the absolute library root explicitly");
  const key = createHash("sha256").update(path.resolve(root).toLowerCase()).digest("hex").slice(0, 16);
  const directory = path.resolve(__dirname, "../.cache/shared-thumbnail-warmup", key);
  await fs.mkdir(directory, { recursive: true });
  const reportPath = path.join(directory, "report.json");
  const recordsPath = path.join(directory, "records.json");
  const memoPath = path.join(directory, "library.memo.json.gz");
  const memoArgument = process.argv.indexOf("--memo");
  if (memoArgument >= 0) {
    const sourceMemo = process.argv[memoArgument + 1];
    assert.ok(sourceMemo && path.isAbsolute(sourceMemo), "--memo requires an absolute local scan-memo path");
    if (path.resolve(sourceMemo) !== memoPath) await fs.copyFile(sourceMemo, memoPath);
  }
  const warnings = [];
  const concurrencyArgument = process.argv.indexOf("--concurrency");
  const concurrency = Math.max(1, Math.min(8, Math.trunc(Number(process.argv[concurrencyArgument + 1]) || 4)));
  if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = String(concurrency + 2);
  let lastLog = 0;
  const log = payload => process.stdout.write(JSON.stringify({ time: new Date().toISOString(), ...payload }) + "\n");
  const startedAt = new Date().toISOString();
  log({ phase: "scan", root, reportPath });
  const resume = process.argv.includes("--resume-records");
  if (resume) {
    const previous = JSON.parse(await fs.readFile(reportPath, "utf8"));
    assert.equal(path.resolve(previous.root).toLowerCase(), path.resolve(root).toLowerCase(), "Resume report belongs to another library");
    warnings.push(...previous.scanWarnings);
  }
  let records = resume ? JSON.parse(await fs.readFile(recordsPath, "utf8")) : await scanLibraryInWorker(root, { maintenance: false, writeSharedMemo: false,
    scanMemoPath: memoPath, concurrency: 4,
    forceFullScan: true, refreshMetadata: false,
    onWarning: warning => { warnings.push(warning); log({ phase: "scan-warning", ...warning }); },
    onProgress: progress => { if (Date.now() - lastLog > 10000) { lastLog = Date.now(); log({ phase: "scan", ...progress }); } }
  });
  assert.ok(Array.isArray(records) && records.every(record => record.metaPath &&
    !path.relative(root, record.metaPath).startsWith("..") && !path.isAbsolute(path.relative(root, record.metaPath))), "Records must belong to this library");
  await writeFileAtomic(recordsPath, JSON.stringify(records.map(toAssetListRecord)));
  const files = [...new Set(records.map(asset => String(asset.previewImage || asset.preview || "").trim()).filter(Boolean))];
  const cache = createSharedDerivedCache({ libraryRoot: root, localRoot: path.join(directory, "local"),
    warmConcurrency: concurrency,
    onFailure: error => log({ phase: "cache-warning", message: error.message }) });
  const report = { root, startedAt, assets: records.length, withoutPreview: records.filter(asset => !asset.previewImage && !asset.preview).length,
    uniquePreviews: files.length, processed: 0, cached: 0, published: 0, skipped: [], failures: [], scanWarnings: warnings, complete: false };
  const save = () => writeFileAtomic(reportPath, JSON.stringify(report, null, 2));
  await save();
  let next = 0;
  let saving = Promise.resolve();
  let failuresInRow = 0;
  try {
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < files.length) {
        if (failuresInRow >= 12) { report.abortedReason = "Repeated cache failures; rerun to resume"; break; }
        const sourcePath = files[next++];
        const result = await cache.warmThumbnail(sourcePath, { verify: true }) || { status: "failed", message: "Cache worker unavailable" };
        report.processed++;
        if (result.status === "cached") report.cached++;
        else if (result.status === "published") report.published++;
        else if (result.status === "skipped") report.skipped.push({ sourcePath, ...result });
        else report.failures.push({ sourcePath, ...result });
        failuresInRow = result.status === "failed" ? failuresInRow + 1 : 0;
        if (report.processed % 100 === 0 || Date.now() - lastLog > 10000) {
          lastLog = Date.now();
          log({ phase: "warm", processed: report.processed, total: files.length, cached: report.cached,
            published: report.published, skipped: report.skipped.length, failures: report.failures.length });
          saving = saving.then(save); await saving;
        }
      }
    }));
    // Assets may be deleted while a long warmup runs. Confirm absent metadata
    // separately; a missing picture alone is still a real failure.
    const removed = new Set();
    report.removedAssets = [];
    for (const failure of report.failures) {
      if (failure.code !== "ENOENT" || failure.stage !== "source") continue;
      const matching = records.filter(asset => (asset.previewImage || asset.preview) === failure.sourcePath);
      const missing = await Promise.all(matching.map(async asset => {
        try { await fs.stat(asset.metaPath); return false; }
        catch (error) { return error.code === "ENOENT"; }
      }));
      if (matching.length && missing.every(Boolean)) {
        removed.add(failure.sourcePath);
        report.removedAssets.push(...matching.map(asset => ({ id: asset.id, metaPath: asset.metaPath })));
      }
    }
    records = records.filter(asset => !removed.has(asset.previewImage || asset.preview));
    report.failures = report.failures.filter(failure => !removed.has(failure.sourcePath));
    report.assets = records.length;
    report.uniquePreviews = files.length - removed.size;
    await writeFileAtomic(recordsPath, JSON.stringify(records.map(toAssetListRecord)));
    report.complete = report.processed === files.length && !report.failures.length && !warnings.length;
    if (!warnings.length) report.snapshotPublished = await cache.publishSnapshot(records.map(toAssetListRecord));
    report.finishedAt = new Date().toISOString();
  } finally {
    await saving;
    await save();
    cache.dispose();
    log({ phase: "done", ...report, skipped: report.skipped.length, failures: report.failures.length,
      scanWarnings: warnings.length, reportPath, recordsPath });
  }
  if (!report.complete) process.exitCode = 1;
}

main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
