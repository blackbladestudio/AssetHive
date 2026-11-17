const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { lock } = require('./megascans-runner.cjs');
const { ImportWorker } = require('./lib/megascans-import-worker.cjs');
const { receiptPath } = require('./lib/megascans-paths.cjs');
const { assetId, GIB, inventory, freeBytes, ownedCache, copyVerified, cleanupOwnedCache, inside, atomicJson, verifyImportedFiles, metadataReferences } = require('./lib/megascans-transfer.cjs');

async function removeWorkspace(parent, library) {
  if (!await fs.stat(library).then(() => true, () => false)) return;
  if (path.dirname(await fs.realpath(library)).toLowerCase() !== (await fs.realpath(parent)).toLowerCase()) throw new Error('基准工作区清理路径越界');
  await fs.rm(library, { recursive: true, maxRetries: 5, retryDelay: 100 });
}

async function benchmark(id, cacheRoot = path.resolve(__dirname, '../.cache/megascans-download')) {
  assetId(id);
  const config = JSON.parse(await fs.readFile(path.join(cacheRoot, 'configuration.json'), 'utf8'));
  const releaseLocal = await lock(path.join(cacheRoot, 'runner.lock'));
  let releaseShare, worker;
  const benchCache = path.join(cacheRoot, 'import-benchmark-cache');
  const parent = path.join(config.library, '.megascans', 'benchmarks');
  const library = path.join(parent, crypto.randomUUID());
  try {
    releaseShare = await lock(path.join(config.library, '.megascans/runner.lock'));
    const receipt = JSON.parse(await fs.readFile(await receiptPath(config.library, id), 'utf8'));
    const files = receipt.archive.files, bytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const existing = await inventory(path.join(cacheRoot, 'assets'), { content: false });
    if (bytes + existing.reduce((sum, file) => sum + file.bytes, 0) > config.maxCacheGb * GIB || await freeBytes(cacheRoot) < bytes + config.minFreeGb * GIB) throw new Error('基准测试超过磁盘预算');
    const source = path.join(library, '.megascans/originals/v3', id);
    const dir = await ownedCache(benchCache, id), localSource = path.join(dir, 'payload');
    const original = path.resolve(config.library, receipt.archive.root);
    if (!inside(config.library, original)) throw new Error('回执路径越界');
    await copyVerified(original, localSource, files);
    const copySamples = [];
    for (const concurrency of [1, 3, 1, 3]) {
      const started = performance.now();
      await copyVerified(localSource, source, files, { concurrency });
      copySamples.push({ concurrency, ms: Math.round(performance.now() - started) });
      console.log(JSON.stringify(copySamples.at(-1)));
      if (copySamples.length < 4) await fs.rm(source, { recursive: true, maxRetries: 5, retryDelay: 100 });
    }
    worker = new ImportWorker({ cacheRoot: benchCache });
    const start = performance.now();
    await worker.start();
    const startupMs = Math.round(performance.now() - start), samples = [];
    for (const mode of ['archive', 'local', 'archive', 'local']) {
      const started = performance.now();
      const result = await worker.run({ id, source, library, cacheRoot: benchCache, cacheKey: path.basename(dir), sourceFiles: files.map(file => file.file), ...(mode === 'local' ? { localSource } : {}) });
      const importMs = Math.round(performance.now() - started);
      const meta = JSON.parse(await fs.readFile(path.join(result.assetPath, 'asset_info.json'), 'utf8'));
      await verifyImportedFiles(result.assetPath, id, result.files, metadataReferences(result.assetPath, meta, id, result.files));
      samples.push({ mode, importMs, files: result.files.length });
      console.log(JSON.stringify(samples.at(-1)));
      if (!inside(library, result.assetPath)) throw new Error('基准清理路径越界');
      await fs.rm(result.assetPath, { recursive: true, maxRetries: 5, retryDelay: 100 });
    }
    const report = { id, measuredAt: new Date().toISOString(), bytes, startupMs, copySamples, samples, fullSha256Verified: true };
    await atomicJson(path.join(cacheRoot, 'import-benchmark.json'), report);
    await cleanupOwnedCache(benchCache, id);
    return report;
  } finally {
    try {
      if (worker) await worker.close();
      await removeWorkspace(parent, library);
    } finally { try { if (releaseShare) await releaseShare(); } finally { await releaseLocal(); } }
  }
}

if (require.main === module) benchmark(process.argv[2]).catch(error => { console.error(`入库基准测试失败：${error.message}`); process.exitCode = 1; });
module.exports = { benchmark };
