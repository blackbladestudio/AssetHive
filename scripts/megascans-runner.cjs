const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');
const { QuixelClient, DOWNLOAD_POLICY, GIB, exists, atomicJson, freeBytes, inventory, inside } = require('./lib/megascans-transfer.cjs');
const { Progress, readProgress, safeError } = require('./lib/megascans-progress.cjs');
const { orderedCatalog, selectedTypes } = require('./lib/megascans-queue.cjs');
const { pauseRequested } = require('./lib/megascans-control.cjs');
const { checkCompletedReceipts } = require('./lib/megascans-resume.cjs');
const { recover, paused } = require('./lib/megascans-recovery.cjs');
const { ImportWorker } = require('./lib/megascans-import-worker.cjs');
const { cachedOrder, runPipeline } = require('./lib/megascans-pipeline.cjs');
const { createArchiveBudget } = require('./lib/megascans-archive-retention.cjs');
const { readDeferred, setDeferred, remainingQueue } = require('./lib/megascans-deferred.cjs');
const { isolatedAssetFailure } = require('./lib/megascans-failure-policy.cjs');
const { storageId, recordPath, cachePath } = require('./lib/megascans-paths.cjs');

const REPO = path.resolve(__dirname, '..');
const LOGIN_STATUS = {
  window: 'Quixel 登录窗口已创建。',
  loaded: 'Quixel 页面已加载，请在窗口中完成登录。',
  loadFailed: 'Quixel 页面加载失败，请检查网络或代理后重试。',
  saveFailed: '登录凭证加密保存失败。',
  failed: 'Quixel 登录助手启动或凭证读取失败。',
  restoring: '正在用已保存的 Quixel 浏览器会话自动登录。',
  continuing: '正在自动关闭迁移提示并通过 Epic 已保存会话继续登录。',
  needsLogin: '自动登录尚未完成，请在 Quixel 窗口完成登录；成功后自动继续。'
};
function child(exe, args, env = {}, interactive = false, { shouldStop, onStatus } = {}) {
  return new Promise((resolve, reject) => {
    const variables = { ...process.env, ...env };
    delete variables.ELECTRON_RUN_AS_NODE;
    const proc = spawn(exe, args, { cwd: REPO, env: variables, windowsHide: !interactive, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let partialLine = '';
    let callbacks = Promise.resolve(), cancelled = false;
    const timer = shouldStop ? globalThis.setInterval(async () => {
      if (await shouldStop().catch(() => false)) { cancelled = true; proc.kill(); }
    }, 1000) : null;
    proc.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 4 * 1024 * 1024) { proc.kill(); reject(new Error('子进程输出超限')); return; }
      if (interactive || onStatus) {
        partialLine += chunk;
        const lines = partialLine.split(/\r?\n/);
        partialLine = lines.pop();
        for (const line of lines) {
          const status = LOGIN_STATUS[line.replace(/^ASSETHIVE_LOGIN_STATUS:/, '')];
          if (line.startsWith('ASSETHIVE_LOGIN_STATUS:') && status) console.log(status);
          if (line.startsWith('ASSETHIVE_LOGIN_STATUS:') && status && onStatus) {
            callbacks = callbacks.then(() => onStatus(line.slice('ASSETHIVE_LOGIN_STATUS:'.length)));
            callbacks.catch(() => {});
          }
          if (line === 'ASSETHIVE_MONITOR:ready') console.log('Megascans 进度窗口已打开，每 2 秒自动刷新。');
          if (line === 'ASSETHIVE_MONITOR:failed') console.log('进度窗口启动失败。');
        }
      }
    });
    // Do not echo Electron/remote-page diagnostics: they can contain auth URLs.
    proc.stderr.resume();
    proc.on('error', () => { if (timer) globalThis.clearInterval(timer); reject(new Error('无法启动 Electron，请先安装项目依赖')); });
    proc.on('close', code => {
      if (timer) globalThis.clearInterval(timer);
      callbacks.then(() => cancelled ? reject(paused()) : resolve({ code, stdout }), reject);
    });
  });
}
async function authenticate(cacheRoot, login, { refresh = false, shouldStop, onStatus } = {}) {
  if (!login && !refresh && process.env.QUIXEL_TOKEN) return process.env.QUIXEL_TOKEN.trim();
  const authRoot = path.join(cacheRoot, 'login');
  await fs.mkdir(path.join(authRoot, 'browser'), { recursive: true });
  // Electron controls its own hidden/visible BrowserWindow. Windows' startup
  // hide flag can suppress the first show when automatic renewal needs input.
  const result = await child(require('electron'), [path.join(__dirname, 'quixel-login.cjs'), ...(refresh || login ? ['--refresh'] : []), ...(login ? ['--login'] : refresh ? [] : ['--auto-login'])], { ASSETHIVE_QUIXEL_AUTH_ROOT: authRoot }, true, { shouldStop, onStatus });
  const message = result.stdout.split(/\r?\n/).find(line => line.startsWith('ASSETHIVE_AUTH:'));
  if (result.code !== 0 || !message) throw new Error('没有可用登录，请运行 node scripts/download-megascans.cjs --login；不需要在聊天中提供密码或 Token');
  let auth;
  try { auth = JSON.parse(message.slice('ASSETHIVE_AUTH:'.length)); } catch { throw new Error('Quixel 登录返回格式异常'); }
  if (!auth.token) throw new Error('Quixel 登录没有返回有效凭证');
  return auth.token;
}
async function importAsset(job) {
  const worker = new ImportWorker({ cacheRoot: job.cacheRoot });
  try { return await worker.run(job); }
  finally { await worker.close(); }
}
async function lock(file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    const handle = await fs.open(file, 'wx');
    await handle.writeFile(JSON.stringify({ host: os.hostname(), pid: process.pid }));
    return async () => { await handle.close(); await fs.unlink(file); };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const old = JSON.parse(await fs.readFile(file, 'utf8'));
    let alive = true;
    if (old.host === os.hostname() && Number.isInteger(old.pid)) {
      try { process.kill(old.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    }
    if (alive) throw new Error('已有下载任务持锁；确认原任务退出后再重试');
    await fs.unlink(file);
    return lock(file);
  }
}
async function main(argv = process.argv.slice(2)) {
  const { values: opts } = parseArgs({ args: argv, options: {
    help: { type: 'boolean', short: 'h' }, login: { type: 'boolean' }, run: { type: 'boolean' }, status: { type: 'boolean' }, monitor: { type: 'boolean' }, 'verify-existing': { type: 'boolean' }, 'no-prefetch': { type: 'boolean' },
    defer: { type: 'string' }, restore: { type: 'string' }, types: { type: 'string' },
    library: { type: 'string', default: '\\\\fileshare\\share\\Artist\\AssetLibrary' },
    cache: { type: 'string', default: path.join(REPO, '.cache', 'megascans-download') },
    resolution: { type: 'string', default: '4096' }, 'max-cache-gb': { type: 'string', default: '8' },
    'min-free-gb': { type: 'string', default: '10' }, 'max-archive-gb': { type: 'string' }, 'download-workers': { type: 'string', default: '4' }, 'download-assets': { type: 'string', default: '1' }, 'download-connections': { type: 'string' }, limit: { type: 'string' }, mode: { type: 'string', default: 'import' }
  } });
  if (opts.help) {
    console.log(`Megascans 已购库分批下载与 AssetHive 入库（Node 22+）

登录：node scripts/download-megascans.cjs --login
预检：node scripts/download-megascans.cjs
试跑：node scripts/download-megascans.cjs --run --limit 1
全量：node scripts/download-megascans.cjs --run
进度：node scripts/download-megascans.cjs --status
窗口：node scripts/download-megascans.cjs --monitor

--library <共享库路径>    默认 \\\\fileshare\\share\\Artist\\AssetLibrary
--cache <本地目录>        默认仓库 .cache/megascans-download
--resolution <像素>       1024 / 2048 / 4096 / 8192，默认 4096
                         3D Assets / Surface / Decal（含 Atlas）始终最高 4K
                         3D Assets 仅 Highpoly FBX；优先 PNG，仅有 JPG 保留，排除 EXR
--max-cache-gb <GiB>      资产缓存硬上限，默认 8（文件流式写入）
--min-free-gb <GiB>       保留本地空闲，默认 10
--max-archive-gb <GiB>    共享盘原始归档上限；沿用已保存值，新任务未设置时不清理
                         仅清理已完整入库的旧模型/贴图，保留JSON/预览和原始哈希记录
--download-workers <数量> 当前资产内并发文件数，1–8，默认 4
--download-assets <数量>  同时下载的资产数，1–2，默认 1；始终最多两项缓存
--download-connections <数量> 全部资产共享的下载连接上限，1–8，默认同 download-workers
--no-prefetch             关闭下一项预取，使用串行模式（默认受容量约束预取一项）
--verify-existing         续跑前重新读取全部历史文件做 SHA-256；默认快速检查文件大小和元数据
--defer <ID>              停机持双锁后明确暂存一项；保留缓存，不计完成，不自动跳过其他失败
--restore <ID>            停机持双锁后恢复待重试项；保留独立缓存恢复记录，下次 --run 优先重试
--limit <数量>            只处理前 N 个尚未完成的资产
--mode import|archive    默认入库；archive 仅保留 Bridge 原始资源
--types <类型列表>       逗号分隔：3d,3dplant,surface,decal,hdri（Atlas 归 Decal）
                         默认沿用任务已保存选择；新任务默认 3d,surface,decal

最多两项缓存；可同时下载两项，入库始终逐项执行。两项缓存合计受预算约束，完整校验后才清理自身缓存。
断网及服务器临时错误会自动退避重试；登录失效先尝试保存的浏览器会话，需要手动登录时显示窗口，成功后自动续跑。
私有 Quixel 接口可能变化；请先试跑一项。预检只读取已购清单，不下载资源。`);
    return;
  }
  const library = path.resolve(opts.library), cacheRoot = path.resolve(opts.cache), resolution = Number(opts.resolution);
  const maxCacheBytes = Number(opts['max-cache-gb']) * GIB, reserveBytes = Number(opts['min-free-gb']) * GIB;
  const limit = opts.limit === undefined ? Infinity : Number(opts.limit);
  const downloadWorkers = Number(opts['download-workers']);
  if (opts.types !== undefined) selectedTypes(opts.types);
  const downloadAssets = Number(opts['download-assets']), downloadConnections = Number(opts['download-connections'] ?? downloadWorkers);
  if ((opts.defer || opts.restore) && (opts.defer && opts.restore || opts.run || opts.login || opts.monitor || opts.status)) throw new Error('暂存或恢复必须单独执行，不能同时运行其他操作');
  if (opts['max-archive-gb'] !== undefined && (!Number.isFinite(Number(opts['max-archive-gb'])) || Number(opts['max-archive-gb']) <= 0 || !Number.isSafeInteger(Number(opts['max-archive-gb']) * GIB))) throw new Error('原始归档上限必须为正数GiB');
  if (!Number.isInteger(downloadWorkers) || downloadWorkers < 1 || downloadWorkers > 8) throw new Error('下载并发数必须在 1–8 之间');
  if (![1, 2].includes(downloadAssets) || !Number.isInteger(downloadConnections) || downloadConnections < 1 || downloadConnections > 8) throw new Error('下载资产数应为1–2，总下载连接数应为1–8');
  if (![1024, 2048, 4096, 8192].includes(resolution) || !Number.isFinite(maxCacheBytes) || maxCacheBytes <= 0 || !Number.isFinite(reserveBytes) || reserveBytes < 0 || !(limit > 0) || (limit !== Infinity && !Number.isInteger(limit)) || !['import', 'archive'].includes(opts.mode)) throw new Error('参数无效，请运行 --help');
  if (inside(library, cacheRoot) || inside(cacheRoot, library)) throw new Error('本地缓存与共享库不能相互包含');
  if (process.platform === 'win32' && cacheRoot.startsWith('\\\\')) throw new Error('--cache 应指定本机磁盘');
  if (opts.monitor) {
    await fs.mkdir(cacheRoot, { recursive: true });
    const result = await child(require('electron'), [path.join(__dirname, 'megascans-monitor.cjs')], { ASSETHIVE_MEGASCANS_CACHE: cacheRoot, ASSETHIVE_MEGASCANS_LIBRARY: library }, true);
    if (result.code !== 0) throw new Error('进度窗口异常退出');
    return;
  }
  if (opts.status) {
    const progress = await readProgress({ cacheRoot, library });
    if (!progress) { console.log('还没有下载任务进度；--run 后自动记录。'); return; }
    console.log(`状态 ${progress.status}；阶段 ${progress.stage}；完成 ${progress.completed}/${progress.total ?? '未知'}；待处理 ${progress.pending ?? '未知'}；已校验跳过 ${progress.skipped}；本次处理 ${progress.processedThisRun}。`);
    console.log(`待重试 ${progress.deferred || 0} 项：${(progress.deferredIds || []).join(', ')}`);
    if (progress.stage === 'ordering') console.log(`分类 ${progress.orderingDone}/${progress.orderingTotal}；源站不可用 ${progress.unavailable || 0}。`);
    if (progress.stage === 'checking') console.log(`历史检查 ${progress.checkingDone || 0}/${progress.checkingTotal ?? '未知'}；${progress.checkingMode === 'full' ? '完整 SHA-256' : '快速检查'}；${progress.checkingFile || ''}`);
    if (progress.current) console.log(`当前 ${progress.current.id}：${progress.current.stage}；文件 ${progress.current.completedFiles || 0}/${progress.current.totalFiles ?? '未知'}；字节 ${progress.current.downloadedBytes || 0}/${progress.current.totalBytes ?? '未知'}。`);
    if (progress.error) console.log(`失败原因：${progress.error}`);
    console.log(`更新时间 ${progress.updatedAt}；详细记录 ${path.join(library, '.megascans', 'progress.json')}`);
    return;
  }
  await fs.mkdir(cacheRoot, { recursive: true });
  const releaseLocal = await lock(path.join(cacheRoot, 'runner.lock'));
  let releaseShare;
  let progress;
  const importWorker = new ImportWorker({ cacheRoot });
  let stopRequested = false;
  const stop = () => { stopRequested = true; console.log('已请求停止；当前资产完成并释放缓存后退出，不再开始下一项。'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    if (opts.login) { await authenticate(cacheRoot, true); console.log('Quixel 登录已加密保存，可以进行预检。'); return; }
    if (!await exists(library)) throw new Error(`共享盘不可访问：${library}。先连接公司网络/VPN 并确认此路径可打开`);
    if (await freeBytes(cacheRoot) < reserveBytes) throw new Error('本地剩余空间低于保留值');
    const control = path.join(library, '.megascans');
    if (opts.defer || opts.restore) {
      releaseShare = await lock(path.join(control, 'runner.lock'));
      const saved = JSON.parse(await fs.readFile(path.join(cacheRoot, 'configuration.json'), 'utf8'));
      if (saved.library !== library || saved.resolution !== resolution || saved.mode !== opts.mode) throw new Error('请保持原任务的目标库、分辨率和模式');
      const id = opts.defer || opts.restore;
      const catalog = JSON.parse(await fs.readFile(path.join(cacheRoot, 'catalog.json'), 'utf8'));
      if (!catalog.ids.includes(id)) throw new Error('资产不属于当前已购清单');
      const options = { cacheRoot, library, resolution, mode: opts.mode };
      const root = path.join(cacheRoot, 'assets');
      const cached = await exists(root) ? (await fs.readdir(root)).map(storageId) : [];
      await cachedOrder(cached, options);
      let item;
      if (opts.defer) item = JSON.parse(await fs.readFile(await recordPath(path.join(cacheRoot, 'items'), id), 'utf8'));
      if (opts.defer && item.status !== 'failed') throw new Error('仅允许明确暂存已失败的资产');
      await setDeferred(options, { id, restore: !!opts.restore, retainedCache: cached.includes(id), reason: item?.error || '' });
      console.log(`${id} 已${opts.restore ? '恢复到重试队列' : '暂存待重试'}；缓存完整保留。使用原配置 --run 继续。`);
      return;
    }
    if (opts.run) {
      releaseShare = await lock(path.join(control, 'runner.lock'));
      progress = new Progress({ cacheRoot, library, resolution, mode: opts.mode });
      await progress.update();
    }
    const shouldStop = async () => stopRequested || !!(progress && await pauseRequested(cacheRoot, progress.state.runId));
    const state = details => progress ? progress.update({ status: 'running', ...details }, { event: false }) : Promise.resolve();
    const onStatus = value => ['needsLogin', 'restoring', 'continuing', 'window', 'loadFailed'].includes(value)
      ? state({ stage: value === 'needsLogin' || value === 'window' ? 'waiting_login' : 'reauthenticating', retryReason: LOGIN_STATUS[value], retryAt: null }) : Promise.resolve();
    const authOptions = { shouldStop, onStatus };
    const token = await authenticate(cacheRoot, false, authOptions), client = new QuixelClient(token);
    const refreshAuth = async () => { client.token = await authenticate(cacheRoot, false, { ...authOptions, refresh: true }); };
    const recovering = (operation, onState = state) => recover(operation, { refreshAuth, shouldStop, onState });
    if (progress) await progress.update({ stage: 'listing' });
    const ids = await recovering(() => client.acquired());
    if (progress) await progress.update({ stage: 'checking', total: ids.length, pending: ids.length });
    const configuration = { library, resolution, mode: opts.mode, policy: DOWNLOAD_POLICY, downloadWorkers, downloadAssets, downloadConnections, prefetchNext: !opts['no-prefetch'],
      maxCacheGb: Number(opts['max-cache-gb']), minFreeGb: Number(opts['min-free-gb']) };
    const configurationFile = path.join(cacheRoot, 'configuration.json');
    let previous = {};
    if (await exists(configurationFile)) {
      previous = JSON.parse(await fs.readFile(configurationFile, 'utf8'));
      if (previous.library !== library || previous.resolution !== resolution || previous.mode !== opts.mode) throw new Error('此缓存任务的目标库、分辨率或导入模式已改变，请保持原参数续跑，或指定新的 --cache');
      if (previous.maxArchiveGb !== undefined) configuration.maxArchiveGb = previous.maxArchiveGb;
    }
    configuration.assetTypes = selectedTypes(opts.types ?? previous.assetTypes);
    configuration.order = configuration.assetTypes;
    if (opts['max-archive-gb'] !== undefined) configuration.maxArchiveGb = Number(opts['max-archive-gb']);
    if (configuration.maxArchiveGb !== undefined && (!Number.isFinite(configuration.maxArchiveGb) || configuration.maxArchiveGb <= 0 || !Number.isSafeInteger(configuration.maxArchiveGb * GIB))) throw new Error('原始归档上限必须为正数GiB');
    if (configuration.maxArchiveGb !== undefined && opts.mode !== 'import') throw new Error('原始归档清理仅支持入库模式');
    const catalog = { version: 1, fetchedAt: new Date().toISOString(), total: ids.length, ids };
    await atomicJson(path.join(cacheRoot, 'catalog.json'), catalog);
    const ordered = await recovering(() => orderedCatalog(ids, { client, cacheRoot, assetTypes: configuration.assetTypes, shouldStop,
      onProgress: details => progress ? progress.update(details, { event: false }) : Promise.resolve() }));
    if (ordered.paused) { if (progress) await progress.update({ status: 'paused', stage: 'stopped' }); return; }
    const eligible = ordered.ids;
    const leftovers = path.join(cacheRoot, 'assets');
    const cached = await exists(leftovers) ? (await fs.readdir(leftovers)).map(storageId) : [];
    if (cached.some(id => !ids.includes(id))) throw new Error('缓存里有不属于当前账号已购库的资产；停止以避免跨账号处理');
    if (cached.some(id => !eligible.includes(id))) throw new Error('未完成缓存包含未选择的类型；请先勾选这些类型完成当前资产，再调整分类。原缓存已保留');
    if (opts.run) await atomicJson(configurationFile, configuration);
    const checked = await checkCompletedReceipts({ ids: eligible, library, resolution, mode: opts.mode, full: !!opts['verify-existing'], shouldStop,
      onProgress: details => progress ? progress.update(details, { event: false }) : Promise.resolve() });
    if (checked.paused) { if (progress) await progress.update({ status: 'paused', stage: 'stopped' }); return; }
    const completedIds = checked.completedIds;
    let completed = completedIds.size;
    const pending = eligible.filter(id => !completedIds.has(id));
    const cacheBytes = await exists(leftovers) ? (await inventory(leftovers, { content: false })).reduce((sum, f) => sum + f.bytes, 0) : 0;
    if (cacheBytes > maxCacheBytes) throw new Error('现有缓存超过上限，请先以原参数续跑或检查失败项');
    console.log(`已购资产 ${ids.length}，所选类型 ${configuration.assetTypes.join(', ')}，队列 ${eligible.length}，有完成回执 ${completed}，待处理 ${pending.length}；${opts['no-prefetch'] ? '串行' : downloadAssets === 2 ? '两项同时下载' : '最多预取下一项'}，共享连接上限 ${downloadConnections}，缓存合计上限 ${opts['max-cache-gb']} GiB，保留空闲 ${opts['min-free-gb']} GiB。`);
    if (!opts.run) { console.log('预检完成，未下载资产。先用 --run --limit 1 验证一项，再 --run 全量执行。'); return; }
    await progress.update({ completed, skipped: completed, pending: pending.length });
    const archiveBudget = configuration.maxArchiveGb !== undefined ? await createArchiveBudget({ library, maxBytes: configuration.maxArchiveGb * GIB, shouldStop,
      onProgress: async details => {
        await progress.update({ stage: 'archive_retention', ...details }, { event: false });
        console.log(`[归档容量] ${(details.archiveBytes / GIB).toFixed(2)}/${configuration.maxArchiveGb} GiB；已清理 ${details.prunedAssets} 项；回收 ${(details.reclaimedBytes / GIB).toFixed(2)} GiB`);
      } }) : null;
    const eligiblePending = eligible.filter(id => !completedIds.has(id));
    completed = eligible.length - eligiblePending.length;
    await progress.update({ stage: 'ready', total: eligible.length, acquiredTotal: ids.length, acquiredDuplicates: client.acquiredStats.duplicates,
      excluded: ordered.excluded, unavailable: ordered.unavailable, assetTypes: configuration.assetTypes, typeCounts: ordered.counts, completed, skipped: completed, pending: eligiblePending.length, downloadWorkers, downloadAssets, downloadConnections });
    // Failed/interrupted caches stay first unless saved as pending retry.
    const transferOptions = { client, library, cacheRoot, resolution, maxCacheBytes, reserveBytes, downloadWorkers, mode: opts.mode, importer: job => importWorker.run(job),
      ...(archiveBudget ? { beforeArchive: details => archiveBudget.reserve(details) } : {}) };
    const orderedCached = await cachedOrder(cached, transferOptions);
    const deferredRecord = await readDeferred(transferOptions);
    const remaining = remainingQueue({ eligible, completedIds, orderedCached, record: deferredRecord });
    const queue = remaining.queue.slice(0, limit);
    await progress.update({ deferred: remaining.deferredIds.length, deferredIds: remaining.deferredIds });
    console.log(`待重试 ${remaining.deferredIds.length} 项：${remaining.deferredIds.join(', ') || '无'}；本轮可继续 ${remaining.queue.length} 项。`);
    let count = 0, handled = 0;
    await runPipeline({ ids: queue, options: transferOptions, prefetch: !opts['no-prefetch'], downloadAssets, downloadConnections, shouldStop,
      execute: (operation, controls) => recover(operation, { ...controls,
        shouldDefer: error => isolatedAssetFailure({ client, id: controls.id, error, controlIds: completedIds, resolution, shouldStop: controls.shouldStop }),
        refreshAuth: async () => {
        client.token = await authenticate(cacheRoot, false, { ...authOptions, refresh: true, shouldStop: controls.shouldStop });
      } }),
      onPromote: async (id, details) => {
        console.log(`[总进度] ${completed}/${eligible.length}；当前 ${id} (${ordered.types[id]})；并发 ${downloadWorkers}`);
        await progress.update({ prefetch: null });
        await progress.asset(id, details);
      },
      onProgress: (id, details, primary) => primary ? progress.asset(id, { retryAt: null, retryReason: '', ...details }) : progress.prefetch(id, details),
      onCompleted: async (id, receipt) => {
        archiveBudget?.completed(receipt);
        count++; handled++; completedIds.add(id);
        if (eligiblePending.includes(id)) completed++;
        await progress.update({ completed, processedThisRun: count, pending: eligible.length - completed });
      },
      onDeferred: async (id, error) => {
        const message = safeError(error);
        await setDeferred(transferOptions, { id, automatic: true, retainedCache: await exists(await cachePath(cacheRoot, id)), reason: message, httpStatus: error.status, retryAttempts: error.retryAttempts });
        handled++;
        if (!remaining.deferredIds.includes(id)) remaining.deferredIds.push(id);
        await progress.asset(id, { status: 'deferred', stage: 'deferred', error: message, retryAt: null, retryReason: '' });
        await progress.update({ deferred: remaining.deferredIds.length, deferredIds: [...remaining.deferredIds], lastDeferred: { id, reason: message, httpStatus: error.status, retryAttempts: error.retryAttempts, at: new Date().toISOString() } });
        console.log(`[暂存待重试，继续下一项] ${id}；HTTP ${error.status}；${message}`);
      }
    });
    const awaitingRetry = !await shouldStop() && handled === remaining.queue.length && remaining.deferredIds.length > 0;
    await progress.update({ status: completed === eligible.length ? 'completed' : awaitingRetry ? 'pending_retry' : 'paused', stage: completed === eligible.length ? 'done' : awaitingRetry ? 'awaiting_retry' : 'stopped' });
    console.log(`本次处理 ${count} 项。AssetHive 中刷新资源库即可看到已入库资产。`);
  } catch (error) {
    if (error.code === 'MEGASCANS_PAUSED') { if (progress) await progress.update({ status: 'paused', stage: 'stopped', retryAt: null }); return; }
    if (progress) await progress.failed(error).catch(() => {});
    throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    try {
      await importWorker.close();
      if (progress) await progress.flush();
    } finally {
      try { if (releaseShare) await releaseShare(); }
      finally { await releaseLocal(); }
    }
  }
}

if (require.main === module) main().catch(error => { console.error(`[已停止] ${error.message}`); process.exitCode = 1; });
module.exports = { main, importAsset, lock, authenticate };
