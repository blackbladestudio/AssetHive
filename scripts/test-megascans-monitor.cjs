const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { atomicJson } = require('./lib/megascans-transfer.cjs');
const { Progress } = require('./lib/megascans-progress.cjs');
const { MonitorLibrary } = require('./lib/megascans-monitor-data.cjs');

test('monitor renders persisted progress and imported cards; search works in the actual Electron window', { timeout: 45000 }, async t => {
  const parent = path.resolve(__dirname, '../.cache/megascans-monitor-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'run-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(parent));
    await fs.rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
  });
  const cacheRoot = path.join(root, 'cache'), library = path.join(root, 'library');
  const id = 'monitorfixture', folder = path.join(library, 'Environment/Surfaces/megascans_monitorfixture');
  await atomicJson(path.join(folder, 'asset_info.json'), { name: 'Limestone · 石灰岩', assetType: 'surface', previews: { images: [] } });
  await atomicJson(path.join(library, '.megascans/receipts', `${id}.json`), { id, completedAt: new Date().toISOString(), archive: { root: '.megascans/originals/v3/monitorfixture' }, imported: { root: path.relative(library, folder) } });
  const progress = new Progress({ cacheRoot, library, resolution: 4096, mode: 'import', total: 2 });
  await progress.update({ status: 'paused', stage: 'stopped', completed: 1, pending: 1, processedThisRun: 1 });
  const data = new MonitorLibrary(library);
  assert.equal((await data.list()).imported, 1);
  assert.equal((await data.list({ query: 'LIMESTONE' })).items[0].id, id);
  assert.equal((await data.list({ query: 'missing' })).total, 0);
  await assert.rejects(data.readAsset('../outside'), /无效/);
  const env = { ...process.env, ASSETHIVE_MEGASCANS_CACHE: cacheRoot, ASSETHIVE_MEGASCANS_LIBRARY: library, ASSETHIVE_MEGASCANS_MONITOR_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const bootstrap = path.join(root, 'monitor-fixture.cjs');
  await fs.writeFile(bootstrap, `
const runner = require(${JSON.stringify(path.join(__dirname, 'megascans-runner.cjs'))});
runner.authenticate = async (cache, login, { onStatus }) => {
  if (!login) throw new Error('必须主动登录');
  await onStatus('loaded');
  await new Promise(resolve => setTimeout(resolve, 200));
  await require('node:fs/promises').writeFile(require('node:path').join(cache, 'login-clicked'), 'ok');
  return 'private-fixture-token';
};
require(${JSON.stringify(path.join(__dirname, 'megascans-monitor.cjs'))});
`);
  const child = spawn(require('electron'), [bootstrap], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { if (child.exitCode == null) child.kill(); });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, output); assert.match(output, /smoke-passed/);
  assert.equal(await fs.readFile(path.join(cacheRoot, 'login-clicked'), 'utf8'), 'ok');
  assert.ok(!output.includes('private-fixture-token'));
  await fs.copyFile(path.join(cacheRoot, 'monitor-smoke.png'), path.join(parent, 'latest.png'));
});
