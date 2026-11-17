const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Buffer } = require('node:buffer');
const { createReadStream, createWriteStream } = require('node:fs');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { performance } = require('node:perf_hooks');
const { materialPreview } = require('../../electron/services/megascansPreview');
const { transient } = require('./megascans-recovery.cjs');
const { paused } = require('./megascans-recovery.cjs');
const { assetId, receiptPath: resolveReceiptPath, cachePath } = require('./megascans-paths.cjs');
const { readJson } = require('./megascans-json.cjs');

const API = 'https://quixel.com/v1/';
const GIB = 1024 ** 3;
const DOWNLOAD_POLICY = { version: 3, model3d: 'highpoly-fbx-only', maxTexture3d: 4096, maxTextureSurface: 4096, maxTextureDecal: 4096, textureFormat: 'png-preferred-jpg-source', exr: false };

function inside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

async function exists(file) {
  try { await fs.stat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx' });
    await renameWithRetry(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}

async function renameWithRetry(source, destination) {
  // SMB readers / antivirus can temporarily deny a Windows rename. Keep the
  // old durable destination in place until an atomic replacement succeeds.
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(source, destination); return; }
    catch (error) {
      if (attempt >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await new Promise(resolve => globalThis.setTimeout(resolve, Math.min(2000, 100 * 2 ** attempt)));
    }
  }
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  return hash.digest('hex');
}

async function inventory(root, { content = true, include = () => true } = {}) {
  const result = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (/^(thumbs\.db|desktop\.ini|\.DS_Store)$/i.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('归档中不允许符号链接');
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const file = path.relative(root, full).split(path.sep).join('/');
        if (include(file)) result.push({ file, bytes: (await fs.stat(full)).size, ...(content ? { sha256: await hashFile(full) } : {}) });
      }
      else throw new Error('归档中存在不支持的文件');
    }
  }
  await walk(root);
  return result.sort((a, b) => a.file.localeCompare(b.file));
}

async function verifyInventory(root, files, { content = true, onFile = async () => {} } = {}) {
  if (!Array.isArray(files) || !files.length) throw new Error('缺少文件校验清单');
  for (const item of files) {
    if (/^(thumbs\.db|desktop\.ini|\.DS_Store)$/i.test(path.basename(item.file))) continue;
    const file = path.resolve(root, item.file);
    if (!inside(root, file) || path.isAbsolute(item.file)) throw new Error('校验路径越界');
    await onFile(item);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size !== item.bytes || ((content || /\.json$/i.test(item.file)) && await hashFile(file) !== item.sha256)) throw new Error(`文件校验失败：${item.file}`);
  }
}

