const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { lock, authenticate } = require('./megascans-runner.cjs');
const { QuixelClient, GIB, assetId, atomicJson, exists, inventory, downloadFile } = require('./lib/megascans-transfer.cjs');
const { runPipeline } = require('./lib/megascans-pipeline.cjs');
const { ImportWorker } = require('./lib/megascans-import-worker.cjs');

async function removeWorkspace(parent, root) {
  if (!await exists(root)) return;
  if (path.dirname(await fs.realpath(root)).toLowerCase() !== (await fs.realpath(parent)).toLowerCase()) throw new Error('基准清理路径越界');
  await fs.rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
}

async function benchmark(id, count = 3, cacheRoot = path.resolve(__dirname, '../.cache/megascans-download'), comparison = 'pipeline') {
  assetId(id);
  if (!['pipeline', 'multi'].includes(comparison)) throw new Error('基准模式应为pipeline或multi');
  if (!Number.isInteger(count) || count < 2 || count > 5) throw new Error('基准样本数应为2–5');
  const config = JSON.parse(await fs.readFile(path.join(cacheRoot, 'configuration.json'), 'utf8'));
  const releaseLocal = await lock(path.join(cacheRoot, 'runner.lock'));
  let releaseShare;
  const parent = path.join(config.library, '.megascans/benchmarks'), root = path.join(parent, crypto.randomUUID());
  const cacheParent = path.join(cacheRoot, 'pipeline-benchmarks'), localRoot = path.join(cacheParent, crypto.randomUUID());
  try {
    releaseShare = await lock(path.join(config.library, '.megascans/runner.lock'));
    const leftovers = path.join(cacheRoot, 'assets');
    // A graceful pause can retain one prefetched asset. Preserve it unchanged,
    // and subtract every retained byte from the isolated benchmark's budget.
    const retainedCacheBytes = await exists(leftovers) ? (await inventory(leftovers, { content: false })).reduce((sum, file) => sum + file.bytes, 0) : 0;
    const maxCacheBytes = config.maxCacheGb * GIB - retainedCacheBytes;
    if (maxCacheBytes <= 0) throw new Error('剩余缓存额度不足以进行基准测试，请先恢复已有缓存');
    const reference = JSON.parse(await fs.readFile(await require('./lib/megascans-paths.cjs').receiptPath(config.library, id), 'utf8'));
    const client = new QuixelClient(await authenticate(cacheRoot, false)), original = await client.plan(id, config.resolution);
    if (original.files.some(file => file.file.includes('/'))) throw new Error('此基准夹具要求源资产文件位于同一层目录');
    const samples = [];
    const variants = comparison === 'multi'
      ? [{ label: 'pipeline', prefetch: true, downloadAssets: 1, downloadConnections: 4 }, { label: 'dual4', prefetch: true, downloadAssets: 2, downloadConnections: 4 }, { label: 'dual8', prefetch: true, downloadAssets: 2, downloadConnections: 8 }, { label: 'pipeline_repeat', prefetch: true, downloadAssets: 1, downloadConnections: 4 }]
      : [{ label: 'serial', prefetch: false }, { label: 'pipeline', prefetch: true }];
    for (const { label, prefetch, downloadAssets = 1, downloadConnections = config.downloadWorkers } of variants) {
      const library = path.join(root, label), cache = path.join(localRoot, label);
      await fs.mkdir(cache, { recursive: true });
      const worker = new ImportWorker({ cacheRoot: cache });
      try {
        await worker.start();
        const ids = Array.from({ length: count }, (_, index) => `perf${label}${index}`);
        const started = performance.now();
        let activeDownloads = 0, peakDownloads = 0, peakDownloadingAssets = 0;
        const downloading = new Map();
        await runPipeline({ ids, prefetch, downloadAssets, downloadConnections, options: { library, cacheRoot: cache, resolution: config.resolution, mode: 'import',
          maxCacheBytes, reserveBytes: config.minFreeGb * GIB, downloadWorkers: config.downloadWorkers,
          download: async (entry, directory, settings) => {
            const owner = path.basename(path.dirname(directory));
            activeDownloads++; peakDownloads = Math.max(peakDownloads, activeDownloads);
            downloading.set(owner, (downloading.get(owner) || 0) + 1); peakDownloadingAssets = Math.max(peakDownloadingAssets, downloading.size);
            try { return await downloadFile(entry, directory, settings); }
            finally { activeDownloads--; const remaining = downloading.get(owner) - 1; if (remaining) downloading.set(owner, remaining); else downloading.delete(owner); }
          },
          client: { plan: async clone => ({ meta: { ...globalThis.structuredClone(original.meta), id: clone }, files: original.files.filter(file => !/\.json$/i.test(file.file)) }) },
          importer: job => worker.run(job), log: () => {} },
          onCompleted: async (clone, receipt) => {
            for (const file of receipt.archive.files.filter(file => !/\.json$/i.test(file.file))) {
              if (reference.archive.files.find(item => item.file === file.file)?.sha256 !== file.sha256) throw new Error('基准资源与正式回执SHA-256不匹配');
            }
            console.log(`${label}: ${clone} complete`);
          }
        });
        samples.push({ label, count, downloadAssets, downloadConnections, peakDownloads, peakDownloadingAssets, seconds: +((performance.now() - started) / 1000).toFixed(3) });
        console.log(JSON.stringify(samples.at(-1)));
      } finally { await worker.close(); }
    }
    const report = { id, measuredAt: new Date().toISOString(), description: 'same purchased asset cloned into isolated test identities; actual CDN downloads and Electron imports; workers warmed before timing', samples, retainedCacheBytes,
      ...(comparison === 'pipeline' ? { throughputGainPercent: +(100 * (samples[0].seconds / samples[1].seconds - 1)).toFixed(1) } : {}), sha256MatchedProductionReceipt: true };
    await atomicJson(path.join(cacheRoot, comparison === 'multi' ? 'multi-download-benchmark.json' : 'pipeline-benchmark.json'), report);
    return report;
  } finally {
    try { await removeWorkspace(parent, root); await removeWorkspace(cacheParent, localRoot); }
    finally { try { if (releaseShare) await releaseShare(); } finally { await releaseLocal(); } }
  }
}

if (require.main === module) benchmark(process.argv[2], Number(process.argv[3] || 3), undefined, process.argv[4] || 'pipeline').catch(error => { console.error(`流水线基准失败：${error.message}`); process.exitCode = 1; });
module.exports = { benchmark };
