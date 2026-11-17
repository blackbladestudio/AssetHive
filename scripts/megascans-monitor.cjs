const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { readProgress, safeError } = require('./lib/megascans-progress.cjs');
const { MonitorLibrary } = require('./lib/megascans-monitor-data.cjs');
const { inside } = require('./lib/megascans-transfer.cjs');
const { spawn } = require('node:child_process');
const { activeRunner, requestPause, pauseRequested } = require('./lib/megascans-control.cjs');
const { authenticate, lock } = require('./megascans-runner.cjs');
const { selectedTypes } = require('./lib/megascans-queue.cjs');
const cacheRoot = path.resolve(process.env.ASSETHIVE_MEGASCANS_CACHE);
const library = path.resolve(process.env.ASSETHIVE_MEGASCANS_LIBRARY);
app.setPath('userData', path.join(cacheRoot, 'monitor-runtime'));
app.disableHardwareAcceleration();
let win;
let starting = false;
let loggingIn = false;
let loginStatus = '可主动登录 Bridge / Quixel 账号';
async function readConfiguration() {
  try { return JSON.parse(await fs.readFile(path.join(cacheRoot, 'configuration.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
app.whenReady().then(async () => {
  const assets = new MonitorLibrary(library);
  win = new BrowserWindow({ width: 1160, height: 850, minWidth: 800, minHeight: 600, backgroundColor: '#121212', title: 'Megascans 下载与入库进度 · AssetHive',
    show: !process.env.ASSETHIVE_MEGASCANS_MONITOR_SMOKE,
    webPreferences: { preload: path.join(__dirname, 'megascans-monitor-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  const handle = (channel, action) => ipcMain.handle(channel, async (event, input) => {
    if (event.sender !== win.webContents) throw new Error('非法窗口');
    try { return { ok: true, value: await action(input) }; }
    catch (error) { return { ok: false, error: safeError(error) }; }
  });
  handle('megascans-monitor:progress', async () => {
    const progress = await readProgress({ cacheRoot, library });
    return { progress, library, active: starting || await activeRunner(cacheRoot), loggingIn, loginStatus, pausePending: progress ? await pauseRequested(cacheRoot, progress.runId) : false };
  });
  handle('megascans-monitor:configuration', async () => {
    const configuration = await readConfiguration();
    return { assetTypes: selectedTypes(configuration.assetTypes), mode: configuration.mode || 'import', modeLocked: !!configuration.mode, source: configuration.source || 'quixel' };
  });
  handle('megascans-monitor:login', async () => {
    if ((await readConfiguration()).source === 'fab') throw new Error('Fab 免费下载无需 Bridge 登录');
    if (loggingIn || starting || await activeRunner(cacheRoot)) throw new Error('请先暂停下载并等待任务退出，再主动登录');
    loggingIn = true;
    let release;
    try {
      release = await lock(path.join(cacheRoot, 'runner.lock'));
      loginStatus = '正在打开 Bridge / Quixel 登录窗口…';
      await authenticate(cacheRoot, true, { onStatus: status => {
        if (status === 'loaded') loginStatus = '请在官方窗口完成登录，成功后自动保存';
        if (status === 'loadFailed') loginStatus = '登录页面加载失败，正在重试；请检查网络或代理';
      } });
      loginStatus = 'Bridge 登录成功，凭证已加密保存';
    } catch (error) { loginStatus = '登录未完成，可重新点击 Bridge 登录'; throw error; }
    finally { try { if (release) await release(); } finally { loggingIn = false; } }
  });
  handle('megascans-monitor:pause', async () => {
    const progress = await readProgress({ cacheRoot, library });
    await requestPause(cacheRoot, progress?.runId);
  });
  handle('megascans-monitor:start', async input => {
    if (loggingIn || starting || await activeRunner(cacheRoot)) throw new Error('已有运行中的下载或登录任务');
    starting = true;
    try {
      const configuration = await readConfiguration();
      const assetTypes = selectedTypes(input?.assetTypes ?? configuration.assetTypes);
      const mode = input?.mode ?? configuration.mode ?? 'import';
      if (!['import', 'archive'].includes(mode)) throw new Error('请选择有效处理方式');
      if (configuration.mode && mode !== configuration.mode) throw new Error('现有任务须保持原处理方式；不同模式请使用新的 --cache');
      const fab = configuration.source === 'fab';
      if (fab && (mode !== 'import' || assetTypes.join(',') !== '3d,surface,decal')) throw new Error('本次 Fab 任务沿用 3D Assets、Surface、Decal 和正式入库规格');
      const args = fab ? [path.join(__dirname, 'fab-megascans-runner.cjs'), '--run', '--library', library, '--cache', cacheRoot,
        '--download-workers', String(configuration.downloadWorkers || 4), '--max-cache-gb', String(configuration.maxCacheGb || 8),
        '--min-free-gb', String(configuration.minFreeGb ?? 10), '--max-archive-gb', String(configuration.maxArchiveGb || 50)]
        : [path.join(__dirname, 'megascans-runner.cjs'), '--run', '--library', library, '--cache', cacheRoot,
        '--resolution', String(configuration.resolution || 4096), '--mode', mode, '--types', assetTypes.join(','),
        '--download-workers', String(configuration.downloadWorkers || 4), '--max-cache-gb', String(configuration.maxCacheGb || 8),
        '--download-assets', String(configuration.downloadAssets || 1), '--download-connections', String(configuration.downloadConnections || configuration.downloadWorkers || 4),
        '--min-free-gb', String(configuration.minFreeGb ?? 10), ...(configuration.maxArchiveGb !== undefined ? ['--max-archive-gb', String(configuration.maxArchiveGb)] : []), ...(configuration.prefetchNext === false ? ['--no-prefetch'] : [])];
      const proc = spawn(process.execPath, args, { cwd: path.resolve(__dirname, '..'), windowsHide: true,
        detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      await new Promise((resolve, reject) => { proc.once('spawn', resolve); proc.once('error', () => reject(new Error('无法启动下载进程'))); });
      proc.unref();
      globalThis.setTimeout(() => { starting = false; }, 3000);
    } catch (error) { starting = false; throw error; }
  });
  handle('megascans-monitor:assets', options => assets.list(options || {}));
  handle('megascans-monitor:open', async id => {
    const folder = id ? (await assets.readAsset(id)).folder : library;
    const realLibrary = await fs.realpath(library), realFolder = await fs.realpath(folder);
    if (!inside(realLibrary, realFolder)) throw new Error('目录不属于此资源库');
    const error = await shell.openPath(realFolder);
    if (error) throw new Error('无法打开资源文件夹');
  });
  await win.loadFile(path.join(__dirname, 'megascans-monitor', 'index.html'));
  if (process.env.ASSETHIVE_MEGASCANS_MONITOR_SMOKE) {
    const assert = require('node:assert/strict');
    const inspect = () => win.webContents.executeJavaScript('({count:document.querySelectorAll(".asset").length,completed:document.getElementById("completed").textContent,error:document.getElementById("error").textContent})');
    for (let attempt = 0; attempt < 80; attempt++) {
      const state = await inspect();
      if (state.count === 1) break;
      await new Promise(resolve => globalThis.setTimeout(resolve, 100));
    }
    const state = await inspect();
    assert.equal(state.count, 1, JSON.stringify(state)); assert.equal(state.completed, '1'); assert.equal(state.error, '');
    assert.equal(await win.webContents.executeJavaScript('document.getElementById("start").disabled'), false);
    assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("input[name=asset-type]").length'), 5);
    await win.webContents.executeJavaScript('document.getElementById("login").click()');
    for (let attempt = 0; attempt < 40; attempt++) {
      if (!loggingIn && await fs.access(path.join(cacheRoot, 'login-clicked')).then(() => true, () => false)) break;
      await new Promise(resolve => globalThis.setTimeout(resolve, 50));
    }
    assert.equal(loggingIn, false);
    await win.webContents.executeJavaScript('refresh()');
    assert.match(await win.webContents.executeJavaScript('document.getElementById("login-status").textContent'), /登录成功/);
    const invalidStart = await win.webContents.executeJavaScript('globalThis.megascans.start({assetTypes:[],mode:"import"})');
    assert.equal(invalidStart.ok, false);
    await win.webContents.executeJavaScript('document.querySelectorAll("input[name=asset-type]").forEach(input=>input.checked=false);document.getElementById("type-selection").dispatchEvent(new Event("change"))');
    assert.equal(await win.webContents.executeJavaScript('document.getElementById("start").disabled'), true);
    await win.webContents.executeJavaScript('document.querySelector(\'input[value="3dplant"]\').checked=true;document.getElementById("type-selection").dispatchEvent(new Event("change"))');
    assert.equal(await win.webContents.executeJavaScript('document.getElementById("start").disabled'), false);
    const savedProgressPath = path.join(cacheRoot, 'progress.json');
    const savedProgress = JSON.parse(await fs.readFile(savedProgressPath, 'utf8'));
    await fs.writeFile(savedProgressPath, JSON.stringify({ ...savedProgress, deferred: 2, deferredIds: ['denied', 'badplan'], lastDeferred: { id: 'badplan', reason: 'HTTP 500' } }));
    await win.webContents.executeJavaScript('refresh()');
    assert.match(await win.webContents.executeJavaScript('document.getElementById("deferred-info").textContent'), /待重试 2 项.*denied.*badplan.*HTTP 500/);
    await fs.writeFile(savedProgressPath, JSON.stringify({ ...savedProgress, status: 'pending_retry', stage: 'awaiting_retry', deferred: 2, deferredIds: ['denied', 'badplan'] }));
    await win.webContents.executeJavaScript('refresh()');
    assert.match(await win.webContents.executeJavaScript('document.getElementById("status").textContent'), /仍有资产待重试/);
    await fs.writeFile(savedProgressPath, JSON.stringify({ ...savedProgress, prefetch: { id: 'nextfixture', stage: 'prefetched', downloadedBytes: 1024, totalBytes: 1024 } }));
    await win.webContents.executeJavaScript('refresh()');
    assert.match(await win.webContents.executeJavaScript('document.getElementById("prefetch-info").textContent'), /nextfixture.*下载完成/);
    await fs.writeFile(savedProgressPath, JSON.stringify({ ...savedProgress, stage: 'checking', checkingDone: 1, checkingTotal: 2, checkingMode: 'quick', checkingId: 'monitorfixture', checkingFile: 'color.png' }));
    await win.webContents.executeJavaScript('refresh()');
    assert.match(await win.webContents.executeJavaScript('document.getElementById("overall-text").textContent'), /检查 1 \/ 2/);
    assert.equal(await win.webContents.executeJavaScript('document.getElementById("file-info").textContent'), 'color.png');
    await fs.writeFile(savedProgressPath, JSON.stringify({ ...savedProgress, stage: 'retrying', retryAttempt: 2, retryAt: new Date(Date.now() + 10000).toISOString(), retryReason: '网络中断' }));
    await win.webContents.executeJavaScript('refresh()');
    assert.match(await win.webContents.executeJavaScript('document.getElementById("file-info").textContent'), /第 2 次重试/);
    await fs.writeFile(savedProgressPath, JSON.stringify({ ...savedProgress, stage: 'waiting_login' }));
    await win.webContents.executeJavaScript('refresh()');
    assert.match(await win.webContents.executeJavaScript('document.getElementById("stage").textContent'), /等待 Quixel 登录/);
    await fs.writeFile(savedProgressPath, JSON.stringify(savedProgress));
    await fs.writeFile(path.join(cacheRoot, 'runner.lock'), JSON.stringify({ host: require('node:os').hostname(), pid: process.pid }));
    await win.webContents.executeJavaScript('refresh()');
    assert.equal(await win.webContents.executeJavaScript('document.getElementById("pause").disabled'), false);
    await win.webContents.executeJavaScript('document.getElementById("pause").click()');
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await pauseRequested(cacheRoot, (await readProgress({ cacheRoot, library })).runId)) break;
      await new Promise(resolve => globalThis.setTimeout(resolve, 50));
    }
    assert.equal(await pauseRequested(cacheRoot, (await readProgress({ cacheRoot, library })).runId), true);
    await fs.unlink(path.join(cacheRoot, 'runner.lock'));
    await fs.writeFile(path.join(cacheRoot, 'monitor-smoke.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript('document.getElementById("search").value="no-matching-asset"; refresh(true)');
    assert.equal((await inspect()).count, 0);
    await win.webContents.executeJavaScript('document.getElementById("search").value=""; refresh(true)');
    assert.equal((await inspect()).count, 1);
    process.stdout.write('ASSETHIVE_MONITOR:smoke-passed\n'); app.exit(0); return;
  }
  win.show(); win.focus();
  process.stdout.write('ASSETHIVE_MONITOR:ready\n');
}).catch(error => {
  if (process.env.ASSETHIVE_MEGASCANS_MONITOR_SMOKE) process.stdout.write(`MONITOR_TEST_ERROR:${safeError(error)}\n`);
  process.stdout.write('ASSETHIVE_MONITOR:failed\n'); app.exit(1);
});
app.on('window-all-closed', () => app.quit());
