// Explicit, bounded benchmark of one already-purchased asset. The normal runner
// must be safely paused first. No signed URL or credential enters the report.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { lock } = require('./megascans-runner.cjs');
const { QuixelClient, GIB, atomicJson, downloadFile, inventory, freeBytes, ownedCache, cleanupOwnedCache, assetId } = require('./lib/megascans-transfer.cjs');

async function benchmark(id, cacheRoot = path.resolve(__dirname, '../.cache/megascans-download')) {
  assetId(id);
  const config = JSON.parse(await fs.readFile(path.join(cacheRoot, 'configuration.json'), 'utf8'));
  const releaseLocal = await lock(path.join(cacheRoot, 'runner.lock'));
  let releaseShare;
  try {
    releaseShare = await lock(path.join(config.library, '.megascans/runner.lock'));
    const env = { ...process.env, ASSETHIVE_QUIXEL_AUTH_ROOT: path.join(cacheRoot, 'login') };
    delete env.ELECTRON_RUN_AS_NODE;
    const auth = await new Promise((resolve, reject) => {
      const proc = spawn(require('electron'), [path.join(__dirname, 'quixel-login.cjs'), '--auto-login'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      proc.stdout.on('data', chunk => { output += chunk; });
      proc.on('error', () => reject(new Error('登录助手无法启动')));
      proc.on('close', code => {
        const line = output.split(/\r?\n/).find(line => line.startsWith('ASSETHIVE_AUTH:'));
        if (code !== 0 || !line) { reject(new Error('没有有效登录，停止基准测试')); return; }
        try { resolve(JSON.parse(line.slice('ASSETHIVE_AUTH:'.length))); } catch { reject(new Error('登录结果无效')); }
      });
    });
    const client = new QuixelClient(auth.token);
    const plan = await client.plan(id, config.resolution);
    const bytes = plan.files.reduce((sum, file) => sum + file.bytes, 0);
    const budget = config.maxCacheGb * GIB, reserveBytes = config.minFreeGb * GIB;
    const activeCache = path.join(cacheRoot, 'assets');
    const existing = await fs.stat(activeCache).then(() => inventory(activeCache, { content: false }), error => { if (error.code === 'ENOENT') return []; throw error; });
    const existingBytes = existing.reduce((sum, file) => sum + file.bytes, 0);
    if (bytes + existingBytes + plan.files.length * 64 + 4096 > budget || await freeBytes(cacheRoot) < bytes + reserveBytes) throw new Error('基准测试超过当前磁盘预算');
    const benchRoot = path.join(cacheRoot, 'benchmark-cache');
    const samples = [];
    let hashes;
    for (const [label, workers, sort] of [['original-4', 4, false], ['largest-first-4', 4, true], ['largest-first-8', 8, true]]) {
      const dir = await ownedCache(benchRoot, id);
      const queue = sort ? [...plan.files].sort((a, b) => b.bytes - a.bytes) : plan.files;
      let cursor = 0, failure;
      const started = performance.now();
      await Promise.all(Array.from({ length: workers }, async () => {
        while (!failure && cursor < queue.length) {
          const file = queue[cursor++];
          try { await downloadFile(file, dir, { reserveBytes }); } catch (error) { failure ||= error; }
        }
      }));
      if (failure) throw failure;
      const seconds = (performance.now() - started) / 1000;
      const files = await inventory(dir, { include: file => plan.files.some(item => item.file === file) });
      const fingerprint = JSON.stringify(files);
      if (hashes && hashes !== fingerprint) throw new Error('不同基准测试收到的资源内容不一致');
      hashes = fingerprint;
      samples.push({ label, workers, seconds: +seconds.toFixed(3), mibPerSecond: +(bytes / 1024 ** 2 / seconds).toFixed(2) });
      console.log(JSON.stringify(samples.at(-1)));
      await cleanupOwnedCache(benchRoot, id);
    }
    const report = { id, measuredAt: new Date().toISOString(), files: plan.files.length, bytes, samples, identicalSha256: true };
    await atomicJson(path.join(cacheRoot, 'download-benchmark.json'), report);
    return report;
  } finally { try { if (releaseShare) await releaseShare(); } finally { await releaseLocal(); } }
}

if (require.main === module) benchmark(process.argv[2]).catch(() => { console.error('基准测试失败，缓存保留；请检查磁盘、网络和登录状态。'); process.exitCode = 1; });
module.exports = { benchmark };
