const fs = require('node:fs/promises');
const { Buffer } = require('node:buffer');
const { createReadStream } = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const { analyzeFbxInWorker } = require('./modelAnalysis');
const { readCharacterFbxAxes } = require('../../shared/characterFbxAxes.mjs');

// Character-only cache. Validate the file stamp on every use; failed reads are not cached.
const hashes = new Map();
const analyses = new Map();
const active = new Set();
let cleanupBarrier = Promise.resolve();
function tracked(operation) {
  return (...args) => {
    const task = cleanupBarrier.then(() => operation(...args));
    active.add(task);
    void task.finally(() => active.delete(task)).catch(() => {});
    return task;
  };
}
// Local derived data only: survive preview/application restarts without modifying the library.
// Bump this version when model inspection semantics change.
const cacheRoot = process.env.ASSETHIVE_CHARACTER_INSPECTION_CACHE || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'AssetHive', 'CharacterInspection', 'v3');
const cacheKey = value => crypto.createHash('sha256').update(value).digest('hex');
async function readCache(kind, key) {
  try { return JSON.parse(await fs.readFile(path.join(cacheRoot, `${kind}-${key}.json`), 'utf8')); } catch { return null; }
}
async function writeCache(kind, key, value) {
  const target = path.join(cacheRoot, `${kind}-${key}.json`);
  const temporary = target + '.' + crypto.randomUUID() + '.tmp';
  try {
    await fs.mkdir(cacheRoot, { recursive: true });
    await fs.writeFile(temporary, JSON.stringify(value));
    await fs.rename(temporary, target);
  } catch { await fs.unlink(temporary).catch(() => {}); }
}
const stamp = info => `${info.size}|${info.mtimeMs}|${info.ctimeMs}|${info.ino}`;
function remember(cache, key, value) {
  cache.delete(key); cache.set(key, value);
  if (cache.size > 256) cache.delete(cache.keys().next().value);
  return value;
}
async function inspectCharacterFile(filePath) {
  const file = await fs.realpath(filePath);
  const info = await fs.stat(file);
  if (!info.isFile()) throw new Error('管理文件不可读取：' + filePath);
  const signature = stamp(info);
  const old = hashes.get(file);
  if (old?.signature === signature) return old.value;
  const diskKey = cacheKey(file);
  const stored = await readCache('file', diskKey);
  if (stored?.signature === signature && stored.value?.sourcePath === file && /^[a-f0-9]{64}$/.test(stored.value.sourceHash)) {
    remember(hashes, file, stored);
    return stored.value;
  }
  const digest = crypto.createHash('sha256');
  // Node's 64 KiB default causes thousands of serial read requests for large
  // FBX/TGA files on SMB. Four bounded export readers use at most 16 MiB here.
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) digest.update(chunk);
  if (stamp(await fs.stat(file)) !== signature) throw new Error('文件正在变化，请重新检查：' + filePath);
  const value = { sourcePath: file, sourceHash: digest.digest('hex') };
  remember(hashes, file, { signature, value });
  await writeCache('file', diskKey, { signature, value });
  return value;
}
async function inspectCharacterModel(filePath, analyze = analyzeFbxInWorker) {
  const source = await inspectCharacterFile(filePath);
  if (!analyses.has(analyze)) analyses.set(analyze, new Map());
  const cache = analyses.get(analyze);
  // File names change during managed copies; FBX geometry/material/bone data does not.
  const key = analyze === analyzeFbxInWorker ? source.sourceHash : `${source.sourceHash}|${path.basename(source.sourcePath)}`;
  if (cache.has(key)) return cache.get(key);
  if (analyze === analyzeFbxInWorker) {
    const stored = await readCache('model', key);
    if (stored?.sourceHash === key && stored.result?.meshKind && !stored.result.error) return remember(cache, key, stored.result);
  }
  const result = await analyze(source.sourcePath, { geometryOnlyTextures: true });
  if (result.error) return result;
  const handle = await fs.open(source.sourcePath, 'r');
  try {
    const buffer = Buffer.alloc(131072);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    result.sourceAxes = readCharacterFbxAxes(buffer.subarray(0, bytesRead));
  } finally { await handle.close(); }
  const after = await inspectCharacterFile(filePath);
  if (after.sourceHash !== source.sourceHash) throw new Error('模型正在变化，请重新检查');
  if (analyze === analyzeFbxInWorker) await writeCache('model', key, { sourceHash: key, result });
  return remember(cache, key, result);
}
async function inspectCharacterNormalAlpha(source, check, persistent = false) {
  if (persistent) {
    const stored = await readCache('normal-alpha', source.sourceHash);
    if (typeof stored?.hasAlpha === 'boolean') return stored.hasAlpha;
  }
  const hasAlpha = await check(source.sourcePath);
  if ((await inspectCharacterFile(source.sourcePath)).sourceHash !== source.sourceHash) throw new Error('贴图正在变化，请重新检查');
  if (persistent && typeof hasAlpha === 'boolean') await writeCache('normal-alpha', source.sourceHash, { hasAlpha });
  return hasAlpha;
}
// Let the OS copy to SMB in large native transfers. Small Node stream writes
// multiply network round trips. Hash the stable source locally and reuse that
// fingerprint for the completed destination instead of rereading it over SMB.
async function copyCharacterFile(sourcePath, destinationPath) {
  const source = await fs.realpath(sourcePath);
  const before = await fs.stat(source);
  const existingDestination = await fs.realpath(destinationPath).catch(error => { if (error.code === 'ENOENT') return path.resolve(destinationPath); throw error; });
  const existingInfo = await fs.stat(existingDestination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (source.toLowerCase() === existingDestination.toLowerCase() || (existingInfo && before.ino && before.dev === existingInfo.dev && before.ino === existingInfo.ino)) {
    throw new Error('导入源文件与管理副本不能相同');
  }
  const results = await Promise.allSettled([
    fs.copyFile(source, destinationPath),
    inspectCharacterFile(source)
  ]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  if (stamp(await fs.stat(source)) !== stamp(before)) throw new Error('复制期间源文件已变化，请重新导入');
  const destination = await fs.realpath(destinationPath);
  const info = await fs.stat(destination);
  if (info.size !== before.size) throw new Error('管理副本大小不一致，请重新导入');
  const value = { sourcePath: destination, sourceHash: results[1].value.sourceHash };
  const entry = { signature: stamp(info), value };
  remember(hashes, destination, entry);
  await writeCache('file', cacheKey(destination), entry);
  return value;
}
function clearCharacterInspection({ paths, assetPath, contentHashes = [] }) {
  const previous = [...active];
  const job = cleanupBarrier.then(async () => {
    await Promise.allSettled(previous);
    const normalized = value => path.resolve(value).toLowerCase();
    const canonicalPaths = await Promise.all(paths.map(file => fs.realpath(file).catch(() => file)));
    const sources = new Set([...paths, ...canonicalPaths].map(normalized));
    const folder = normalized(assetPath) + path.sep;
    const matches = value => sources.has(normalized(value)) || normalized(value).startsWith(folder);
    const digests = new Set(contentHashes);
    for (const [file, entry] of hashes) if (matches(file)) { hashes.delete(file); digests.add(entry.value.sourceHash); }
    for (const name of await fs.readdir(cacheRoot).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
      if (!/^file-[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = path.join(cacheRoot, name);
      const entry = JSON.parse(await fs.readFile(file, 'utf8'));
      if (entry.value?.sourcePath && matches(entry.value.sourcePath)) {
        digests.add(entry.value.sourceHash); await fs.unlink(file);
      }
    }
    for (const cache of analyses.values()) for (const key of cache.keys()) if (digests.has(key.split('|')[0])) cache.delete(key);
    for (const digest of digests) if (/^[a-f0-9]{64}$/.test(digest)) for (const kind of ['model', 'normal-alpha']) {
      await fs.unlink(path.join(cacheRoot, `${kind}-${digest}.json`)).catch(e => { if (e.code !== 'ENOENT') throw e; });
    }
  });
  cleanupBarrier = job.catch(() => {});
  return job;
}
module.exports = { inspectCharacterFile: tracked(inspectCharacterFile), inspectCharacterModel: tracked(inspectCharacterModel),
  inspectCharacterNormalAlpha: tracked(inspectCharacterNormalAlpha), copyCharacterFile: tracked(copyCharacterFile), clearCharacterInspection };
