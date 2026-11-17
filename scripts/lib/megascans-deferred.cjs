const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicJson, assetId, DOWNLOAD_POLICY } = require('./megascans-transfer.cjs');
const { safeError } = require('./megascans-progress.cjs');

const context = ({ library, resolution, mode }) => ({ library, resolution, mode, policy: DOWNLOAD_POLICY });

async function readDeferred(options) {
  let record;
  try { record = JSON.parse(await fs.readFile(path.join(options.cacheRoot, 'deferred.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, context: context(options), items: [] }; throw error; }
  if (record.version !== 1 || JSON.stringify(record.context) !== JSON.stringify(context(options)) || !Array.isArray(record.items)
    || new Set(record.items.map(item => item.id)).size !== record.items.length) throw new Error('待重试记录与任务不匹配，停止并保留文件');
  for (const item of record.items) {
    assetId(item.id);
    if (!['deferred', 'retry'].includes(item.state) || typeof item.retainedCache !== 'boolean') throw new Error('待重试记录无效，停止并保留文件');
  }
  return record;
}

// Caller holds both runner locks. Keep recovery membership after restoring an
// item: pipeline.json may already have been replaced by the continuing queue.
async function setDeferred(options, { id, restore = false, retainedCache = false, reason = '', automatic = false, httpStatus, retryAttempts }) {
  assetId(id);
  const record = await readDeferred(options);
  let item = record.items.find(entry => entry.id === id);
  if (restore && !item) throw new Error('此资产没有待重试记录');
  if (!item) { item = { id, retainedCache, deferredAt: new Date().toISOString() }; record.items.push(item); }
  Object.assign(item, { state: restore ? 'retry' : 'deferred', updatedAt: new Date().toISOString() });
  if (!restore) {
    item.retainedCache ||= retainedCache; item.reason = safeError(reason);
    Object.assign(item, { automatic, ...(httpStatus ? { httpStatus } : {}), ...(retryAttempts ? { retryAttempts } : {}) });
  }
  await atomicJson(path.join(options.cacheRoot, 'deferred.json'), record);
  await atomicJson(path.join(options.library, '.megascans', 'deferred.json'), record);
  return record;
}

function remainingQueue({ eligible, completedIds, orderedCached, record }) {
  const pending = eligible.filter(id => !completedIds.has(id));
  const deferredIds = record.items.filter(item => item.state === 'deferred' && pending.includes(item.id)).map(item => item.id);
  const deferred = new Set(deferredIds);
  const cached = new Set(orderedCached);
  return { deferredIds, queue: [...orderedCached.filter(id => !deferred.has(id)), ...pending.filter(id => !cached.has(id) && !deferred.has(id))] };
}

module.exports = { context, readDeferred, setDeferred, remainingQueue };
