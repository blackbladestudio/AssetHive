const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs, promisify } = require('node:util');
const gunzip = promisify(require('node:zlib').gunzip);
const { FabMegascans, existingIds, downloadFabFile, applyListingExclusions } = require('./lib/fab-megascans.cjs');
const { GIB, atomicJson, exists, inside, transferOne, verifyReceipt } = require('./lib/megascans-transfer.cjs');
const { lock } = require('./megascans-runner.cjs');
const { ImportWorker } = require('./lib/megascans-import-worker.cjs');
const { Progress, safeError } = require('./lib/megascans-progress.cjs');
const { pauseRequested } = require('./lib/megascans-control.cjs');
const { createArchiveBudget } = require('./lib/megascans-archive-retention.cjs');
const { recover } = require('./lib/megascans-recovery.cjs');

async function readLibraryIndex(library) {
  let compressed;
  try { compressed = await fs.readFile(path.join(library, '.assethive', 'custom-index.json.gz')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return JSON.parse(await fs.readFile(path.join(library, '.assethive', 'custom-index.json'), 'utf8'));
  }
  return JSON.parse((await gunzip(compressed, { maxOutputLength: 512 * 1024 * 1024 })).toString('utf8'));
}

async function main(argv = process.argv.slice(2)) {
  const { values: opts } = parseArgs({ args: argv, options: {
    run: { type: 'boolean' }, 'accept-eula': { type: 'boolean' }, refresh: { type: 'boolean' },
    library: { type: 'string', default: '\\\\fileshare\\share\\Artist\\AssetLibrary' },
    cache: { type: 'string', default: path.resolve(__dirname, '../.cache/fab-megascans') },
    limit: { type: 'string' }, 'max-cache-gb': { type: 'string', default: '8' },
    'min-free-gb': { type: 'string', default: '10' }, 'max-archive-gb': { type: 'string', default: '50' },
    'download-workers': { type: 'string', default: '4' }
  } });
  const library = path.resolve(opts.library), cacheRoot = path.resolve(opts.cache);
  const maxCacheGb = Number(opts['max-cache-gb']), minFreeGb = Number(opts['min-free-gb']), maxArchiveGb = Number(opts['max-archive-gb']);
  const downloadWorkers = Number(opts['download-workers']), limit = opts.limit === undefined ? Infinity : Number(opts.limit);
  if (![maxCacheGb, maxArchiveGb].every(value => Number.isFinite(value) && value > 0 && Number.isSafeInteger(value * GIB))
    || !Number.isFinite(minFreeGb) || minFreeGb < 0 || !Number.isInteger(downloadWorkers) || downloadWorkers < 1 || downloadWorkers > 8
    || !(limit > 0) || limit !== Infinity && !Number.isInteger(limit)) throw new Error('下载参数无效');
  if (inside(library, cacheRoot) || inside(cacheRoot, library)) throw new Error('缓存和共享库不能相互包含');
  await fs.mkdir(cacheRoot, { recursive: true });
  const releaseLocal = await lock(path.join(cacheRoot, 'runner.lock'));
  let releaseShare, progress, stopped = false;
  const worker = new ImportWorker({ cacheRoot });
  const client = new FabMegascans(cacheRoot);
  const stop = () => { stopped = true; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const consentFile = path.join(cacheRoot, 'eula-consent.json');
    if (opts['accept-eula']) await atomicJson(consentFile, { acceptedAt: new Date().toISOString(), url: 'https://www.fab.com/eula', scope: 'free-quixel-megascans', userConfirmed: true });
    if (opts.run && !(await exists(consentFile))) throw new Error('首次下载须由用户确认 Fab EULA，确认后传 --accept-eula');
    const index = await readLibraryIndex(library);
    const known = existingIds(index);
    // A newly published asset can precede the desktop index refresh.
    const receiptsRoot = path.join(library, '.megascans', 'receipts');
    if (await exists(receiptsRoot)) for (const name of await fs.readdir(receiptsRoot)) {
      if (!name.endsWith('.json')) continue;
      const receipt = JSON.parse(await fs.readFile(path.join(receiptsRoot, name), 'utf8'));
      if (!receipt.imported || known.has(receipt.id)) continue;
      await verifyReceipt(library, receipt, receipt.id, { content: false });
      known.set(receipt.id, [path.resolve(library, receipt.imported.root, 'asset_info.json')]);
    }
    if (opts.run) {
      releaseShare = await lock(path.join(library, '.megascans', 'runner.lock'));
      progress = new Progress({ cacheRoot, library, resolution: 4096, mode: 'import' });
      await progress.update({ source: 'fab', stage: 'listing' });
    }
    const shouldStop = async () => stopped || !!(progress && await pauseRequested(cacheRoot, progress.state.runId));
    const catalogFile = path.join(cacheRoot, 'free-catalog.json');
    let listings;
    if (!opts.refresh && await exists(catalogFile)) {
      const saved = JSON.parse(await fs.readFile(catalogFile, 'utf8'));
      if (saved.items?.every(item => item.sourceId || item.unsupported || item.excludedSourceType || !['3d-model', 'material', 'decal'].includes(item.listingType))) listings = saved.items;
    }
    if (!listings) listings = await client.catalog(async details => {
      if (await shouldStop()) throw Object.assign(new Error('已暂停清单整理'), { code: 'FAB_PAUSED' });
      await atomicJson(path.join(cacheRoot, 'inventory-progress.json'), { ...details, updatedAt: new Date().toISOString() });
      if (progress) await progress.update(details, { event: false });
    });
    const bundleExclusions = path.join(cacheRoot, 'bundle-exclusions.json');
    if (await exists(bundleExclusions)) listings = applyListingExclusions(listings, JSON.parse(await fs.readFile(bundleExclusions, 'utf8')));
    const matureExclusions = path.join(cacheRoot, 'mature-exclusions.json');
    if (await exists(matureExclusions)) listings = applyListingExclusions(listings, JSON.parse(await fs.readFile(matureExclusions, 'utf8')));
    const unique = new Map();
    for (const listing of listings) if (listing.sourceId && !listing.excludedSourceType && !unique.has(listing.sourceId)) unique.set(listing.sourceId, listing);
    const duplicates = [], queue = [];
    for (const listing of unique.values()) {
      const matches = known.get(listing.sourceId);
      if (matches) {
        for (const file of matches) {
          if (!inside(library, file) || !await exists(file)) throw new Error(`索引引用已失效，先刷新库索引：${listing.sourceId}`);
        }
        duplicates.push({ sourceId: listing.sourceId, listingId: listing.uid, metaPaths: matches });
      } else queue.push(listing);
    }
    const order = { '3d-model': 0, material: 1, decal: 2 };
    queue.sort((left, right) => order[left.listingType] - order[right.listingType]);
    const summary = { checkedAt: new Date().toISOString(), libraryIndexAt: index.generatedAt, freeListings: listings.length,
      eligible: unique.size, duplicates: duplicates.length, pending: queue.length,
      unsupported: listings.filter(item => item.unsupported), excluded: listings.filter(item => item.excludedSourceType || !item.sourceId && !item.unsupported).length };
    await atomicJson(path.join(cacheRoot, 'deduplication.json'), { ...summary, skipped: duplicates, queue });
    console.log(JSON.stringify({ ...summary, unsupported: summary.unsupported.length }));
    if (!opts.run) return;
    await atomicJson(path.join(cacheRoot, 'configuration.json'), { source: 'fab', library, resolution: 4096, mode: 'import',
      assetTypes: ['3d', 'surface', 'decal'], downloadWorkers, maxCacheGb, minFreeGb, maxArchiveGb });
    await progress.update({ total: unique.size, completed: duplicates.length, skipped: duplicates.length, pending: queue.length,
      acquiredTotal: listings.length, source: 'fab', stage: 'ready', deferred: 0, deferredIds: [] });
    const budget = await createArchiveBudget({ library, maxBytes: maxArchiveGb * GIB, shouldStop,
      onProgress: details => progress.update(details, { event: false }) });
    let processed = 0, resolvedDuplicates = 0, excludedByMetadata = 0, notFree = 0;
    const controls = [...unique.values()].filter(listing => known.has(listing.sourceId));
    const deferred = [];
    const exclusions = [];
    const pricedOut = [];
    await atomicJson(path.join(cacheRoot, 'deferred.json'), { items: [] });
    await atomicJson(path.join(cacheRoot, 'not-free.json'), { items: [] });
    const saveIdentity = async (listing, id) => {
      if (listing.sourceId === id) return;
      listing.fabSourceId ||= listing.sourceId;
      listing.sourceId = id;
      await atomicJson(catalogFile, { fetchedAt: new Date().toISOString(), items: listings });
    };
    const updateCounts = () => progress.update({ total: unique.size - excludedByMetadata - notFree,
      completed: duplicates.length + resolvedDuplicates + processed, skipped: duplicates.length + resolvedDuplicates,
      processedThisRun: processed, pending: queue.length - processed - resolvedDuplicates - excludedByMetadata - notFree,
      excludedByMetadata, notFree });
    for (const listing of queue.slice(0, limit)) {
      if (await shouldStop()) break;
      await progress.update({ stage: 'planning', current: { id: listing.sourceId, status: 'running', stage: 'planning', title: listing.title } });
      try {
        const result = await recover(async () => {
          const plan = await client.plan(listing, { knownIds: known }), id = plan.meta.id;
          await saveIdentity(listing, id);
          if (known.has(id)) {
            for (const file of known.get(id)) if (!inside(library, file) || !await exists(file)) throw new Error(`索引引用已失效，先刷新库索引：${id}`);
            return { duplicate: true };
          }
          await progress.update({ current: { ...progress.state.current, id } });
          const receipt = await transferOne({ id, client: { plan: async () => plan }, library, cacheRoot,
          resolution: 4096, maxCacheBytes: maxCacheGb * GIB, reserveBytes: minFreeGb * GIB, mode: 'import',
          downloadWorkers, download: downloadFabFile,
          importer: job => worker.run({ ...job, downloadSource: 'fab', removePreviewBackground: true }),
          beforeArchive: details => budget.reserve(details),
          onProgress: details => progress.update({ ...(details.stage ? { stage: details.stage } : {}), current: { ...progress.state.current, ...details } }, { event: false }) });
          return { receipt };
        }, {
          shouldStop,
          onState: details => progress.update({ ...details, current: { ...progress.state.current, ...details } }),
          shouldDefer: async error => {
            if (error.code === 'FAB_MATURE_SKIPPED') return false;
            if (!['fab', 'cdn'].includes(error.source)) return false;
            for (const control of controls.slice(-2).reverse()) {
              if (control.sourceId === listing.sourceId || await shouldStop()) continue;
              try { await client.plan(control); return true; } catch { /* No proof of an isolated failure. */ }
            }
            return false;
          }
        });
        if (result.duplicate) { resolvedDuplicates++; console.log(`[源 ID 去重跳过] ${listing.sourceId}`); }
        else {
          budget.completed(result.receipt); processed++; controls.push(listing);
          if (result.receipt.imported) known.set(listing.sourceId, [path.resolve(library, result.receipt.imported.root, 'asset_info.json')]);
        }
        await updateCounts();
      } catch (error) {
        // Non-free licenses are outside this run, but are checked again on a
        // future run. Do not permanently blacklist a staged price rollout.
        if (error.code === 'FAB_NOT_FREE') {
          notFree++;
          pricedOut.push({ id: listing.sourceId, listingId: listing.uid, title: listing.title, reason: safeError(error), at: new Date().toISOString() });
          await atomicJson(path.join(cacheRoot, 'not-free.json'), { items: pricedOut });
          console.log(`[尚未免费] ${listing.sourceId}：${safeError(error)}`);
          await updateCounts();
          continue;
        }
        // Only an item-specific format/type/availability failure is deferred.
        // Storage, integrity, auth, throttling and general network failures stop.
        if (['FAB_EXCLUDED', 'FAB_MATURE_SKIPPED'].includes(error.code)) {
          if (error.nativeId) await saveIdentity(listing, error.nativeId);
          listing.excludedSourceType = error.assetType;
          await atomicJson(catalogFile, { fetchedAt: new Date().toISOString(), items: listings });
          excludedByMetadata++;
          exclusions.push({ id: listing.sourceId, listingId: listing.uid, assetType: error.assetType, reason: safeError(error) });
          await atomicJson(path.join(cacheRoot, 'excluded.json'), { items: exclusions });
          console.log(`[类型排除] ${listing.sourceId}：${safeError(error)}`);
          await updateCounts();
          continue;
        }
        if (!['FAB_UNSUPPORTED', 'MEGASCANS_DEFER_ASSET'].includes(error.code) && ![404, 410].includes(error.status)) throw error;
        deferred.push({ id: listing.sourceId, listingId: listing.uid, reason: safeError(error), source: error.source, endpoint: error.endpoint, at: new Date().toISOString() });
        await atomicJson(path.join(cacheRoot, 'deferred.json'), { items: deferred });
        await progress.update({ deferred: deferred.length, deferredIds: deferred.map(item => item.id) });
      }
    }
    const paused = await shouldStop(), remaining = queue.length - processed - resolvedDuplicates - excludedByMetadata - notFree;
    await progress.update({ status: paused || limit < queue.length ? 'paused' : remaining ? 'pending_retry' : 'completed',
      stage: paused ? 'paused' : remaining ? 'awaiting_retry' : 'done', pending: remaining, current: null });
  } catch (error) {
    await atomicJson(path.join(cacheRoot, 'last-error.json'), { at: new Date().toISOString(), code: error.code,
      message: safeError(error), file: error.file, stack: safeError(error.stack) }).catch(() => {});
    if (progress) await progress.update({ status: ['FAB_PAUSED', 'MEGASCANS_PAUSED'].includes(error.code) ? 'paused' : 'failed', stage: 'stopped', error: safeError(error) });
    throw error;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    try {
      try { await client.close(); }
      finally { await worker.close(); if (progress) await progress.flush(); }
    }
    finally { try { if (releaseShare) await releaseShare(); } finally { await releaseLocal(); } }
  }
}

if (require.main === module) main().catch(error => { console.error(`[已停止] ${safeError(error)}`); process.exitCode = 1; });
module.exports = { main };
