const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicJson, inventory, exists, freeBytes, transferOne, downloadFile } = require('./megascans-transfer.cjs');
const { paused } = require('./megascans-recovery.cjs');
const { context, readDeferred } = require('./megascans-deferred.cjs');
const { storageId } = require('./megascans-paths.cjs');

const delay = ms => new Promise(resolve => globalThis.setTimeout(resolve, ms));

async function cachedOrder(cached, options) {
  const deferred = await readDeferred(options);
  const retained = deferred.items.filter(item => item.retainedCache).map(item => item.id);
  const activeCached = cached.filter(id => !retained.includes(id));
  const file = path.join(options.cacheRoot, 'pipeline.json');
  if (!await exists(file)) {
    if (activeCached.length > 1) throw new Error('多个缓存没有流水线恢复记录，停止并保留文件');
    return [...retained.filter(id => cached.includes(id)), ...activeCached];
  }
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  if (record.version !== 1 || JSON.stringify(record.context) !== JSON.stringify(context(options)) || !Array.isArray(record.ids)
    || record.ids.length > 2 || new Set(record.ids).size !== record.ids.length || activeCached.some(id => !record.ids.includes(id))) throw new Error('流水线恢复记录与缓存不匹配，停止并保留文件');
  return [...retained.filter(id => cached.includes(id)), ...record.ids.filter(id => cached.includes(id) && !retained.includes(id))];
}