// Decode only the URL path. Signed query parameters must never enter state or logs.
function relativeUri(uri, id) {
  const url = new globalThis.URL(uri, 'https://quixel.com');
  let parts;
  try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { throw new Error('下载路径编码无效'); }
  if (parts.some(p => p === '.' || p === '..' || /[\\/:<>"|?*]/.test(p) || [...p].some(c => c.charCodeAt(0) < 32) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) throw new Error('下载路径不安全');
  const index = parts.indexOf(id);
  const relative = (index >= 0 ? parts.slice(index + 1) : parts.slice(-1)).join('/');
  if (!relative) throw new Error('下载文件名为空');
  return relative;
}

function trustedDownload(uri) {
  const url = new globalThis.URL(uri);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !(
    url.hostname === 'quixel.com' || url.hostname.endsWith('.quixel.com') ||
    url.hostname.endsWith('.cloudfront.net') || url.hostname.endsWith('.amazonaws.com')
  )) throw new Error('下载清单包含非 Quixel/CDN 地址');
  return url.href;
}

function flattenFiles(value, result = [], hints = {}) {
  if (!value || typeof value !== 'object') return result;
  if (Array.isArray(value)) { for (const item of value) flattenFiles(item, result, hints); return result; }
  const next = { ...hints };
  for (const key of ['type', 'mimeType', 'resolution', 'tris', 'lod', 'variation']) if (value[key] !== undefined) next[key] = value[key];
  if (typeof value.uri === 'string' && !value.uri.startsWith('data:')) result.push({ ...next, ...value });
  for (const [key, item] of Object.entries(value)) if (key !== 'uri' && item && typeof item === 'object') flattenFiles(item, result, next);
  return result;
}

function resolutionNumber(value) { return Math.max(...String(value || '').split('x').map(Number).filter(Number.isFinite), 0); }

function assetTypeTokens(meta) {
  const types = [meta.type, meta.assetType, meta.semanticTags?.asset_type, ...(Array.isArray(meta.categories) ? meta.categories : []), ...Object.keys(meta.assetCategories || {})];
  return types.map(value => String(value || '').toLowerCase().replace(/[\s_-]+/g, ''));
}
function is3dAsset(meta) {
  return assetTypeTokens(meta).some(value => ['3d', '3dasset', '3dassets', 'asset3d'].includes(value));
}
function catalogAssetType(meta) {
  const aliases = {
    '3d': ['3d', '3dasset', '3dassets', 'asset3d'],
    '3dplant': ['3dplant', '3dplants', 'plant3d'],
    surface: ['surface', 'surfaces', 'material', 'materials', 'tile', 'tiles', 'tiling', 'imperfection', 'imperfections', 'displacement', 'displacements'],
    decal: ['decal', 'decals', 'atlas', 'atlases'], hdri: ['hdri', 'hdr', 'sky']
  };
  for (const token of assetTypeTokens(meta)) for (const [type, names] of Object.entries(aliases)) if (names.includes(token)) return type;
  return 'other';
}
function textureResolution(meta, requested) {
  const capped = is3dAsset(meta) || assetTypeTokens(meta).some(value => ['surface', 'surfaces', 'material', 'materials', 'tile', 'tiles', 'tiling', 'decal', 'decals', 'atlas', 'atlases', 'imperfection', 'imperfections', 'displacement', 'displacements'].includes(value));
  return capped ? Math.min(requested, 4096) : requested;
}
function highpolyFiles(meta) {
  return flattenFiles(meta.version === 2 ? meta.models : meta.meshes)
    .filter(file => (['original', 'highpoly', 'vfx'].includes(file.type) || file.lod === -1) && file.mimeType === 'application/x-fbx');
}
function selectedFiles(meta, files) {
  const hdri = catalogAssetType(meta) === 'hdri';
  const high = new Set(highpolyFiles(meta).map(file => relativeUri(file.uri, meta.id)));
  const texturePaths = new Set(flattenFiles(meta.maps || meta.components || []).map(file => relativeUri(file.uri, meta.id)));
  const preview = materialPreview(meta, catalogAssetType(meta));
  const previewPaths = new Set(flattenFiles(meta.previews).map(file => relativeUri(file.uri, meta.id)));
  const chosenPreview = preview ? relativeUri(preview.uri, meta.id) : null;
  const result = files.filter(file => (!chosenPreview || !previewPaths.has(file.file) || file.file === chosenPreview)
    && (hdri || !/\.exr$/i.test(file.file)) && (!is3dAsset(meta) || !/\.(fbx|obj|abc|ztl|uasset)$/i.test(file.file) || high.has(file.file)))
    .map(file => ({ ...file, ...(texturePaths.has(file.file) ? { isTexture: true, maxResolution: textureResolution(meta, 8192) } : {}) }));
  if (is3dAsset(meta) && !result.some(file => high.has(file.file))) throw new Error('签名清单没有所需的 Highpoly FBX，停止，不回退为 LOD 模型');
  if (chosenPreview && !result.some(file => file.file === chosenPreview)) throw new Error('签名清单缺少目录中的材质球预览，停止，避免使用平铺贴图代替');
  if (!result.length) throw new Error('排除 EXR 后没有可下载文件');
  return result;
}

// These request shapes match the installed Bridge v1/downloads client. They are
// private service interfaces: validate against a real account before a full run.
function downloadRequest(meta, resolution = 4096) {
  resolution = textureResolution(meta, resolution);
  const hdri = catalogAssetType(meta) === 'hdri';
  const onlyHighpoly = is3dAsset(meta);
  if (onlyHighpoly && !highpolyFiles(meta).length) throw new Error('此 3D Asset 没有可用的 Highpoly FBX，停止，不回退为 LOD 模型');
  const id = assetId(meta.id);
  const allMaps = flattenFiles(meta.maps || meta.components || []);
  const types = [...new Set(allMaps.map(x => x.type).filter(Boolean))];
  const components = [];
  for (const type of types) {
    const maps = allMaps.filter(x => x.type === type && (hdri || (!/exr/i.test(x.mimeType || '') && !/\.exr(?:[?#]|$)/i.test(x.uri || ''))));
    const sizes = [...new Set(maps.map(x => x.resolution).filter(x => resolutionNumber(x) <= resolution && resolutionNumber(x) > 0))];
    sizes.sort((a, b) => resolutionNumber(b) - resolutionNumber(a));
    if (!sizes.length) continue;
    const size = sizes[0];
    const available = maps.filter(x => x.resolution === size);
    const prefer = hdri ? ['image/vnd.radiance', 'image/x-hdr', 'image/hdr', 'image/x-exr', 'image/exr', 'image/x-openexr'] : ['image/png', 'image/jpeg'];
    const mimeType = prefer.find(m => available.some(x => x.mimeType === m));
    if (!mimeType) continue;
    const trisValues = [...new Set(available.filter(x => x.mimeType === mimeType && x.tris !== undefined).map(x => x.tris))];
    if (trisValues.length) for (const tris of onlyHighpoly ? [Math.max(...trisValues.map(Number))] : trisValues) components.push({ type, mimeType, resolution: size, tris });
    else components.push({ type, mimeType, resolution: size });
  }
  if (meta.version === 2) {
    const lods = [...new Set((meta.models || []).filter(x => x.type === 'lod').map(x => x.lod))].filter(Number.isFinite).sort((a,b) => a-b);
    const meshes = onlyHighpoly
      ? ((meta.models || []).some(model => model.type === 'vfx') ? [{ mimeType: 'application/x-fbx', type: 'vfx' }] : [{ mimeType: 'application/x-fbx', lod: -1 }])
      : lods.map(lod => ({ mimeType: 'application/x-fbx', lod }));
    const billboards = [...new Set(flattenFiles(meta.billboards || []).map(x => x.type).filter(Boolean))]
      .map(type => ({ type, mimeType: 'image/jpeg', resolution: `${resolution}x${resolution}` }));
    return { asset: id, components, ...(meshes.length ? { meshes } : {}), ...(billboards.length ? { billboards } : {}) };
  }
  const lods = (meta.meshes || []).filter(x => x.type === 'lod').map(x => x.tris).filter(Number.isFinite);
  return { asset: id, components, config: { highpoly: onlyHighpoly, ztool: false, lowerlod_normals: !onlyHighpoly, albedo_lods: false, meshMimeType: 'application/x-fbx', brushes: (meta.categories || []).includes('brush'), lods: onlyHighpoly ? [] : lods } };
}

function signedFiles(response, id) {
  const files = new Map();
  for (const entry of flattenFiles(response)) {
    // /downloads signs each requested asset file. Never construct private CDN
    // links from public catalog metadata or skip entitlement checks.
    if (!/^https:\/\//.test(entry.uri)) throw new Error('Quixel 返回了未识别的下载清单（需要带签名的完整 URL）');
    const url = trustedDownload(entry.uri);
    const relative = relativeUri(url, id);
    const bytes = Number(entry.contentLength);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`文件大小未知，停止以保护本地空间：${relative}`);
    const key = relative.toLowerCase();
    if (files.has(key) && files.get(key).url !== url) throw new Error(`下载清单存在重名文件：${relative}`);
    files.set(key, { url, file: relative, bytes });
  }
  if (!files.size) throw new Error('Quixel 返回空下载清单');
  return [...files.values()];
}

class QuixelClient {
  constructor(token, { fetchImpl = fetch, retries = 3, sleep = ms => new Promise(r => globalThis.setTimeout(r, ms)) } = {}) {
    if (!token || /[\r\n]/.test(token)) throw new Error('缺少 Quixel 登录凭证，请先运行 --login');
    this.token = token; this.fetch = fetchImpl; this.retries = retries; this.sleep = sleep;
  }
  async request(endpoint, body) {
    let last;
    for (let attempt = 0; attempt < this.retries; attempt++) {
      try {
        const response = await this.fetch(`${API}${endpoint}`, {
          method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: globalThis.AbortSignal.timeout(60000)
        });
        if (response.status === 401 || response.status === 403) throw Object.assign(new Error('登录已过期或该资产无下载权限，请重新登录确认已购库'), { fatal: true, code: 'QUIXEL_AUTH', status: response.status });
        if (!response.ok) {
          const transient = response.status === 429 || response.status >= 500;
          const seconds = Number(response.headers.get('retry-after'));
          throw Object.assign(new Error(`Quixel 接口失败：HTTP ${response.status}`), { source: 'quixel', status: response.status, fatal: !transient, retryMs: Number.isFinite(seconds) ? Math.min(60000, seconds * 1000) : 0 });
        }
        return await response.json();
      } catch (e) {
        if (e.fatal) throw e;
        last = e;
        if (attempt + 1 < this.retries) await this.sleep(e.retryMs || Math.min(30000, 1000 * 2 ** attempt));
      }
    }
    throw Object.assign(new Error(`Quixel 请求重试失败：${last?.status ? `HTTP ${last.status}` : last?.name || 'network error'}`), { source: last?.source, transient: transient(last), status: last?.status, retryMs: last?.retryMs });
  }
  async acquired() {
    const data = await this.request('assets/acquired');
    if (!Array.isArray(data)) throw new Error('已购库返回格式变化，停止，不能保证已列出全库');
    const ids = [...new Set(data.map(item => assetId(item.assetID)))];
    this.acquiredStats = { received: data.length, unique: ids.length, duplicates: data.length - ids.length };
    return ids;
  }
  async metadata(id) {
    const meta = await this.request(`assets/${assetId(id)}`);
    if (meta.id !== id) throw new Error('Quixel 资产 ID 不匹配');
    return meta;
  }
  async plan(id, resolution) {
    const meta = await this.metadata(id);
    const request = downloadRequest(meta, resolution);
    const response = await this.request('downloads', request);
    return { meta, files: selectedFiles(meta, signedFiles(response, id)) };
  }
}

async function freeBytes(dir) {
  const stats = await fs.statfs(dir, { bigint: true });
  return Number(stats.bavail * stats.bsize);
}

async function downloadFile(entry, root, { fetchImpl = fetch, reserveBytes = 0, checkFree = freeBytes, onBytes, validateUrl = trustedDownload } = {}) {
  const destination = path.resolve(root, entry.file);
  if (!inside(root, destination)) throw new Error('下载目标越界');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const checksumPath = `${destination}.transfer-sha256`;
  if (await exists(destination) && await exists(checksumPath) && (await fs.stat(destination)).size === entry.bytes && await hashFile(destination) === (await fs.readFile(checksumPath, 'utf8')).trim()) return;
  // Invalid completed files are ours to replace; remove them before streaming
  // a replacement so .part never doubles the required local disk space.
  await fs.rm(destination, { force: true });
  await fs.rm(checksumPath, { force: true });
  if (await checkFree(root) < reserveBytes + entry.bytes) throw new Error('本地剩余空间不足，保留缓存并暂停');
  const temp = `${destination}.part`;
  await fs.rm(temp, { force: true });
  try {
    const response = await fetchImpl(validateUrl(entry.url), { redirect: 'error', signal: globalThis.AbortSignal.timeout(30 * 60 * 1000) });
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`资源下载失败：HTTP ${response.status}（${entry.file}）`), { source: 'cdn', file: entry.file, status: response.status }); }
    const contentType = response.headers.get('content-type') || '';
    // Signed manifests also contain source metadata. JSON is valid for those
    // files, while a JSON error body must never be saved as a model or texture.
    if (/text\/html/i.test(contentType) || (/application\/json/i.test(contentType) && !/\.json$/i.test(entry.file))) throw new Error('CDN 返回的不是资源文件');
    const hash = crypto.createHash('sha256');
    let count = 0, lastUpdate = Date.now();
    const bounded = new Transform({ transform(chunk, encoding, callback) {
      count += chunk.length;
      hash.update(chunk);
      if (count > entry.bytes) callback(new Error('下载超过清单声明大小，已停止'));
      else if (onBytes && Date.now() - lastUpdate >= 5000) {
        lastUpdate = Date.now();
        Promise.resolve().then(() => onBytes(count)).then(() => callback(null, chunk), callback);
      } else callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), bounded, createWriteStream(temp, { flags: 'wx' }));
    if (count !== entry.bytes) throw new Error(`下载长度不匹配：${entry.file}`);
    if (/\.json$/i.test(entry.file)) {
      try { JSON.parse(await fs.readFile(temp, 'utf8')); }
      catch { throw new Error(`CDN 返回的 JSON 文件无效：${entry.file}`); }
    }
    await fs.rename(temp, destination);
    // The final publication still reads back and verifies the stored files.
    // This checkpoint describes the received stream without another full read.
    await fs.writeFile(checksumPath, hash.digest('hex'));
  } finally { await fs.rm(temp, { force: true }); }
}

async function ownedCache(cacheRoot, id) {
  const parent = path.join(cacheRoot, 'assets');
  const dir = await cachePath(cacheRoot, id);
  await fs.mkdir(parent, { recursive: true });
  if (await exists(dir)) {
    const marker = await readJson(path.join(dir, '.transfer-owner.json'));
    if (marker.id !== id || marker.tool !== 'assethive-megascans-v1') throw new Error('缓存目录不是本脚本创建，拒绝使用');
  } else {
    await fs.mkdir(dir);
    await atomicJson(path.join(dir, '.transfer-owner.json'), { id, tool: 'assethive-megascans-v1' });
  }
  return dir;
}

async function cleanupOwnedCache(cacheRoot, id) {
  const parent = path.join(cacheRoot, 'assets');
  const dir = await cachePath(cacheRoot, id);
  if (!await exists(dir)) return;
  const realParent = await fs.realpath(parent), realDir = await fs.realpath(dir);
  if (path.dirname(realDir).toLowerCase() !== realParent.toLowerCase() || (await fs.lstat(dir)).isSymbolicLink()) throw new Error('缓存清理路径越界');
  const marker = await readJson(path.join(dir, '.transfer-owner.json'));
  if (marker.id !== id || marker.tool !== 'assethive-megascans-v1') throw new Error('拒绝清理非本任务缓存');
  await inventory(dir); // Reject nested links before recursive deletion too.
  await fs.rm(realDir, { recursive: true, maxRetries: 5, retryDelay: 100 });
}

function localMetadata(meta, files) {
  const byName = new Map(files.map(f => [f.sourceFile || f.file, f]));
  function rewrite(value) {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    let mapped;
    for (const [key, val] of Object.entries(value)) {
      if (key === 'uri' && typeof val === 'string' && !val.startsWith('data:')) {
        const relative = relativeUri(val, meta.id);
        mapped = byName.get(relative);
        if (!mapped) return null;
        out.uri = mapped.file;
      } else out[key] = rewrite(val);
    }
    return mapped ? { ...out, contentLength: mapped.bytes } : out;
  }
  const stripNulls = value => Array.isArray(value) ? value.filter(Boolean).map(stripNulls) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k, stripNulls(v)])) : value;
  const result = stripNulls(rewrite(meta));
  return { ...result, id: meta.id, source: 'quixel', json: { uri: `${meta.id}.json` } };
}

async function copyVerified(source, destination, files, { concurrency = 3 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('共享盘复制并发数必须在 1–4 之间');
  if (!await exists(destination)) await fs.mkdir(destination, { recursive: true });
  const copy = async entry => {
    const to = path.resolve(destination, entry.file);
    if (!inside(destination, to)) throw new Error('归档目标越界');
    if (await exists(to)) {
      if ((await fs.stat(to)).size === entry.bytes && await hashFile(to) === entry.sha256) return;
      throw new Error(`共享盘已存在不同内容，停止：${entry.file}`);
    }
    await fs.mkdir(path.dirname(to), { recursive: true });
    const temp = `${to}.transfer-part`;
    await fs.copyFile(path.resolve(source, entry.file), temp);
    if (await hashFile(temp) !== entry.sha256) throw new Error('共享盘复制校验失败');
    await fs.rename(temp, to);
  };
  let cursor = 0, failure;
  // Overlap a few independent SMB operations while retaining per-file readback.
  // Drain every writer before reporting failure, so resume cannot race old IO.
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, async () => {
    while (!failure && cursor < files.length) {
      const entry = files[cursor++];
      try { await copy(entry); } catch (error) { failure ||= error; }
    }
  }));
  if (failure) throw failure;
  // Each copied (or existing) target was just hashed above. Check structure here;
  // transferOne performs a complete final readback before publishing a receipt.
  await verifyInventory(destination, files, { content: false });
}

function metadataReferences(root, meta, id, files) {
  if (meta.schemaVersion !== '1.0' || meta.identity?.sourceKind !== 'megascans' || meta.identity?.sourceAssetId !== id) throw new Error('入库元数据的来源身份无效');
  const manifest = new Set(files.map(file => file.file.toLowerCase()));
  const normalize = reference => {
    const full = path.resolve(root, reference);
    const relative = path.relative(root, full).split(path.sep).join('/').toLowerCase();
    if (!inside(root, full) || !manifest.has(relative)) throw new Error('入库元数据引用了回执之外的文件');
    return relative;
  };
  return { id, assetID: meta.assetID, assetType: meta.assetType,
    models: (meta.modelFiles || []).map(normalize).sort(), textures: (meta.textureFiles || []).map(normalize).sort(),
    components: (meta.components || []).filter(item => item.uri).map(item => normalize(item.uri)).sort() };
}

async function verifyImportedFiles(root, id, files, references, options) {
  if (!references) return verifyInventory(root, files, options);
  const meta = await readJson(path.join(root, 'asset_info.json'));
  const isPreview = file => /^Preview[\\/].*\.(png|jpe?g|webp)$/i.test(file);
  const recordedPreviews = new Set(files.filter(file => isPreview(file.file)).map(file => file.file.replaceAll('\\', '/').toLowerCase()));
  const previewUris = [meta.previewImage, meta.detailImage, meta.previews?.preview,
    ...(meta.previews?.images || [])].map(value => typeof value === 'string' ? value : value?.uri).filter(Boolean);
  const previews = [...new Set(previewUris)].map(uri => {
    const file = path.resolve(root, uri);
    if (!inside(root, file)) throw new Error('当前预览路径越界');
    return { file, relative: path.relative(root, file).replaceAll('\\', '/') };
  });
  const replacedPreview = recordedPreviews.size > 0 && previews.some(preview => isPreview(preview.relative) && !recordedPreviews.has(preview.relative.toLowerCase()));
  await verifyInventory(root, files.filter(file => file.file !== 'asset_info.json' && !(replacedPreview && isPreview(file.file))), options);
  if (replacedPreview) for (const preview of previews) {
    const stat = await fs.lstat(preview.file);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || !inside(await fs.realpath(root), await fs.realpath(preview.file))) throw new Error('当前预览引用无效');
  }
  // The editor versions preview filenames on replacement. Accept a valid new
  // presentation image while retaining strict hashes and references for every
  // model/texture; an absent current image or changed resource still stops.
  if (JSON.stringify(metadataReferences(root, meta, id, files)) !== JSON.stringify(references)) throw new Error(`入库元数据的来源或资源引用已变化：${id}`);
}