async function runPipeline({ ids, options, prefetch = true, downloadAssets = 1, downloadConnections = options.downloadWorkers || 4, checkFree = freeBytes, shouldStop = async () => false, transfer = transferOne,
  execute = operation => operation(), onProgress = async () => {}, onPromote = async () => {}, onCompleted = async () => {}, onDeferred }) {
  if (![1, 2].includes(downloadAssets) || !Number.isInteger(downloadConnections) || downloadConnections < 1 || downloadConnections > 8) throw new Error('下载资产数应为1–2，总下载连接数应为1–8');
  const tasks = new Map(), reservations = new Map();
  const waitingDownloads = [];
  let activeDownloads = 0;
  const withDownloadSlot = async operation => {
    if (activeDownloads >= downloadConnections) await new Promise(resolve => waitingDownloads.push(resolve));
    else activeDownloads++;
    try { return await operation(); }
    finally { if (waitingDownloads.length) waitingDownloads.shift()(); else activeDownloads--; }
  };
  let stopping = false, position = 0, writes = Promise.resolve(), admission = Promise.resolve();
  const checkAdmission = operation => {
    const result = admission.then(operation);
    admission = result.catch(() => {});
    return result;
  };
  const stop = async () => stopping || await shouldStop();
  const persist = () => {
    const record = { version: 1, context: context(options), ids: [...tasks.keys()], updatedAt: new Date().toISOString() };
    writes = writes.then(() => atomicJson(path.join(options.cacheRoot, 'pipeline.json'), record));
    return writes;
  };
  const start = async (id, primary) => {
    let ready, release, admitted;
    const task = { id, primary, ready: new Promise(resolve => { ready = resolve; }), admitted: new Promise(resolve => { admitted = resolve; }), gate: new Promise(resolve => { release = resolve; }), release,
      latest: { status: 'running', stage: 'planning', startedAt: new Date().toISOString() } };
    tasks.set(id, task);
    await persist(); // Durable membership precedes creating any second cache.
    if (primary) { await onPromote(id, task.latest); task.release(); }
    const report = async details => {
      Object.assign(task.latest, details);
      delete task.latest.byteUpdate;
      await onProgress(id, details, task.primary);
    };
    task.result = execute(() => transfer({ ...options, id, onProgress: report,
      download: (entry, directory, settings) => withDownloadSlot(async () => {
        if (!task.primary && await stop()) throw paused();
        return (options.download || downloadFile)(entry, directory, settings);
      }),
      reserveCache: async required => {
        let waiting = false;
        for (;;) {
          if (!task.primary && await stop()) throw paused();
          const accepted = await checkAdmission(async () => {
            const root = path.join(options.cacheRoot, 'assets');
            let files;
            try { files = await exists(root) ? await inventory(root, { content: false }) : []; }
            catch (error) { if (error.code === 'ENOENT') return false; throw error; }
            // Existing interrupted files not yet reserved also consume the budget.
            const outside = files.filter(file => {
              const owner = storageId(file.file.split('/')[0]);
              return owner !== id && !reservations.has(owner);
            }).reduce((sum, file) => sum + file.bytes, 0);
            const held = [...reservations].filter(([owner]) => owner !== id).reduce((sum, [, bytes]) => sum + bytes, 0);
            const ownBytes = files.filter(file => storageId(file.file.split('/')[0]) === id).reduce((sum, file) => sum + file.bytes, 0);
            const otherRemaining = [...reservations].filter(([owner]) => owner !== id).reduce((sum, [owner, reserved]) =>
              sum + Math.max(0, reserved - files.filter(file => storageId(file.file.split('/')[0]) === owner).reduce((bytes, file) => bytes + file.bytes, 0)), 0);
            const free = await checkFree(options.cacheRoot);
            if (held + outside + required <= options.maxCacheBytes && free >= (options.reserveBytes || 0) + Math.max(0, required - ownBytes) + otherRemaining) {
              reservations.set(id, required); admitted(); return true;
            }
            return false;
          });
          if (accepted) return;
          if (task.primary) throw new Error('当前资产与残留缓存合计超过缓存预算，停止并保留文件');
          if (!waiting) { await report({ stage: 'waiting_capacity', requiredBytes: required }); waiting = true; }
          await delay(200);
        }
      },
      beforeArchive: async details => {
        ready();
        if (!task.primary) await report({ stage: 'prefetched' });
        await task.gate;
        if (!task.primary || stopping) throw paused();
        await options.beforeArchive?.(details);
      },
      shouldStopDownload: async () => !task.primary && await stop()
    }), { id, shouldStop: stop, onState: details => report({ status: 'running', ...details }) })
      .then(value => { reservations.delete(id); return { value }; }, error => { task.error = error; return { error }; })
      .finally(() => { admitted(); ready(); });
    return task;
  };
  let current, next;
  try {
    while (current || position < ids.length) {
      if (!current) {
        if (await stop()) break;
        current = await start(ids[position++], true);
      }
      // Admit the foreground first so an early prefetch cannot consume its
      // space. Two assets may share the same bounded, fair download pool.
      if (downloadAssets === 2) await current.admitted;
      else await current.ready;
      if (!current.error && prefetch && position < ids.length && !await stop()) next = await start(ids[position++], false);
      const result = await current.result;
      if (result.error) {
        if (result.error.code !== 'MEGASCANS_DEFER_ASSET' || !onDeferred) throw result.error;
        if (await stop()) throw paused();
        // Persist independent recovery membership before overwriting pipeline
        // order. Failed bytes remain on disk and count against later admission.
        await onDeferred(current.id, result.error);
        reservations.delete(current.id);
      }
      tasks.delete(current.id);
      await persist();
      if (!result.error) await onCompleted(current.id, result.value);
      if (await stop()) break;
      current = next;
      next = null;
      if (current) {
        current.primary = true;
        await onPromote(current.id, current.latest);
        current.release();
      }
    }
  } finally {
    stopping = true;
    for (const task of tasks.values()) task.release();
    // Includes downloads, retries, capacity waits and gated publication. No
    // background writer may survive release of either runner lock.
    await Promise.all([...tasks.values()].map(task => task.result));
    for (const task of tasks.values()) if (!task.primary) {
      try { await onProgress(task.id, { status: task.error?.code === 'MEGASCANS_PAUSED' ? 'paused' : 'failed' }, false); } catch { /* Preserve the primary error if the progress store is also unavailable. */ }
    }
  }
}

module.exports = { cachedOrder, runPipeline };