async function verifyReceipt(library, receipt, id, options) {
  if (receipt.id !== id || receipt.version !== 1) throw new Error('任务回执无效');
  if (JSON.stringify(receipt.policy) !== JSON.stringify(DOWNLOAD_POLICY)) throw new Error('完成记录使用了旧下载规格，不能按 Highpoly / PNG / 无 EXR 规格跳过，请使用独立目标库');
  for (const section of [receipt.archive, receipt.imported].filter(Boolean)) {
    const root = path.resolve(library, section.root);
    if (!inside(library, root)) throw new Error('回执目标越界');
    if (section === receipt.imported && section.metadataReferences) {
      // AssetHive legitimately writes tags, dimensions and analysis after import.
      // Keep every resource hash strict while validating metadata's identity and
      // exact resource references instead of freezing its editable presentation.
      await verifyImportedFiles(root, id, section.files, section.metadataReferences, options);
    } else {
      const removed = section === receipt.archive ? archiveRetentionFiles(receipt) : new Set();
      await verifyInventory(root, section.files.filter(file => !removed.has(file.file)), options);
      for (const file of section.files.filter(file => removed.has(file.file))) {
        if (!await exists(path.resolve(root, file.file))) continue;
        if (section.retention.status === 'pruned') throw new Error('已清理的原始文件重新出现，请检查归档');
        await verifyInventory(root, [file], options);
      }
    }
  }
  if (!receipt.archive) throw new Error('缺少原始资源归档回执');
  if (receipt.mode === 'import' && !receipt.imported && !receipt.archivedOnlyReason) throw new Error('缺少 AssetHive 入库回执');
}

// Keep the original hash manifest as evidence. Only an explicit, durable
// retention transaction for a verified import may account for missing files.
function archiveRetentionFiles(receipt) {
  const retention = receipt.archive?.retention;
  if (!retention) return new Set();
  const names = retention.removedFiles;
  if (receipt.mode !== 'import' || !receipt.imported?.metadataReferences || retention.version !== 1
    || !['pruning', 'pruned'].includes(retention.status) || retention.reason !== 'capacity'
    || !Array.isArray(names) || !names.length || new Set(names).size !== names.length
    || names.some(name => typeof name !== 'string' || path.isAbsolute(name) || name.split(/[\\/]/).some(part => part === '..' || part === '.')
      || !receipt.archive.files.some(file => file.file === name) || /\.json$/i.test(name))
    || !receipt.archive.files.some(file => !names.includes(file.file))) throw new Error('原始归档清理回执无效');
  return new Set(names);
}

// Publication stays sequential. A coordinator may download one following item,
// reserving combined cache space and gating its archive until promotion.
async function transferOne({ id, client, library, cacheRoot, resolution, maxCacheBytes, reserveBytes, importer, mode = 'import', log = console.log, download = downloadFile, downloadWorkers = 1, onProgress = async () => {}, reserveCache = async () => {}, beforeArchive = async () => {}, shouldStopDownload = async () => false }) {
  if (!Number.isInteger(downloadWorkers) || downloadWorkers < 1 || downloadWorkers > 8) throw new Error('下载并发数必须在 1–8 之间');
  const progressCallback = onProgress;
  let notification = Promise.resolve();
  const started = performance.now(), timingsMs = {};
  let phase = 'planning', phaseStarted = started;
  onProgress = details => {
    const now = performance.now();
    if (details.stage && details.stage !== phase) {
      timingsMs[phase] = (timingsMs[phase] || 0) + now - phaseStarted;
      phase = details.stage;
      phaseStarted = now;
    }
    const timing = Object.fromEntries(Object.entries({ ...timingsMs, [phase]: (timingsMs[phase] || 0) + now - phaseStarted }).map(([key, value]) => [key, Math.round(value)]));
    const update = globalThis.structuredClone({ ...details, timingsMs: timing, elapsedMs: Math.round(now - started) });
    notification = notification.then(() => progressCallback(update));
    return notification;
  };
  try {
  assetId(id);
  const control = path.join(library, '.megascans');
  const receiptPath = await resolveReceiptPath(library, id);
  const storageKey = path.basename(receiptPath, '.json');
  if (await exists(receiptPath)) {
    const receipt = await readJson(receiptPath);
    await verifyReceipt(library, receipt, id);
    if (receipt.resolution !== resolution) throw new Error('共享盘已有另一分辨率的完成记录，请使用独立目标库，不会静默覆盖');
    if (mode === 'import' && receipt.mode !== 'import') throw new Error('该资产此前仅归档，请使用新的缓存任务进行入库，不能直接当作已导入');
    await cleanupOwnedCache(cacheRoot, id);
    log(`[跳过] ${id} 已归档并通过校验`);
    return receipt;
  }
  const dir = await ownedCache(cacheRoot, id);
  const payload = path.join(dir, 'payload');
  await fs.mkdir(payload, { recursive: true });
  log(`[准备] ${id}`);
  await onProgress({ status: 'running', stage: 'planning' });
  const plan = await client.plan(id, resolution);
  const bytes = plan.files.reduce((sum, f) => sum + f.bytes, 0);
  let metadata = localMetadata(plan.meta, plan.files);
  const metadataBytes = Buffer.byteLength(JSON.stringify(metadata, null, 2));
  // A force-killed download can leave a partial file. It is never counted as a
  // second full asset during resume, nor copied to the original archive.
  const existingFiles = await inventory(payload, { content: false });
  for (const entry of existingFiles) {
    if (entry.file.endsWith('.part')) await fs.rm(path.join(payload, entry.file));
  }
  const expectedPaths = new Set(plan.files.map(f => f.file));
  expectedPaths.add(`${id}.json`);
  const cachedFiles = existingFiles.filter(f => !f.file.endsWith('.part'));
  const oldBytes = cachedFiles.filter(f => !expectedPaths.has(f.file) && !f.file.endsWith('.transfer-sha256')).reduce((sum, f) => sum + f.bytes, 0);
  const requiredBytes = bytes + metadataBytes + oldBytes + plan.files.length * 64 + 1024;
  if (requiredBytes > maxCacheBytes) throw new Error(`单资产 ${id} 超过缓存上限，未开始下载`);
  await reserveCache(requiredBytes);
  const cachedBytes = plan.files.reduce((sum, file) => sum + (cachedFiles.find(f => f.file === file.file)?.bytes || 0), 0);
  if (await freeBytes(dir) < Math.max(0, bytes - cachedBytes) + metadataBytes + reserveBytes) throw new Error('本地可用空间不足，未开始下一项');
  const previewPaths = new Set(flattenFiles(plan.meta.previews).map(file => relativeUri(file.uri, id)));
  const resourcePaths = new Set(flattenFiles([plan.meta.maps || plan.meta.components || [], plan.meta.models || plan.meta.meshes || []]).map(file => relativeUri(file.uri, id)));
  const optionalPreview = file => is3dAsset(plan.meta) && previewPaths.has(file.file) && !resourcePaths.has(file.file) && /\.(png|jpe?g|webp)$/i.test(file.file);
  const omittedPreviews = [];
  let downloadedBytes = 0, completedFiles = 0, cursor = 0, failure;
  const active = new Map();
  const report = (byteUpdate = false) => onProgress({ status: 'running', stage: 'downloading', file: [...active.keys()].join(' · '),
    activeFiles: [...active.keys()], downloadWorkers, totalFiles: plan.files.length - omittedPreviews.length, completedFiles,
    totalBytes: bytes - omittedPreviews.reduce((sum, item) => sum + plan.files.find(file => file.file === item.file).bytes, 0),
    downloadedBytes: downloadedBytes + [...active.values()].reduce((a, b) => a + b, 0), omittedPreviews, byteUpdate });
  const worker = async () => {
    while (!failure && cursor < plan.files.length) {
      if (await shouldStopDownload()) { failure ||= paused(); break; }
      if (failure || cursor >= plan.files.length) break;
      const file = plan.files[cursor++];
      active.set(file.file, 0);
      try {
        await report();
        log(`[下载或校验缓存] ${id} / ${file.file}`);
        for (let attempt = 0; ; attempt++) {
          try {
            active.set(file.file, 0);
            await download(file, payload, { reserveBytes, onBytes: count => { active.set(file.file, count); return report(true); } });
            break;
          } catch (error) {
            if ([403, 404].includes(error.status) && optionalPreview(file)) {
              omittedPreviews.push({ file: file.file, status: error.status });
              log(`[预览不可用] ${id} / ${file.file}：HTTP ${error.status}；将检查其他预览后再入库`);
              break;
            }
            if (attempt === 2 || failure) throw error;
            await new Promise(resolve => globalThis.setTimeout(resolve, 1000 * 2 ** attempt));
          }
        }
        active.delete(file.file);
        if (!omittedPreviews.some(item => item.file === file.file)) { downloadedBytes += file.bytes; completedFiles++; }
        await report();
      } catch (error) {
        failure ||= error;
      }
    }
  };
  // Drain every active stream before returning an error or publishing anything.
  await Promise.all(Array.from({ length: Math.min(downloadWorkers, plan.files.length) }, worker));
  if (failure) throw failure;
  await onProgress({ stage: 'preparing' });
  const preparedFiles = plan.files.filter(file => !omittedPreviews.some(item => item.file === file.file));
  if (omittedPreviews.length && !preparedFiles.some(optionalPreview)) throw new Error('所有 3D 预览均不可用，保留缓存，停止入库');
  metadata = localMetadata(plan.meta, preparedFiles);
  await atomicJson(path.join(payload, `${id}.json`), metadata);
  // A resumed plan can select a different texture tier. Only publish files in
  // the current signed plan, never stale higher-resolution cache leftovers.
  const archivePaths = new Set(preparedFiles.map(file => file.file));
  archivePaths.add(`${id}.json`);
  const originalFiles = await inventory(payload, { include: file => archivePaths.has(file) });
  const archiveRoot = path.join(control, 'originals', `v${DOWNLOAD_POLICY.version}`, storageKey);
  await beforeArchive({ id, archiveRoot, files: originalFiles });
  log(`[归档与校验] ${id}`);
  await onProgress({ stage: 'archiving' });
  await copyVerified(payload, archiveRoot, originalFiles);
  let imported = null;
  let archivedOnlyReason = '';
  if (mode === 'import') {
    log(`[AssetHive 入库] ${id}`);
    await onProgress({ stage: 'importing' });
    if (!importer) throw new Error('未配置 AssetHive 导入器');
    const result = await importer({ id, storageKey, cacheKey: path.basename(dir), source: archiveRoot, localSource: payload, library, cacheRoot, sourceFiles: originalFiles.map(file => file.file) });
    if (!result?.ok) throw new Error(`AssetHive 入库失败：${result?.message || '没有成功回执'}`);
    if (result.archivedOnly) {
      archivedOnlyReason = result.message;
      if (!archivedOnlyReason) throw new Error('未说明仅归档原因');
      log(`[仅原始归档] ${id}：${archivedOnlyReason}`);
    } else {
      if (!inside(library, result.assetPath)) throw new Error('导入器输出路径越界');
      // The importer hashes its staging output. Reuse that manifest, then check
      // the published bytes against it in verifyReceipt below.
      imported = { root: path.relative(library, result.assetPath), files: result.files || await inventory(result.assetPath) };
      if (!imported.files.some(f => f.file === 'asset_info.json')) throw new Error('缺少 AssetHive 标准元数据，禁止清理本地缓存');
      const savedMeta = await readJson(path.join(result.assetPath, 'asset_info.json'));
      if (savedMeta.schemaVersion === '1.0' && savedMeta.identity?.sourceAssetId === id) imported.metadataReferences = metadataReferences(result.assetPath, savedMeta, id, imported.files);
    }
  }
  const receipt = { version: 1, policy: DOWNLOAD_POLICY, id, mode, resolution, completedAt: new Date().toISOString(), archive: { root: path.relative(library, archiveRoot), files: originalFiles }, imported, ...(omittedPreviews.length ? { omittedPreviews } : {}), ...(archivedOnlyReason ? { archivedOnlyReason } : {}) };
  await onProgress({ stage: 'verifying' });
  await verifyReceipt(library, receipt, id);
  await atomicJson(receiptPath, receipt);
  await onProgress({ stage: 'cleaning' });
  await cleanupOwnedCache(cacheRoot, id);
  await onProgress({ stage: 'done', status: 'completed', archivedOnlyReason });
  log(`[阶段耗时] ${id}：${Object.entries(timingsMs).map(([stage, ms]) => `${stage} ${(ms / 1000).toFixed(2)}s`).join('；')}；合计 ${((performance.now() - started) / 1000).toFixed(2)}s`);
  log(`[完成并释放本地空间] ${id}`);
  return receipt;
  } catch (error) {
    await onProgress({}).catch(() => {});
    throw error;
  }
}

module.exports = { DOWNLOAD_POLICY, GIB, assetId, inside, exists, atomicJson, renameWithRetry, inventory, verifyInventory, verifyImportedFiles, metadataReferences, archiveRetentionFiles, hashFile, relativeUri, trustedDownload, flattenFiles, catalogAssetType, downloadRequest, selectedFiles, signedFiles, QuixelClient, freeBytes, downloadFile, ownedCache, cleanupOwnedCache, localMetadata, copyVerified, verifyReceipt, transferOne };
